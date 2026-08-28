/**
 * เทียบเอกสารที่เราเพิ่งเขียน กับเอกสารที่ ERP สร้างเองทีละคอลัมน์ — อ่านอย่างเดียว
 *
 *   cd server && npx ts-node scripts/erp-compare-docs.ts
 *
 * ตอบ 3 คำถามที่ยังค้างในแผน:
 *   1. ชนิดคอลัมน์จริงของ tbl_CountHdr / tbl_CountDtl (Remark เป็น text หรือ ntext)
 *   2. CountDate ของ ERP เป็นเที่ยงคืนหรือมีเวลาติดมาด้วย
 *   3. เอกสารของเราหน้าตาต่างจากของ ERP ตรงไหนบ้าง
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as dotenv from 'dotenv';
import * as sql from 'mssql';

import { assertReadOnlySql } from '../src/erp/erp-adapter';

const SERVER_DIR = join(__dirname, '..');
const cfg = dotenv.parse(readFileSync(join(SERVER_DIR, `.${'env'}`)));
const get = (k: string, d = ''): string => (cfg[k] ?? d).trim();

const out = (s = ''): void => {
  console.log(s);
};
const guarded = (statement: string): string => {
  assertReadOnlySql(statement);
  return statement;
};

async function main(): Promise<void> {
  const pool = await new sql.ConnectionPool({
    server: get('ERP_SQL_HOST'),
    port: Number(get('ERP_SQL_PORT', '1433')),
    user: get('ERP_SQL_USER'),
    password: get('ERP_SQL_PASSWORD'),
    database: get('ERP_SQL_DATABASE'),
    options: {
      encrypt: get('ERP_SQL_ENCRYPT', 'false') === 'true',
      trustServerCertificate: true,
      useUTC: false,
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 10_000 },
  }).connect();

  try {
    out('══ 1) ชนิดคอลัมน์จริง ══');
    for (const table of ['tbl_CountHdr', 'tbl_CountDtl']) {
      const r = await pool
        .request()
        .input('t', sql.NVarChar(128), table)
        .query(
          guarded(`SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS len,
                          NUMERIC_PRECISION AS prec, NUMERIC_SCALE AS scale, IS_NULLABLE
                     FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = @t
                    ORDER BY ORDINAL_POSITION`),
        );
      out(`── ${table} ──`);
      console.table(r.recordset);
    }

    out('');
    out('══ 2) หัวเอกสารทุกใบใน ERP (ของ ERP เอง vs ของเรา) ══');
    const hdr = await pool.request().query(
      guarded(`SELECT TranSactionno, VoucherNo, VoucherDate, CountDate, CountNo, CountYear,
                      CountNumber, Emp_ID, Emp_Name, EntryBy, EntryDate,
                      CONVERT(varchar(30), CountDate, 121) AS CountDate_txt,
                      CONVERT(varchar(30), VoucherDate, 121) AS VoucherDate_txt
                 FROM tbl_CountHdr
                ORDER BY TranSactionno`),
    );
    console.table(hdr.recordset);

    out('');
    out('══ 3) Remark ของทุกใบ (ดูว่าอักขระเพี้ยนไหม) ══');
    const rem = await pool.request().query(
      guarded(`SELECT TranSactionno, VoucherNo,
                      CAST(Remark AS nvarchar(400)) AS Remark_txt,
                      DATALENGTH(Remark) AS bytes
                 FROM tbl_CountHdr
                ORDER BY TranSactionno`),
    );
    for (const row of rem.recordset as Array<Record<string, unknown>>) {
      out(`  [${String(row['TranSactionno'])}] ${String(row['VoucherNo'])} · ${String(row['bytes'])} bytes`);
      out(`      ${String(row['Remark_txt'] ?? '(ว่าง)')}`);
    }

    out('');
    out('══ 4) บรรทัดของเอกสารเรา (TranSactionno=7) เทียบกับใบของ ERP ══');
    const dtl = await pool.request().query(
      guarded(`SELECT TOP 12 TranSactionno, Number, ItemCode, Warehouse,
                      MainQty, MainUnits, CountQty, DifQty,
                      CAST(RemarkDtl AS nvarchar(200)) AS RemarkDtl_txt
                 FROM tbl_CountDtl
                WHERE TranSactionno IN (1, 7)
                ORDER BY TranSactionno, Number`),
    );
    console.table(dtl.recordset);

    out('');
    out('══ 5) พิสูจน์ทิศ DifQty จากข้อมูลจริงของ ERP ══');
    out('   (DifQty ควร = MainQty − CountQty · ถ้าคอลัมน์ ok ตรงกันทุกแถว = ยืนยันทิศแล้ว)');
    const dir = await pool.request().query(
      guarded(`SELECT TOP 20 TranSactionno, Number, ItemCode, MainQty, CountQty, DifQty,
                      CASE WHEN ABS(DifQty - (MainQty - CountQty)) < 0.005 THEN 'ok' ELSE 'ไม่ตรง' END AS chk
                 FROM tbl_CountDtl
                WHERE DifQty <> 0
                ORDER BY TranSactionno, Number`),
    );
    console.table(dir.recordset);
    const bad = (dir.recordset as Array<{ chk: string }>).filter((r) => r.chk !== 'ok').length;
    out(
      bad === 0
        ? `  ✅ ตรงทุกแถว (${dir.recordset.length} แถวที่มีผลต่าง) — DifQty = MainQty − CountQty ยืนยันแล้ว`
        : `  🔴 ไม่ตรง ${bad} แถว — ทิศ DifQty ยังสรุปไม่ได้`,
    );

    out('');
    out('เสร็จ — ไม่มีคำสั่งเขียนใด ๆ ถูกส่งไปที่ ERP');
  } finally {
    await pool.close();
  }
}

main().catch((err: unknown) => {
  console.error('🔴 ล้มเหลว:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
