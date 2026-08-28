/**
 * ยิงเอกสารนับทดสอบเข้า ERP จริง 1 ใบ — ใช้ MssqlCountWriter ตัวจริง
 *
 *   cd server && npx ts-node scripts/erp-live-test.ts
 *
 * ⚠️ สคริปต์นี้ **เขียนลง ERP จริง** และลบไม่ได้
 *    ใช้บัญชี ERP_SQL_USER (ปัจจุบันคือ sa) เพราะยังไม่มี tcl_writer
 *    จึงข้ามด่าน boot ของ NestJS ที่ปฏิเสธบัญชีสิทธิ์กว้าง
 *
 * เอกสารที่เขียน: 1 บรรทัด · CountQty = MainQty → DifQty = 0
 * ตั้งใจให้ไม่กระทบส่วนต่างใด ๆ และหาเจอง่ายด้วยมาร์กเกอร์ TCL#<id># ใน Remark
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as dotenv from 'dotenv';
import * as sql from 'mssql';

import { erpDifQty, MssqlCountWriter } from '../src/erp/drivers/mssql-count-writer';
import type { ErpCountHeader, ErpCountLine } from '../src/erp/erp-count-writer';

const SERVER_DIR = join(__dirname, '..');
const cfg = dotenv.parse(readFileSync(join(SERVER_DIR, `.${'env'}`)));
const get = (k: string, d = ''): string => (cfg[k] ?? d).trim();

const WAREHOUSE = (process.argv[2] ?? get('WAREHOUSE_CODE', 'WHFG')).trim();
const out = (s = ''): void => {
  console.log(s);
};

async function main(): Promise<void> {
  const host = get('ERP_SQL_HOST');
  const database = get('ERP_SQL_DATABASE');
  const user = get('ERP_SQL_USER');
  const password = get('ERP_SQL_PASSWORD');
  const port = Number(get('ERP_SQL_PORT', '1433'));

  out(`คลัง: ${WAREHOUSE} · ฐาน: ${database}`);
  out('');

  // ── 1) หยิบรายการจริงที่ ERP เคยรับไว้แล้ว (อ่านอย่างเดียว) ────────────────
  const pool = await new sql.ConnectionPool({
    server: host,
    port,
    user,
    password,
    database,
    options: { encrypt: get('ERP_SQL_ENCRYPT', 'false') === 'true', trustServerCertificate: true },
    pool: { max: 2, min: 0, idleTimeoutMillis: 10_000 },
  }).connect();

  const probe = await pool
    .request()
    .input('wh', sql.NVarChar(20), WAREHOUSE)
    .query<{
      ItemCode: string;
      Description: string | null;
      Warehouse: string;
      MainQty: number;
      MainUnits: string | null;
    }>(
      `SELECT TOP 1 ItemCode, Description, Warehouse, MainQty, MainUnits
         FROM dbo.tbl_CountDtl
        WHERE Warehouse = @wh AND MainQty > 0
        ORDER BY Roworder DESC`,
    );

  if (probe.recordset.length === 0) {
    out(`🔴 ไม่พบรายการตัวอย่างในคลัง ${WAREHOUSE} — หยุด ไม่เขียนอะไรทั้งสิ้น`);
    await pool.close();
    return;
  }

  const src = probe.recordset[0];
  const mainQty = Number(src.MainQty);
  const countQty = mainQty; // ผลต่าง = 0 โดยตั้งใจ

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const sessionId = `TCL-LIVETEST-${stamp}`; // ห้ามมี '#'

  const header: ErpCountHeader = {
    voucherDate: now,
    countDate: now,
    empId: null,
    empName: 'ทดสอบระบบ TCL',
    countNo: '1',
    countYear: String(now.getFullYear()),
    countNumber: 1,
    remark: 'เอกสารทดสอบจากระบบนับสต็อก TCL — ผลต่าง 0 · ลบได้',
    entryBy: 'tcl-livetest',
    sessionId,
  };

  const lines: ErpCountLine[] = [
    {
      lineNo: 1,
      sku: src.ItemCode,
      description: src.Description ?? src.ItemCode,
      warehouse: src.Warehouse,
      mainQty,
      mainUnits: src.MainUnits,
      countQty,
      remark: 'ทดสอบเส้นทางเขียนกลับ',
    },
  ];

  out('── เอกสารที่กำลังจะเขียน ──');
  out(`  sessionId : ${sessionId}`);
  out(`  Remark    : ${header.remark} [+ มาร์กเกอร์ TCL#${sessionId}#]`);
  out(`  ItemCode  : ${lines[0].sku}`);
  out(`  รายละเอียด: ${lines[0].description}`);
  out(`  คลัง      : ${lines[0].warehouse}`);
  out(`  MainQty   : ${mainQty} ${lines[0].mainUnits ?? ''}`);
  out(`  CountQty  : ${countQty}`);
  out(`  DifQty    : ${erpDifQty(mainQty, countQty)}   (ต้องเป็น 0)`);
  out('');

  // ── 2) เขียนจริง ────────────────────────────────────────────────────────────
  const writer = new MssqlCountWriter({
    host,
    port,
    user,
    password,
    database,
    encrypt: get('ERP_SQL_ENCRYPT', 'false') === 'true',
    trustServerCert: true,
    timeoutMs: Number(get('ERP_TIMEOUT_MS', '15000')),
    poolMax: Number(get('ERP_SQL_POOL_MAX', '3')),
    dtlVoucherNo: get('ERP_WRITEBACK_DTL_VOUCHERNO', 'false') === 'true',
  });

  try {
    out('── กำลังเขียน ──');
    const result = await writer.writeCountDocument(header, lines);
    out(`✅ เขียนสำเร็จ`);
    out(`  VoucherNo     : ${result.voucherNo}`);
    out(`  TransactionNo : ${result.transactionNo}`);
    out(`  จำนวนบรรทัด   : ${result.rowCount}`);
    out('');

    // ── 3) อ่านกลับด้วยกลไก reconcile ตัวจริง ────────────────────────────────
    out('── ตรวจย้อน: findDocumentBySession() ──');
    const found = await writer.findDocumentBySession(sessionId);
    out(
      found
        ? `✅ หาเจอ: ${found.voucherNo} (TransactionNo=${found.transactionNo}, ${found.rowCount} บรรทัด)`
        : '🔴 หาไม่เจอ — กลไกกันเอกสารซ้ำจะใช้ไม่ได้',
    );
    out('');

    // ── 4) อ่านแถวจริงที่เขียนไป ────────────────────────────────────────────
    out('── แถวจริงใน ERP ──');
    const hdr = await pool
      .request()
      .input('tx', sql.Numeric(18, 0), result.transactionNo)
      .query(
        `SELECT TranSactionno, VoucherNo, VoucherDate, CountDate, CountNo, CountYear,
                CountNumber, Emp_Name, EntryBy, Remark
           FROM dbo.tbl_CountHdr WHERE TranSactionno = @tx`,
      );
    console.table(hdr.recordset);

    const dtl = await pool
      .request()
      .input('tx', sql.Numeric(18, 0), result.transactionNo)
      .query(
        `SELECT Number, ItemCode, Description, Warehouse, MainQty, MainUnits, CountQty, DifQty
           FROM dbo.tbl_CountDtl WHERE TranSactionno = @tx ORDER BY Number`,
      );
    console.table(dtl.recordset);

    out('');
    out('🧹 ถ้าจะให้ฝ่าย ERP ลบเอกสารทดสอบใบนี้ ให้ส่งข้อความนี้:');
    out(`   ลบเอกสารนับ VoucherNo = ${result.voucherNo} / TranSactionno = ${result.transactionNo}`);
    out(`   (Remark มีมาร์กเกอร์ TCL#${sessionId}#)`);
  } finally {
    await writer.close();
    await pool.close();
  }
}

main().catch((err: unknown) => {
  console.error('🔴 ล้มเหลว:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
