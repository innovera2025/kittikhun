// -----------------------------------------------------------------------------
// TCL Mobile Stock Check — CLI สร้าง admin แบบ break-glass (bootstrap)
// -----------------------------------------------------------------------------
// ⚠️ script ใน package.json ต้องเป็น `node dist/cli/create-admin.js` เท่านั้น
//    (เคยเป็น `ts-node src/cli/create-admin.ts` ซึ่ง **ใช้ในคอนเทนเนอร์จริงไม่ได้**:
//     runtime stage ของ Dockerfile COPY มาแค่ node_modules ที่ผ่าน `npm prune --omit=dev`
//     แล้ว + dist + package.json + sql → ไม่มีทั้ง ts-node และไม่มีโฟลเดอร์ src/ เลย
//     ทางถอยฉุกเฉินจึงพังเงียบด้วย MODULE_NOT_FOUND ตอนที่ต้องใช้จริงที่สุด)
//
// เรียกใช้ (หลัง npm run build):
//   npm run create-admin -- --emp-id 52901 --name "Tcl S." \
//                           [--shift "กะเช้า · A"] [--pin 481920]
// ระหว่าง dev (ไม่ต้อง build):
//   npx ts-node src/cli/create-admin.ts --emp-id 52901 --name "Tcl S."
// ในคอนเทนเนอร์:
//   docker compose exec api node dist/cli/create-admin.js --emp-id 52901 --name "..."
//
// ทำไมต้องมีไฟล์นี้ (ไก่กับไข่): ไม่มี endpoint ไหนสร้างผู้ใช้ได้อีกแล้ว — บัญชีมาจาก
// sync ผู้ใช้ของ ERP เท่านั้น และ sync เองก็ **ปฏิเสธการรันทั้งรอบ** ถ้าไม่มี admin ที่
// มี credential `source='local'` เหลืออยู่อย่างน้อย 1 คน (ด่าน last-admin ชั้นที่ 1)
// CLI นี้จึงเป็นทั้งผู้ใช้คนแรกและกุญแจสำรองที่ ERP แตะไม่ได้ (รันบนเครื่อง server เท่านั้น)
//
// 🚫 ไม่แตะ ERP: ไฟล์นี้คุยกับ Postgres ของระบบเราเท่านั้น
// 🚫 ไม่เขียนรหัสผ่านลง log/audit — พิมพ์บน stdout "ครั้งเดียว" ตามการใช้งานจริง
//    (ผู้ดูแลแจ้งเจ้าตัว แล้วเก็บเฉพาะ argon2id hash ลง user_credentials.secret_hash)
// -----------------------------------------------------------------------------

// env.config.ts มี @Module decorator → ต้องมี polyfill นี้ก่อน import (CLI ไม่ได้บูต Nest)
import 'reflect-metadata';

import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { z } from 'zod';

import { EmpIdSchema, PinSchema } from '../auth/auth.types';
// ⚠️ type-only เท่านั้น — ห้าม import ค่าจาก env.config.ts ที่ระดับ top-level
//    ไฟล์นั้นมี ConfigModule.forRoot() ที่ตรวจ .env ทันทีตอน import (ดู loadAppConfig)
import type { AppConfig } from '../config/env.config';

/**
 * ⚠️ ต้องตรงกับ AuthService.ARGON_OPTS เป๊ะ ๆ (src/auth/auth.service.ts)
 * hash ที่สร้างที่นี่ต้อง argon2.verify ผ่านตอน login จริง — แก้ที่ใดที่หนึ่งต้องแก้ทั้งสองที่
 */
const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const USAGE = [
  'วิธีใช้:',
  '  npm run create-admin -- --emp-id <รหัส> --name "<ชื่อ>" [--shift "<กะ>"] [--pin <6 หลัก>]',
  '',
  'ตัวเลือก:',
  '  --emp-id     รหัสพนักงาน (A-Z a-z 0-9 . _ - ยาวไม่เกิน 32 ตัว) — บังคับ',
  '  --name       ชื่อที่แสดงในแอป — บังคับ',
  '  --shift      กะ/ทีม เช่น "กะเช้า · A" — ไม่บังคับ',
  '  --pin        รหัสผ่านของบัญชีนี้ — ตัวเลข 6 หลัก ไม่บังคับ (ไม่ระบุ = ระบบสุ่มให้)',
  '  -h, --help   แสดงวิธีใช้',
  '',
  'หมายเหตุ:',
  '  • สิทธิ์เป็น admin เสมอ',
  '  • ชื่อผู้ใช้ตอนล็อกอินคือรหัสพนักงานตัวพิมพ์เล็ก และรหัสผ่านคือค่าที่พิมพ์ออกมาข้างล่าง',
  '  • credential เขียนเป็น source=local ซึ่ง sync ผู้ใช้ของ ERP ห้ามแตะ (กุญแจสำรอง)',
  '  • รหัสคลังมาจาก WAREHOUSE_CODE ใน .env (ไม่ต้องส่งเข้ามา)',
  '  • ถ้ามีรหัสพนักงานนี้อยู่แล้ว จะไม่ทับของเดิม (ออกด้วย exit code 1)',
].join('\n');

