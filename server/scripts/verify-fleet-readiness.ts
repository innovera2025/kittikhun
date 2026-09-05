/**
 * ด่านที่ 1 ของ Cutover Phase 3 — เครื่องยิงในคลังอัปเดต APK ครบแล้วหรือยัง
 *
 *   cd server && npx ts-node scripts/verify-fleet-readiness.ts [เวอร์ชันเป้าหมาย]
 *   cd server && npm run verify:fleet-readiness
 *
 * ทำไมต้องมีด่านนี้: หน้าล็อกอินเดิมเป็น numeric keypad 6 หลัก **พิมพ์ username ของ ERP
 * ไม่ได้เลย** ไม่ว่าสัญญา wire จะเข้ากันได้แค่ไหน (แผนคง `empId`/`pin` ไว้เป๊ะเพื่อไม่ให้
 * APK เก่าโดน 400 ทันทีที่ deploy) เปิด `ERP_USER_SYNC_ENABLED=true` ตอนที่ยังมีเครื่อง
 * ค้างเวอร์ชันเก่า = เครื่องนั้นล็อกอินไม่ได้อีกเลยทันทีที่ credential ของคนใช้ถูกเปลี่ยน
 * เป็นรหัสผ่าน ERP — จึงต้องรอให้ fleet ขึ้นครบก่อนเสมอ
 *
 * ── 🚫 สคริปต์นี้ไม่แตะ ERP เลยแม้แต่บรรทัดเดียว ───────────────────────────
 *   อ่าน `devices.app_version` / `devices.last_seen_at` ของ Postgres เราเอง ซึ่งถูกเขียน
 *   อยู่แล้วทุก login (`touchDevice`) และทุก heartbeat — ไม่มีกลไก telemetry ใหม่
 *   ตั้ง `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` ก่อนยิง query แรก
 *   → คำสั่งเขียนใด ๆ ถูก engine ปฏิเสธ ไม่ใช่แค่ "ตั้งใจไม่เขียน"
 *
 * เวอร์ชันเป้าหมายมาจาก (ตามลำดับ): argv[1] → APP_MIN_VERSION ใน process.env → ใน .env
 * ไม่มีค่าเริ่มต้นในตัวโดยตั้งใจ — ด่านที่เดาเวอร์ชันเองอาจตอบ "พร้อม" ทั้งที่ยังไม่พร้อม
 *
 * ⚠️ รันที่ไหน: เครื่องที่ `npm ci` แล้ว (มี ts-node) และต่อ Postgres ของระบบเราได้
 *    **รันในคอนเทนเนอร์ production ไม่ได้** — image ไม่มี `scripts/` และ ts-node ถูก
 *    `npm prune --omit=dev` ตัดทิ้ง บน VPS ที่ไม่มี node_modules ใช้ psql แทนได้ตรง ๆ:
 *
 *      docker compose exec -T postgres sh -c \
 *        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
 *           SELECT device_id, app_version, last_seen_at FROM devices
 *            WHERE last_seen_at > now() - interval ''14 days''
 *              AND (app_version IS NULL OR app_version <> ''5.0.0'');"'
 *
 *    ไม่มีแถวออกมา = พร้อม (เท่ากับ exit code 0 ของสคริปต์นี้)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as dotenv from 'dotenv';
import { Pool } from 'pg';

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

const out = (s = ''): void => {
  console.log(s);
};

interface StaleDevice {
  device_id: string;
  app_version: string | null;
  last_seen_at: Date;
}

/** ชิ้นที่ i ของเวอร์ชัน — ชิ้นที่ขาดหรือไม่ใช่ตัวเลขนับเป็น 0 */
function versionPart(parts: readonly number[], index: number): number {
  const value = parts[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** เทียบ semver แบบหยาบ ๆ พอสำหรับจัดกลุ่มในรายงาน (ไม่ใช้ตัดสินผ่าน/ไม่ผ่าน) */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const da = versionPart(pa, i);
    const db = versionPart(pb, i);
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

function describe(version: string | null, target: string): string {
  if (version === null) return 'ไม่เคยรายงานเวอร์ชัน';
  const cmp = compareVersion(version, target);
  if (cmp < 0) return 'เก่ากว่าเป้าหมาย';
  if (cmp > 0) return 'ใหม่กว่าเป้าหมาย';
  return 'ตรงเป้าหมาย';
}

async function main(): Promise<void> {
  const targetVersion = process.argv[2]?.trim() || raw('APP_MIN_VERSION');
  if (targetVersion === undefined || targetVersion === '') {
    console.error(
      'ไม่รู้เวอร์ชันเป้าหมาย — ส่งเป็นอาร์กิวเมนต์แรก หรือตั้ง APP_MIN_VERSION ใน .env\n' +
        '  ตัวอย่าง: npm run verify:fleet-readiness -- 5.0.0',
    );
    process.exitCode = 1;
    return;
  }

  const dbUrl = raw('DATABASE_URL');
  if (dbUrl === undefined) {
    console.error('ไม่มี DATABASE_URL — ตั้งค่าที่ต่อ Postgres ของระบบเราได้จากเครื่องนี้ก่อน');
    process.exitCode = 1;
    return;
  }

  out(`เวอร์ชันเป้าหมาย: ${targetVersion}`);
  out('ช่วงที่นับว่า "ยังใช้งานอยู่": เห็นเครื่องล่าสุดภายใน 14 วัน');
  out();

  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  try {
    // 🚫 ปิดการเขียนที่ระดับ engine ก่อนยิง query แรก
    await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM devices WHERE last_seen_at > now() - interval '14 days'`,
    );
    const activeCount = active.rows[0]?.n ?? 0;

    const stale = await pool.query<StaleDevice>(
      `SELECT device_id, app_version, last_seen_at FROM devices
        WHERE last_seen_at > now() - interval '14 days'
          AND (app_version IS NULL OR app_version <> $1)
        ORDER BY last_seen_at DESC`,
      [targetVersion],
    );
    const staleCount = stale.rowCount ?? 0;

    out(`เครื่องที่ยังใช้งานอยู่ : ${activeCount} เครื่อง`);
    out(`ขึ้น ${targetVersion} แล้ว   : ${activeCount - staleCount} เครื่อง`);
    out();

    if (staleCount > 0) {
      out(`ยังไม่พร้อม — เครื่อง ${staleCount} เครื่องยังไม่ขึ้น ${targetVersion}:`);
      console.table(
        stale.rows.map((row) => ({
          device_id: row.device_id,
          app_version: row.app_version ?? '(ไม่มีค่า)',
          สถานะ: describe(row.app_version, targetVersion),
          เห็นล่าสุด: new Date(row.last_seen_at).toISOString().slice(0, 16).replace('T', ' '),
        })),
      );
      out();
      out('ห้ามเปิด ERP_USER_SYNC_ENABLED=true จนกว่ารายการนี้จะว่าง');
      out('  · "เก่ากว่าเป้าหมาย" / "ไม่เคยรายงานเวอร์ชัน" → ต้อง sideload APK ใหม่ให้เครื่องนั้น');
      out('  · "ใหม่กว่าเป้าหมาย" → ด่านนี้เทียบแบบ "ต้องตรงเป๊ะ" ตามแผน แก้ด้วยการ');
      out(`    ขยับ APP_MIN_VERSION ให้ตรงกับเวอร์ชันที่แจกจริง แล้วรันใหม่`);
      out('  · เครื่องที่เลิกใช้แล้ว → ปล่อยให้เกิน 14 วันแล้วมันจะหลุดจากรายการเอง');
      process.exitCode = 1;
    } else if (activeCount === 0) {
      // ไม่มีเครื่องเลย = ตอบไม่ได้ ไม่ใช่ "ผ่าน" — ถือเป็นไม่ผ่านโดยตั้งใจ
      out('🔴 ไม่มีเครื่องที่ใช้งานใน 14 วันล่าสุดเลย — ด่านนี้ยังตอบไม่ได้');
      out('   ให้เครื่องจริงล็อกอินอย่างน้อย 1 ครั้งเพื่อเขียน devices.app_version แล้วรันใหม่');
      process.exitCode = 1;
    } else {
      out(`✅ fleet พร้อม — ไม่มีเครื่องที่ active ใน 14 วันล่าสุดค้างเวอร์ชันเก่า`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('ล้มเหลว:', err instanceof Error ? err.message : String(err));
  console.error('ตรวจ: DATABASE_URL ต่อจากเครื่องนี้ได้จริงไหม (ค่าใน .env ชี้ไปที่ชื่อโฮสต์ของ compose)');
  process.exitCode = 1;
});
