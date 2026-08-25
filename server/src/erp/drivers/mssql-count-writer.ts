import { Logger } from '@nestjs/common';
import * as sql from 'mssql';

import {
  assertCountWriteSql,
  type ErpCountHeader,
  type ErpCountLine,
  type ErpCountWriteResult,
  type ErpCountWriter,
} from '../erp-count-writer';

const logger = new Logger('MssqlCountWriter');

/**
 * เขียนเอกสารนับสต็อกกลับเข้า `db_TCL` — ทำงานบน **connection pool และบัญชีของตัวเอง**
 * ไม่แชร์อะไรกับ `MssqlDriver` ที่ใช้อ่าน
 *
 * ทุก statement ผ่าน `assertCountWriteSql()` ก่อนแตะ connection เสมอ
 */

export type MssqlWriterConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCert: boolean;
  timeoutMs: number;
};

export class ErpCountWriteError extends Error {
  constructor(
    readonly code: 'ERP_WRITE_UNREACHABLE' | 'ERP_WRITE_FAILED' | 'ERP_WRITE_CONFIG',
    message: string,
  ) {
    super(message);
    this.name = 'ErpCountWriteError';
  }
}

/**
 * `DifQty` = `MainQty − CountQty` (ขาด = บวก · เกิน = ลบ)
 *
 * ⚠️ ทิศทางนี้ **ตรงข้ามกับ `closed_variance.diff` ของระบบเรา** ซึ่งเก็บเป็น
 *    `counted − system` ยืนยันจากข้อมูลจริงใน `tbl_CountDtl` 8 แถว
 *    (204−212=−8 · 24−23=1 · 214−265=−51) — สลับทิศแล้วรายงานส่วนต่างของ ERP
 *    จะกลับด้านทั้งฉบับ ของเกินกลายเป็นของขาด
 */
export function erpDifQty(mainQty: number, countQty: number): number {
  return round2(mainQty - countQty);
}

