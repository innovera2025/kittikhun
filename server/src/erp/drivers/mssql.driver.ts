import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';
import { z } from 'zod';

import type { AppConfig } from '../../config/env.config';
import {
  assertReadOnlySql,
  BaseErpDriver,
  type CanonicalItem,
  type Cursor,
  type ErpCountRow,
  type ErpCountSession,
  type ErpCountSessionSummary,
} from '../erp-adapter';

/**
 * ERP driver: Microsoft SQL Server 2019 · database `db_TCL` · collation `Thai_CI_AS`
 *
 * 🚫 กฎเหล็ก: ERP เป็นแหล่ง **อ่านอย่างเดียว** — ไม่มี method เขียนในคลาสนี้ และทุก
 *    statement ที่วิ่งเข้า connection ของ ERP ต้องผ่าน assertReadOnlySql() ก่อนเสมอ
 *    (ข้อยกเว้นเดียว = write-probe ตอน boot ที่มีไว้เพื่อ *กัน* การเขียน — ดู verifyReadOnly())
 *
 * ข้อเท็จจริงของ ERP จริงที่ driver นี้ยึด (docs/erp-tcl-findings.md):
 *  - item master = `dbo.InventoryItem` · PK = (Roworder, ItemCode) → **ItemCode ซ้ำได้**
 *    → กติกา: Roworder สูงสุดชนะ (ทำด้วย ROW_NUMBER() ใน SQL / ในหน่วยความจำสำหรับ script)
 *  - ไม่มีตารางยอดคงเหลือสำเร็จรูป → ยอดระบบที่เชื่อถือได้คือ `tbl_CountDtl.MainQty` ในรอบนับ
 *  - รอบนับ = `dbo.tbl_CountHdr` + `dbo.tbl_CountDtl` join ด้วย TransactionNo
 *    `tbl_CountHdr` PK = (Roworder, TransactionNo) → **VoucherNo/TransactionNo ซ้ำได้** → dedupe เช่นกัน
 *  - คอลัมน์ nvarchar ถูก pad ช่องว่าง → LTRIM/RTRIM ทุกคอลัมน์ข้อความ
 *  - คลังจริง: WHRM / WHFG / WHWIP / WHNG (ไม่ใช่ WH-BKK-02 ที่ design เดิมสมมติไว้)
 */

const logger = new Logger('MssqlDriver');

const DRIVER_NAME = 'sql';

/** ขนาด batch ของ AsyncIterable ตามสัญญา adapter */
const ITEM_BATCH_SIZE = 500;
/** กันลูป pagination วิ่งไม่จบถ้า ERP ตอบแปลก */
const MAX_ITEM_PAGES = 2000;

const DEFAULT_ITEMS_TABLE = 'dbo.InventoryItem';
const COUNT_HDR_TABLE = 'dbo.tbl_CountHdr';
const COUNT_DTL_TABLE = 'dbo.tbl_CountDtl';

/** ตารางชั่วคราวของ write-probe (ชั้นที่ 2 ของกฎเหล็ก) — ต้องไม่มีอยู่จริงใน ERP */
const PROBE_TABLE = 'dbo.__kittikhun_probe';

/** คลังที่พบจริงใน db_TCL — ใช้เตือน schema/config drift เท่านั้น ไม่ใช่ตัวกรองข้อมูล */
const KNOWN_WAREHOUSES: readonly string[] = ['WHRM', 'WHFG', 'WHWIP', 'WHNG'];

/** ชื่อ object ที่ยอมให้ประกอบเข้า SQL ได้ (config เท่านั้น ไม่ใช่ input ผู้ใช้) */
const SQL_IDENTIFIER_RE = /^\[?[A-Za-z_][\w$#]*\]?(\.\[?[A-Za-z_][\w$#]*\]?){0,2}$/;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type MssqlDriverErrorCode =
  | 'ERP_CONFIG' // .env / ไฟล์ .sql ผิด — ผู้ดูแลต้องแก้ก่อน start
  | 'ERP_WRITE_ALLOWED' // 🚨 login เขียน ERP ได้ — ปฏิเสธการ start
  | 'ERP_PROBE_INCONCLUSIVE' // probe ไม่สามารถสรุปได้ว่าเขียนไม่ได้
  | 'ERP_UNREACHABLE' // ต่อไม่ได้/ล็อกอินไม่ผ่าน — ไม่ควร block การ start (degraded)
  | 'ERP_THAI_DECODE' // ข้อความไทยเพี้ยน → charset ผิด
  | 'ERP_SCHEMA_DRIFT' // คอลัมน์/ชนิดข้อมูลเปลี่ยน
  | 'ERP_QUERY'; // query ล้มเหลวด้วยเหตุอื่น

export class MssqlDriverError extends Error {
  constructor(
    readonly code: MssqlDriverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MssqlDriverError';
  }
}

// ---------------------------------------------------------------------------
// zod helpers — ข้อมูลจาก ERP คือข้อมูลภายนอก ต้อง validate ทุกแถว
// ---------------------------------------------------------------------------

/** ข้อความจาก ERP: trim ช่องว่างที่ pad มา · ค่าว่าง/NULL → undefined (ไม่ใช่ '') */
const zTextOpt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  });

const zTextReq = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((text) => text.length > 0, { message: 'ค่าว่าง' });

const zNumOpt = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value, ctx) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim().length === 0) return undefined;
    const num = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(num)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ไม่ใช่ตัวเลข' });
      return z.NEVER;
    }
    return num;
  });

const zNumReq = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const num = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(num)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ไม่ใช่ตัวเลข' });
    return z.NEVER;
  }
  return num;
});

/** วันที่จาก ERP เป็น ค.ศ. (ยืนยันแล้ว: CountDate 17/08/2026) → ไม่ต้องแปลง พ.ศ. */
const zDateOpt = z
  .union([z.date(), z.string(), z.number(), z.null(), z.undefined()])
  .transform((value, ctx) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim().length === 0) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'วันที่ไม่ถูกต้อง' });
      return z.NEVER;
    }
    return date.toISOString();
  });

/** ฟิลด์สินค้าหลัง pick ชื่อคอลัมน์แล้ว (รองรับทั้งชื่อ ERP และ snake_case จาก script) */
const ItemFieldsSchema = z.object({
  sku: zTextReq,
  name: zTextReq,
  nameEn: zTextOpt,
  unit: zTextOpt,
  loc: zTextOpt,
  lot: zTextOpt,
  rop: zNumOpt,
  onHand: zNumOpt,
  barcodeUnits: zTextOpt,
  barcodePack: zTextOpt,
  roworder: zNumOpt,
  warehouse: zTextOpt,
});

/** หัวรอบนับจาก dbo.tbl_CountHdr (alias ตาม SQL ในไฟล์นี้) */
const CountHeaderRowSchema = z.object({
  TransactionNo: zTextReq,
  VoucherNo: zTextOpt,
  CountDate: zDateOpt,
  EmpId: zTextOpt,
  CountNo: zTextOpt,
  CountYear: zTextOpt,
  Roworder: zNumOpt,
  LineCount: zNumOpt,
});

