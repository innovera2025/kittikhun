/**
 * สัญญา ERP Adapter — KITTIKHUN Mobile Stock Check
 *
 * 🚫 กฎเหล็กของโปรเจค: ERP (`db_TCL` บน SQL Server 2019) เป็นแหล่ง **อ่านอย่างเดียว**
 *    ไม่มีการเขียนข้อมูลกลับ ERP ทุกกรณี ไม่มีข้อยกเว้น (คำสั่งเจ้าของโปรเจค 17 ส.ค. 2569)
 *    เส้นทางข้อมูล: ERP (SELECT) → items_cache → มือถือ → พนักงานกรอกค่าที่นับได้
 *                  → server คำนวณส่วนต่าง → เก็บใน Postgres ของเราเอง ✗ ไม่กลับไป ERP
 *
 * ไฟล์นี้บังคับ 2 ชั้นจาก 5 ชั้นของกฎเหล็ก (ดู docs/erp-integration.md §กฎเหล็ก):
 *    ชั้นที่ 3 — statement guard: `assertReadOnlySql()` + `BaseErpDriver.guardedQuery()`
 *    ชั้นที่ 4 — interface ไม่มี method เขียน: `ErpAdapter` (+ ตัวจับ regression ตอน compile)
 * อีก 3 ชั้นอยู่ที่อื่น: (1) สิทธิ์ DB `db_datareader` (2) boot write-probe ใน driver
 *    (5) read-only connection option
 *
 * ไฟล์นี้เป็น pure TypeScript — ไม่ผูก NestJS decorator (มีแต่ DI token)
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// 1. Canonical types (รูปข้อมูลหลัง map จาก ERP แล้ว — domain ไม่เห็นชื่อคอลัมน์ ERP)
// ────────────────────────────────────────────────────────────────────────────

/**
 * สินค้า 1 รายการในรูปแบบกลาง (map มาจาก `dbo.InventoryItem` + แหล่งยอด)
 *
 * ข้อเท็จจริงจาก db_TCL ที่ driver ต้องยึด (docs/erp-tcl-findings.md):
 * - `sku` = `ItemCode` (ครบ 100%) แต่ **PK คือ (Roworder, ItemCode) → ItemCode ซ้ำได้ (85 รหัส)**
 *   กติกา: **Roworder สูงสุดชนะ** (รายการใหม่สุด) — driver ต้อง dedupe ก่อนคืนค่า
 * - `barcodes` = ฉลาก Code128 ที่พิมพ์จาก `ItemCode` + EAN-13/ITF-14 ที่มีจริง (`BarCodeUnits` 1.9%)
 * - `onHand` = `tbl_CountDtl.MainQty` (ยอดระบบในรอบนับ) — ERP ไม่มีตารางยอดคงเหลือสำเร็จ
 * - `loc` (`Shelf`) · `nameEn` (`ItemNameEng`) · `reserved` (`PendingQTY`) · `lot` ว่าง 100% → undefined
 * - `rop` = `MinStock` มีราว 29% → undefined ได้ (UI ซ่อน tile เมื่อไม่มีค่า)
 * - `warehouseCode` ต้อง LTRIM/RTRIM แล้ว (คอลัมน์ Warehouse เป็น nvarchar padded)
 *   คลังจริง: `WHRM` `WHFG` `WHWIP` `WHNG`
 */
export interface CanonicalItem {
  sku: string;
  name: string;
  nameEn?: string;
  barcodes: string[];
  loc?: string;
  unit: string;
  onHand?: number;
  reserved?: number;
  rop?: number;
  vendor?: string;
  lot?: string;
  lastCountDate?: Date;
  updatedAt?: Date;
  warehouseCode?: string;
}

/*
 * ⚠️ เคยมี ErpCountRow / ErpCountSessionSummary / ErpCountSession อยู่ตรงนี้
 *    สำหรับ mirror "รอบนับที่ทำใน ERP อยู่แล้ว" (tbl_CountHdr/tbl_CountDtl) เข้ามาในระบบเรา
 *
 *    ตัดออกถาวร 22 ส.ค. 2569 ตามขอบเขตที่เจ้าของโปรเจคยืนยัน:
 *    **ระบบนี้ดึงจาก ERP แค่ "จำนวนคงเหลือ" เท่านั้น ไม่เอาข้อมูลอื่น**
 *    เดิมจำเป็นเพราะยังไม่มีสูตรคำนวณยอด ต้องยืมยอดจากรอบนับของ ERP มาใช้
 *    ตอนนี้สูตรจากฝ่าย ERP แม่น 100% แล้ว (docs/erp-tcl-findings.md §6.6) จึงไม่ต้องใช้อีก
 *
 *    รอบนับทั้งหมด **เปิดจากแอปเราเอง** → freeze ยอดจาก items_cache
 */

