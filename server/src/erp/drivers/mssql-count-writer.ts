import { Logger } from '@nestjs/common';
import * as sql from 'mssql';

import {
  assertCountReadSql,
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
  /** เพดาน connection ของ pool ฝั่งเขียน — มาจาก ERP_SQL_POOL_MAX เหมือนฝั่งอ่าน */
  poolMax: number;
  /**
   * ใส่ `VoucherNo` ลง `tbl_CountDtl` ด้วยหรือไม่ (ERP_WRITEBACK_DTL_VOUCHERNO)
   *
   * ⚠️ ค่าเริ่มต้นคือ `false` เพราะสัญญา `INSERT` ที่ฝ่าย ERP ส่งมาไม่มีคอลัมน์นี้
   *    แต่โมดูล InventoryFlow ของ ERP join `Hdr`↔`Dtl` ด้วย **สองคีย์**
   *    (`TranSactionno` + `VoucherNo`) ถ้ารายงานโมดูลนับก็ join สองคีย์เหมือนกัน
   *    รายการที่เราเขียนจะไม่โผล่ในรายงานเลย → เปิดสวิตช์นี้เมื่อฝ่าย ERP ยืนยันว่า
   *    `tbl_CountDtl` มีคอลัมน์ `VoucherNo` จริง (คำถามข้อ 1 ใน docs/erp-data-mapping.md)
   */
  dtlVoucherNo: boolean;
  /**
   * 🚨 ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT — ยอมให้บัญชีเขียนมีสิทธิ์กว้างเกินขอบเขต (เช่น `sa`)
   *    โดยไม่หยุด boot · ใช้ทดสอบก่อนได้ `tcl_writer` เท่านั้น ห้ามใช้บน production
   */
  allowPrivilegedAccount: boolean;
};