// ── argv ────────────────────────────────────────────────────────────────────

/** ชื่อ flag ที่ใช้ในข้อความ error (map จาก key ของ schema) */
const FLAG_OF: Record<string, string> = {
  empId: '--emp-id',
  name: '--name',
  shift: '--shift',
  pin: '--pin',
};

const ArgsSchema = z.object({
  empId: EmpIdSchema,
  name: z
    .string()
    .trim()
    .min(1, 'ต้องมีชื่อพนักงาน')
    .max(120, 'ชื่อยาวได้ไม่เกิน 120 ตัวอักษร'),
  shift: z.string().trim().min(1).max(64).optional(),
  pin: PinSchema.optional(),
});
type Args = z.infer<typeof ArgsSchema>;

/** error ที่มีข้อความพร้อมแสดงให้ผู้ใช้ (ไม่ต้องมี stack trace) */
class CliError extends Error {
  /** true = ผู้ใช้พิมพ์คำสั่งผิด → ต่อท้ายด้วยวิธีใช้ (error เรื่อง DB/คอนฟิกไม่ต้อง) */
  constructor(
    message: string,
    readonly showUsage = false,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function parseArgv(argv: readonly string[]): Args | 'help' {
  let values: {
    'emp-id'?: string;
    name?: string;
    shift?: string;
    pin?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'emp-id': { type: 'string' },
        name: { type: 'string' },
        shift: { type: 'string' },
        pin: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new CliError(`อ่านพารามิเตอร์ไม่ได้: ${(err as Error).message}`, true);
  }

  if (values.help === true) return 'help';

  const result = ArgsSchema.safeParse({
    empId: values['emp-id'],
    name: values.name,
    // --shift "" ถือว่าไม่ได้ระบุ (คอลัมน์ shift เป็น NULL ได้)
    shift: values.shift !== undefined && values.shift.trim() !== '' ? values.shift : undefined,
    pin: values.pin,
  });
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    const flag = FLAG_OF[key] ?? key;
    const reason =
      issue.code === z.ZodIssueCode.invalid_type && issue.received === 'undefined'
        ? 'ต้องระบุค่านี้'
        : issue.message;
    return `  • ${flag}: ${reason}`;
  });
  throw new CliError(['พารามิเตอร์ไม่ถูกต้อง:', ...lines].join('\n'), true);
}

// ── .env ────────────────────────────────────────────────────────────────────

/**
 * โหลด .env ให้ CLI เอง (ปกติ ConfigModule ทำให้ตอนบูต Nest แต่ CLI ไม่บูต Nest)
 * ไม่มีไฟล์ = ไม่ error เพราะในคอนเทนเนอร์ค่ามาจาก env_file ของ compose แล้ว
 */
function loadEnvFileIfPresent(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '..', '.env')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch (err) {
      throw new CliError(`อ่านไฟล์ .env ไม่สำเร็จ (${path}): ${(err as Error).message}`);
    }
    return;
  }
}

/**
 * โหลดคอนฟิกด้วย loadConfig() — fail fast พร้อมชื่อตัวแปรที่ผิด (ไม่พิมพ์ "ค่า")
 *
 * ⚠️ ต้อง import env.config.ts *หลัง* โหลดไฟล์ .env เสมอ: ไฟล์นั้นประกาศ
 *    `@Module({ imports: [ConfigModule.forRoot({ validate: loadConfig })] })` →
 *    forRoot() ทำงานทันทีตอน import และตรวจ .env ซ้ำเองแบบ async
 *    ถ้า import ก่อน env พร้อม CLI จะโดน unhandledRejection พ่น stack ดิบ
 *    ทับข้อความไทยของเรา (ดักไว้อีกชั้นที่ท้ายไฟล์)
 */
async function loadAppConfig(): Promise<AppConfig> {
  const env = await import('../config/env.config');
  try {
    return env.loadConfig();
  } catch (err) {
    if (err instanceof env.EnvValidationError) throw new CliError(err.message);
    throw err;
  }
}