/** สถานะ ERP สำหรับ `GET /healthz/erp` — ERP ล่มห้ามทำให้ container unhealthy */
export interface ErpHealth {
  ok: boolean;
  driver: string;
  latencyMs?: number;
  error?: string;
}

/** ความสามารถของ driver — ERP ที่ไม่มี updated-at ที่เชื่อถือได้ = full snapshot + diff ฝั่ง server */
export interface ErpCapabilities {
  delta: boolean;
}

/**
 * cursor ของ delta feed ฝั่ง ERP = เวลาที่ ERP อัปเดตล่าสุด
 * (cursor ของ device feed คือ `row_version` ใน Postgres — คนละตัว ห้ามสับสน)
 * ดึงแบบมี overlap window: `since = cursor − ERP_SYNC_OVERLAP_S` กันแถวตกขอบ
 */
export type ErpCursor = Date;

/** alias สั้นของ ErpCursor */
export type Cursor = ErpCursor;

/** ชนิด driver ที่เลือกด้วย `ERP_DRIVER` ใน `.env` */
export type ErpDriverKind = 'sql' | 'rest' | 'mock';

// ────────────────────────────────────────────────────────────────────────────
// 2. Adapter interface — ชั้นที่ 4 ของกฎเหล็ก
// ────────────────────────────────────────────────────────────────────────────

/**
 * 🚫 **READ-ONLY โดยสัญญา — ห้ามเพิ่ม method เขียนใด ๆ ในนี้เด็ดขาด**
 *
 * ห้าม: `pushAdjustment`, `postCount`, `writeBack`, `updateStock`, `syncToErp`, ... ทุกรูปแบบ
 * ถ้ามีคนเผลอเพิ่ม → `ERP_ADAPTER_IS_READ_ONLY` ด้านล่างจะทำให้ compile ไม่ผ่าน (ตัวจับ regression)
 * การเขียนกลับ ERP ถูกตัดออกจาก scope **ถาวร** — ห้ามเสนอใหม่ (docs/erp-integration.md §6)
 */
export interface ErpAdapter {
  capabilities(): ErpCapabilities;

  /** อ่าน item master แบบ stream เป็น batch (ห้ามโหลดทั้งก้อนเข้า memory) */
  fetchItems(since?: ErpCursor): AsyncIterable<CanonicalItem[]>;

  healthCheck(): Promise<ErpHealth>;
}

/** ชื่อ method แนว "เขียน" ที่ห้ามปรากฏใน `ErpAdapter` */
type WriteishMethodName =
  | `push${string}`
  | `post${string}`
  | `send${string}`
  | `write${string}`
  | `insert${string}`
  | `update${string}`
  | `upsert${string}`
  | `delete${string}`
  | `remove${string}`
  | `save${string}`
  | `submit${string}`
  | `apply${string}`
  | `adjust${string}`
  | `merge${string}`
  | `truncate${string}`
  | `drop${string}`
  | `alter${string}`
  | `exec${string}`
  | `enqueue${string}`
  | `import${string}`;

/**
 * ชั้นที่ 4 แบบบังคับตอน compile: ถ้ามีใครเพิ่ม method แนวเขียนใน `ErpAdapter`
 * บรรทัดนี้จะ error ทันที (`Type 'true' is not assignable to type 'never'`)
 */
export const ERP_ADAPTER_IS_READ_ONLY: Extract<
  keyof ErpAdapter,
  WriteishMethodName
> extends never
  ? true
  : never = true;

// ────────────────────────────────────────────────────────────────────────────
// 3. Statement guard — ชั้นที่ 3 ของกฎเหล็ก (pure function, unit-testable)
// ────────────────────────────────────────────────────────────────────────────

/** ประเภทการละเมิดกฎ read-only */
export type ReadOnlySqlViolation =
  | 'EMPTY_STATEMENT'
  | 'UNTERMINATED_STRING'
  | 'UNTERMINATED_COMMENT'
  | 'NOT_SELECT_OR_WITH'
  | 'MULTIPLE_STATEMENTS'
  | 'FORBIDDEN_KEYWORD';

export class ReadOnlySqlViolationError extends Error {
  readonly violation: ReadOnlySqlViolation;
  readonly keyword?: string;