export class ErpCountWriteError extends Error {
  constructor(
    readonly code:
      | 'ERP_WRITE_UNREACHABLE'
      | 'ERP_WRITE_FAILED'
      | 'ERP_WRITE_CONFIG'
      | 'ERP_WRITE_SCOPE_TOO_WIDE'
      | 'ERP_WRITE_SCOPE_INSUFFICIENT'
      | 'ERP_WRITE_PROBE_INCONCLUSIVE',
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

/**
 * ตัดเวลาทิ้งให้เหลือแต่วันที่ (เที่ยงคืนตามเวลาท้องถิ่นของ container)
 *
 * `tbl_CountHdr.VoucherDate` / `CountDate` เป็นชนิด `datetime` ก็จริง แต่เอกสารที่
 * โมดูลนับของ ERP สร้างเองมีเวลาเป็น `00:00:00.000` ทุกใบ (ตรวจจากของจริง 8 ใบ
 * 28 ส.ค. 2569) และรายงานฝั่ง ERP กรอง `WHERE` ด้วยวันที่ล้วน — ถ้าเราเขียนเวลา
 * ติดไปด้วย เอกสารของเราจะหลุดจากรายงานที่เทียบวันแบบตรงตัว
 *
 * ⚠️ ใช้ `setHours` (เวลาท้องถิ่น) ไม่ใช่ `setUTCHours` เพราะ pool ตั้ง `useUTC:false`
 *    ไว้โดยเจตนา — ค่าที่เขียนคือเวลานาฬิกาท้องถิ่นตรง ๆ (container ตั้ง TZ=Asia/Bangkok)
 */
function startOfDay(value: Date): Date {
  const atMidnight = new Date(value.getTime());
  atMidnight.setHours(0, 0, 0, 0);
  return atMidnight;
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

    warnIfPrecisionLost(lines);

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
        await this.insertLine(tx, transactionNo, voucherNo, line);
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

  /**
   * ค้นเอกสารของรอบนับนี้ใน ERP — ใช้ก่อนส่งซ้ำเสมอ
   *
   * อาศัยมาร์กเกอร์ `TCL#<sessionId>#` ที่ {@link stampSession} ประทับไว้ใน
   * `Remark` เพราะปลายทางไม่มีคอลัมน์ structured ให้ผูกกับรอบนับของเรา
   * statement ผ่าน `assertCountReadSql()` — SELECT เท่านั้น และแตะได้แค่ตารางรอบนับ
   */
  async findDocumentBySession(sessionId: string): Promise<ErpCountWriteResult | null> {
    const text = `SELECT TOP (1)
       h.TransactionNo AS transaction_no,
       h.VoucherNo     AS voucher_no,
       (SELECT COUNT(*) FROM tbl_CountDtl AS d
         WHERE d.TransactionNo = h.TransactionNo${this.cfg.dtlVoucherNo ? ' AND d.VoucherNo = h.VoucherNo' : ''}) AS row_count
  FROM tbl_CountHdr AS h
 WHERE h.Remark LIKE @pattern ESCAPE '\\'
 ORDER BY h.Roworder DESC`;
    assertCountReadSql(text);

    const pattern = `%${likeEscape(MssqlCountWriter.sessionMarker(sessionId))}%`;

    try {
      const pool = await this.getPool();
      const found = await new sql.Request(pool)
        .input('pattern', sql.NVarChar(200), pattern)
        .query<{ transaction_no: number; voucher_no: string; row_count: number }>(text);

      const hit = found.recordset[0];
      if (!hit) return null;
      return {
        transactionNo: hit.transaction_no,
        voucherNo: hit.voucher_no,
        rowCount: hit.row_count,
      };
    } catch (err) {
      if (err instanceof ErpCountWriteError) throw err;
      throw new ErpCountWriteError(
        isConnectionError(err) ? 'ERP_WRITE_UNREACHABLE' : 'ERP_WRITE_FAILED',
        `ค้นเอกสารของรอบ ${sessionId} ใน ERP ไม่สำเร็จ: ${errMessage(err)}`,
      );
    }
  }

  /**
   * ตรวจสิทธิ์ของบัญชีเขียนตอน boot — เทียบเท่า `verifyReadOnly()` ของฝั่งอ่าน
   *
   * ก่อนหน้านี้ฝั่งเขียนไม่มีการตรวจใด ๆ ตอน start: รหัสผ่านผิดหรือสิทธิ์กว้างเกิน
   * จะรู้ตัวก็ตอน admin กดส่งเอกสารจริงแล้ว ซึ่งสายเกินไป
   *
   * ผลลัพธ์ 3 ทาง (ตรงกับฝั่งอ่าน):
   *   - เขียนตารางอื่นของ ERP ได้ / เป็น sysadmin / db_owner → `ERP_WRITE_SCOPE_TOO_WIDE`
   *   - เขียน 3 ตารางรอบนับไม่ได้ → `ERP_WRITE_SCOPE_INSUFFICIENT`
   *   - probe ตอบ NULL (สรุปไม่ได้) → `ERP_WRITE_PROBE_INCONCLUSIVE`
   * ทั้งสามต้องหยุด boot · ต่อไม่ได้ → `ERP_WRITE_UNREACHABLE` (ปล่อยผ่านแบบ degraded)
   */
  async verifyWriteScope(): Promise<void> {
    const text = `SELECT
  HAS_PERMS_BY_NAME(@hdr,     @objType, @insertPerm) AS can_write_hdr,
  HAS_PERMS_BY_NAME(@dtl,     @objType, @insertPerm) AS can_write_dtl,
  HAS_PERMS_BY_NAME(@run,     @objType, @updatePerm) AS can_write_run,
  HAS_PERMS_BY_NAME(@run,     @objType, @insertPerm) AS can_insert_run,
  HAS_PERMS_BY_NAME(@run,     @objType, @selectPerm) AS can_read_run,
  HAS_PERMS_BY_NAME(@hdr,     @objType, @selectPerm) AS can_read_hdr,
  HAS_PERMS_BY_NAME(@dtl,     @objType, @selectPerm) AS can_read_dtl,
  HAS_PERMS_BY_NAME(@item,    @objType, @insertPerm) AS can_write_item,
  HAS_PERMS_BY_NAME(@flowHdr, @objType, @insertPerm) AS can_write_flow_hdr,
  HAS_PERMS_BY_NAME(@flowDtl, @objType, @insertPerm) AS can_write_flow_dtl,
  IS_SRVROLEMEMBER(@sysadminRole) AS is_sysadmin,
  IS_ROLEMEMBER(@ownerRole)       AS is_db_owner,
  IS_ROLEMEMBER(@writerRole)      AS is_db_datawriter`;
    assertCountReadSql(text);

    const pool = await this.getPool();
    // ชื่อสิทธิ์และชื่อ role ผูกเป็นพารามิเตอร์ ไม่ฝังในข้อความ SQL
    // เพราะคำว่า INSERT/UPDATE ในข้อความจะไปชนกับ guard ของเส้นทางอ่าน
    const probe = await new sql.Request(pool)
      .input('objType', sql.NVarChar(50), 'OBJECT')
      .input('insertPerm', sql.NVarChar(50), 'INSERT')
      .input('updatePerm', sql.NVarChar(50), 'UPDATE')
      // ต้องอ่าน 2 ตารางนี้ได้ด้วย ไม่งั้น findDocumentBySession() ใช้ไม่ได้ตอน retry
      // = กลับไปเสี่ยงเอกสารซ้ำเหมือนเดิม
      .input('selectPerm', sql.NVarChar(50), 'SELECT')
      .input('hdr', sql.NVarChar(200), 'dbo.tbl_CountHdr')
      .input('dtl', sql.NVarChar(200), 'dbo.tbl_CountDtl')
      .input('run', sql.NVarChar(200), 'dbo.RunningNumber')
      .input('item', sql.NVarChar(200), 'dbo.InventoryItem')
      .input('flowHdr', sql.NVarChar(200), 'dbo.InventoryFlowHdr')
      .input('flowDtl', sql.NVarChar(200), 'dbo.InventoryFlowDtl')
      .input('sysadminRole', sql.NVarChar(50), 'sysadmin')
      .input('ownerRole', sql.NVarChar(50), 'db_owner')
      .input('writerRole', sql.NVarChar(50), 'db_datawriter')
      .query<WriteScopeRow>(text);

    const row = probe.recordset[0];
    if (!row) {
      throw new ErpCountWriteError(
        'ERP_WRITE_PROBE_INCONCLUSIVE',
        'probe สิทธิ์ของบัญชีเขียนไม่คืนผลลัพธ์ — สรุปขอบเขตความเสียหายไม่ได้ จึงไม่ยอม start',
      );
    }

    const inconclusive = Object.entries(row)
      .filter(([, value]) => value === null || value === undefined)
      .map(([key]) => key);
    if (inconclusive.length > 0) {
      throw new ErpCountWriteError(
        'ERP_WRITE_PROBE_INCONCLUSIVE',
        `probe สิทธิ์ของบัญชีเขียนตอบ NULL ที่ ${inconclusive.join(', ')} — ` +
          'ปกติแปลว่าอ็อบเจกต์ไม่มีอยู่จริงหรือบัญชีมองไม่เห็น สรุปไม่ได้จึงไม่ยอม start',
      );
    }

    const tooWide: string[] = [];
    if (row.is_sysadmin === 1) tooWide.push('เป็น sysadmin');
    if (row.is_db_owner === 1) tooWide.push('เป็น db_owner');
    if (row.is_db_datawriter === 1) tooWide.push('เป็น db_datawriter');
    if (row.can_write_item === 1) tooWide.push('เขียน dbo.InventoryItem ได้');
    if (row.can_write_flow_hdr === 1) tooWide.push('เขียน dbo.InventoryFlowHdr ได้');
    if (row.can_write_flow_dtl === 1) tooWide.push('เขียน dbo.InventoryFlowDtl ได้');
    if (tooWide.length > 0 && this.cfg.allowPrivilegedAccount) {
      // 🚨 โหมดทดสอบ — ปล่อยผ่านแต่ต้องดังพอที่จะไม่มีใครเผลอปล่อยไว้บน production
      logger.warn(
        `🚨 โหมดทดสอบ: บัญชีเขียน "${this.cfg.user}" มีสิทธิ์กว้างเกินขอบเขต (${tooWide.join(' · ')}) — ` +
          'ปกติต้องหยุด boot แต่ ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT=true จึงปล่อยผ่าน · ' +
          'ห้ามใช้ค่านี้บน production เด็ดขาด',
      );
    } else if (tooWide.length > 0) {
      throw new ErpCountWriteError(
        'ERP_WRITE_SCOPE_TOO_WIDE',
        `บัญชีเขียน "${this.cfg.user}" มีสิทธิ์กว้างเกินขอบเขตที่ตกลงไว้ (${tooWide.join(' · ')}) — ` +
          'ขอให้ฝ่าย ERP GRANT เฉพาะ INSERT+SELECT บน tbl_CountHdr/tbl_CountDtl และ ' +
          'SELECT+INSERT+UPDATE บน RunningNumber เท่านั้น แล้วค่อย start ใหม่',
      );
    }

    const missing: string[] = [];
    if (row.can_write_hdr !== 1) missing.push('tbl_CountHdr');
    if (row.can_write_dtl !== 1) missing.push('tbl_CountDtl');
    if (row.can_write_run !== 1) missing.push('UPDATE บน RunningNumber');
    // nextNumber() มี fallback INSERT เมื่อยังไม่มีแถวของเดือนนั้น →
    // ขาดสิทธิ์นี้แล้วเอกสาร **ใบแรกของทุกเดือน** จะล้มกลางธุรกรรม
    if (row.can_insert_run !== 1) missing.push('INSERT บน RunningNumber (ใบแรกของเดือนใหม่)');
    if (row.can_read_run !== 1) missing.push('SELECT บน RunningNumber');
    if (row.can_read_hdr !== 1) missing.push('อ่าน tbl_CountHdr (ต้องใช้กันเอกสารซ้ำตอน retry)');
    if (row.can_read_dtl !== 1) missing.push('อ่าน tbl_CountDtl (ต้องใช้กันเอกสารซ้ำตอน retry)');
    if (missing.length > 0) {
      throw new ErpCountWriteError(
        'ERP_WRITE_SCOPE_INSUFFICIENT',
        `บัญชีเขียน "${this.cfg.user}" ยังเขียน ${missing.join(' / ')} ไม่ได้ — ` +
          'เปิด ERP_WRITEBACK_ENABLED ไว้แต่ส่งเอกสารไม่ได้จริง จึงไม่ยอม start',
      );
    }

    logger.log(
      `ตรวจสิทธิ์บัญชีเขียนผ่าน: เขียนได้เฉพาะ tbl_CountHdr / tbl_CountDtl / RunningNumber ` +
        `และแตะตารางยอดคงเหลือของ ERP ไม่ได้`,
    );
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
      .input('voucherDate', sql.DateTime, startOfDay(header.voucherDate))
      .input('empId', sql.NVarChar(20), clamp(header.empId, 20))
      .input('empName', sql.NVarChar(50), clamp(header.empName, 50))
      .input('countDate', sql.DateTime, startOfDay(header.countDate))
      .input('countNo', sql.NVarChar(2), clamp(header.countNo, 2))
      .input('countYear', sql.NVarChar(4), clamp(header.countYear, 4))
      .input('countNumber', sql.Numeric(18, 0), header.countNumber)
      .input(
        'remark',
        sql.NVarChar(sql.MAX),
        MssqlCountWriter.stampSession(header.remark, header.sessionId),
      )
      .input('entryBy', sql.NVarChar(20), clamp(header.entryBy, 20))
      .query(text);
  }

  private async insertLine(
    tx: sql.Transaction,
    transactionNo: number,
    voucherNo: string,
    line: ErpCountLine,
  ): Promise<void> {
    // ดู MssqlWriterConfig.dtlVoucherNo — ปิดไว้จนกว่าฝ่าย ERP จะยืนยันว่ามีคอลัมน์นี้
    const withVoucher = this.cfg.dtlVoucherNo;
    const text = `INSERT INTO tbl_CountDtl(
  TransactionNo,${withVoucher ? ' VoucherNo,' : ''} Number, ItemCode, Description, Warehouse,
  MainQty, MainUnits, CountQty, DifQty, RemarkDtl)
VALUES(@tx,${withVoucher ? ' @voucher,' : ''} @no, @sku, @description, @warehouse,
  @mainQty, @mainUnits, @countQty, @difQty, @remark)`;
    assertCountWriteSql(text);

    const request = new sql.Request(tx).input('tx', sql.Int, transactionNo);
    if (withVoucher) request.input('voucher', sql.NVarChar(20), voucherNo);

    await request
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

  /**
   * มาร์กเกอร์รอบนับที่ประทับไว้ใน `Remark` — รูปแบบ `TCL#<sessionId>#`
   *
   * ตั้งใจไม่ใช้ `[...]` เพราะวงเล็บเหลี่ยมเป็นอักขระพิเศษของ `LIKE` ใน T-SQL
   */
  static sessionMarker(sessionId: string): string {
    // '#' ในตัว id เองจะทำให้มาร์กเกอร์ของรอบหนึ่งกลายเป็น substring ของอีกรอบ
    // (id `A#B` → `TCL#A#B#` ซึ่ง LIKE '%TCL#A#%' จับได้) → เอกสารข้ามรอบกัน
    if (sessionId.includes('#')) {
      throw new ErpCountWriteError(
        'ERP_WRITE_CONFIG',
        `รหัสรอบนับห้ามมีอักขระ '#' (ได้รับ "${sessionId}") — ใช้เป็นตัวคั่นของมาร์กเกอร์ใน Remark`,
      );
    }
    return `TCL#${sessionId}#`;
  }

  /** ต่อมาร์กเกอร์รอบนับท้ายข้อความ `Remark` (ไม่ซ้ำถ้ามีอยู่แล้ว) */
  static stampSession(remark: string | null, sessionId: string): string {
    const marker = MssqlCountWriter.sessionMarker(sessionId);
    const base = (remark ?? '').trim();
    if (base.includes(marker)) return base;
    return base.length > 0 ? `${base} ${marker}` : marker;
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
        // ⚠️ `false` โดยเจตนา — `tbl_CountHdr.VoucherDate`/`CountDate` เป็น `datetime`
        //    ไร้ timezone และ `EntryDate` ใช้ `GETDATE()` ของ SQL Server (เวลาไทย)
        //    ถ้าปล่อย `true` เวลาที่เราเขียนจะเป็น UTC = ช้ากว่าอีกสองช่อง 7 ชม.
        //    ในเอกสารใบเดียวกัน · container ตั้ง TZ=Asia/Bangkok ไว้แล้ว
        useUTC: false,
        // ไม่มี readOnlyIntent ที่นี่โดยเจตนา — pool นี้ต้องเขียนได้
      },
      // เพดานเดียวกับฝั่งอ่าน (ERP_SQL_POOL_MAX) — ข้อตกลงกับฝ่าย ERP คือห้ามดูดจนอิ่ม
      pool: { max: cfg.poolMax, min: 0, idleTimeoutMillis: 30_000 },
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

type WriteScopeRow = {
  can_write_hdr: number | null;
  can_write_dtl: number | null;
  can_write_run: number | null;
  can_insert_run: number | null;
  can_read_run: number | null;
  can_read_hdr: number | null;
  can_read_dtl: number | null;
  can_write_item: number | null;
  can_write_flow_hdr: number | null;
  can_write_flow_dtl: number | null;
  is_sysadmin: number | null;
  is_db_owner: number | null;
  is_db_datawriter: number | null;
};

/** escape ตัวอักษรพิเศษของ LIKE — `%` `_` `[` `]` และ `\` เอง */
function likeEscape(value: string): string {
  return value.replace(/[\\%_[\]]/g, (ch) => `\\${ch}`);
}

/**
 * เตือนเมื่อทศนิยมตำแหน่งที่ 3 จะหายไปกับ `decimal(18,2)` ของ ERP
 *
 * ระบบเราเก็บ `numeric(18,3)` — ปัดทิ้งเงียบ ๆ แล้วยอดรวมใน ERP กับรายงาน
 * ส่วนต่างของเราจะไม่ตรงกันโดยไม่มีร่องรอยว่าเกิดที่ไหน
 */
function warnIfPrecisionLost(lines: readonly ErpCountLine[]): void {
  const lost = lines.filter(
    (line) => round2(line.mainQty) !== line.mainQty || round2(line.countQty) !== line.countQty,
  );
  if (lost.length === 0) return;
  const sample = lost
    .slice(0, 10)
    .map((line) => `${line.sku}(${line.mainQty}→${round2(line.mainQty)} · ${line.countQty}→${round2(line.countQty)})`)
    .join(', ');
  logger.warn(
    `ปัดทศนิยมตำแหน่งที่ 3 ทิ้ง ${lost.length} รายการเพื่อให้พอดี decimal(18,2) ของ ERP: ` +
      `${sample}${lost.length > 10 ? ' …' : ''}`,
  );
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
