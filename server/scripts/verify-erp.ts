/**
 * ตรวจสุขภาพการเชื่อมต่อ ERP และความแม่นของสูตรยอดคงเหลือ
 *
 *   cd server && npx ts-node scripts/verify-erp.ts [รหัสคลัง]
 *
 * ── 🚫 กฎเหล็ก: สคริปต์นี้ **อ่านอย่างเดียว** ──────────────────────────────
 *   - ไม่มีคำสั่ง CREATE / INSERT / UPDATE / DELETE ใด ๆ
 *   - ทุก statement ต้องผ่าน `assertReadOnlySql()` (กฎเหล็กชั้นที่ 3 ตัวเดียวกับที่
 *     driver ใช้) ก่อนถูกส่งเข้า connection ของ ERP เสมอ
 *   - สคริปต์นี้ตรวจสิทธิ์เองด้วย metadata function ชุดเดียวกับ
 *     `MssqlDriver.verifyReadOnly()` — เมธอดนั้น **ไม่เคยเขียนอะไรลง ERP**
 *     ใช้ `IS_SRVROLEMEMBER` / `IS_ROLEMEMBER` / `HAS_PERMS_BY_NAME` ล้วน ๆ
 *     (ดู server/src/erp/drivers/mssql.driver.ts) ผลลัพธ์ของ boot probe มี 3 ทาง:
 *       · ตอบว่าเขียนได้ → `ERP_WRITE_ALLOWED` → ปฏิเสธการ start
 *       · ตอบ NULL (สรุปไม่ได้) → `ERP_PROBE_INCONCLUSIVE` → ปฏิเสธการ start
 *       · ต่อ ERP ไม่ได้ → `ERP_UNREACHABLE` → start ได้แบบ degraded
 *     ที่นี่ไม่เรียกเมธอดนั้นตรง ๆ เพราะมันผูกกับ NestJS config ของ runtime
 *   - ไม่พิมพ์ host / user / password ออกทาง stdout
 *
 * ใช้เมื่อไหร่:
 *   - ได้ login `db_datareader` ใหม่ → ยืนยันว่าอ่านได้และเขียนไม่ได้จริง
 *   - ฝ่าย ERP ตอบเรื่องคลัง WHRM → ตรวจว่ายอดมาครบหรือยัง
 *   - ก่อน go-live ทุกครั้ง → ยืนยันว่าสูตรยังตรงกับรอบนับของ ERP
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as dotenv from 'dotenv';
import * as sql from 'mssql';

import { assertReadOnlySql } from '../src/erp/erp-adapter';

const SERVER_DIR = join(__dirname, '..');
const ENV_PATH = join(SERVER_DIR, `.${'env'}`);

const cfg = dotenv.parse(readFileSync(ENV_PATH));
const get = (key: string, fallback = ''): string => (cfg[key] ?? fallback).trim();

const WAREHOUSE = (process.argv[2] ?? get('WAREHOUSE_CODE', 'WHFG')).trim();
const SCRIPT = readFileSync(join(SERVER_DIR, 'sql/erp/inventory-items-with-balance.sql'), 'utf8');

const out = (s = ''): void => {
  console.log(s);
};
const yes = (v: unknown): boolean => v === 1 || v === true;

/**
 * ด่านเดียวกับที่ driver ใช้ — statement ไหนไม่ผ่านจะ throw ก่อนถึง ERP
 * สคริปต์นี้เป็น connection ที่ต่อ ERP นอก runtime จึงต้องเรียกเอง ทุกครั้ง ทุก statement
 */
const guarded = (statement: string): string => {
  assertReadOnlySql(statement);
  return statement;
};

interface Diag {
  rows_isclosed_null: number;
  rows_approved_null: number;
  items_active: number;
  items_with_movement: number;
  min_balance: number | null;
}

interface Perms {
  is_sysadmin: number;
  is_db_owner: number;
  is_db_datareader: number;
  is_db_datawriter: number;
  can_insert: number;
  can_update: number;
  can_delete: number;
  can_select: number;
}

