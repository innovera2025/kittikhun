/**
 * เส้นทางเขียนกลับ ERP — **แยกจาก `ErpAdapter` โดยสิ้นเชิง**
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  กฎเหล็กเดิมไม่ถูกยกเลิก แต่ถูกจำกัดขอบเขต
 * ══════════════════════════════════════════════════════════════════════════
 * ทุกเส้นทาง **อ่าน** ยังคงพิสูจน์ได้ว่าเขียนไม่ได้เหมือนเดิมทุกประการ:
 * `ErpAdapter` ยังอยู่ใต้ `WriteishMethodName` · `assertReadOnlySql()` ยังบังคับ
 * ทุก statement ของฝั่งอ่าน · บัญชี `ERP_SQL_USER` ยังต้องเป็น `db_datareader` ล้วน
 *
 * สิ่งที่เพิ่มคือประตูบานใหม่ที่แคบที่สุดเท่าที่ทำได้:
 *   - คนละ interface · คนละ connection pool · **คนละบัญชีฐานข้อมูล**
 *   - เขียนได้เฉพาะ 3 ตาราง: `tbl_CountHdr` · `tbl_CountDtl` · `RunningNumber`
 *   - ทุก statement ต้องผ่าน `assertCountWriteSql()` ด้านล่าง
 *   - ปิดอยู่โดยค่าเริ่มต้น (`ERP_WRITEBACK_ENABLED=false`)
 *
 * เหตุผลที่เปิด: เจ้าของโปรเจคสั่งเมื่อ 25 ส.ค. 2569 และฝ่าย ERP ส่งสัญญา
 * `INSERT` พร้อมกลไกออกเลขเอกสารมาให้ ดู
 * `process/general-plans/active/erp-writeback_PLAN_25-08-26.md`
 *
 * ข้อเท็จจริงที่ตรวจจาก `db_TCL` จริง (25 ส.ค. 2569) และเป็นฐานของโค้ดนี้:
 *   - ไม่มี trigger บนทั้ง 3 ตาราง → เขียนเอกสารนับ **ไม่กระทบยอดคงเหลือ**
 *     (ยอดคงเหลือมาจาก `InventoryFlowHdr`/`Dtl` คนละเส้นทาง)
 *   - `Roworder` / `RowOrder` เป็น IDENTITY → ไม่ต้องส่งค่า
 *   - `RunningNumber.Number` = **เลขล่าสุดที่ใช้ไปแล้ว** → เลขถัดไปคือ +1
 *   - `DifQty` = `MainQty − CountQty` (ขาด = บวก · เกิน = ลบ)
 *   - ⚠️ ไม่มี unique บน `VoucherNo` และ `TransactionNo` เดี่ยว ๆ
 *     → ฐานข้อมูลปลายทาง **ไม่มีด่านกันเอกสารซ้ำ** ต้องกันที่ `erp_writeback` ของเรา
 */

/** หนึ่งบรรทัดใน `tbl_CountDtl` */
export interface ErpCountLine {
  /** `Number` — ลำดับในเอกสาร เริ่มที่ 1 */
  lineNo: number;
  /** `ItemCode` — nvarchar(50) */
  sku: string;
  /** `Description` — nvarchar(100) */
  description: string;
  /** `Warehouse` — nvarchar(20) */
  warehouse: string;
  /** `MainQty` — ยอดระบบที่ตรึงตอนเปิดรอบ · decimal(18,2) */
  mainQty: number;
  /** `MainUnits` — nvarchar(10) */
  mainUnits: string | null;
  /** `CountQty` — จำนวนที่นับได้จริง · decimal(18,2) */
  countQty: number;
  /** `RemarkDtl` — text */
  remark: string | null;
}

/** หัวเอกสาร `tbl_CountHdr` (ไม่รวมช่องที่ ERP หรือเราออกเลขให้ตอนเขียน) */
export interface ErpCountHeader {
  /** `VoucherDate` — วันที่ของเอกสาร · writer ตัดเวลาทิ้งเหลือเที่ยงคืนก่อนเขียนเสมอ */
  voucherDate: Date;
  /** `CountDate` — วันที่นับจริง · writer ตัดเวลาทิ้งเหลือเที่ยงคืนก่อนเขียนเสมอ */
  countDate: Date;
  /** `Emp_ID` — nvarchar(20) · ของจริงใน ERP บางใบเว้นว่าง */
  empId: string | null;
  /** `Emp_Name` — nvarchar(50) */
  empName: string | null;
  /** `CountNo` — nvarchar(2) */
  countNo: string;
  /** `CountYear` — nvarchar(4) · ค.ศ. */
  countYear: string;
  /** `CountNumber` — numeric(18,0) */
  countNumber: number;
  /** `Remark` — text · writer จะต่อมาร์กเกอร์รอบนับให้เองท้ายข้อความ */
  remark: string | null;
  /** `EntryBy` — nvarchar(20) · ผู้กดส่ง */
  entryBy: string;
  /**
   * รหัสรอบนับของเรา — ไม่ใช่คอลัมน์ของ ERP
   *
   * writer ประทับเป็นมาร์กเกอร์ `TCL#<id>#` ไว้ใน `Remark` เพื่อให้
   * {@link ErpCountWriter.findDocumentBySession} ค้นเอกสารกลับมาเจอ
   * ตอน retry ได้ — ปลายทางไม่มีคอลัมน์ structured ให้ผูก
   */
  sessionId: string;
}