/**
 * ปัดเป็น 2 ตำแหน่ง — `tbl_CountDtl` เป็น `decimal(18,2)` ส่วนระบบเราเก็บ
 * `numeric(18,3)` ทศนิยมตำแหน่งที่ 3 จึงหายเสมอ ปัดที่นี่ให้เห็นชัด
 * ดีกว่าปล่อยให้ SQL Server ปัดเงียบ ๆ ตอน insert
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** ตัดสตริงตามความยาวคอลัมน์ปลายทาง — ยาวเกินแล้ว insert จะ error ทั้งเอกสาร */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export class MssqlCountWriter implements ErpCountWriter {
  private poolPromise?: Promise<sql.ConnectionPool>;

  constructor(private readonly cfg: MssqlWriterConfig) {}

  async writeCountDocument(
    header: ErpCountHeader,
    lines: readonly ErpCountLine[],
  ): Promise<ErpCountWriteResult> {
    if (lines.length === 0) {
      throw new ErpCountWriteError(
        'ERP_WRITE_CONFIG',
        'ไม่มีรายการให้ส่ง — เอกสารเปล่าไม่มีความหมายและ ERP ตามรอยไม่ได้',
      );
    }

    const pool = await this.getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    try {
      const transactionNo = await this.nextNumber(tx, 'CNTTr');
      const monthKey = MssqlCountWriter.monthKey(header.voucherDate);
      const seq = await this.nextNumber(tx, `CNT${monthKey}`);
      const voucherNo = `CNT-${monthKey}-${String(seq).padStart(4, '0')}`;

      await this.insertHeader(tx, header, transactionNo, voucherNo);
      for (const line of lines) {
        await this.insertLine(tx, transactionNo, line);
      }

      await tx.commit();
      logger.log(
        `เขียนเอกสารนับเข้า ERP สำเร็จ: ${voucherNo} (TransactionNo=${transactionNo}) ` +
          `${lines.length} รายการ`,
      );
      return { transactionNo, voucherNo, rowCount: lines.length };
    } catch (err) {
      // ⚠️ ล้มกลางทางต้องไม่เหลือหัวเอกสารลอยที่ไม่มีรายการ และต้องไม่กินเลขไปเปล่า ๆ
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        logger.error(`rollback ไม่สำเร็จ: ${errMessage(rollbackErr)}`);
      }
      if (err instanceof ErpCountWriteError) throw err;
      throw new ErpCountWriteError(
        isConnectionError(err) ? 'ERP_WRITE_UNREACHABLE' : 'ERP_WRITE_FAILED',
        `เขียนเอกสารนับเข้า ERP ไม่สำเร็จ: ${errMessage(err)}`,
      );
    }
  }

  async close(): Promise<void> {
    const pending = this.poolPromise;
    this.poolPromise = undefined;
    if (!pending) return;
    try {
      await (await pending).close();
    } catch (err) {
      logger.warn(`ปิด pool ของเส้นทางเขียนไม่สำเร็จ: ${errMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // ภายใน
  // -------------------------------------------------------------------------

  /**
   * ออกเลขถัดไปจาก `RunningNumber` แบบกันชน
   *
   * ⚠️ สเปกที่ฝ่าย ERP ให้มาเป็น `SELECT` แล้วค่อย `UPDATE` แยกคำสั่ง ซึ่งถ้า
   *    โปรแกรม ERP ออกเลขพร้อมกันจะได้เลขเดียวกันทั้งคู่ และเนื่องจาก
   *    `tbl_CountHdr` ไม่มี unique บน `TransactionNo` (คีย์หลักคือ
   *    `Roworder + TransactionNo` โดย `Roworder` เป็น IDENTITY) เอกสารสองใบ
   *    จะใช้ `TransactionNo` เดียวกันได้ → รายการนับปนกันโดยไม่มีอะไรฟ้อง
   *
   *    จึงรวมเป็นคำสั่งเดียวที่ `UPDATE` พร้อมล็อกแถว แล้วอ่านค่าใหม่ออกมาด้วย
   *    `OUTPUT` — อะตอมมิกในตัวเอง ไม่มีช่องว่างระหว่างอ่านกับเขียน
   *
   * `RunningNumber.Number` เก็บ **เลขล่าสุดที่ใช้ไปแล้ว** (ตรวจแล้ว: `CNTTr=6`
   * ตรงกับ `TransactionNo=6` ที่มีอยู่จริง) เลขถัดไปจึงเป็น `+1`
   */
  private async nextNumber(tx: sql.Transaction, name: string): Promise<number> {
    const updateSql = `UPDATE RunningNumber WITH (UPDLOCK, HOLDLOCK)
   SET Number = ISNULL(Number, 0) + 1
OUTPUT INSERTED.Number AS next_number
 WHERE Name = @name`;
    assertCountWriteSql(updateSql);

    const updated = await new sql.Request(tx)
      .input('name', sql.VarChar(20), name)
      .query<{ next_number: number }>(updateSql);

    const hit = updated.recordset[0];
    if (hit) return hit.next_number;

    // ยังไม่มีแถวของเดือนนี้ = เอกสารใบแรกของเดือน
    const insertSql = `INSERT INTO RunningNumber(Name, Number) VALUES (@name, 1)`;
    assertCountWriteSql(insertSql);
    await new sql.Request(tx).input('name', sql.VarChar(20), name).query(insertSql);
    return 1;
  }

  private async insertHeader(
    tx: sql.Transaction,
    header: ErpCountHeader,
    transactionNo: number,
    voucherNo: string,
  ): Promise<void> {
    // `Roworder` เป็น IDENTITY จึงไม่ส่งค่า · `EntryDate` ให้ SQL Server ใส่เอง
    // เพื่อให้เวลาอ้างอิงนาฬิกาของ ERP ไม่ใช่ของ container เรา
    const text = `INSERT INTO tbl_CountHdr(
  TransactionNo, VoucherNo, VoucherDate, Emp_ID, Emp_Name,
  CountDate, CountNo, CountYear, CountNumber, Remark, EntryBy, EntryDate)
VALUES(@tx, @voucher, @voucherDate, @empId, @empName,
  @countDate, @countNo, @countYear, @countNumber, @remark, @entryBy, GETDATE())`;
    assertCountWriteSql(text);

    await new sql.Request(tx)
      .input('tx', sql.Int, transactionNo)
      .input('voucher', sql.NVarChar(20), voucherNo)
      .input('voucherDate', sql.DateTime, header.voucherDate)
      .input('empId', sql.NVarChar(20), clamp(header.empId, 20))
      .input('empName', sql.NVarChar(50), clamp(header.empName, 50))
      .input('countDate', sql.DateTime, header.countDate)
      .input('countNo', sql.NVarChar(2), clamp(header.countNo, 2))
      .input('countYear', sql.NVarChar(4), clamp(header.countYear, 4))
      .input('countNumber', sql.Numeric(18, 0), header.countNumber)
      .input('remark', sql.NVarChar(sql.MAX), header.remark)
      .input('entryBy', sql.NVarChar(20), clamp(header.entryBy, 20))
      .query(text);
  }

  private async insertLine(
    tx: sql.Transaction,
    transactionNo: number,
    line: ErpCountLine,
  ): Promise<void> {
    const text = `INSERT INTO tbl_CountDtl(
  TransactionNo, Number, ItemCode, Description, Warehouse,
  MainQty, MainUnits, CountQty, DifQty, RemarkDtl)
VALUES(@tx, @no, @sku, @description, @warehouse,
  @mainQty, @mainUnits, @countQty, @difQty, @remark)`;
    assertCountWriteSql(text);

    await new sql.Request(tx)
      .input('tx', sql.Int, transactionNo)
      .input('no', sql.Decimal(18, 0), line.lineNo)
      .input('sku', sql.NVarChar(50), clamp(line.sku, 50))
      .input('description', sql.NVarChar(100), clamp(line.description, 100))
      .input('warehouse', sql.NVarChar(20), clamp(line.warehouse, 20))
      .input('mainQty', sql.Decimal(18, 2), round2(line.mainQty))
      .input('mainUnits', sql.NVarChar(10), clamp(line.mainUnits, 10))
      .input('countQty', sql.Decimal(18, 2), round2(line.countQty))
      .input('difQty', sql.Decimal(18, 2), erpDifQty(line.mainQty, line.countQty))
      .input('remark', sql.NVarChar(sql.MAX), line.remark)
      .query(text);
  }

  /** `CNT2608` — YYMM ตาม ค.ศ. ให้ตรงกับที่ ERP ใช้อยู่จริง */
  static monthKey(date: Date): string {
    const yy = String(date.getFullYear() % 100).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${yy}${mm}`;
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.createPool();
    try {
      return await this.poolPromise;
    } catch (err) {
      this.poolPromise = undefined;
      throw err;
    }
  }

  private async createPool(): Promise<sql.ConnectionPool> {
    const cfg = this.cfg;
    const pool = new sql.ConnectionPool({
      server: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionTimeout: cfg.timeoutMs,
      requestTimeout: cfg.timeoutMs,
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCert,
        useUTC: true,
        // ไม่มี readOnlyIntent ที่นี่โดยเจตนา — pool นี้ต้องเขียนได้
      },
      // เพดานต่ำสุดที่ทำงานได้: เขียนทีละเอกสารอยู่แล้ว ไม่ต้องดูด connection ของ ERP
      pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    });

    pool.on('error', (err: unknown) => {
      logger.error(`connection pool ของเส้นทางเขียนผิดพลาด: ${errMessage(err)}`);
    });

    try {
      await pool.connect();
    } catch (err) {
      throw new ErpCountWriteError(
        'ERP_WRITE_UNREACHABLE',
        `เชื่อมต่อ ERP ด้วยบัญชีเขียนไม่ได้ (${cfg.host}:${cfg.port}/${cfg.database}): ${errMessage(err)}`,
      );
    }
    logger.log(`pool ของเส้นทางเขียนพร้อม (${cfg.host}:${cfg.port}/${cfg.database})`);
    return pool;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    ['ESOCKET', 'ETIMEOUT', 'ECONNCLOSED', 'ELOGIN', 'ENOTOPEN'].includes(code)
  );
}