/** รายการนับจาก dbo.tbl_CountDtl */
const CountLineRowSchema = z.object({
  ItemCode: zTextReq,
  Description: zTextOpt,
  Warehouse: zTextOpt,
  MainQty: zNumReq, // ยอดระบบที่ ERP freeze ไว้ — ไม่มี NULL (ยืนยันจากข้อมูลจริง)
  MainUnits: zTextOpt,
  ErpCountQty: zNumOpt,
  ErpDifQty: zNumOpt,
});

// ---------------------------------------------------------------------------
// รูปร่างข้อมูลรอบนับที่ driver ส่งออก (canonical types อยู่ที่ ../erp-adapter)
// ---------------------------------------------------------------------------

interface MssqlSessionSummary {
  /** คีย์ที่ใช้ join กับ tbl_CountDtl */
  readonly transactionNo: string;
  readonly voucherNo?: string;
  /** ISO 8601 (ค.ศ.) */
  readonly countDate?: string;
  readonly countNo?: string;
  readonly countYear?: string;
  readonly empId?: string;
  /** Roworder ที่ชนะการ dedupe — เก็บไว้ตรวจย้อนหลัง */
  readonly erpRoworder?: number;
  readonly lineCount?: number;
}

interface MssqlCountLine {
  readonly sku: string;
  readonly description?: string;
  readonly warehouseCode?: string;
  readonly unit?: string;
  /** ยอดระบบจาก tbl_CountDtl.MainQty (freeze แล้วฝั่ง ERP) */
  readonly systemQty: number;
  /**
   * ⚠️ ค่าที่ ERP เคยนับไว้ — **ห้ามใช้เป็นผลนับของระบบเรา** ระบบนี้เก็บผลนับเอง
   * (count_submissions → closed_variance) ค่าสองตัวนี้อ่านมาเป็นข้อมูลอ้างอิง/ประวัติเท่านั้น
   */
  readonly erpReferenceCountQty?: number;
  readonly erpReferenceDifQty?: number;
}

interface MssqlCountSession extends MssqlSessionSummary {
  readonly rows: readonly MssqlCountLine[];
  /** คลังที่พบในรายการนับรอบนี้ (ERP เก็บคลังที่ระดับรายการ ไม่ใช่ที่หัวเอกสาร) */
  readonly warehouseCodes: readonly string[];
}


// ---------------------------------------------------------------------------
// map internal (ละเอียดตาม ERP) → canonical ที่ domain เห็น
// ---------------------------------------------------------------------------

/** ISO string ของ ERP → Date; ไม่มีค่า = epoch 0 เพื่อคง contract ว่า countDate ต้องมี */
function toCanonicalDate(iso?: string): Date {
  if (!iso) return new Date(0);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function toCanonicalSummary(s: MssqlSessionSummary): ErpCountSessionSummary {
  return {
    transactionNo: s.transactionNo,
    voucherNo: s.voucherNo,
    countDate: toCanonicalDate(s.countDate),
    employeeId: s.empId,
    rowCount: s.lineCount,
  };
}

function toCanonicalRow(l: MssqlCountLine, fallbackWarehouse: string): ErpCountRow {
  return {
    sku: l.sku,
    description: l.description ?? '',
    warehouse: l.warehouseCode ?? fallbackWarehouse,
    systemQty: l.systemQty,
    unit: l.unit ?? '',
  };
}

function toCanonicalSession(
  s: MssqlCountSession,
  fallbackWarehouse: string,
): ErpCountSession {
  return {
    ...toCanonicalSummary(s),
    // ERP เก็บคลังที่ระดับรายการ — ถ้ารอบนับใช้คลังเดียว ประทับที่หัวเอกสารด้วย
    warehouse: s.warehouseCodes.length === 1 ? s.warehouseCodes[0] : undefined,
    rows: s.rows.map((l) => toCanonicalRow(l, fallbackWarehouse)),
  };
}

// ---------------------------------------------------------------------------
// charset ไทย
// ---------------------------------------------------------------------------

type ThaiCharset = 'utf8' | 'win874' | 'tis620';

/** ไบต์พิเศษของ Windows-874 ที่ไม่ได้อยู่ในบล็อก Thai */
const CP874_SPECIALS: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x85: 0x2026,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
};

function cp874ByteToCodePoint(byte: number): number {
  if (byte < 0x80) return byte;
  const special = CP874_SPECIALS[byte];
  if (special !== undefined) return special;
  // ช่วงไทยของ CP874/TIS-620 แม็ปตรงเข้าบล็อก Thai: 0xA1→U+0E01 … 0xFB→U+0E5B (offset 0x0D60)
  if ((byte >= 0xa1 && byte <= 0xda) || (byte >= 0xdf && byte <= 0xfb)) {
    return byte + 0x0d60;
  }
  return 0xfffd; // ไบต์ที่ไม่มีในตาราง → U+FFFD ให้ smoke test จับได้
}

function decodeCp874(buf: Buffer): string {
  let out = '';
  for (const byte of buf) out += String.fromCodePoint(cp874ByteToCodePoint(byte));
  return out;
}

/** ช่วง Thai Unicode U+0E01–U+0E5B */
const THAI_BLOCK_RE = /[\u0E01-\u0E5B]/;
/** U+FFFD — สัญญาณว่า decode ผิด charset */
const REPLACEMENT_CHAR = '\uFFFD';

/**
 * แปลงค่าที่ได้จาก driver ให้เป็นสตริงไทยที่ถูกต้อง
 * - NVARCHAR (`ERP_SQL_CHARSET=utf8`) = Unicode อยู่แล้ว ใช้ค่าตรง ๆ
 * - VARCHAR + Thai collation (`win874`/`tis620`) = ถ้า tedious คืน Buffer หรือ decode มาเป็น
 *   latin1 ให้ม้วนกลับเป็นไบต์แล้วแม็ปด้วยตาราง CP874 (ถ้ามีอักษรไทยอยู่แล้ว = ถูกต้อง ไม่แตะ)
 */
function decodeThai(value: unknown, charset: ThaiCharset): unknown {
  if (Buffer.isBuffer(value)) {
    return charset === 'utf8' ? value.toString('utf8') : decodeCp874(value);
  }
  if (typeof value !== 'string' || charset === 'utf8') return value;
  if (THAI_BLOCK_RE.test(value)) return value;
  return decodeCp874(Buffer.from(value, 'latin1'));
}

// ---------------------------------------------------------------------------
// utility
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readProp(err: unknown, key: string): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as Record<string, unknown>)[key];
}

/** ข้อความของ error ทั้งชั้นนอกและ originalError ของ tedious */
function allMessages(err: unknown): string {
  const inner = readProp(err, 'originalError');
  return `${errMessage(err)} ${inner ? errMessage(inner) : ''}`;
}

const PERMISSION_DENIED_NUMBERS = new Set([229, 230, 262, 297, 300, 3906, 15247]);
const PERMISSION_DENIED_RE =
  /permission (?:was )?denied|permission to perform|does not have permission|read[- ]only|ไม่มีสิทธิ/i;
const CONNECTION_ERROR_CODES = new Set([
  'ELOGIN',
  'ESOCKET',
  'ETIMEOUT',
  'ECONNCLOSED',
  'ENOTOPEN',
  'EINSTLOOKUP',
  'EDRIVER',
]);