/** ผลของการเขียนหนึ่งเอกสาร */
export interface ErpCountWriteResult {
  transactionNo: number;
  voucherNo: string;
  rowCount: number;
}

/**
 * สัญญาการเขียน — มี method เดียวโดยเจตนา
 *
 * ⚠️ ห้ามเพิ่ม method ที่แตะตารางอื่นของ ERP ลงในนี้ ถ้าต้องการเส้นทางใหม่
 *    ให้สร้าง interface ใหม่พร้อม guard ของตัวเอง เพื่อให้ขอบเขตความเสียหาย
 *    ของแต่ละเส้นทางยังอ่านออกจากชนิดข้อมูลได้
 */
export interface ErpCountWriter {
  /** เขียนหัว + รายการในธุรกรรมเดียว — ล้มกลางทางต้องไม่เหลือหัวลอย */
  writeCountDocument(
    header: ErpCountHeader,
    lines: readonly ErpCountLine[],
  ): Promise<ErpCountWriteResult>;

  /**
   * ค้นเอกสารของรอบนับนี้ที่ **อาจเข้า ERP ไปแล้ว** — อ่านอย่างเดียว
   *
   * มีไว้ปิดช่องเดียวที่ทำให้เอกสารซ้ำได้จริง: ERP commit สำเร็จแต่สายขาด
   * ตอนตอบกลับ ฝั่งเราจึงบันทึกเป็น `failed` แล้วปล่อยให้กดส่งใหม่ — และ
   * เพราะปลายทางไม่มี unique บน `VoucherNo`/`TransactionNo` จะได้เอกสารสองใบ
   * โดยไม่มีอะไรฟ้อง เรียกเมธอดนี้ก่อนส่งซ้ำเสมอ
   *
   * `null` = ยังไม่มีเอกสารของรอบนี้ใน ERP
   */
  findDocumentBySession(sessionId: string): Promise<ErpCountWriteResult | null>;

  /**
   * ตรวจขอบเขตสิทธิ์ของบัญชีเขียนตอน boot — optional เพราะ implementation
   * ที่ไม่ได้ต่อฐานข้อมูลจริง (เทสต์/mock) ตรวจไม่ได้
   *
   * โยน error ที่มี `code` เป็นหนึ่งใน `ERP_WRITE_SCOPE_TOO_WIDE` /
   * `ERP_WRITE_SCOPE_INSUFFICIENT` / `ERP_WRITE_PROBE_INCONCLUSIVE`
   * เมื่อขอบเขตไม่ถูกต้อง — `ErpModule` จะหยุด boot ตามนั้น
   */
  verifyWriteScope?(): Promise<void>;

  close(): Promise<void>;
}

export const ERP_COUNT_WRITER = Symbol('ERP_COUNT_WRITER');

// ---------------------------------------------------------------------------
// statement guard ของฝั่งเขียน
// ---------------------------------------------------------------------------

export class ErpWriteSqlViolationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErpWriteSqlViolationError';
  }
}

/** ตารางเดียวที่เส้นทางนี้แตะได้ — เพิ่มชื่อในนี้ = ขยายขอบเขตความเสียหาย */
const ALLOWED_TABLES = ['tbl_CountHdr', 'tbl_CountDtl', 'RunningNumber'] as const;