// ── PIN ─────────────────────────────────────────────────────────────────────

/** PIN ที่เจอบ่อยในการเดา (นอกเหนือจากเลขซ้ำ/เลขเรียง ที่ตรวจด้วยฟังก์ชัน) */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '121212',
  '123123',
  '112233',
  '101010',
  '123321',
  '654321',
  '696969',
]);

function isSequential(pin: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < pin.length; i += 1) {
    const step = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  return ascending || descending;
}

/**
 * รหัสผ่านที่เดาง่าย — เลขซ้ำ/เลขเรียง/รหัสยอดฮิต และ **ค่าที่ตรงกับรหัสพนักงาน**
 * เพราะรหัสพนักงานอยู่บนป้ายชื่อ ใครก็เห็น (docs/architecture.md §7)
 *
 * ยังยึด "ตัวเลข 6 หลัก" ตาม `PinSchema` โดยตั้งใจ แม้ล็อกอินจะรับรหัสผ่านแบบใดก็ได้แล้ว:
 * ค่านี้ถูกพิมพ์ปากเปล่า/จดใส่กระดาษเพื่อส่งต่อในสถานการณ์ฉุกเฉิน สั้นและกดง่ายจึงสำคัญ
 * กว่าเอนโทรปี — ด่านกัน brute force ตัวจริงคือ throttle ทวีคูณใน AuthService
 */
function isGuessablePin(pin: string, empId: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  if (isSequential(pin)) return true;
  if (COMMON_PINS.has(pin)) return true;
  const empDigits = empId.replace(/\D/g, '');
  return empDigits.length >= 6 && pin === empDigits.slice(-6);
}

/** สุ่ม PIN 6 หลักแบบ cryptographic (เก็บเลขศูนย์นำหน้าไว้ด้วย padStart) */
function generatePin(empId: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!isGuessablePin(pin, empId)) return pin;
  }
  // แทบไม่มีทางเกิด (ค่าที่ถูกคัดออกมีไม่ถึง 0.01% ของช่วง) — กัน loop ไม่รู้จบ
  throw new CliError('สุ่ม PIN ที่ปลอดภัยไม่สำเร็จ — ลองรันคำสั่งอีกครั้ง');
}

// ── Postgres error → ข้อความที่อ่านรู้เรื่อง ─────────────────────────────────

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function describeDbError(err: unknown): string {
  const code = errorCode(err);
  const detail = err instanceof Error ? err.message : String(err);

  switch (code) {
    case '42P01': // undefined_table
      return [
        'ยังไม่มีตาราง users / user_credentials ในฐานข้อมูล — ต้องติดตั้งสคีมาก่อน',
        '  psql "$DATABASE_URL" -f db/schema.sql',
        '  (หรือ: docker compose exec -T db psql -U <user> -d <db> < db/schema.sql)',
      ].join('\n');
    case '3D000': // invalid_catalog_name
      return 'ไม่พบฐานข้อมูลตามที่ระบุใน DATABASE_URL — สร้าง database ก่อน แล้วรัน db/schema.sql';
    case '28P01': // invalid_password
    case '28000': // invalid_authorization_specification
      return 'ชื่อผู้ใช้หรือรหัสผ่านใน DATABASE_URL ไม่ถูกต้อง (Postgres ปฏิเสธการยืนยันตัวตน)';
    case '42501': // insufficient_privilege
      return 'บัญชีใน DATABASE_URL ไม่มีสิทธิ์เขียนตาราง users / user_credentials — ใช้บัญชีเจ้าของสคีมา';
    case '23505': {
      // unique_violation — เกิดได้ที่ user_credentials (login_name PK / emp_id UNIQUE)
      const constraint = (err as { constraint?: unknown }).constraint;
      const name = typeof constraint === 'string' ? ` (${constraint})` : '';
      return `รหัสพนักงานหรือชื่อผู้ใช้ซ้ำกับที่มีอยู่แล้ว${name} — ใช้ --emp-id ค่าอื่น`;
    }
    case '23514': {
      // check_violation — บอกชื่อ constraint ให้ตามได้ว่าเงื่อนไขไหนไม่ผ่าน
      const constraint = (err as { constraint?: unknown }).constraint;
      const name = typeof constraint === 'string' ? ` (${constraint})` : '';
      return `ข้อมูลไม่ผ่านเงื่อนไขของตาราง${name} — ตรวจค่า --emp-id / --name / WAREHOUSE_CODE`;
    }
    case 'ECONNREFUSED':
      return 'ต่อ Postgres ไม่ได้: ถูกปฏิเสธการเชื่อมต่อ — ตรวจว่า DB รันอยู่และ host/port ใน DATABASE_URL ถูกต้อง';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'ต่อ Postgres ไม่ได้: หา host ตาม DATABASE_URL ไม่เจอ (ถ้ารันนอกคอนเทนเนอร์ให้ใช้ localhost แทนชื่อ service)';
    case 'ETIMEDOUT':
      return 'ต่อ Postgres ไม่ได้: หมดเวลาเชื่อมต่อ — ตรวจ network/firewall ระหว่างเครื่องนี้กับ DB';
    default:
      return `ทำงานกับฐานข้อมูลไม่สำเร็จ: ${detail}`;
  }
}