  constructor(violation: ReadOnlySqlViolation, detail: string, keyword?: string) {
    super(
      `[ERP read-only · ชั้นที่ 3 statement guard] ปฏิเสธ SQL: ${detail} (violation=${violation}` +
        (keyword ? `, keyword=${keyword}` : '') +
        ')',
    );
    this.name = 'ReadOnlySqlViolationError';
    this.violation = violation;
    this.keyword = keyword;
  }
}

const STRING_PLACEHOLDER = "''";
const IDENT_PLACEHOLDER = '"id"';

/**
 * ตัดคอมเมนต์บรรทัดเดียวและคอมเมนต์บล็อก (รวมแบบซ้อนชั้น) แทนเนื้อใน string literal / quoted identifier
 * ด้วย placeholder แล้วยุบช่องว่าง — เพื่อให้การตรวจ keyword และ `;` ไม่ถูกหลอกด้วยข้อความในลิเทอรัล
 * และไม่ false-positive กับชื่อคอลัมน์อย่าง `[Update Date]`
 *
 * export ไว้ให้เขียน unit test ตรง ๆ ได้ (pure)
 */
export function normalizeSqlForGuard(sql: string): string {
  // ไฟล์ .sql ที่ export จาก SSMS มักมี BOM นำหน้า — ตัดก่อนไม่ให้ชนกฎ "ต้องเริ่มด้วย SELECT"
  const src = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // คอมเมนต์บรรทัดเดียว
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // คอมเมนต์บล็อก (T-SQL ซ้อนชั้นได้)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) {
        throw new ReadOnlySqlViolationError(
          'UNTERMINATED_COMMENT',
          'คอมเมนต์บล็อก /* ... */ ไม่ถูกปิด จึงตรวจสอบคำสั่งไม่ได้',
        );
      }
      out += ' ';
      continue;
    }

    // string literal '...' (escape ด้วย '')
    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        throw new ReadOnlySqlViolationError(
          'UNTERMINATED_STRING',
          "string literal ' ... ' ไม่ถูกปิด จึงตรวจสอบคำสั่งไม่ได้",
        );
      }
      out += STRING_PLACEHOLDER;
      continue;
    }

    // quoted identifier [..] / ".."
    if (ch === '[' || ch === '"') {
      const close = ch === '[' ? ']' : '"';
      i += 1;
      let closed = false;
      while (i < src.length) {
        if (src[i] === close) {
          if (src[i + 1] === close) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        throw new ReadOnlySqlViolationError(
          'UNTERMINATED_STRING',
          `quoted identifier ${ch} ... ${close} ไม่ถูกปิด จึงตรวจสอบคำสั่งไม่ได้`,
        );
      }
      out += IDENT_PLACEHOLDER;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.replace(/\s+/g, ' ').trim();
}

/** keyword ที่ห้ามปรากฏ (word-boundary) พร้อมเหตุผลไทยสำหรับ log/ops */
const FORBIDDEN_KEYWORDS: ReadonlyArray<{ label: string; pattern: RegExp; why: string }> = [
  { label: 'INSERT', pattern: /\binsert\b/i, why: 'เพิ่มข้อมูลลง ERP' },
  { label: 'UPDATE', pattern: /\bupdate\b/i, why: 'แก้ข้อมูลใน ERP' },
  { label: 'DELETE', pattern: /\bdelete\b/i, why: 'ลบข้อมูลใน ERP' },
  { label: 'MERGE', pattern: /\bmerge\b/i, why: 'upsert ข้อมูลใน ERP' },
  { label: 'TRUNCATE', pattern: /\btruncate\b/i, why: 'ล้างตาราง ERP' },
  { label: 'DROP', pattern: /\bdrop\b/i, why: 'ลบ object ใน ERP' },
  { label: 'ALTER', pattern: /\balter\b/i, why: 'แก้โครงสร้าง ERP' },
  { label: 'CREATE', pattern: /\bcreate\b/i, why: 'สร้าง object ใน ERP' },
  { label: 'GRANT', pattern: /\bgrant\b/i, why: 'แก้สิทธิ์ใน ERP' },
  { label: 'REVOKE', pattern: /\brevoke\b/i, why: 'แก้สิทธิ์ใน ERP' },
  {
    label: 'EXEC/EXECUTE',
    pattern: /\bexec(ute)?\b/i,
    why: 'เรียก stored procedure — sp ของ ERP หลายตัวเขียนตารางจริงหรือ temp table',
  },
  { label: 'sp_executesql', pattern: /\bsp_executesql\b/i, why: 'รัน SQL แบบ dynamic เลี่ยงตัวกรอง' },
  { label: 'xp_cmdshell', pattern: /\bxp_cmdshell\b/i, why: 'รันคำสั่งระดับ OS' },
  { label: 'BULK', pattern: /\bbulk\b/i, why: 'BULK INSERT / OPENROWSET(BULK ...) = เขียน/อ่านไฟล์' },
  { label: 'OPENROWSET', pattern: /\bopenrowset\b/i, why: 'เข้าถึงแหล่งข้อมูลภายนอก' },
  { label: 'INTO', pattern: /\binto\b/i, why: 'SELECT ... INTO = สร้าง/เขียนตารางใหม่' },
  { label: 'BACKUP', pattern: /\bbackup\b/i, why: 'คำสั่งระดับเซิร์ฟเวอร์ ERP' },
  { label: 'RESTORE', pattern: /\brestore\b/i, why: 'คำสั่งระดับเซิร์ฟเวอร์ ERP' },
  { label: 'SHUTDOWN', pattern: /\bshutdown\b/i, why: 'สั่งปิดเซิร์ฟเวอร์ ERP' },
];

/**
 * ชั้นที่ 3 ของกฎเหล็ก — ทุก SQL ที่จะส่งเข้า connection ของ ERP ต้องผ่านฟังก์ชันนี้ก่อน
 * ผ่าน = return void · ไม่ผ่าน = throw `ReadOnlySqlViolationError`
 *
 * กติกา: ต้องเป็น statement เดียว เริ่มด้วย SELECT หรือ WITH เท่านั้น
 * และห้ามมี keyword ฝั่งเขียน/ระดับเซิร์ฟเวอร์ปนมา
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new ReadOnlySqlViolationError('EMPTY_STATEMENT', 'SQL ว่างเปล่า');
  }

  const normalized = normalizeSqlForGuard(sql);
  if (normalized.length === 0) {
    throw new ReadOnlySqlViolationError(
      'EMPTY_STATEMENT',
      'SQL มีแต่คอมเมนต์/ช่องว่าง ไม่มีคำสั่งจริง',
    );
  }

  // ต้องเริ่มด้วย SELECT หรือ WITH เท่านั้น (SET NOCOUNT ON / DECLARE / EXEC ก็ไม่ผ่าน)
  if (!/^(select|with)\b/i.test(normalized)) {
    const firstToken = normalized.split(/[\s(;]/, 1)[0];
    throw new ReadOnlySqlViolationError(
      'NOT_SELECT_OR_WITH',
      `คำสั่งต้องเริ่มด้วย SELECT หรือ WITH เท่านั้น แต่เริ่มด้วย "${firstToken}" — ` +
        'ถ้า script ของ ERP มี SET NOCOUNT ON / DECLARE / EXEC นำหน้า ให้ตัดออกหรือย่อเป็น CTE (WITH ...) ก่อน',
      firstToken,
    );
  }

  // statement ซ้อน: อนุญาต ';' ตัวท้ายสุดเท่านั้น
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new ReadOnlySqlViolationError(
      'MULTIPLE_STATEMENTS',
      "พบ ';' คั่นกลาง = ส่งได้หลายคำสั่งในครั้งเดียว (อนุญาตแค่ ';' ปิดท้ายคำสั่งเดียว)",
    );
  }

  for (const rule of FORBIDDEN_KEYWORDS) {
    if (rule.pattern.test(withoutTrailingSemicolon)) {
      throw new ReadOnlySqlViolationError(
        'FORBIDDEN_KEYWORD',
        `พบคำสั่งที่ห้ามใช้กับ ERP: ${rule.label} (${rule.why}) — ERP ของโปรเจคนี้อ่านอย่างเดียว`,
        rule.label,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Base driver — บังคับให้ทุก query ผ่าน statement guard
// ────────────────────────────────────────────────────────────────────────────

/** พารามิเตอร์ที่ bind ได้ (ห้ามต่อสตริงค่าเข้า SQL เอง — ใช้ named parameter เสมอ) */
export type ErpQueryParam = string | number | boolean | Date | null;
export type ErpQueryParams = Readonly<Record<string, ErpQueryParam>>;

/**
 * ฐานของทุก ERP driver — จุดเดียวที่ SQL ออกไปหา ERP ได้ คือผ่าน `guardedQuery()` / `guardSql()`
 * driver ลูกห้ามเรียก connection ตรงโดยไม่ผ่านสองตัวนี้
 */
export abstract class BaseErpDriver implements ErpAdapter {
  /** ชื่อ driver สำหรับ log / `ErpHealth.driver` / `sync_runs.driver` — driver ลูกควร override */
  readonly driverName: string = 'erp';

  abstract capabilities(): ErpCapabilities;
  abstract fetchItems(since?: ErpCursor): AsyncIterable<CanonicalItem[]>;
  abstract healthCheck(): Promise<ErpHealth>;

  /**
   * ชั้นที่ 2 ของกฎเหล็ก: driver ที่ต่อ DB จริง override เพื่อทำ write-probe ตอน boot
   * (ยิง INSERT ทดสอบ — ถ้าสำเร็จ = ปฏิเสธการ start) + charset smoke test
   * default = ไม่ทำอะไร (เช่น mock driver)
   */
  init(): Promise<void> {
    return Promise.resolve();
  }

  /** ปิด pool/connection ตอน shutdown — default ไม่ทำอะไร */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** ตรวจแล้วคืน SQL เดิม สำหรับกรณีที่ driver ต้องส่งเข้า request/stream ของตัวเอง */
  protected guardSql(sql: string): string {
    assertReadOnlySql(sql);
    return sql;
  }

  /** ทางเดียวที่อนุญาตให้ query ERP — ตรวจ read-only ก่อนส่งออกทุกครั้ง */
  protected async guardedQuery<TRow extends object>(
    sql: string,
    params: ErpQueryParams = {},
  ): Promise<TRow[]> {
    assertReadOnlySql(sql);
    return this.executeQuery<TRow>(sql, params);
  }

  /**
   * ส่ง SQL ที่ผ่าน guard แล้วเข้า connection จริง — override ใน driver ที่ต่อ DB
   * ⚠️ ห้าม override ให้ข้าม `guardedQuery()` และห้ามเปิด transaction เขียน
   */
  protected executeQuery<TRow extends object>(
    _sql: string,
    _params: ErpQueryParams,
  ): Promise<TRow[]> {
    return Promise.reject(
      new Error(`driver "${this.driverName}" ไม่รองรับการ query SQL (ไม่ได้ implement executeQuery)`),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. DI token + factory
// ────────────────────────────────────────────────────────────────────────────

/** DI token ของ adapter (ตัวเดียวต่อ process — สร้างตาม `ERP_DRIVER` ตอน boot) */
export const ERP_ADAPTER: unique symbol = Symbol('ERP_ADAPTER');

/** ผู้สร้าง driver ตามค่าใน `.env` — คืน adapter ที่ read-only เท่านั้น */
export interface ErpDriverFactory {
  readonly kind: ErpDriverKind;
  create(): ErpAdapter | Promise<ErpAdapter>;
}

// ────────────────────────────────────────────────────────────────────────────
// 6. zod schema — ตรวจข้อมูลจาก ERP ก่อนเข้า domain (ERP = ข้อมูลภายนอก)
//    driver map แถวดิบ → canonical (trim/decode/dedupe) แล้วค่อย parse ด้วย schema นี้
// ────────────────────────────────────────────────────────────────────────────

const nonEmptyString = z.string().min(1);

export const canonicalItemSchema = z.object({
  sku: nonEmptyString,
  name: nonEmptyString,
  nameEn: z.string().optional(),
  barcodes: z.array(nonEmptyString),
  loc: z.string().optional(),
  unit: nonEmptyString,
  onHand: z.number().finite().optional(),
  reserved: z.number().finite().optional(),
  rop: z.number().finite().optional(),
  vendor: z.string().optional(),
  lot: z.string().optional(),
  lastCountDate: z.date().optional(),
  updatedAt: z.date().optional(),
  warehouseCode: z.string().optional(),
});

/** true เมื่อ schema กับ interface ตรงกันทั้งสองทาง ไม่ตรง = never */
type SchemaMatchesType<TSchema extends z.ZodTypeAny, TType> = [z.infer<TSchema>] extends [TType]
  ? [TType] extends [z.infer<TSchema>]
    ? true
    : never
  : never;

/** ตัวจับ drift ตอน compile: แก้ interface แล้วลืมแก้ schema (หรือกลับกัน) = compile ไม่ผ่าน */
export const ERP_SCHEMAS_IN_SYNC: [
  SchemaMatchesType<typeof canonicalItemSchema, CanonicalItem>,
] = [true];