async function main(): Promise<void> {
  let failures = 0;

  out(`คลังที่ตรวจ: ${WAREHOUSE}`);
  out();

  const pool = await new sql.ConnectionPool({
    server: get('ERP_SQL_HOST'),
    port: Number(get('ERP_SQL_PORT', '1433')),
    user: get('ERP_SQL_USER'),
    password: get('ERP_SQL_PASSWORD'),
    database: get('ERP_SQL_DATABASE'),
    options: {
      encrypt: get('ERP_SQL_ENCRYPT', 'false').toLowerCase() === 'true',
      trustServerCertificate: get('ERP_SQL_TRUST_SERVER_CERT', 'true').toLowerCase() !== 'false',
    },
    connectionTimeout: Number(get('ERP_TIMEOUT_MS', '20000')),
    // ⏱️ ยาวกว่างบของ runtime (ERP_TIMEOUT_MS) โดยตั้งใจ: สคริปต์นี้ทำ full scan
    //    ของ ledger ทั้งคลังและวนเทียบทุกรอบนับ ซึ่งกินเวลาเป็นนาทีบน db_TCL จริง
    //    ต่างจาก runtime ที่มีคนรอหน้าจอจึงต้องตัดจบเร็ว — ปรับได้ผ่าน env ถ้าเครื่องช้ากว่านี้
    requestTimeout: Number(get('ERP_VERIFY_TIMEOUT_MS', '120000')),
    // ต่อไม่เกิน 2 connection: สคริปต์ยิงทีละ query อยู่แล้ว และ ERP เป็นเครื่อง production
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
  }).connect();
  out('✅ เชื่อมต่อ ERP สำเร็จ');
  out();

  // ── 1. สิทธิ์ของ login (กฎเหล็กชั้นที่ 1) ────────────────────────────
  out('── สิทธิ์ของ login (ตรวจด้วย metadata ไม่ได้ลองเขียน) ──');
  const perms = (
    await pool.request().query<Perms>(guarded(`
      SELECT IS_SRVROLEMEMBER('sysadmin')                     AS is_sysadmin,
             IS_ROLEMEMBER('db_owner')                        AS is_db_owner,
             IS_ROLEMEMBER('db_datareader')                   AS is_db_datareader,
             IS_ROLEMEMBER('db_datawriter')                   AS is_db_datawriter,
             HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT') AS can_insert,
             HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UPDATE') AS can_update,
             HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','DELETE') AS can_delete,
             HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','SELECT') AS can_select`))
  ).recordset[0];

  const writable =
    yes(perms.is_sysadmin) ||
    yes(perms.is_db_owner) ||
    yes(perms.is_db_datawriter) ||
    yes(perms.can_insert);

  out(`  อ่านได้ (SELECT) : ${yes(perms.can_select) ? 'ใช่' : 'ไม่'}`);
  out(`  เขียนได้         : ${writable ? 'ใช่' : 'ไม่'}`);
  if (!yes(perms.can_select)) {
    out('  🔴 อ่านไม่ได้ — login นี้ใช้กับระบบไม่ได้');
    failures += 1;
  }
  if (writable) {
    out('  🔴 login นี้เขียน ERP ได้ → boot probe จะปฏิเสธการ start (ถูกต้องตามกฎเหล็ก)');
    out('     ต้องขอ login สิทธิ์ db_datareader จากฝ่าย ERP');
    failures += 1;
  } else {
    out('  ✅ อ่านอย่างเดียวจริง — ผ่านกฎเหล็กชั้นที่ 1');
  }
  out();

  // ── 2. diagnostic ของสูตร ────────────────────────────────────────────
  out('── diagnostic ของสูตรยอดคงเหลือ ──');
  // ต้นฉบับเขียนไว้ให้ sqlcmd (`'$(warehouse)'`) — ที่นี่แปลง token นั้นเป็นตัวแปร @warehouse
  // แล้วผูกค่าแบบ parameter แทนการแทนสตริงลง SQL ตรง ๆ (กันรหัสคลังแปลกปลอมเข้าไปในคำสั่ง)
  const diagSql = readFileSync(join(SERVER_DIR, 'sql/erp/verify-balance.sql'), 'utf8').replace(
    /'?\$\(warehouse\)'?/g,
    '@warehouse',
  );
  const diag = (
    await pool
      .request()
      .input('warehouse', sql.NVarChar(50), WAREHOUSE)
      .query<Diag>(guarded(diagSql))
  ).recordset[0];
  out(`  เอกสารที่ IsClosed เป็น NULL : ${diag.rows_isclosed_null}`);
  out(`  เอกสารที่ Approved เป็น NULL : ${diag.rows_approved_null}`);
  out(`  สินค้าที่ยังใช้งาน           : ${diag.items_active}`);
  out(`  สินค้าที่มีความเคลื่อนไหว     : ${diag.items_with_movement}`);
  out(`  ยอดต่ำสุดที่คำนวณได้         : ${diag.min_balance ?? 'ไม่มีข้อมูล'}`);

  if (diag.rows_isclosed_null > 0 || diag.rows_approved_null > 0) {
    out('  ⚠️ มีเอกสารที่ค่าว่าง — เงื่อนไขของสูตรจะตัดทิ้ง ต้องยืนยันกับฝ่าย ERP');
  }
  if (diag.items_with_movement === 0) {
    out(`  🔴 ไม่มีความเคลื่อนไหวของคลัง ${WAREHOUSE} เลย — ตรวจว่ารหัสคลังถูกต้องหรือไม่`);
    failures += 1;
  }
  out();

  // ── 3. ความแม่น เทียบกับรอบนับของ ERP ────────────────────────────────
  out('── ความแม่น เทียบกับ tbl_CountDtl.MainQty ของ ERP ──');
  const sessions = (
    await pool.request().input('wh', sql.NVarChar(50), WAREHOUSE).query<{
      tno: number;
      vno: string;
      countDate: Date;
    }>(guarded(`
      SELECT h.TransactionNo AS tno, LTRIM(RTRIM(h.VoucherNo)) AS vno, h.CountDate AS countDate
        FROM dbo.tbl_CountHdr h WITH (NOLOCK)
        JOIN dbo.tbl_CountDtl d WITH (NOLOCK) ON d.TransactionNo = h.TransactionNo
       GROUP BY h.TransactionNo, h.VoucherNo, h.CountDate
      HAVING MAX(LTRIM(RTRIM(d.Warehouse))) = @wh
       ORDER BY h.CountDate`))
  ).recordset;

  if (sessions.length === 0) {
    out(`  ⚠️ ไม่มีรอบนับของคลัง ${WAREHOUSE} ใน ERP — เทียบความแม่นไม่ได้`);
  }

  for (const s of sessions) {
    const ref = (
      await pool.request().input('tno', sql.Int, s.tno).query<{ sku: string; qty: number }>(guarded(`
        SELECT LTRIM(RTRIM(ItemCode)) AS sku, SUM(MainQty) AS qty
          FROM dbo.tbl_CountDtl WITH (NOLOCK)
         WHERE TransactionNo = @tno
         GROUP BY LTRIM(RTRIM(ItemCode))`))
    ).recordset;

    // ⚠️ CountDate ไม่มีเวลากำกับ (เที่ยงคืนเสมอ) → ยอดที่ ERP freeze คือยอดถึง
    //    "สิ้นวันก่อนวันนับ" ต้องลบ 1 ms ไม่งั้นกลายเป็นรวมความเคลื่อนไหวของวันที่นับด้วย
    //    (จุดนี้คือสาเหตุที่สูตรเคยดูเหมือนตรงแค่ 52% — ดู docs/erp-tcl-findings.md §6.6)
    const asOf = new Date(new Date(s.countDate).getTime() - 1);

    const req = pool.request();
    req.input('warehouse', sql.NVarChar(50), WAREHOUSE);
    req.input('asOf', sql.DateTime2, asOf);
    // script อ้าง @skus ด้วย (NULL = ทั้งคลัง) — driver ผูกให้เสมอ ที่นี่ก็ต้องผูก
    // ไม่งั้น SQL Server ตอบ "Must declare the scalar variable @skus" ทุกครั้ง
    req.input('skus', sql.NVarChar(sql.MAX), null);
    const calc = (await req.query<{ ItemCode: string; on_hand: number | null }>(guarded(SCRIPT)))
      .recordset;
    const bySku = new Map(calc.map((r) => [String(r.ItemCode), r.on_hand]));

    let match = 0;
    for (const r of ref) {
      const got = bySku.get(String(r.sku));
      if (got !== undefined && got !== null && Math.abs(Number(got) - Number(r.qty)) < 0.001) {
        match += 1;
      }
    }
    const pct = ref.length === 0 ? 0 : (match / ref.length) * 100;
    const mark = match === ref.length ? '✅' : pct >= 95 ? '⚠️' : '🔴';
    out(
      `  ${mark} ${s.vno} (นับ ${new Date(s.countDate).toISOString().slice(0, 10)}) ` +
        `ตรง ${match}/${ref.length} = ${pct.toFixed(1)}%`,
    );
    if (pct < 95) failures += 1;
  }

  await pool.close();
  out();
  out('เสร็จ — ไม่มีคำสั่งเขียนใด ๆ ถูกส่งไปที่ ERP');

  if (failures > 0) {
    out(`\n🔴 มี ${failures} เรื่องที่ต้องแก้ก่อนใช้งานจริง`);
    process.exitCode = 1;
  } else {
    out('\n✅ ผ่านทุกข้อ');
  }
}

main().catch((err: unknown) => {
  console.error('ล้มเหลว:', err instanceof Error ? err.message : String(err));
  console.error('ตรวจ: firewall เปิดพอร์ตให้เครื่องนี้หรือยัง · host/login ถูกต้องไหม');
  process.exitCode = 1;
});
