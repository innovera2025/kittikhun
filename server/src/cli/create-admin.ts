// -----------------------------------------------------------------------------
// KITTIKHUN Mobile Stock Check — CLI สร้าง admin คนแรก (bootstrap)
// -----------------------------------------------------------------------------
// ⚠️ ต้องมี script บรรทัดนี้ใน package.json (agent อื่นเป็นคนแก้ไฟล์นั้น):
//       "create-admin": "node dist/cli/create-admin.js"
//
// เรียกใช้ (หลัง npm run build):
//   npm run create-admin -- --emp-id 52104 --name "Kittikhun S." \
//                           [--shift "กะเช้า · A"] [--pin 481920]
// ระหว่าง dev (ไม่ต้อง build):
//   npx ts-node src/cli/create-admin.ts --emp-id 52104 --name "Kittikhun S."
// ในคอนเทนเนอร์:
//   docker compose exec api node dist/cli/create-admin.js --emp-id 52104 --name "..."
//
// ทำไมต้องมีไฟล์นี้ (ไก่กับไข่): POST /members ต้องมี admin ที่ยืนยันตัวแล้ว →
// ตอน deploy ครั้งแรกยังไม่มี admin จึงสร้างใครผ่าน API ไม่ได้เลย
// CLI นี้คือทางเดียวที่เขียน users แถวแรก (รันบนเครื่อง server เท่านั้น)
//
// 🚫 ไม่แตะ ERP: ไฟล์นี้คุยกับ Postgres ของระบบเราเท่านั้น (users เป็นของระบบเราทั้งหมด)
// 🚫 ไม่เขียน PIN ลง log/audit — พิมพ์ PIN เริ่มต้นบน stdout "ครั้งเดียว" ตามการใช้งานจริง
//    (ผู้ดูแลแจ้งเจ้าตัว แล้ว must_change_pin=true บังคับตั้ง PIN ใหม่ตอน login ครั้งแรก)
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
  '  --pin        PIN 6 หลัก — ไม่บังคับ (ไม่ระบุ = ระบบสุ่มให้แบบปลอดภัย)',
  '  -h, --help   แสดงวิธีใช้',
  '',
  'หมายเหตุ:',
  '  • สิทธิ์เป็น admin เสมอ และบังคับตั้ง PIN ใหม่ตอน login ครั้งแรก',
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
 * PIN ที่เดาง่าย — เกณฑ์เดียวกับที่ AuthService.changePin ปฏิเสธ (เลขซ้ำ/123456)
 * บวกเลขเรียง เลขซ้ำเป็นคู่ และ **PIN ที่ตรงกับรหัสพนักงาน** เพราะรหัสพนักงาน
 * อยู่บนป้ายชื่อ ใครก็เห็น (docs/architecture.md §7)
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
        'ยังไม่มีตาราง users ในฐานข้อมูล — ต้องติดตั้งสคีมาก่อน',
        '  psql "$DATABASE_URL" -f db/schema.sql',
        '  (หรือ: docker compose exec -T db psql -U <user> -d <db> < db/schema.sql)',
      ].join('\n');
    case '3D000': // invalid_catalog_name
      return 'ไม่พบฐานข้อมูลตามที่ระบุใน DATABASE_URL — สร้าง database ก่อน แล้วรัน db/schema.sql';
    case '28P01': // invalid_password
    case '28000': // invalid_authorization_specification
      return 'ชื่อผู้ใช้หรือรหัสผ่านใน DATABASE_URL ไม่ถูกต้อง (Postgres ปฏิเสธการยืนยันตัวตน)';
    case '42501': // insufficient_privilege
      return 'บัญชีใน DATABASE_URL ไม่มีสิทธิ์เขียนตาราง users — ใช้บัญชีเจ้าของสคีมา';
    case '23514': {
      // check_violation — บอกชื่อ constraint ให้ตามได้ว่าเงื่อนไขไหนไม่ผ่าน
      const constraint = (err as { constraint?: unknown }).constraint;
      const name = typeof constraint === 'string' ? ` (${constraint})` : '';
      return `ข้อมูลไม่ผ่านเงื่อนไขของตาราง users${name} — ตรวจค่า --emp-id / --name / WAREHOUSE_CODE`;
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
    console.error('⚠️  PIN ที่ระบุมาเดาง่าย — แนะนำให้ไม่ใส่ --pin เพื่อให้ระบบสุ่มให้');
  }

  const pinHash = await argon2.hash(pin + config.PIN_PEPPER, ARGON_OPTS);

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const inserted = await pool.query<{ emp_id: string }>(
      `INSERT INTO users (emp_id, name, pin_hash, role, shift, warehouse_code, must_change_pin)
       VALUES ($1, $2, $3, 'admin', $4, $5, true)
       ON CONFLICT (emp_id) DO NOTHING
       RETURNING emp_id`,
      [args.empId, args.name, pinHash, args.shift ?? null, config.WAREHOUSE_CODE],
    );

    if (inserted.rows.length === 0) {
      console.error(
        [
          `✖ มีรหัสพนักงาน ${args.empId} อยู่ในระบบแล้ว — ไม่ได้สร้างใหม่และไม่ได้แก้ข้อมูล/PIN ของเดิม`,
          '  ถ้าต้องการรีเซ็ต PIN หรือเปลี่ยนสิทธิ์ ให้ทำผ่านหน้าจัดการผู้ใช้ด้วยบัญชี admin',
        ].join('\n'),
      );
      return 1;
    }

    // audit: ไม่มี actor ที่ล็อกอิน → actor='system', payload.by บอกว่ามาจากช่องทาง CLI
    // 🚫 ห้ามใส่ PIN หรือ hash ลง payload
    await pool
      .query(`INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`, [
        'system',
        'members.bootstrap_admin',
        JSON.stringify({ empId: args.empId, by: 'cli' }),
      ])
      .catch((err: unknown) => {
        // สร้าง user สำเร็จแล้ว — audit พลาดไม่ควรทำให้คำสั่งล้มเหลว แต่ต้องเห็นว่าพลาด
        console.error(`⚠️  เขียน audit_log ไม่สำเร็จ: ${(err as Error).message}`);
      });

    // พิมพ์ PIN เริ่มต้นครั้งเดียวบน stdout (ไม่มีที่อื่นเก็บค่านี้ — hash เท่านั้นที่อยู่ใน DB)
    console.log(
      [
        '',
        '✔ สร้างผู้ใช้ระดับ admin สำเร็จ',
        `  รหัสพนักงาน : ${args.empId}`,
        `  ชื่อ : ${args.name}`,
        `  สิทธิ์ : admin`,
        `  คลัง : ${config.WAREHOUSE_CODE}`,
        `  กะ : ${args.shift ?? '(ไม่ระบุ)'}`,
        `  PIN เริ่มต้น : ${pin}${pinWasGiven ? ' (ตามที่ระบุด้วย --pin)' : ' (ระบบสุ่มให้)'}`,
        '',
        '⚠️  PIN นี้แสดงเพียงครั้งเดียว — ระบบเก็บเฉพาะ hash จึงเปิดดูย้อนหลังไม่ได้',
        '    แจ้ง PIN ให้เจ้าตัวโดยตรง แล้วระบบจะบังคับตั้ง PIN ใหม่ตอน login ครั้งแรก',
        '    (ถ้า PIN หาย: ให้ admin อีกคนรีเซ็ต หรือรันคำสั่งนี้กับรหัสพนักงานใหม่)',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (err) {
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