// ── เขียนลงฐานข้อมูล ────────────────────────────────────────────────────────

interface AdminRow {
  empId: string;
  name: string;
  shift: string | null;
  warehouseCode: string;
  /** สิ่งที่ผู้ใช้พิมพ์ตอนล็อกอิน = lower(emp_id) (CHECK user_credentials_login_fmt บังคับ) */
  loginName: string;
  secretHash: string;
}

/**
 * สร้าง admin หนึ่งคน = `users` + `user_credentials` **ในทรานแซกชันเดียว**
 *
 * ทั้งสองแถวต้องเกิดพร้อมกันหรือไม่เกิดเลย: แถว `users` ที่ไม่มี credential คือ admin
 * ที่ล็อกอินไม่ได้ (ล็อกอินอ่านจาก `user_credentials` เท่านั้นแล้ว) และแย่กว่านั้นคือ
 * มันไป**ปิด**ทางสร้างใหม่ด้วย เพราะ `ON CONFLICT (emp_id) DO NOTHING` จะเจอแถวเดิม
 * ทุกครั้งที่รันซ้ำ
 *
 * `source='local'` คือสัญญากับ sync ผู้ใช้ของ ERP ว่าห้ามแตะแถวนี้ (ด่าน last-admin
 * ชั้นที่ 1) — ค่านี้ห้ามเปลี่ยนเป็นอย่างอื่นเด็ดขาด
 */