/** คำสั่งที่ห้ามเด็ดขาดแม้จะอยู่ในตารางที่อนุญาต */
const FORBIDDEN = [
  { re: /\bdrop\b/i, label: 'DROP' },
  { re: /\btruncate\b/i, label: 'TRUNCATE' },
  { re: /\balter\b/i, label: 'ALTER' },
  { re: /\bgrant\b/i, label: 'GRANT' },
  { re: /\bexec(ute)?\b/i, label: 'EXEC' },
  { re: /\bxp_\w+/i, label: 'extended stored procedure' },
  { re: /\bsp_\w+/i, label: 'system stored procedure' },
  { re: /\binto\s+#/i, label: 'temp table' },
] as const;

/**
 * ทำให้ statement อยู่ในรูปที่ตรวจได้ — **สำคัญกว่าที่เห็น**
 *
 * ⚠️ เวอร์ชันเดิมใช้ regex ตัด `--` และ `/* *\/` โดยไม่รู้จัก string literal
 *    ทำให้ `UPDATE tbl_CountHdr SET Remark = '--' ; DROP TABLE tbl_CountDtl`
 *    ถูกตัดเหลือแค่ท่อนหน้า `--` แล้วผ่านทุกด่าน ทั้งที่ค่าที่ส่งเข้า `.query()`
 *    คือสตริงเต็ม → ด่านทั้งชุดตรวจคนละสตริงกับที่ SQL Server ได้รับ
 *
 * ที่นี่เดินทีละอักขระ รู้จัก `'...'` (รวม `''`), `N'...'`, `[...]` และ `"..."`
 * เนื้อใน string literal ถูกแทนด้วย `''` (ว่าง) เพื่อไม่ให้คำในข้อมูลไปชนกฎ
 * ส่วนคอมเมนต์จะถูกตัดเฉพาะที่อยู่ **นอก** literal เท่านั้น
 */
function normalizeStatement(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const isQuote = ch === "'";
    const isNQuote = (ch === 'N' || ch === 'n') && sql[i + 1] === "'";
    if (isQuote || isNQuote) {
      let j = (isQuote ? i : i + 1) + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += "''";
      i = j + 1;
      continue;
    }
    // identifier ที่คร่อมไว้ — เก็บไว้ทั้งก้อนให้ตัวสแกนชื่อตารางอ่านต่อได้
    if (ch === '[' || ch === '"') {
      const close = ch === '[' ? ']' : '"';
      let j = i + 1;
      while (j < sql.length && sql[j] !== close) j += 1;
      out += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** คำที่ปิดรายการตารางใน FROM — ใช้ตรวจว่ามี comma-join แอบอยู่หรือไม่ */
const CLAUSE_STOP =
  /^(where|group|having|order|union|except|intersect|option|for|on|inner|left|right|full|cross|outer|join|apply|values|set|output|select|end|when|then|else)$/i;

/** อักขระที่เป็น identifier ของ T-SQL (รองรับ unicode ตามที่ SQL Server ยอม) */
const IDENT_RE = /^[\p{L}_@#][\p{L}\p{N}_@#$]*/u;

type ScanState = { readonly sql: string; pos: number };

function skipSpace(st: ScanState): void {
  while (st.pos < st.sql.length && /\s/.test(st.sql[st.pos])) st.pos += 1;
}

/** อ่านชื่อหนึ่งส่วน (`tbl`, `[tbl]`, `"tbl"`) — `null` = อ่านไม่ได้ */
function readNamePart(st: ScanState): string | null {
  skipSpace(st);
  const ch = st.sql[st.pos];
  if (ch === '[' || ch === '"') {
    const close = ch === '[' ? ']' : '"';
    const end = st.sql.indexOf(close, st.pos + 1);
    if (end === -1) return null;
    const name = st.sql.slice(st.pos + 1, end);
    st.pos = end + 1;
    return name;
  }
  const match = IDENT_RE.exec(st.sql.slice(st.pos));
  if (!match) return null;
  st.pos += match[0].length;
  return match[0];
}

/**
 * อ่าน table reference หลังคำสั่ง (`dbo.tbl` / `[db].[dbo].[tbl]`)
 * คืนชื่อตารางส่วนสุดท้าย · `null` = ไม่ใช่ชื่อตาราง (เช่น subquery ที่ขึ้นต้นด้วย `(`)
 */
function readTableName(st: ScanState): string | null {
  skipSpace(st);
  if (st.sql[st.pos] === '(') return null; // derived table / subquery — ตัวสแกนหลักจะเจอ FROM ข้างในเอง
  let name = readNamePart(st);
  if (name === null) return null;
  while (st.sql[st.pos] === '.') {
    st.pos += 1;
    const next = readNamePart(st);
    if (next === null) return null;
    name = next;
  }
  return name;
}

function isAllowedTable(name: string): boolean {
  return ALLOWED_TABLES.some((t) => t.toLowerCase() === name.toLowerCase());
}

/**
 * ทุกชื่อตารางที่ statement อ้างถึงต้องอยู่ใน {@link ALLOWED_TABLES}
 *
 * ⚠️ เดิมตรวจแค่ว่า "มีตารางที่อนุญาตอย่างน้อยหนึ่งตัว" ทำให้
 *    `INSERT INTO tbl_CountDtl(...) SELECT ... FROM InventoryItem` ผ่านได้
 *    และเวอร์ชันถัดมาที่ใช้ regex ก็ยังมองไม่เห็น comma-join (`FROM a, b`)
 *    กับ `CROSS/OUTER APPLY` — ที่นี่จึงสแกนแบบ fail-closed:
 *    อ่านชื่อตารางไม่ออก = ปฏิเสธ ไม่ใช่ปล่อยผ่าน
 */
function assertNoForeignTables(sql: string): void {
  const anchor = /\b(?:insert\s+into|update|from|join|apply)\b/gi;
  const foreign = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = anchor.exec(sql)) !== null) {
    const isFrom = /^from$/i.test(match[0]);
    const st: ScanState = { sql, pos: match.index + match[0].length };
    const name = readTableName(st);
    if (name === null) {
      // `(` = subquery → ข้ามได้ · อย่างอื่นแปลว่าอ่านไม่ออก → ปฏิเสธ
      skipSpace(st);
      if (sql[st.pos] === '(') continue;
      throw new ErpWriteSqlViolationError(
        'UNPARSEABLE_TABLE',
        `อ่านชื่อตารางหลัง "${match[0]}" ไม่ออก — ปฏิเสธไว้ก่อนตามหลัก fail-closed`,
      );
    }
    if (!isAllowedTable(name)) foreign.add(name);

    if (isFrom) assertNoCommaJoin(sql, st.pos);
  }

  if (foreign.size > 0) {
    throw new ErpWriteSqlViolationError(
      'TABLE_NOT_ALLOWED',
      `พบชื่อตารางนอกขอบเขตในคำสั่ง: ${[...foreign].join(', ')} — ` +
        `เส้นทางนี้แตะได้เฉพาะ ${ALLOWED_TABLES.join(' / ')}`,
    );
  }
}

/**
 * comma-join (`FROM tbl_CountHdr h, InventoryItem i`) หลบตัวสแกนที่อิงคำสั่งนำหน้าได้
 * โค้ดของเราไม่เคยใช้รูปแบบนี้ จึงปฏิเสธไปเลยแทนที่จะพยายามแกะให้ครบทุกกรณี
 */
function assertNoCommaJoin(sql: string, from: number): void {
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return;
      depth -= 1;
    } else if (ch === ';') return;
    else if (ch === ',' && depth === 0) {
      throw new ErpWriteSqlViolationError(
        'COMMA_JOIN',
        'ไม่รับ comma-join ใน FROM (เช่น `FROM a, b`) — เขียนเป็น JOIN ที่ตรวจได้แทน',
      );
    } else if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      if (word && CLAUSE_STOP.test(word[0])) return;
      if (word) i += word[0].length - 1;
    }
  }
}

