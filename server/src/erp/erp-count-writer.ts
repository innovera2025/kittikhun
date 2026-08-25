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
  /** `VoucherDate` — วันที่ของเอกสาร */
  voucherDate: Date;
  /** `CountDate` — วันที่นับจริง */
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
  /** `Remark` — text */
  remark: string | null;
  /** `EntryBy` — nvarchar(20) · ผู้กดส่ง */
  entryBy: string;
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

/** ตัดคอมเมนต์ออกก่อนตรวจ — ไม่งั้นซ่อนคำสั่งไว้ในคอมเมนต์ปลอมได้ */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const normalized = stripComments(sql);
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
}