async function insertAdmin(pool: Pool, row: AdminRow): Promise<'created' | 'duplicate'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ON CONFLICT DO NOTHING = กันชนแบบ race-safe (ไม่ต้อง pre-check แล้วเจอ TOCTOU)
    // 🚫 ไม่เขียน users.pin_hash อีกต่อไป — คอลัมน์นั้น DEPRECATED (ดู db/schema.sql §3.1b)
    const inserted = await client.query<{ emp_id: string }>(
      `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
       VALUES ($1, $2, 'admin', $3, $4, false)
       ON CONFLICT (emp_id) DO NOTHING
       RETURNING emp_id`,
      [row.empId, row.name, row.shift, row.warehouseCode],
    );
    if (inserted.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }

    // DO UPDATE มี WHERE คุมไว้: ถ้า login_name นี้เป็นของ "คนอื่น" อยู่แล้ว จะได้ 0 แถว
    // แทนที่จะไปทับ credential ของเขาแล้วล็อกเจ้าตัวออกจากระบบเงียบ ๆ
    const cred = await client.query<{ emp_id: string }>(
      `INSERT INTO user_credentials (login_name, emp_id, secret_hash, source)
       VALUES ($1, $2, $3, 'local')
       ON CONFLICT (login_name) DO UPDATE
         SET secret_hash = EXCLUDED.secret_hash, secret_rotated_at = now(), source = 'local'
       WHERE user_credentials.emp_id = EXCLUDED.emp_id
       RETURNING emp_id`,
      [row.loginName, row.empId, row.secretHash],
    );
    if (cred.rows.length === 0) {
      throw new CliError(
        [
          `ชื่อผู้ใช้ "${row.loginName}" ถูกใช้โดยรหัสพนักงานอื่นอยู่แล้ว — ไม่ได้สร้างอะไรเลย`,
          '  (ชื่อผู้ใช้คือรหัสพนักงานตัวพิมพ์เล็ก จึงชนกันได้แม้รหัสพนักงานจะต่างตัวพิมพ์)',
          '  ใช้ --emp-id ค่าอื่น',
        ].join('\n'),
      );
    }

    await client.query('COMMIT');
    return 'created';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function run(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return 0;
  }
  const args = parsed;

  loadEnvFileIfPresent();
  const config = await loadAppConfig();

  const pinWasGiven = args.pin !== undefined;
  const pin = args.pin ?? generatePin(args.empId);
  if (pinWasGiven && isGuessablePin(pin, args.empId)) {
    console.error('⚠️  รหัสผ่านที่ระบุมาเดาง่าย — แนะนำให้ไม่ใส่ --pin เพื่อให้ระบบสุ่มให้');
  }

  // pepper ตัวเดียวกับ AuthService เสมอ — hash ที่ใช้ pepper อื่นจะ verify ไม่ผ่านตอนล็อกอิน
  const secretHash = await argon2.hash(pin + config.PIN_PEPPER, ARGON_OPTS);
  const loginName = args.empId.toLowerCase();

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const outcome = await insertAdmin(pool, {
      empId: args.empId,
      name: args.name,
      shift: args.shift ?? null,
      warehouseCode: config.WAREHOUSE_CODE,
      loginName,
      secretHash,
    });

    if (outcome === 'duplicate') {
      console.error(
        [
          `✖ มีรหัสพนักงาน ${args.empId} อยู่ในระบบแล้ว — ไม่ได้สร้างใหม่และไม่ได้แก้ข้อมูล/รหัสผ่านของเดิม`,
          '  ถ้าต้องการกุญแจสำรองอีกดอก ให้รันคำสั่งนี้กับรหัสพนักงานที่ยังไม่มีในระบบ',
        ].join('\n'),
      );
      return 1;
    }

    // audit: ไม่มี actor ที่ล็อกอิน → actor='system', payload.by บอกว่ามาจากช่องทาง CLI
    // 🚫 ห้ามใส่รหัสผ่านหรือ hash ลง payload
    await pool
      .query(`INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`, [
        'system',
        'members.bootstrap_admin',
        JSON.stringify({ empId: args.empId, loginName, source: 'local', by: 'cli' }),
      ])
      .catch((err: unknown) => {
        // สร้าง user สำเร็จแล้ว — audit พลาดไม่ควรทำให้คำสั่งล้มเหลว แต่ต้องเห็นว่าพลาด
        console.error(`⚠️  เขียน audit_log ไม่สำเร็จ: ${(err as Error).message}`);
      });

    // พิมพ์รหัสผ่านครั้งเดียวบน stdout (ไม่มีที่อื่นเก็บค่านี้ — hash เท่านั้นที่อยู่ใน DB)
    console.log(
      [
        '',
        '✔ สร้างผู้ใช้ระดับ admin สำเร็จ',
        `  รหัสพนักงาน : ${args.empId}`,
        `  ชื่อ : ${args.name}`,
        `  สิทธิ์ : admin`,
        `  คลัง : ${config.WAREHOUSE_CODE}`,
        `  กะ : ${args.shift ?? '(ไม่ระบุ)'}`,
        `  ชื่อผู้ใช้ตอนล็อกอิน : ${loginName}`,
        `  รหัสผ่าน : ${pin}${pinWasGiven ? ' (ตามที่ระบุด้วย --pin)' : ' (ระบบสุ่มให้)'}`,
        '',
        '⚠️  รหัสผ่านนี้แสดงเพียงครั้งเดียว — ระบบเก็บเฉพาะ hash จึงเปิดดูย้อนหลังไม่ได้',
        '    แจ้งเจ้าตัวโดยตรง (บัญชีนี้เป็น source=local — sync ของ ERP จะไม่แตะและไม่เขียนทับ)',
        '    (ถ้ารหัสผ่านหาย: รันคำสั่งนี้กับรหัสพนักงานใหม่ แล้วปลดบัญชีเดิมทีหลัง)',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(describeDbError(err));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * ConfigModule.forRoot() ใน env.config.ts ตรวจ .env ซ้ำแบบ async ตอน import →
 * ถ้าคอนฟิกผิด มันจะโยน EnvValidationError เป็น unhandledRejection ในทิคถัดไป
 * เรารายงานปัญหาเดียวกันนี้ด้วยข้อความไทยของเราเองแล้ว (loadAppConfig) จึงกลืนตัวซ้ำ
 * ไม่ให้ stack ดิบทับ output และไม่ให้ exit code เพี้ยนตอนสร้าง user สำเร็จ
 */
process.on('unhandledRejection', (err: unknown) => {
  if (err instanceof Error && err.name === 'EnvValidationError') return;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✖ เกิดข้อผิดพลาดที่ไม่ได้จัดการ: ${message}\n`);
  process.exitCode = 1;
});

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof CliError ? err.message : `เกิดข้อผิดพลาด: ${String(err)}`;
    console.error(`\n✖ ${message}\n`);
    if (err instanceof CliError && err.showUsage) console.error(USAGE);
    process.exitCode = 1;
  });