/**
 * `SELECT … INTO tbl` และ `OUTPUT … INTO tbl` สร้าง/เขียนตารางนอกขอบเขตได้
 * ทั้งที่ไม่ได้ขึ้นต้นด้วย INSERT — ห้ามทั้งสองแบบในทุกเส้นทาง
 */
function assertNoSelectInto(sql: string): void {
  const withoutInsertInto = sql.replace(/\binsert\s+into\b/gi, 'insert');
  if (/\binto\b/i.test(withoutInsertInto)) {
    throw new ErpWriteSqlViolationError(
      'FORBIDDEN_KEYWORD',
      'พบ INTO ที่ไม่ได้ตามหลัง INSERT (SELECT … INTO / OUTPUT … INTO) — สร้างตารางนอกขอบเขตได้',
    );
  }
}

/**
 * ชั้นป้องกันของเส้นทางเขียน — เทียบเท่า `assertReadOnlySql()` ของฝั่งอ่าน
 *
 * อนุญาตเฉพาะ `INSERT` / `UPDATE` ที่อ้างถึงตารางใน {@link ALLOWED_TABLES}
 * และไม่มีคำสั่งอันตรายปนอยู่ · `DELETE` ไม่อนุญาตทุกกรณี เพราะเส้นทางนี้
 * มีไว้เพิ่มเอกสาร ไม่ใช่ลบของที่ ERP มีอยู่
 */