function isConnectionError(err: unknown): boolean {
  const code = readProp(err, 'code');
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

/** ตารางทดสอบค้างจากรอบก่อน (error 2714) — ไม่ใช่คำตอบเรื่องสิทธิ์ ต้องลอง INSERT ต่อ */
function isAlreadyExists(err: unknown): boolean {
  const num = readProp(err, 'number');
  if (typeof num === 'number' && num === 2714) return true;
  return /already an object named|already exists/i.test(allMessages(err));
}

/** SQL Server ปฏิเสธสิทธิ์ = สิ่งที่ write-probe ต้องการเห็น */
function isPermissionDenied(err: unknown): boolean {
  const num = readProp(err, 'number');
  if (typeof num === 'number' && PERMISSION_DENIED_NUMBERS.has(num)) return true;
  const innerNum = readProp(readProp(err, 'originalError'), 'number');
  if (typeof innerNum === 'number' && PERMISSION_DENIED_NUMBERS.has(innerNum)) return true;
  return PERMISSION_DENIED_RE.test(allMessages(err));
}

function* chunk<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** อ่านค่าจากแถวแบบไม่สนตัวพิมพ์ใหญ่-เล็ก (script ของเจ้าของโปรเจคอาจตั้งชื่อคอลัมน์คนละสไตล์) */
function rowGetter(row: Record<string, unknown>): (...names: string[]) => unknown {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) lower.set(key.toLowerCase(), value);
  return (...names: string[]): unknown => {
    for (const name of names) {
      const value = lower.get(name.toLowerCase());
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
}

/**
 * แปลงค่าจาก ERP เป็น string เฉพาะเมื่อเป็น scalar จริง ๆ
 *
 * ⚠️ `String(unknown)` กับ object จะได้ `'[object Object]'` ซึ่งดู "มีค่า" ทั้งที่ไม่มี
 *    ถ้าปล่อยให้ค่านั้นกลายเป็นรหัสสินค้า จะมีสินค้าผีไหลเข้า items_cache
 *    → คืน '' เพื่อให้ผู้เรียกถือว่า "ไม่มีค่า" แล้วข้ามแถวไป
 */
function asScalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function pickItemFields(row: Record<string, unknown>): Record<string, unknown> {
  const get = rowGetter(row);
  return {
    sku: get('ItemCode', 'sku', 'item_code'),
    name: get('ItemName', 'name', 'item_name'),
    nameEn: get('ItemNameEng', 'name_en', 'nameEn'),
    unit: get('MainUnits', 'unit', 'main_units'),
    loc: get('Shelf', 'loc', 'location', 'shelf'),
    lot: get('LotNumber', 'lot', 'lot_number'),
    rop: get('MinStock', 'rop', 'min_stock', 'reorder_point'),
    // ยอดคงเหลือ: `dbo.InventoryItem` ไม่มีค่าที่ใช้ได้ (BalStock ตรงกับ ledger 0/56)
    // → มาจาก script ของฝ่าย ERP ที่ SUM(InOut × MainQuantity) จาก InventoryFlowDtl
    // 'Balqty' คือชื่อคอลัมน์ในสูตรต้นฉบับ — รับไว้ด้วยเผื่อ script ไม่ได้ alias เป็น on_hand
    onHand: get('on_hand', 'onHand', 'Balqty', 'BalQty'),
    barcodeUnits: get('BarCodeUnits', 'barcode', 'bar_code_units'),
    barcodePack: get('BarCodePack', 'barcode_pack', 'bar_code_pack'),
    roworder: get('Roworder', 'roworder'),
    warehouse: get('Warehouse', 'warehouse_code', 'warehouseCode'),
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'ไม่ผ่าน validation';
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const zBoolLike = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
});

const zIntLike = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const num = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(num) || num <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ต้องเป็นจำนวนเต็มบวก' });
    return z.NEVER;
  }
  return num;
});

const zSqlIdentifier = z
  .string()
  .trim()
  .regex(SQL_IDENTIFIER_RE, 'ต้องเป็นชื่อแบบ schema.object เท่านั้น (ห้ามมีช่องว่าง, ; หรือคำสั่ง SQL)');

/**
 * zod ซ้ำอีกชั้นเฉพาะ subset ของ driver นี้ — env.config ตรวจตอน boot แล้ว
 * แต่ driver ต้องพิสูจน์เองว่าค่าที่ได้ใช้ต่อ SQL Server ได้จริง (fail fast + บอกชื่อตัวแปร)
 */
const DriverEnvSchema = z.object({
  ERP_SQL_HOST: z.string().trim().min(1),
  ERP_SQL_PORT: zIntLike.default(1433),
  ERP_SQL_USER: z.string().min(1),
  ERP_SQL_PASSWORD: z.string().min(1),
  ERP_SQL_DATABASE: z.string().trim().min(1),
  ERP_SQL_ENCRYPT: zBoolLike.default(false),
  ERP_SQL_TRUST_SERVER_CERT: zBoolLike.default(true),
  ERP_TIMEOUT_MS: zIntLike.default(15_000),
  ERP_SQL_POOL_MAX: zIntLike.default(3),
  ERP_SQL_CHARSET: z.enum(['utf8', 'win874', 'tis620']).default('utf8'),
  ERP_SQL_ITEMS_VIEW: zSqlIdentifier.optional(),
  ERP_SQL_ITEMS_SQL_FILE: z.string().trim().min(1).optional(),
  WAREHOUSE_CODE: z.string().trim().min(1),
});

interface MssqlDriverConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly encrypt: boolean;
  readonly trustServerCert: boolean;
  readonly timeoutMs: number;
  readonly poolMax: number;
  readonly charset: ThaiCharset;
  readonly itemsTable: string;
  readonly itemsSqlFile?: string;
  readonly warehouseCode: string;
}

