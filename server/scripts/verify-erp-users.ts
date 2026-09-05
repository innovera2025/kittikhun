/**
 * Phase 0 recon ของแผนล็อกอินผ่าน ERP — ตอบ U1/U3 ด้วยข้อมูล `menuuser` จริง
 *
 *   cd server && npx ts-node scripts/verify-erp-users.ts
 *   cd server && npm run verify:erp-users
 *
 * ── 🚫 กฎเหล็กข้อที่ 1: ห้าม plaintext รหัสผ่านหลุดออกทาง stdout ────────────
 *   สคริปต์นี้ดึง `a_Password` มาจริง (เพราะ query ของ sync ดึงมาจริง) แต่ค่านั้น
 *   ถูกห่อเป็น `ErpSecret` ตั้งแต่ใน driver แล้ว — ที่นี่แตะมันได้ทางเดียวคือ
 *   `.expose()` ซึ่งถูกเรียกในบรรทัดเดียวเพื่อ **นับ** เท่านั้น (ว่าง / มี U+FFFD /
 *   มีอักขระนอก ASCII) ไม่มีบรรทัดไหนพิมพ์ค่าจริง ไม่มีตัวแปรไหนเก็บค่าจริงไว้
 *   ตัวเลขที่พิมพ์ออกมาเป็น "จำนวนแถว" ล้วน ไม่ผูกกับว่าแถวไหนคือใคร
 *
 * ── 🚫 กฎเหล็กข้อที่ 2: อ่านอย่างเดียวทั้งสองฐาน ───────────────────────────
 *   - ฝั่ง ERP: ไม่ยิง SQL เอง แต่เรียก `MssqlDriver.fetchUsers()` ตัวจริง ซึ่งวิ่งผ่าน
 *     `assertReadOnlySql()` + write-probe ตอนแรกใช้งาน (กฎเหล็กชั้นที่ 2 และ 3)
 *     ผลพลอยได้ที่ตั้งใจ: รายงานนี้เห็น **ค่าเดียวกับที่ sync จะเห็นจริง** ทุกตัว
 *     ทั้ง query ที่ override ด้วย `ERP_SQL_USERS_SQL_FILE`, การ decode ภาษาไทยตาม
 *     `ERP_SQL_CHARSET` และ timeout ตาม `ERP_TIMEOUT_MS` — ไม่ใช่ query สำเนาที่ drift ได้
 *   - ฝั่ง Postgres ของเรา: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`
 *     ตั้งแต่บรรทัดแรก → คำสั่งเขียนใด ๆ ถูก engine ปฏิเสธ ไม่ใช่แค่ "ตั้งใจไม่เขียน"
 *   - ไม่พิมพ์ host / user / password ของการเชื่อมต่อทั้งสองฝั่ง
 *
 * คำถามที่ต้องตอบให้ได้ก่อนเปิด `ERP_USER_SYNC_ENABLED=true` (ดู Cutover Phase 0):
 *   U1 — `user_level` มีค่าอะไรบ้าง ค่าไหนควร map เป็น admin/staff/viewer
 *   U3 — `menuuser.emp_id` ตรงรูปแบบไหม และเป็นคนเดียวกับ `users.emp_id` เดิมกี่ %
 *   + จำนวนแถวรวม สำหรับตั้ง `ERP_USER_MIN_EXPECTED_ROWS`
 *
 * ⚠️ รันที่ไหน: เครื่องที่ `npm ci` แล้ว (มี ts-node) และต่อได้ทั้ง ERP และ Postgres ของเรา
 *    **รันในคอนเทนเนอร์ production ไม่ได้** — image ไม่มี `scripts/` และ ts-node ถูก
 *    `npm prune --omit=dev` ตัดทิ้ง (ปัญหาเดียวกับที่เคยทำให้ `npm run create-admin` ใช้ไม่ได้)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';

import type { AppConfig } from '../src/config/env.config';
import { MssqlDriver } from '../src/erp/drivers/mssql.driver';
import type { ErpUserRow } from '../src/erp/erp-adapter';

const SERVER_DIR = join(__dirname, '..');
const ENV_PATH = join(SERVER_DIR, `.${'env'}`);

const fileCfg: Record<string, string> = existsSync(ENV_PATH)
  ? dotenv.parse(readFileSync(ENV_PATH))
  : {};

/** process.env ชนะไฟล์ .env — ให้ override ค่าเฉพาะรอบได้โดยไม่ต้องแก้ไฟล์ */
const raw = (key: string): string | undefined => {
  const value = (process.env[key] ?? fileCfg[key])?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/** คีย์ที่ driver เทียบเป็น boolean แท้ (`=== true`) ไม่ใช่สตริง */
const BOOL_KEYS = new Set([
  'ERP_SQL_ENCRYPT',
  'ERP_SQL_TRUST_SERVER_CERT',
  'ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT',
]);

/**
 * ConfigService ปลอมที่อ่านจาก .env ตรง ๆ — รูปแบบเดียวกับ `test/support/test-db.ts`
 * (`undefined` เมื่อไม่ได้ตั้ง เพื่อให้ default ของ zod ใน driver ทำงานตามปกติ)
 */
const cfg = {
  get: (key: string): unknown => {
    const value = raw(key);
    if (BOOL_KEYS.has(key)) return value === undefined ? undefined : value.toLowerCase() === 'true';
    return value;
  },
} as unknown as ConfigService<AppConfig, true>;

/** เดียวกับที่ `runUsers()` ใช้ตัดสินว่าแถวไหนใช้เป็น `users.emp_id` ได้ */
const EMP_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
/** U+FFFD — สัญญาณว่า decode charset ผิด (เงื่อนไขเดียวกับที่ `runUsers()` ใช้ปฏิเสธแถว) */
const REPLACEMENT_CHAR = '�';
const MAX_SAMPLE = 15;

const out = (s = ''): void => {
  console.log(s);
};

/** พิมพ์ค่าพร้อมเครื่องหมายคำพูด เพื่อให้ช่องว่างหัว/ท้ายที่ ERP pad มามองเห็นด้วยตา */
const q = (value: string): string => JSON.stringify(value);

const pct = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

const sample = (values: readonly string[]): string =>
  values.slice(0, MAX_SAMPLE).map(q).join(', ') +
  (values.length > MAX_SAMPLE ? ` … (อีก ${values.length - MAX_SAMPLE} รายการ)` : '');

interface LevelStat {
  /** ค่าดิบจาก ERP ไม่ trim — ถ้า ERP pad ช่องว่างมา ต้องเห็นตรงนี้ */
  raw: string;
  rows: number;
  /** ตัวอย่าง user_name ของ level นี้ ช่วยให้คนเดาได้ว่าเป็นกลุ่มงานอะไร */
  logins: string[];
}

function levelStats(rows: readonly ErpUserRow[]): LevelStat[] {
  const byLevel = new Map<string, LevelStat>();
  for (const row of rows) {
    const stat = byLevel.get(row.userLevel) ?? { raw: row.userLevel, rows: 0, logins: [] };
    stat.rows += 1;
    if (stat.logins.length < 3) stat.logins.push(row.loginName.trim());
    byLevel.set(row.userLevel, stat);
  }
  return [...byLevel.values()].sort((a, b) => b.rows - a.rows);
}

async function main(): Promise<void> {
  let failures = 0;
  let warnings = 0;

  out('── Phase 0 recon: menuuser ของ ERP ──');
  out(`  query ที่ใช้ : ${raw('ERP_SQL_USERS_SQL_FILE') ?? 'DEFAULT_USERS_SQL ในตัว driver'}`);
  out(`  charset     : ${raw('ERP_SQL_CHARSET') ?? 'utf8 (ค่าเริ่มต้น)'}`);
  out();

  const driver = new MssqlDriver(cfg);
  let rows: ErpUserRow[];
  try {
    rows = await driver.fetchUsers();
  } finally {
    await driver.close();
  }

  // ── 1. จำนวนแถวรวม (ใช้ตั้ง ERP_USER_MIN_EXPECTED_ROWS) ───────────────────
  out('── 1. จำนวนแถวรวม ──');
  out(`  menuuser ทั้งตาราง : ${rows.length} แถว`);
  if (rows.length === 0) {
    out('  🔴 ไม่มีแถวเลย — ตรวจสิทธิ์ของ login ที่ใช้อ่าน menuuser ก่อนทำอะไรต่อ');
    failures += 1;
  } else {
    // เพดานล่างแบบระมัดระวัง: ยอมให้ ERP หายไปได้ 10% ก่อนที่ sync จะปฏิเสธการ deactivate
    out(`  แนะนำตั้ง ERP_USER_MIN_EXPECTED_ROWS=${Math.max(1, Math.floor(rows.length * 0.9))}`);
    out('  (= 90% ของแถวที่เห็นตอนนี้ — ต่ำกว่านี้แปลว่า query ถูกตัดทอน ห้าม deactivate ใคร)');
  }
  out();

  // ── 2. U1: user_level ที่พบจริง ───────────────────────────────────────────
  out('── 2. U1 — user_level ที่พบจริง (allowlist: ค่าที่ไม่ map = ไม่ได้บัญชีเลย) ──');
  const levels = levelStats(rows);
  for (const level of levels) {
    const padded = level.raw !== level.raw.trim() ? '  ⚠️ มีช่องว่างหัว/ท้าย' : '';
    out(
      `  ${q(level.raw).padEnd(12)} ${String(level.rows).padStart(5)} แถว ` +
        `(${pct(level.rows, rows.length).padStart(6)})  ตัวอย่าง: ${level.logins.join(', ')}${padded}`,
    );
  }
  if (levels.some((level) => level.raw !== level.raw.trim())) {
    out();
    out('  ⚠️ user_level บางค่ามีช่องว่างติดมา — `ERP_USER_LEVEL_ROLE_MAP` เทียบแบบตรงตัว');
    out('     ต้องใส่ค่าที่มีช่องว่างลงใน map ไม่ได้ → ต้อง override query ด้วย');
    out('     ERP_SQL_USERS_SQL_FILE ที่ LTRIM/RTRIM ให้ ไม่งั้นจะไม่มีใคร map ได้เลย');
    warnings += 1;
  }
  out();
  out('  🖐 ต้องมีคนตัดสินใจ: level ไหน = admin / staff / viewer');
  out(`     โครงที่ต้องเติมเอง: ERP_USER_LEVEL_ROLE_MAP=${levels
    .slice(0, 5)
    .map((level) => `${level.raw.trim()}=???`)
    .join(',')}`);
  out('     ⚠️ ต้องมีอย่างน้อย 1 ค่าที่ map เป็น admin ไม่งั้น server บูตไม่ขึ้น (ตั้งใจ)');
  out();

  // ── 3. U3 (รูปแบบ): emp_id ผ่าน regex ที่ users.emp_id ใช้ไหม ─────────────
  out('── 3. U3 (รูปแบบ) — menuuser.emp_id ผ่าน ^[A-Za-z0-9._-]{1,32}$ ไหม ──');
  const trimmedOk: string[] = [];
  const rejected: string[] = [];
  let paddedEmpCodes = 0;
  for (const row of rows) {
    if (row.empCode !== row.empCode.trim()) paddedEmpCodes += 1;
    // sync trim ก่อนตรวจเสมอ (`runUsers()`) → ตัวเลขที่มีความหมายจริงคือหลัง trim
    if (EMP_ID_RE.test(row.empCode.trim())) trimmedOk.push(row.empCode.trim());
    else rejected.push(row.empCode);
  }
  out(`  ผ่านรูปแบบ (หลัง trim) : ${trimmedOk.length}/${rows.length} = ${pct(trimmedOk.length, rows.length)}`);
  out(`  มีช่องว่างหัว/ท้าย     : ${paddedEmpCodes} แถว (sync trim ให้เอง ไม่เป็นปัญหา)`);
  if (rejected.length > 0) {
    out(`  🔴 ไม่ผ่าน ${rejected.length} แถว → จะกลายเป็น anomaly \`rejected_row\` ทุกรอบ sync:`);
    out(`     ${sample(rejected)}`);
    warnings += 1;
  } else {
    out('  ✅ ผ่านทุกแถว');
  }
  // emp_id ซ้ำใน ERP เอง: `user_credentials.emp_id` เป็น UNIQUE → sync upsert ด้วย emp_id
  // แถวหลังจึงทับแถวก่อนแบบเงียบ ๆ (เหลือ login เดียวจากหลายบัญชี ERP) — ต้องเห็นก่อนคัตโอเวอร์
  const empCodeCounts = new Map<string, number>();
  for (const empCode of trimmedOk) empCodeCounts.set(empCode, (empCodeCounts.get(empCode) ?? 0) + 1);
  const dupEmpCodes = [...empCodeCounts.entries()].filter(([, n]) => n > 1);
  out(`  emp_id ซ้ำกันเองใน ERP : ${dupEmpCodes.length} ค่า`);
  if (dupEmpCodes.length > 0) {
    out('  🔴 หลายบัญชี ERP ใช้ emp_id เดียวกัน — sync จะเหลือ credential เดียวต่อ emp_id');
    out('     (แถวท้ายทับแถวหน้าเงียบ ๆ ไม่มี anomaly ให้เห็น) ต้องแก้ที่ ERP ก่อน');
    out(`     ${sample(dupEmpCodes.map(([empCode, n]) => `${empCode}×${n}`))}`);
    failures += 1;
  }
  out();

  // ── 4. login_name: ความยาว + ชนกันแบบไม่สนตัวพิมพ์ ────────────────────────
  out('── 4. user_name — ความยาวและการชนกันแบบไม่สนตัวพิมพ์เล็ก-ใหญ่ ──');
  const byLogin = new Map<string, string[]>();
  const tooLong: string[] = [];
  let emptyLogin = 0;
  for (const row of rows) {
    const login = row.loginName.trim().toLowerCase();
    if (login.length === 0) {
      emptyLogin += 1;
      continue;
    }
    if (login.length > 64) tooLong.push(row.loginName);
    byLogin.set(login, [...(byLogin.get(login) ?? []), row.empCode.trim()]);
  }
  const collisions = [...byLogin.entries()].filter(([, empCodes]) => empCodes.length > 1);
  out(`  user_name ว่าง       : ${emptyLogin} แถว${emptyLogin > 0 ? ' 🔴 ถูกปฏิเสธทุกรอบ' : ''}`);
  out(`  ยาวเกิน 64 ตัวอักษร  : ${tooLong.length} แถว${tooLong.length > 0 ? ' 🔴 ถูกปฏิเสธทุกรอบ' : ''}`);
  out(`  ชนกัน (ไม่สนตัวพิมพ์) : ${collisions.length} ค่า`);
  if (collisions.length > 0) {
    out('  🔴 แถวที่ชนจะเหลือรอดแค่แถวแรกของรอบ ที่เหลือเป็น anomaly `duplicate_login`:');
    for (const [login, empCodes] of collisions.slice(0, MAX_SAMPLE)) {
      out(`     ${q(login)} ← emp_id ${empCodes.map(q).join(', ')}`);
    }
    failures += 1;
  }
  if (emptyLogin > 0 || tooLong.length > 0) warnings += 1;
  out();

  // ── 5. สัญญาณ charset ของ a_Password (นับอย่างเดียว ไม่มีการพิมพ์ค่า) ──────
  out('── 5. a_Password — สัญญาณ charset (พิมพ์เฉพาะจำนวน ไม่มีค่าจริงออกทางไหนทั้งสิ้น) ──');
  let mangled = 0;
  let emptySecret = 0;
  let nonAscii = 0;
  for (const row of rows) {
    // 🚫 `.expose()` ถูกเรียกในบรรทัดเดียวเพื่อนับเท่านั้น — ห้าม assign ผลลัพธ์เก็บไว้
    if (row.password.expose().includes(REPLACEMENT_CHAR)) mangled += 1;
    if (row.password.expose().length === 0) emptySecret += 1;
    if (/[^\u0000-\u007F]/.test(row.password.expose())) nonAscii += 1;
  }
  out(`  มี U+FFFD (decode ผิด) : ${mangled} แถว`);
  out(`  ว่างเปล่า              : ${emptySecret} แถว`);
  out(`  มีอักขระนอก ASCII      : ${nonAscii} แถว`);
  if (mangled > 0) {
    out('  🔴 charset ผิด — แถวเหล่านี้ถูกปฏิเสธเป็น anomaly `rejected_row` ทุกรอบ sync');
    out(`     ลองสลับ ERP_SQL_CHARSET (utf8 / win874 / tis620) แล้วรันสคริปต์นี้ใหม่`);
    failures += 1;
  }
  if (emptySecret > 0) {
    out('  ⚠️ บัญชีที่รหัสผ่านว่างจะได้ credential ที่ hash จากสตริงว่าง — ปิดที่ ERP ก่อนคัตโอเวอร์');
    warnings += 1;
  }
  out();

  // ── 6. U3 (ตัวตน): เทียบกับ users.emp_id ที่มีอยู่แล้วในระบบเรา ────────────
  out('── 6. U3 (ตัวตน) — เทียบ menuuser.emp_id กับ users.emp_id ที่เรามีอยู่แล้ว ──');
  const dbUrl = raw('DATABASE_URL');
  if (dbUrl === undefined) {
    out('  🔴 ไม่มี DATABASE_URL — ตอบ U3 ส่วนตัวตนไม่ได้ ห้ามไปต่อ Phase 3');
    out('     ตั้ง DATABASE_URL ที่ต่อ Postgres ของระบบเราได้จากเครื่องนี้ แล้วรันใหม่');
    failures += 1;
  } else {
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      // 🚫 ปิดการเขียนที่ระดับ engine ก่อนยิง query แรก
      await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

      const hasCreds = (
        await pool.query<{ has: boolean }>(
          `SELECT to_regclass('public.user_credentials') IS NOT NULL AS has`,
        )
      ).rows[0]?.has;

      const ours = (
        await pool.query<{ emp_id: string; source: string | null }>(
          hasCreds === true
            ? `SELECT u.emp_id, c.source
                 FROM users u
                 LEFT JOIN user_credentials c ON c.emp_id = u.emp_id
                ORDER BY u.emp_id`
            : `SELECT emp_id, NULL::text AS source FROM users ORDER BY emp_id`,
        )
      ).rows;

      const erpSet = new Set(trimmedOk);
      const ourSet = new Set(ours.map((r) => r.emp_id));
      const matched = [...erpSet].filter((empId) => ourSet.has(empId));
      const erpOnly = [...erpSet].filter((empId) => !ourSet.has(empId));
      const ourOnly = ours.filter((r) => !erpSet.has(r.emp_id));
      const ourOnlyLocal = ourOnly.filter((r) => r.source === 'local');

      out(`  users ในระบบเรา      : ${ours.length} คน`);
      out(`  emp_id ที่ตรงกัน     : ${matched.length}/${erpSet.size} ของฝั่ง ERP = ${pct(matched.length, erpSet.size)}`);
      out(`  มีใน ERP ไม่มีในเรา  : ${erpOnly.length} คน (จะถูกสร้างเป็น users ใหม่รอบแรก)`);
      out(`  มีในเราไม่มีใน ERP   : ${ourOnly.length} คน (${ourOnlyLocal.length} คนเป็น source='local' ที่ sync ห้ามแตะ)`);
      if (hasCreds !== true) {
        out("  หมายเหตุ: ยังไม่มีตาราง user_credentials (ยังไม่ได้ migrate) → ช่อง source ว่างทั้งหมด");
      }
      if (ourOnly.length > 0) {
        out(`     ${sample(ourOnly.map((r) => r.emp_id))}`);
      }
      // เลขชุดนี้คำนวณแบบเดียวกับ sweep ใน runUsers() เป๊ะ: ตัวหาร = credential ที่ sweep แตะได้
      // (source erp+legacy_pin) ไม่ใช่จำนวน users ทั้งหมด — เทียบกับ ERP_USER_DEACTIVATE_MAX_PCT ได้ตรง ๆ
      const sweepable = ours.filter((r) => r.source === 'erp' || r.source === 'legacy_pin');
      const doomed = sweepable.filter((r) => !erpSet.has(r.emp_id));
      if (hasCreds === true && sweepable.length > 0) {
        const ratio = (doomed.length / sweepable.length) * 100;
        out(
          `  sweep รอบแรกจะลบ    : ${doomed.length}/${sweepable.length} credential ` +
            `= ${ratio.toFixed(1)}% (เพดานคือ ERP_USER_DEACTIVATE_MAX_PCT ค่าเริ่มต้น 10)`,
        );
        if (ratio > 10) {
          out('     ⚠️ เกินเพดานค่าเริ่มต้น → sweep จะไม่ลบใครเลยและขึ้น anomaly');
          out('        `deactivate_guardrail_blocked` ซึ่งถูกต้อง แต่ต้องตัดสินใจว่าจะขยับเพดานไหม');
          warnings += 1;
        }
      }

      // เกณฑ์ ~90% มาจาก Cutover Phase 0 ของแผนโดยตรง
      if (erpSet.size > 0 && matched.length / erpSet.size < 0.9) {
        out('  🔴 ตรงกันต่ำกว่า 90% — สมมติฐาน U3 อาจผิด (คนละระบบรหัสพนักงาน)');
        out('     หยุดคุยกับเจ้าของ ERP ก่อน ห้ามเปิด ERP_USER_SYNC_ENABLED');
        failures += 1;
      } else if (erpSet.size > 0) {
        out('  ✅ ตรงกันในระดับที่สมเหตุสมผล');
      }
    } finally {
      await pool.end();
    }
  }
  out();

  // ── 7. สรุปด่าน Phase 0 ───────────────────────────────────────────────────
  out('── สรุป ──');
  out('  ยังต้องมีคนตอบเองอีก 1 ข้อ (สคริปต์ตอบแทนไม่ได้):');
  out('    U4/U7 — ERP instance นี้เดินกี่คลัง มีคอลัมน์ site/dept ให้กรองไหม');
  out('            ทุกบัญชีที่ sync มาจะได้ WAREHOUSE_CODE เดียวกันหมด');
  out();
  out('เสร็จ — ไม่มีคำสั่งเขียนใด ๆ ถูกส่งไปที่ ERP หรือ Postgres และไม่มีรหัสผ่านถูกพิมพ์ออกมา');
  if (failures > 0) {
    out(`\n🔴 มี ${failures} เรื่องที่ต้องแก้ก่อนเปิด ERP_USER_SYNC_ENABLED`);
    process.exitCode = 1;
  } else if (warnings > 0) {
    out(`\n⚠️ ผ่านแบบมีข้อสังเกต ${warnings} เรื่อง — อ่านให้ครบก่อนตัดสินใจ`);
  } else {
    out('\n✅ ไม่พบสัญญาณผิดปกติจากฝั่งข้อมูล (ยังต้องตัดสินใจเรื่อง role map และ U4/U7 เอง)');
  }
}

main().catch((err: unknown) => {
  // ⚠️ ข้อความ error ของ driver ไม่เคยมี plaintext อยู่แล้ว (ErpSecret + driver ไม่ echo ค่า)
  console.error('ล้มเหลว:', err instanceof Error ? err.message : String(err));
  console.error('ตรวจ: .env ครบไหม · firewall เปิดถึง ERP ไหม · DATABASE_URL ต่อจากเครื่องนี้ได้ไหม');
  process.exitCode = 1;
});