export function assertCountWriteSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new ErpWriteSqlViolationError('EMPTY_STATEMENT', 'SQL ว่างเปล่า');
  }

  const normalized = normalizeStatement(sql);
  if (normalized.length === 0) {
    throw new ErpWriteSqlViolationError(
      'EMPTY_STATEMENT',
      'SQL มีแต่คอมเมนต์/ช่องว่าง ไม่มีคำสั่งจริง',
    );
  }

  if (!/^(insert|update)\b/i.test(normalized)) {
    const first = normalized.split(/[\s(;]/, 1)[0];
    throw new ErpWriteSqlViolationError(
      'NOT_INSERT_OR_UPDATE',
      `เส้นทางเขียนรับเฉพาะ INSERT/UPDATE แต่เริ่มด้วย "${first}" — ` +
        'DELETE และ DDL ถูกห้ามทุกกรณี',
    );
  }

  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new ErpWriteSqlViolationError(
      'MULTIPLE_STATEMENTS',
      "พบ ';' คั่นกลาง = ส่งได้หลายคำสั่งในครั้งเดียว (อนุญาตแค่ ';' ปิดท้ายคำสั่งเดียว)",
    );
  }

  for (const rule of FORBIDDEN) {
    if (rule.re.test(withoutTrailingSemicolon)) {
      throw new ErpWriteSqlViolationError(
        'FORBIDDEN_KEYWORD',
        `พบคำสั่งที่ห้ามใช้กับเส้นทางเขียน: ${rule.label}`,
      );
    }
  }

  // ต้องอ้างถึงตารางที่อนุญาตอย่างน้อยหนึ่งตัว และห้ามมีชื่อตารางอื่นปน
  const target = ALLOWED_TABLES.find((t) =>
    new RegExp(`\\b(?:insert\\s+into|update)\\s+(?:dbo\\.)?${t}\\b`, 'i').test(
      withoutTrailingSemicolon,
    ),
  );
  if (target === undefined) {
    throw new ErpWriteSqlViolationError(
      'TABLE_NOT_ALLOWED',
      `เขียนได้เฉพาะตาราง ${ALLOWED_TABLES.join(' / ')} เท่านั้น`,
    );
  }

  assertNoSelectInto(withoutTrailingSemicolon);
  assertNoForeignTables(withoutTrailingSemicolon);
}

/**
 * guard ฝั่ง **อ่าน** ของเส้นทางเขียน — ใช้กับ {@link ErpCountWriter.findDocumentBySession}
 *
 * pool ของบัญชีเขียนมีสิทธิ์มากกว่าบัญชีอ่าน จึงต้องมีด่านของตัวเอง:
 * อนุญาตเฉพาะ `SELECT` คำสั่งเดียวที่แตะแค่ตารางใน {@link ALLOWED_TABLES}
 * และห้ามคำสั่งเขียน/DDL/stored procedure ทุกชนิด
 */
export function assertCountReadSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new ErpWriteSqlViolationError('EMPTY_STATEMENT', 'SQL ว่างเปล่า');
  }

  const normalized = normalizeStatement(sql);
  if (normalized.length === 0) {
    throw new ErpWriteSqlViolationError(
      'EMPTY_STATEMENT',
      'SQL มีแต่คอมเมนต์/ช่องว่าง ไม่มีคำสั่งจริง',
    );
  }

  if (!/^select\b/i.test(normalized)) {
    const first = normalized.split(/[\s(;]/, 1)[0];
    throw new ErpWriteSqlViolationError(
      'NOT_SELECT',
      `เส้นทางค้นเอกสารรับเฉพาะ SELECT แต่เริ่มด้วย "${first}"`,
    );
  }

  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new ErpWriteSqlViolationError(
      'MULTIPLE_STATEMENTS',
      "พบ ';' คั่นกลาง = ส่งได้หลายคำสั่งในครั้งเดียว",
    );
  }

  for (const rule of [...FORBIDDEN, ...WRITE_VERBS]) {
    if (rule.re.test(withoutTrailingSemicolon)) {
      throw new ErpWriteSqlViolationError(
        'FORBIDDEN_KEYWORD',
        `พบคำสั่งที่ห้ามใช้กับเส้นทางค้นเอกสาร: ${rule.label}`,
      );
    }
  }

  assertNoSelectInto(withoutTrailingSemicolon);
  assertNoForeignTables(withoutTrailingSemicolon);
}

/** คำสั่งเขียนที่ห้ามในเส้นทางอ่าน (เส้นทางเขียนอนุญาต INSERT/UPDATE จึงแยกลิสต์กัน) */
const WRITE_VERBS = [
  { re: /\binsert\b/i, label: 'INSERT' },
  { re: /\bupdate\b/i, label: 'UPDATE' },
  { re: /\bdelete\b/i, label: 'DELETE' },
  { re: /\bmerge\b/i, label: 'MERGE' },
] as const;