function readDriverConfig(cfg: ConfigService<AppConfig, true>): MssqlDriverConfig {
  const parsed = DriverEnvSchema.safeParse({
    ERP_SQL_HOST: cfg.get('ERP_SQL_HOST', { infer: true }),
    ERP_SQL_PORT: cfg.get('ERP_SQL_PORT', { infer: true }),
    ERP_SQL_USER: cfg.get('ERP_SQL_USER', { infer: true }),
    ERP_SQL_PASSWORD: cfg.get('ERP_SQL_PASSWORD', { infer: true }),
    ERP_SQL_DATABASE: cfg.get('ERP_SQL_DATABASE', { infer: true }),
    ERP_SQL_ENCRYPT: cfg.get('ERP_SQL_ENCRYPT', { infer: true }),
    ERP_SQL_TRUST_SERVER_CERT: cfg.get('ERP_SQL_TRUST_SERVER_CERT', { infer: true }),
    ERP_TIMEOUT_MS: cfg.get('ERP_TIMEOUT_MS', { infer: true }),
    ERP_SQL_POOL_MAX: cfg.get('ERP_SQL_POOL_MAX', { infer: true }),
    ERP_SQL_CHARSET: cfg.get('ERP_SQL_CHARSET', { infer: true }),
    ERP_SQL_ITEMS_VIEW: cfg.get('ERP_SQL_ITEMS_VIEW', { infer: true }),
    ERP_SQL_ITEMS_SQL_FILE: cfg.get('ERP_SQL_ITEMS_SQL_FILE', { infer: true }),
    WAREHOUSE_CODE: cfg.get('WAREHOUSE_CODE', { infer: true }),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new MssqlDriverError(
      'ERP_CONFIG',
      `คอนฟิก ERP driver "sql" ไม่ถูกต้อง — แก้ไฟล์ .env ตามนี้:\n${detail}`,
    );
  }

  const env = parsed.data;
  return {
    host: env.ERP_SQL_HOST,
    port: env.ERP_SQL_PORT,
    user: env.ERP_SQL_USER,
    password: env.ERP_SQL_PASSWORD,
    database: env.ERP_SQL_DATABASE,
    encrypt: env.ERP_SQL_ENCRYPT,
    trustServerCert: env.ERP_SQL_TRUST_SERVER_CERT,
    timeoutMs: env.ERP_TIMEOUT_MS,
    poolMax: env.ERP_SQL_POOL_MAX,
    charset: env.ERP_SQL_CHARSET,
    itemsTable: env.ERP_SQL_ITEMS_VIEW ?? DEFAULT_ITEMS_TABLE,
    itemsSqlFile: env.ERP_SQL_ITEMS_SQL_FILE,
    warehouseCode: env.WAREHOUSE_CODE,
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * item master แบบ dedupe แล้ว
 * ⚠️ ItemCode ซ้ำได้ (85 รหัส / 172 แถว) → ROW_NUMBER() เอา Roworder สูงสุด (รายการใหม่สุด) ชนะ
 * LTRIM/RTRIM ทุกคอลัมน์ข้อความเพราะ ERP pad ช่องว่าง
 */
function itemsPageSql(itemsTable: string): string {
  return `WITH ranked AS (
  SELECT
    LTRIM(RTRIM(ItemCode))    AS ItemCode,
    LTRIM(RTRIM(ItemName))    AS ItemName,
    LTRIM(RTRIM(ItemNameEng)) AS ItemNameEng,
    LTRIM(RTRIM(MainUnits))   AS MainUnits,
    MinStock                  AS MinStock,
    LTRIM(RTRIM(BarCodeUnits)) AS BarCodeUnits,
    LTRIM(RTRIM(BarCodePack))  AS BarCodePack,
    LTRIM(RTRIM(Shelf))       AS Shelf,
    LTRIM(RTRIM(LotNumber))   AS LotNumber,
    Roworder                  AS Roworder,
    ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(ItemCode)) ORDER BY Roworder DESC) AS rn
  FROM ${itemsTable}
  WHERE IsActive = 1 AND IsStock = 1
)
SELECT ItemCode, ItemName, ItemNameEng, MainUnits, MinStock,
       BarCodeUnits, BarCodePack, Shelf, LotNumber, Roworder
FROM ranked
WHERE rn = 1
ORDER BY ItemCode
OFFSET @offset ROWS FETCH NEXT @batch ROWS ONLY`;
}

/**
 * หัวรอบนับแบบ dedupe แล้ว
 * ⚠️ tbl_CountHdr PK = (Roworder, TransactionNo) → TransactionNo/VoucherNo ซ้ำได้
 *    → เอา Roworder สูงสุดต่อ TransactionNo
 */
const COUNT_HEADER_CTE = `WITH ranked AS (
  SELECT
    LTRIM(RTRIM(h.TransactionNo)) AS TransactionNo,
    LTRIM(RTRIM(h.VoucherNo))     AS VoucherNo,
    h.CountDate                   AS CountDate,
    LTRIM(RTRIM(h.Emp_ID))        AS EmpId,
    h.CountNo                     AS CountNo,
    h.CountYear                   AS CountYear,
    h.Roworder                    AS Roworder,
    ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(h.TransactionNo)) ORDER BY h.Roworder DESC) AS rn
  FROM ${COUNT_HDR_TABLE} AS h
)`;

const COUNT_SESSIONS_SQL = `${COUNT_HEADER_CTE}
SELECT
  r.TransactionNo, r.VoucherNo, r.CountDate, r.EmpId, r.CountNo, r.CountYear, r.Roworder,
  (SELECT COUNT(*) FROM ${COUNT_DTL_TABLE} AS d
    WHERE LTRIM(RTRIM(d.TransactionNo)) = r.TransactionNo) AS LineCount
FROM ranked AS r
WHERE r.rn = 1
ORDER BY r.CountDate DESC, r.VoucherNo DESC`;

const COUNT_SESSION_SQL = `${COUNT_HEADER_CTE}
SELECT r.TransactionNo, r.VoucherNo, r.CountDate, r.EmpId, r.CountNo, r.CountYear, r.Roworder
FROM ranked AS r
WHERE r.rn = 1 AND r.TransactionNo = @transactionNo`;

/**
 * รายการนับของรอบหนึ่ง
 * systemQty = MainQty (ยอดระบบที่ ERP freeze ไว้ ไม่มี NULL)
 * ⚠️ CountQty/DifQty ดึงมาเป็น "ข้อมูลอ้างอิง" เท่านั้น — ผลนับของระบบเราเก็บใน Postgres ของเราเอง
 */
const COUNT_LINES_SQL = `SELECT
  LTRIM(RTRIM(d.ItemCode))    AS ItemCode,
  LTRIM(RTRIM(d.Description)) AS Description,
  LTRIM(RTRIM(d.Warehouse))   AS Warehouse,
  d.MainQty                   AS MainQty,
  LTRIM(RTRIM(d.MainUnits))   AS MainUnits,
  d.CountQty                  AS ErpCountQty,
  d.DifQty                    AS ErpDifQty
FROM ${COUNT_DTL_TABLE} AS d
WHERE LTRIM(RTRIM(d.TransactionNo)) = @transactionNo
ORDER BY LTRIM(RTRIM(d.ItemCode))`;

/** smoke test ภาษาไทย — อ่านจากตาราง item master จริงของ db_TCL */
const THAI_SAMPLE_SQL = `SELECT TOP (1) LTRIM(RTRIM(ItemName)) AS SampleText
FROM ${DEFAULT_ITEMS_TABLE}
WHERE ItemName IS NOT NULL AND LTRIM(RTRIM(ItemName)) <> ''
ORDER BY Roworder DESC`;

type SqlParams = Readonly<Record<string, string | number | Date>>;

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export class MssqlDriver extends BaseErpDriver {
  private readonly sqlCfg: MssqlDriverConfig;
  private poolPromise?: Promise<sql.ConnectionPool>;
  private itemsSqlCache?: string;
  private readOnlyVerified = false;

  constructor(cfg: ConfigService<AppConfig, true>) {
    super();
    this.sqlCfg = readDriverConfig(cfg);

    if (!KNOWN_WAREHOUSES.includes(this.sqlCfg.warehouseCode)) {
      logger.warn(
        `WAREHOUSE_CODE=${this.sqlCfg.warehouseCode} ไม่ตรงกับคลังที่พบจริงใน db_TCL ` +
          `(${KNOWN_WAREHOUSES.join(' / ')}) — ตรวจ .env ก่อนใช้งานจริง`,
      );
    }
  }

  /** ERP นี้ไม่มี updated-at ที่เชื่อถือได้ → full snapshot + diff ฝั่ง server เท่านั้น */
  capabilities() {
    return { delta: false as const };
  }

  /**
   * ลำดับ boot ของ driver (เรียกจาก ErpModule):
   * 1. เชื่อมต่อ pool
   * 2. ชั้นที่ 2 ของกฎเหล็ก — พิสูจน์ว่า login เขียน ERP ไม่ได้ (ไม่ผ่าน = ไม่ start)
   * 3. smoke test ภาษาไทย
   */
  async init(): Promise<void> {
    await this.getPool();
    await this.verifyReadOnly();
    await this.verifyThaiText();
  }

  async close(): Promise<void> {
    const pending = this.poolPromise;
    this.poolPromise = undefined;
    this.readOnlyVerified = false;
    if (!pending) return;
    const pool = await pending.catch(() => undefined);
    await pool?.close().catch((err: unknown) => {
      logger.warn(`ปิด connection pool ของ ERP ไม่สำเร็จ: ${errMessage(err)}`);
    });
  }

  /**
   * 🚨 ชั้นที่ 2 ของกฎเหล็ก — **write-probe: จุดเดียวในระบบที่ยอมให้ "พยายามเขียน" ERP**
   *
   * เจตนาของ probe นี้คือ **กัน** การเขียน ไม่ใช่การเขียน: ถ้า SQL Server ยอมให้สร้าง
   * ตาราง/INSERT ได้ แปลว่า login ที่คอนฟิกไว้มีสิทธิ์เขียน ERP (เช่นเผลอใส่ `sa`) ซึ่งขัด
   * หลักการของโปรเจค → ปฏิเสธการ start ทันที เพื่อไม่ให้ระบบวิ่งอยู่บนสิทธิ์ที่ทำลาย ERP ได้
   *
   * ด้วยเหตุนี้ statement ในเมธอดนี้จึง **ไม่** ผ่าน assertReadOnlySql() (guard นั้นจะปฏิเสธ
   * มันแน่นอน) — และเป็นข้อยกเว้นที่อนุญาตเฉพาะที่นี่ ห้ามคัดลอกรูปแบบนี้ไปใช้ที่อื่น
   *
   * ผลลัพธ์: ถูกปฏิเสธสิทธิ์ = ✅ ผ่าน · เขียนได้ = 🚨 throw · สรุปไม่ได้ = throw ให้ผู้ดูแลตรวจ
   */
  async verifyReadOnly(): Promise<void> {
    const pool = await this.getPool();

    let tableCreated = false;
    let tableExisted = false;
    let rowInserted = false;
    let refusal: unknown;

    try {
      await pool.request().batch(`CREATE TABLE ${PROBE_TABLE} (probed_at DATETIME2 NOT NULL)`);
      tableCreated = true;
    } catch (err) {
      // ตารางค้างจากรอบก่อน: ยังต้องลอง INSERT เพื่อรู้ว่า login ปัจจุบันเขียนได้จริงไหม
      if (isAlreadyExists(err)) tableExisted = true;
      else refusal = err;
    }

    if (tableCreated || tableExisted) {
      try {
        await pool
          .request()
          .batch(`INSERT INTO ${PROBE_TABLE} (probed_at) VALUES (SYSUTCDATETIME())`);
        rowInserted = true;
      } catch (err) {
        refusal = err;
      }
    }

    // ถ้าเผลอสร้างได้/มีตารางค้าง ต้องพยายามเก็บกวาดคืนให้สะอาดก่อนตัดสินผล — ห้ามทิ้งขยะไว้ใน ERP
    let cleanupError: string | undefined;
    if (tableCreated || tableExisted) {
      try {
        await pool.request().batch(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
      } catch (err) {
        cleanupError = errMessage(err);
      }
    }

    if (tableCreated || rowInserted) {
      const leftover = cleanupError
        ? ` ⚠️ ลบตารางทดสอบ ${PROBE_TABLE} คืนไม่สำเร็จ (${cleanupError}) — ต้องลบด้วยมือ`
        : ` (ลบตารางทดสอบ ${PROBE_TABLE} คืนแล้ว)`;
      throw new MssqlDriverError(
        'ERP_WRITE_ALLOWED',
        `🚨 ปฏิเสธการ start: login ERP_SQL_USER="${this.sqlCfg.user}" **เขียนฐานข้อมูล ERP ` +
          `${this.sqlCfg.database} ได้** (${tableCreated ? 'CREATE TABLE' : 'INSERT'} สำเร็จ)` +
          `${leftover}\n` +
          'ระบบนี้อ่าน ERP อย่างเดียวเท่านั้น — ให้สร้าง login ใหม่ที่มีสิทธิ์เฉพาะ ' +
          '`db_datareader` (หรือ GRANT SELECT เฉพาะ object ที่ใช้) แล้วแก้ ERP_SQL_USER / ' +
          'ERP_SQL_PASSWORD ใน .env · ห้ามใช้ `sa`',
      );
    }

    if (isConnectionError(refusal)) {
      throw new MssqlDriverError(
        'ERP_UNREACHABLE',
        `ต่อ ERP (${this.sqlCfg.host}:${this.sqlCfg.port}/${this.sqlCfg.database}) ไม่ได้ ` +
          `จึงยังพิสูจน์สิทธิ์ read-only ไม่ได้: ${errMessage(refusal)}`,
      );
    }

    if (!isPermissionDenied(refusal)) {
      throw new MssqlDriverError(
        'ERP_PROBE_INCONCLUSIVE',
        'write-probe ไม่สามารถสรุปได้ว่า login เขียน ERP ไม่ได้ — การเขียนล้มเหลวด้วยเหตุอื่น ' +
          `ที่ไม่ใช่ "permission denied": ${errMessage(refusal)} · ` +
          'ตรวจสิทธิ์ของ ERP_SQL_USER (ต้องเป็น db_datareader) แล้วลองใหม่',
      );
    }

    if (tableExisted) {
      logger.warn(
        `พบตารางทดสอบค้างอยู่ใน ERP: ${PROBE_TABLE} ` +
          `(${cleanupError ? `ลบคืนไม่สำเร็จ: ${cleanupError}` : 'ลบคืนแล้ว'}) — ` +
          'แปลว่าเคยมี login ที่เขียนได้ ควรตรวจสิทธิ์ย้อนหลัง',
      );
    }

    this.readOnlyVerified = true;
    logger.log(
      `✅ พิสูจน์แล้ว: login "${this.sqlCfg.user}" เขียน ${this.sqlCfg.database} ไม่ได้ ` +
        `(SQL Server ปฏิเสธสิทธิ์) — ERP อ่านอย่างเดียว`,
    );
  }

  /**
   * smoke test ภาษาไทย: ดึงชื่อสินค้าไทย 1 แถว แล้วตรวจว่า decode ถูก
   * ผิด charset → ข้อมูลไทยจะเพี้ยนเงียบ ๆ ทั้งระบบ จึง fail ทันทีพร้อมบอกตัวแปรที่ต้องแก้
   */
  async verifyThaiText(): Promise<void> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.runQuery('thai-smoke-test', THAI_SAMPLE_SQL);
    } catch (err) {
      if (err instanceof MssqlDriverError && err.code === 'ERP_UNREACHABLE') throw err;
      logger.warn(
        `ข้าม smoke test ภาษาไทย: ดึงตัวอย่างชื่อสินค้าจาก ${DEFAULT_ITEMS_TABLE} ไม่ได้ — ` +
          errMessage(err),
      );
      return;
    }

    const sample = rows[0]?.['SampleText'];
    if (typeof sample !== 'string' || sample.length === 0) {
      logger.warn('ข้าม smoke test ภาษาไทย: ไม่พบชื่อสินค้าที่มีข้อความให้ตรวจ');
      return;
    }

    if (sample.includes(REPLACEMENT_CHAR)) {
      throw new MssqlDriverError(
        'ERP_THAI_DECODE',
        `ข้อความไทยจาก ERP decode ไม่ได้ (พบ U+FFFD): "${sample}" — ` +
          `ERP_SQL_CHARSET=${this.sqlCfg.charset} น่าจะผิด ` +
          '(NVARCHAR ใช้ utf8 · VARCHAR + Thai collation ใช้ win874)',
      );
    }

    if (!THAI_BLOCK_RE.test(sample)) {
      throw new MssqlDriverError(
        'ERP_THAI_DECODE',
        `ตัวอย่างชื่อสินค้า "${sample}" ไม่มีอักขระในช่วง Thai (U+0E01–U+0E5B) — ` +
          `ERP_SQL_CHARSET=${this.sqlCfg.charset} น่าจะผิด หรือคอลัมน์ ItemName ไม่ใช่ข้อมูลไทย`,
      );
    }

    logger.log(`✅ smoke test ภาษาไทยผ่าน (charset=${this.sqlCfg.charset}): "${sample}"`);
  }

  /** SELECT 1 + วัด latency — ERP ล่มที่นี่ต้องไม่ทำให้ /healthz ของ API เป็น unhealthy */
  async healthCheck() {
    const startedAt = Date.now();
    try {
      await this.runQuery('healthcheck', 'SELECT 1 AS ok');
      return {
        ok: true as const,
        driver: DRIVER_NAME,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false as const,
        driver: DRIVER_NAME,
        latencyMs: Date.now() - startedAt,
        error: errMessage(err),
      };
    }
  }

  /**
   * item master → CanonicalItem เป็น batch ละ 500
   * `since` ถูกละเว้นโดยเจตนา: capabilities().delta === false (ERP ไม่มี updated-at ที่เชื่อถือได้)
   */
  async *fetchItems(since?: Cursor): AsyncIterableIterator<CanonicalItem[]> {
    if (since !== undefined) {
      logger.debug(
        `driver sql ไม่รองรับ delta (delta=false) — ละเว้น since=${String(since)} ` +
          'และดึงแบบ full snapshot',
      );
    }

    const source = this.sqlCfg.itemsSqlFile
      ? this.readItemRowsFromScript(this.sqlCfg.itemsSqlFile)
      : this.readItemRowsFromTable();

    let mapped = 0;
    let skipped = 0;
    for await (const rawBatch of source) {
      const items: CanonicalItem[] = [];
      for (const raw of rawBatch) {
        const result = this.toCanonicalItem(raw);
        if (result.ok) {
          items.push(result.item);
          continue;
        }
        skipped += 1;
        if (skipped <= 3) logger.warn(`ข้ามแถวสินค้าที่ไม่ผ่าน validation — ${result.reason}`);
      }

      // ทุกแถวในหน้าเดียวพังหมด = คอลัมน์เปลี่ยน ไม่ใช่ข้อมูลเสียรายแถว → หยุดรอบนี้
      if (items.length === 0 && rawBatch.length > 0) {
        throw new MssqlDriverError(
          'ERP_SCHEMA_DRIFT',
          `แถวสินค้าทั้ง ${rawBatch.length} แถวไม่ผ่าน validation — คอลัมน์ที่ ERP ส่งมาน่าจะเปลี่ยน ` +
            '(ตรวจ ERP_SQL_ITEMS_VIEW / ERP_SQL_ITEMS_SQL_FILE)',
        );
      }

      mapped += items.length;
      yield items;
    }

    logger.log(`ดึง item master จาก ERP สำเร็จ: ${mapped} รายการ (ข้าม ${skipped} แถว)`);
  }

  /**
   * db_TCL **ไม่มีตารางยอดคงเหลือสำเร็จรูป** (findings §5: BalStock ตรง 0/56,
   * tbl_STOCKSTD เป็นรหัสคนละระบบ) → ไม่มี snapshot สำเร็จรูปให้ดึง
   *
   * ตั้งแต่ 22 ส.ค. 2569 ฝ่าย ERP ส่งสูตรคำนวณยอดจาก ledger มาให้แล้ว
   * (`SUM(InOut × MainQuantity)` จาก InventoryFlowHdr/Dtl) — สูตรนั้นถูกรวมเข้ากับ
   * **query item master** ที่ `sql/erp/inventory-items-with-balance.sql` และไหลเข้าระบบ
   * ทาง `fetchItems()` → `CanonicalItem.onHand` แทน จึงไม่ต้องมีเส้นทาง snapshot แยก
   * (ดึงครั้งเดียวได้ทั้ง master + ยอด = ไม่มีช่วงที่สองแหล่งไม่ตรงกัน)
   *
   * ตั้งใจให้ throw ไม่ใช่คืน list ว่าง: list ว่างจะถูกตีความว่า "ของหมดทุกรายการ"
   * แล้วไป tombstone/ล้างยอดใน items_cache ได้ — รอบ sync ที่ล้มเหลวปลอดภัยกว่าข้อมูลผิด
   */
  fetchStockSnapshot(warehouseCode: string): AsyncIterable<never[]> {
    throw new MssqlDriverError(
      'ERP_CONFIG',
      `ERP db_TCL ไม่มีแหล่งยอดคงเหลือสำเร็จรูปสำหรับคลัง ${warehouseCode} — ` +
        'ยอดคงเหลือมาพร้อม item master แล้ว ตั้ง ERP_SQL_ITEMS_SQL_FILE ให้ชี้ไปที่ ' +
        'sql/erp/inventory-items-with-balance.sql (สูตรจากฝ่าย ERP)',
    );
  }

  /** รายการรอบนับทั้งหมด (dedupe แล้ว) พร้อมจำนวนรายการต่อรอบ */
  async fetchCountSessions(): Promise<ErpCountSessionSummary[]> {
    const rows = await this.runQuery('count-sessions', COUNT_SESSIONS_SQL);
    const sessions: MssqlSessionSummary[] = [];

    for (const row of rows) {
      const parsed = CountHeaderRowSchema.safeParse(row);
      if (!parsed.success) {
        logger.warn(`ข้ามหัวรอบนับที่ไม่ผ่าน validation — ${firstIssue(parsed.error)}`);
        continue;
      }
      sessions.push(toSessionSummary(parsed.data));
    }

    // map internal → canonical ที่ขอบของ adapter
    return sessions.map(toCanonicalSummary);
  }

  /** รอบนับหนึ่งรอบ + รายการนับ (systemQty = MainQty) — ไม่พบ = null */
  async fetchCountSession(transactionNo: string): Promise<ErpCountSession | null> {
    const key = transactionNo.trim();
    if (key.length === 0) return null;

    const headerRows = await this.runQuery('count-session', COUNT_SESSION_SQL, {
      transactionNo: key,
    });
    const headerRow = headerRows[0];
    if (!headerRow) return null;

    const header = CountHeaderRowSchema.safeParse(headerRow);
    if (!header.success) {
      throw new MssqlDriverError(
        'ERP_SCHEMA_DRIFT',
        `หัวรอบนับ ${key} ไม่ผ่าน validation — ${firstIssue(header.error)}`,
      );
    }

    const lineRows = await this.runQuery('count-session-lines', COUNT_LINES_SQL, {
      transactionNo: key,
    });

    const bySku = new Map<string, MssqlCountLine>();
    const warehouses: string[] = [];
    const unknownWarehouses = new Set<string>();
    let duplicates = 0;
    let skipped = 0;

    for (const row of lineRows) {
      const parsed = CountLineRowSchema.safeParse(row);
      if (!parsed.success) {
        skipped += 1;
        if (skipped <= 3) {
          logger.warn(`ข้ามรายการนับที่ไม่ผ่าน validation (${key}) — ${firstIssue(parsed.error)}`);
        }
        continue;
      }

      const data = parsed.data;
      if (bySku.has(data.ItemCode)) {
        duplicates += 1; // รายการเดิมชนะ (เรียงตาม ItemCode แล้ว) — ระบบเราเก็บผลนับต่อ (session, sku)
        continue;
      }

      if (data.Warehouse) {
        if (!warehouses.includes(data.Warehouse)) warehouses.push(data.Warehouse);
        if (!KNOWN_WAREHOUSES.includes(data.Warehouse)) unknownWarehouses.add(data.Warehouse);
      }

      bySku.set(data.ItemCode, {
        sku: data.ItemCode,
        description: data.Description,
        warehouseCode: data.Warehouse,
        unit: data.MainUnits,
        systemQty: data.MainQty,
        // ⚠️ อ้างอิงเท่านั้น — ผลนับจริงของระบบนี้มาจากพนักงานผ่าน count_submissions
        erpReferenceCountQty: data.ErpCountQty,
        erpReferenceDifQty: data.ErpDifQty,
      });
    }

    if (duplicates > 0) {
      logger.warn(`รอบนับ ${key}: ItemCode ซ้ำใน tbl_CountDtl ${duplicates} แถว — ใช้แถวแรกต่อรหัส`);
    }
    if (unknownWarehouses.size > 0) {
      logger.warn(
        `รอบนับ ${key}: พบรหัสคลังที่ไม่รู้จัก ${[...unknownWarehouses].join(', ')} ` +
          `(คลังที่คาด: ${KNOWN_WAREHOUSES.join(' / ')})`,
      );
    }

    const internal: MssqlCountSession = {
      ...toSessionSummary(header.data),
      lineCount: bySku.size,
      rows: [...bySku.values()],
      warehouseCodes: warehouses,
    };

    // map internal → canonical ที่ขอบของ adapter
    return toCanonicalSession(internal, this.sqlCfg.warehouseCode);
  }

  // -------------------------------------------------------------------------
  // ภายใน
  // -------------------------------------------------------------------------

  private async getPool(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.createPool();
    try {
      return await this.poolPromise;
    } catch (err) {
      this.poolPromise = undefined; // ต่อไม่ได้รอบนี้ ให้รอบถัดไปลองใหม่ได้
      throw err;
    }
  }

  private async createPool(): Promise<sql.ConnectionPool> {
    const cfg = this.sqlCfg;
    const poolConfig: sql.config = {
      server: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      // หมายเหตุ: mssql รับ requestTimeout/connectionTimeout ที่ระดับ config ราก
      // (ไม่ใช่ใน options) — ค่ามาจาก ERP_TIMEOUT_MS ตัวเดียวกัน
      connectionTimeout: cfg.timeoutMs,
      requestTimeout: cfg.timeoutMs,
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCert,
        // อ่านค่า datetime เป็น UTC ตรงตัว เพื่อให้วันที่ ISO ไม่เลื่อนตาม timezone ของ container
        useUTC: true,
      },
      pool: { max: cfg.poolMax, min: 0, idleTimeoutMillis: 30_000 },
    };

    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', (err: unknown) => {
      logger.error(`connection pool ของ ERP ผิดพลาด: ${errMessage(err)}`);
    });

    try {
      await pool.connect();
    } catch (err) {
      throw new MssqlDriverError(
        'ERP_UNREACHABLE',
        `เชื่อมต่อ ERP ไม่ได้ (${cfg.host}:${cfg.port}/${cfg.database}, encrypt=${cfg.encrypt}): ` +
          errMessage(err),
      );
    }

    logger.log(
      `เชื่อมต่อ ERP แล้ว: ${cfg.host}:${cfg.port}/${cfg.database} ` +
        `(pool max ${cfg.poolMax}, timeout ${cfg.timeoutMs}ms, charset ${cfg.charset})`,
    );
    return pool;
  }

  /**
   * จุดเดียวที่ส่ง SQL เข้า ERP
   * - ชั้นที่ 3 ของกฎเหล็ก: assertReadOnlySql() ก่อนทุกครั้ง
   * - ค่าจากภายนอกผูกด้วย parameter เสมอ (ห้าม concat เข้า SQL)
   * - ยังไม่พิสูจน์ read-only = พิสูจน์ก่อน (เช่นกรณี ERP ล่มตอน boot แล้วกลับมาทีหลัง)
   */
  private async runQuery(
    label: string,
    text: string,
    params: SqlParams = {},
  ): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(text);

    if (!this.readOnlyVerified) await this.verifyReadOnly();

    const pool = await this.getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'number') {
        request.input(name, Number.isInteger(value) ? sql.Int : sql.Float, value);
      } else if (value instanceof Date) {
        request.input(name, sql.DateTime2, value);
      } else {
        request.input(name, sql.NVarChar(4000), value);
      }
    }

    try {
      const result = await request.query(text);
      const rows = (result.recordset ?? []) as unknown as Record<string, unknown>[];
      return rows.map((row) => this.normalizeRow(row));
    } catch (err) {
      if (isConnectionError(err)) {
        throw new MssqlDriverError(
          'ERP_UNREACHABLE',
          `query "${label}" ต่อ ERP ไม่ได้: ${errMessage(err)}`,
        );
      }
      throw new MssqlDriverError('ERP_QUERY', `query "${label}" ล้มเหลว: ${errMessage(err)}`);
    }
  }

  /** decode ข้อความไทยตาม ERP_SQL_CHARSET (NVARCHAR = ผ่านตรง ๆ) */
  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = decodeThai(value, this.sqlCfg.charset);
    }
    return out;
  }

  /** อ่าน item master จากตาราง/view ด้วย OFFSET/FETCH — ไม่โหลดทั้งก้อนเข้า memory */
  private async *readItemRowsFromTable(): AsyncIterableIterator<Record<string, unknown>[]> {
    const text = itemsPageSql(this.sqlCfg.itemsTable);

    for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
      const rows = await this.runQuery('items-page', text, {
        offset: page * ITEM_BATCH_SIZE,
        batch: ITEM_BATCH_SIZE,
      });
      if (rows.length > 0) yield rows;
      if (rows.length < ITEM_BATCH_SIZE) return;
    }

    throw new MssqlDriverError(
      'ERP_SCHEMA_DRIFT',
      `ดึง item master เกิน ${MAX_ITEM_PAGES} หน้า (${MAX_ITEM_PAGES * ITEM_BATCH_SIZE} แถว) ` +
        'แล้วยังไม่จบ — หยุดรอบนี้เพื่อกันลูปไม่สิ้นสุด',
    );
  }

  /**
   * อ่าน item master จาก script .sql ที่เจ้าของโปรเจคส่งมอบ (สัญญาของ driver)
   * script คุม ORDER BY/สูตรเอง จึงไม่แบ่งหน้าใน SQL — รันครั้งเดียวแล้วซอยเป็น batch 500
   * (item master ของ ERP นี้อยู่ระดับหลายร้อยแถว จึงยังรับได้ในหน่วยความจำ)
   *
   * พารามิเตอร์ที่ผูกให้เสมอ (script จะใช้หรือไม่ใช้ก็ได้ — T-SQL ยอมให้ประกาศแล้วไม่อ้างถึง):
   *   `@warehouse` = WAREHOUSE_CODE ของ deployment นี้
   *   `@asOf`      = เวลาที่เริ่มรอบ sync (ยอดคงเหลือ ณ เวลานี้)
   * มีไว้เพื่อให้ script เดียวใช้ได้ทุกคลังโดยไม่ต้องแก้ไฟล์ต่อ deployment
   */
  private async *readItemRowsFromScript(
    path: string,
  ): AsyncIterableIterator<Record<string, unknown>[]> {
    const text = this.loadItemsSqlFile(path);
    const rows = await this.runQuery('items-script', text, {
      warehouse: this.sqlCfg.warehouseCode,
      asOf: new Date(),
    });
    for (const batch of chunk(this.dedupeItemRows(rows), ITEM_BATCH_SIZE)) yield batch;
  }

  private loadItemsSqlFile(path: string): string {
    if (this.itemsSqlCache) return this.itemsSqlCache;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new MssqlDriverError(
        'ERP_CONFIG',
        `อ่านไฟล์ ERP_SQL_ITEMS_SQL_FILE ไม่ได้: ${path} — ${errMessage(err)}`,
      );
    }

    text = text.replace(/^\uFEFF/, '').trim();
    if (text.length === 0) {
      throw new MssqlDriverError('ERP_CONFIG', `ไฟล์ ERP_SQL_ITEMS_SQL_FILE ว่างเปล่า: ${path}`);
    }
    if (/^\s*GO\s*$/im.test(text)) {
      throw new MssqlDriverError(
        'ERP_CONFIG',
        `ERP_SQL_ITEMS_SQL_FILE ต้องเป็นคำสั่ง SELECT เดียว ห้ามมีตัวคั่นแบตช์ GO: ${path}`,
      );
    }

    // ชั้นที่ 3: script จากภายนอกต้องผ่าน guard ก่อนแตะ connection ของ ERP
    assertReadOnlySql(text);
    this.itemsSqlCache = text;
    logger.log(`ใช้ script ดึง item master จาก ${path} (${text.length} ตัวอักษร)`);
    return text;
  }

  /**
   * ⚠️ ItemCode ซ้ำได้ → Roworder สูงสุดชนะ
   * ใช้กับผลจาก script เท่านั้น (เส้นทางตาราง/view dedupe ด้วย ROW_NUMBER() ใน SQL แล้ว)
   */
  private dedupeItemRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    const best = new Map<string, { row: Record<string, unknown>; roworder: number }>();
    let duplicates = 0;
    let withoutSku = 0;

    for (const row of rows) {
      const get = rowGetter(row);
      // ⚠️ ค่าจาก ERP เป็น unknown — ถ้าเป็น object แล้วเผลอ String() จะได้ '[object Object]'
      //    กลายเป็น "รหัสสินค้า" ปลอมที่ไหลเข้า items_cache → ข้ามแถวไปเลยปลอดภัยกว่า
      const sku = asScalarString(get('ItemCode', 'sku', 'item_code')).trim();
      if (sku.length === 0) {
        withoutSku += 1;
        continue;
      }
      const rawOrder = Number(get('Roworder', 'roworder') ?? 0);
      const roworder = Number.isFinite(rawOrder) ? rawOrder : 0;
      const current = best.get(sku);
      if (!current) {
        best.set(sku, { row, roworder });
        continue;
      }
      duplicates += 1;
      if (roworder > current.roworder) best.set(sku, { row, roworder });
    }

    if (duplicates > 0) {
      logger.warn(
        `script ส่ง ItemCode ซ้ำ ${duplicates} แถว — ใช้กติกา Roworder สูงสุดชนะ ` +
          `(เหลือ ${best.size} รหัส)`,
      );
    }
    if (withoutSku > 0) {
      logger.warn(`script ส่งแถวที่ไม่มี ItemCode/sku ${withoutSku} แถว — ข้าม`);
    }

    return [...best.values()].map((entry) => entry.row);
  }

  private toCanonicalItem(
    row: Record<string, unknown>,
  ): { ok: true; item: CanonicalItem } | { ok: false; reason: string } {
    const parsed = ItemFieldsSchema.safeParse(pickItemFields(row));
    if (!parsed.success) {
      return { ok: false, reason: firstIssue(parsed.error) };
    }

    const fields = parsed.data;

    // บาร์โค้ด: ItemCode เองต้องอยู่ด้วยเสมอ เพราะโปรเจคนี้พิมพ์ฉลาก Code128 จาก ItemCode
    // (BarCodeUnits/BarCodePack มีจริงแค่ ~2% ของรายการ)
    const barcodes = uniqueNonEmpty([fields.sku, fields.barcodeUnits, fields.barcodePack]);

    const item: CanonicalItem = {
      sku: fields.sku,
      barcodes,
      name: fields.name,
      nameEn: fields.nameEn,
      loc: fields.loc, // Shelf ว่าง 100% ในข้อมูลจริง → ปกติเป็น undefined
      // ERP ไม่มียอดคงเหลือสำเร็จรูป — ค่านี้มีเฉพาะเมื่อ script ของเจ้าของโปรเจคคำนวณ on_hand มาให้
      onHand: fields.onHand,
      reserved: undefined, // PendingQTY ว่าง 100%
      rop: fields.rop !== undefined && fields.rop > 0 ? fields.rop : undefined, // 0 = ไม่ได้ตั้ง ROP
      // MainUnits ครบ 100% ในข้อมูลจริง — '' เป็น fallback กันกรณีคอลัมน์ว่างผิดคาด
      unit: fields.unit ?? '',
      vendor: undefined, // ต้อง join tbl_SupItem/Supplier — ยังไม่อยู่ในสัญญานี้
      lot: fields.lot, // LotNumber ว่าง 100%
      lastCountDate: undefined, // มาจากรอบนับ (tbl_CountHdr) ไม่ใช่ item master
      updatedAt: undefined, // ERP ไม่มี updated-at ที่เชื่อถือได้ → delta=false
      // item master ของ ERP นี้ไม่มีคอลัมน์คลัง (เป็นระดับบริษัท) — ประทับคลังของ deployment นี้ไว้
      warehouseCode: fields.warehouse ?? this.sqlCfg.warehouseCode,
    };

    return { ok: true, item };
  }
}

function toSessionSummary(
  header: z.infer<typeof CountHeaderRowSchema>,
): MssqlSessionSummary {
  return {
    transactionNo: header.TransactionNo,
    voucherNo: header.VoucherNo,
    countDate: header.CountDate,
    countNo: header.CountNo,
    countYear: header.CountYear,
    empId: header.EmpId,
    erpRoworder: header.Roworder,
    lineCount: header.LineCount,
  };
}
