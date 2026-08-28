import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

/**
 * คอนฟิกกลางของระบบ — zod schema ตรวจ `.env` ตอน boot (fail fast)
 *
 * หลักการ (docs/erp-integration.md §4):
 *   1. ทุก key ตรงกับ `.env.example` แบบ 1:1 — ไม่มี key ลับที่ไม่ได้เขียนไว้ในเทมเพลต
 *   2. คอนฟิกผิด = ไม่ start พร้อมบอก "ชื่อตัวแปร" ที่ผิดทุกตัว + เหตุผล (บรรทัดละตัว)
 *   3. 🚫 ห้ามพิมพ์ "ค่า" ของตัวแปรออก log/ข้อความ error เด็ดขาด (มี secret: PIN pepper,
 *      JWT secret, รหัสผ่าน DB/ERP) — ข้อความ error อ้างอิงชื่อตัวแปรกับกฎที่ผิดเท่านั้น
 *   4. ERP อ่านอย่างเดียว — ไม่มีคอนฟิกสำหรับเขียนกลับ ERP และห้ามเพิ่ม
 *
 * โครงสร้าง schema เป็น discriminated union ตาม `ERP_DRIVER`:
 *   sql  → บังคับกลุ่ม ERP_SQL_*  (+ ต้องมีแหล่ง items อย่างน้อยหนึ่ง: VIEW หรือ SQL_FILE)
 *   rest → บังคับกลุ่ม ERP_REST_*
 *   mock → ไม่บังคับอะไร (dev / CI / demo)
 * ทุก branch ประกาศ "ทุก key" (ของ driver อื่นเป็น optional) เพื่อให้
 * `ConfigService<AppConfig, true>.get('ERP_SQL_HOST', { infer: true })` ใช้ได้ทุกโหมด
 */

// ---------------------------------------------------------------------------
// ค่าที่รับได้ (enum)
// ---------------------------------------------------------------------------

export const ERP_SQL_DIALECTS = ['mssql', 'pg', 'mysql', 'oracle'] as const;
export const ERP_SQL_CHARSETS = ['utf8', 'tis620', 'win874'] as const;
export const ERP_REST_AUTH_MODES = ['header', 'basic', 'none'] as const;
export const ERP_REST_PAGINATIONS = ['page', 'offset', 'cursor', 'none'] as const;
export const ERP_REST_SINCE_FORMATS = ['iso8601', 'epoch_s', 'epoch_ms', 'date_be'] as const;

// ---------------------------------------------------------------------------
// รูปแบบค่าที่ตรวจด้วย regex
// ---------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const WAREHOUSE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
/** อายุ token แบบ ms/vercel-ms เช่น 15m, 30d, 3600 */
const DURATION_RE = /^\d+(?:ms|s|m|h|d|w|y)?$/i;
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._\-[\]]+(?::\d{1,5})?$/;
const HOSTNAME_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** SQL Server รองรับ named instance เช่น SRV01\SQLEXPRESS จึงอนุญาต backslash */
const SQL_HOST_RE = /^[A-Za-z0-9._\-\\:[\]]{1,255}$/;
const SQL_DB_NAME_RE = /^[A-Za-z0-9_$#.-]{1,128}$/;
/** ชื่อ view/ตาราง 1–3 ส่วน เช่น dbo.v_items หรือ [db].[dbo].[v_items] — กัน SQL แปลกปลอม */
const SQL_OBJECT_RE =
  /^(?:\[[A-Za-z_][\w$@#]*\]|[A-Za-z_][\w$@#]*)(?:\.(?:\[[A-Za-z_][\w$@#]*\]|[A-Za-z_][\w$@#]*)){0,2}$/;
const ABS_SQL_FILE_RE = /^\/[^\n\r\0]*\.sql$/i;
const ABS_JSON_FILE_RE = /^\/[^\n\r\0]*\.json$/i;
const CRON_FIELD = String.raw`[0-9*/,\-?LW#]+`;
/** cron 5 ช่อง (มาตรฐาน) หรือ 6 ช่อง (มีวินาที — @nestjs/schedule รองรับ) */
const CRON_RE = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4,5}$`);
const REST_PATH_RE = /^\/[^\s?#]*$/;
const QUERY_PARAM_RE = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const DOT_PATH_RE = /^(?:\.|[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*)$/;

// ---------------------------------------------------------------------------
// ตัวช่วยสร้าง schema (ข้อความไทย ไม่มีการอ้างอิงค่าที่รับมา)
// ---------------------------------------------------------------------------

const listOf = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(' | ');

function envStr(
  hint: string,
  opts: { min?: number; max?: number; pattern?: RegExp } = {},
): z.ZodString {
  let schema = z.string({
    required_error: `ไม่ได้ตั้งค่า (หรือเป็นค่าว่าง) — ${hint}`,
    invalid_type_error: `ต้องเป็นข้อความ — ${hint}`,
  });
  schema =
    opts.min === undefined
      ? schema.min(1, `ต้องไม่เป็นค่าว่าง — ${hint}`)
      : schema.min(opts.min, `ต้องยาวอย่างน้อย ${opts.min} ตัวอักษร — ${hint}`);
  if (opts.max !== undefined) {
    schema = schema.max(opts.max, `ต้องยาวไม่เกิน ${opts.max} ตัวอักษร — ${hint}`);
  }
  if (opts.pattern !== undefined) {
    schema = schema.regex(opts.pattern, `รูปแบบไม่ถูกต้อง — ${hint}`);
  }
  return schema;
}

function envInt(opts: { min: number; max: number; default: number; hint: string }) {
  return z.coerce
    .number({ invalid_type_error: `ต้องเป็นตัวเลข — ${opts.hint}` })
    .int(`ต้องเป็นจำนวนเต็ม (ไม่มีทศนิยม) — ${opts.hint}`)
    .min(opts.min, `ต้องไม่น้อยกว่า ${opts.min} — ${opts.hint}`)
    .max(opts.max, `ต้องไม่เกิน ${opts.max} — ${opts.hint}`)
    .default(opts.default);
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'off']);

/** z.coerce.boolean() ใช้ไม่ได้กับ .env เพราะสตริง "false" จะกลายเป็น true */
function envBool(defaultValue: boolean, hint: string) {
  return z
    .preprocess(
      (value) => {
        if (typeof value !== 'string') return value;
        const word = value.toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
        return value; // ปล่อยให้ z.boolean() ฟ้องว่ารูปแบบผิด
      },
      z.boolean({
        required_error: `ไม่ได้ตั้งค่า — ${hint}`,
        invalid_type_error: `ต้องเป็น true หรือ false — ${hint}`,
      }),
    )
    .default(defaultValue);
}

function envEnum<T extends readonly [string, ...string[]]>(values: T, hint: string) {
  return z.enum(values, {
    required_error: `ไม่ได้ตั้งค่า — ${hint} (ค่าที่รับได้: ${listOf(values)})`,
    invalid_type_error: `ต้องเป็นข้อความ — ${hint} (ค่าที่รับได้: ${listOf(values)})`,
  });
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const okScheme = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    const dbName = url.pathname.replace(/^\//, '');
    return okScheme && url.hostname.length > 0 && dbName.length > 0;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// [1]-[5] คีย์ที่ใช้กับทุก driver
// ---------------------------------------------------------------------------

const commonShape = {
  // [1] แอปพลิเคชันและเซิร์ฟเวอร์
  APP_PORT: envInt({ min: 1, max: 65535, default: 8080, hint: 'พอร์ต API ภายใน compose network' }),
  TZ: envStr('timezone แบบ IANA เช่น Asia/Bangkok')
    .refine(isValidTimeZone, 'ไม่ใช่ timezone ที่ Node รู้จัก (ต้องเป็นชื่อ IANA เช่น Asia/Bangkok)')
    .default('Asia/Bangkok'),
  // คลังจริงใน db_TCL: WHRM WHFG WHWIP WHNG (ค่า WH-BKK-02 ใน .env.example เป็นตัวอย่าง)
  WAREHOUSE_CODE: envStr('รหัสคลังของระบบนี้ เช่น WHRM WHFG WHWIP WHNG', {
    max: 32,
    pattern: WAREHOUSE_RE,
  }),
  APP_MIN_VERSION: envStr('เวอร์ชันแอปต่ำสุดแบบ semver เช่น 4.0.0', {
    pattern: SEMVER_RE,
  }).default('4.0.0'),
  /**
   * 🚨 สวิตช์ทดสอบชั่วคราว — ยอมให้ใช้บัญชี ERP สิทธิ์กว้าง (เช่น `sa`) ทั้งฝั่งอ่านและฝั่งเขียน
   *
   * มีไว้เพื่อทดสอบสายงานจริง (สแกน → เทียบยอด → กรอก → ส่งกลับ ERP) ก่อนที่ฝ่าย ERP
   * จะสร้าง `tcl_reader` / `tcl_writer` ให้ เปิดแล้วกฎเหล็กชั้นที่ 1 และ 2 จะเหลือแค่
   * คำเตือนใน log แทนการปฏิเสธ boot — ตัวตรวจอื่นทั้งหมด (ขอบเขตแคบเกิน · probe
   * สรุปไม่ได้ · ภาษาไทยเพี้ยน) ยังหยุด boot เหมือนเดิมทุกประการ
   *
   * ⚠️ ห้ามเปิดบน production
   */
  ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT: envBool(
    false,
    '🚨 true = ยอมให้ใช้บัญชี ERP สิทธิ์กว้าง (sa) — สำหรับทดสอบเท่านั้น ห้ามใช้บน production',
  ),

  // [2] ฐานข้อมูลของระบบ (Postgres ของเราเอง — ไม่ใช่ DB ของ ERP)
  POSTGRES_PASSWORD: envStr('รหัสผ่าน Postgres ของระบบนี้ (อย่างน้อย 8 ตัวอักษร)', { min: 8 }),
  DATABASE_URL: envStr('connection string ของ Postgres ระบบนี้').refine(
    isPostgresUrl,
    'ต้องเป็น URL รูปแบบ postgres://user:password@host:5432/dbname',
  ),

  // [3] ความปลอดภัย / Authentication
  JWT_ACCESS_SECRET: envStr('สร้างด้วย openssl rand -hex 32 (อย่างน้อย 32 ตัวอักษร)', { min: 32 }),
  JWT_REFRESH_SECRET: envStr('สร้างแยกจาก access secret ด้วย openssl rand -hex 32', { min: 32 }),
  JWT_ACCESS_TTL: envStr('อายุ access token เช่น 15m', { pattern: DURATION_RE }).default('15m'),
  JWT_REFRESH_TTL: envStr('อายุ refresh token เช่น 30d', { pattern: DURATION_RE }).default('30d'),
  PIN_PEPPER: envStr('pepper ฝั่ง server ผสมเข้า argon2id ของ PIN (อย่างน้อย 16 ตัวอักษร)', {
    min: 16,
  }),
  AUTH_THROTTLE_BASE_MS: envInt({
    min: 0,
    max: 60_000,
    default: 1000,
    hint: 'หน่วงเริ่มต้นเมื่อ PIN ผิด (ms)',
  }),
  AUTH_THROTTLE_MAX_MS: envInt({
    min: 0,
    max: 3_600_000,
    default: 300_000,
    hint: 'เพดานหน่วงเมื่อ PIN ผิดซ้ำ (ms)',
  }),
  // ยังเป็นสตริง comma-separated ตามที่ main.ts ใช้ (split เอง) — ห้ามเปลี่ยนเป็น array
  CORS_ORIGINS: envStr('origin คั่นด้วย comma เช่น https://stock.lan (ใช้ * ได้ในเครื่อง dev)', {
    max: 1024,
  })
    .default('https://stock.lan')
    .superRefine((value, ctx) => {
      const origins = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (origins.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'ต้องมีอย่างน้อย 1 origin (เช่น https://stock.lan) หรือ *',
        });
        return;
      }
      origins.forEach((origin, index) => {
        if (origin !== '*' && !ORIGIN_RE.test(origin)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `รายการที่ ${index + 1} ไม่ใช่ origin ที่ถูกต้อง (ต้องเป็น http(s)://host[:port] หรือ *)`,
          });
        }
      });
    }),

  // [4] TLS บน LAN (Caddy) — ห้าม *.local เพราะ Android resolve mDNS ไม่ได้บ่อย
  CADDY_SITE: envStr('ชื่อโฮสต์จาก DNS ของ router เช่น stock.lan หรือ IP นิ่ง', {
    max: 253,
    pattern: HOSTNAME_RE,
  })
    .refine(
      (value) => !value.toLowerCase().endsWith('.local'),
      'ห้ามใช้โดเมน .local (mDNS — Android resolve ไม่ได้บ่อย) ให้ใช้เช่น stock.lan',
    )
    .default('stock.lan'),

  // [5] ERP ส่วนกลาง (ใช้กับทุก driver)
  ERP_SYNC_CRON: envStr('cron ดึง item master เช่น */30 * * * *', {
    pattern: CRON_RE,
  }).default('*/30 * * * *'),
  ERP_SYNC_OVERLAP_S: envInt({
    min: 0,
    max: 86_400,
    default: 120,
    hint: 'overlap window ของ delta pull (วินาที)',
  }),
  ERP_TIMEOUT_MS: envInt({
    min: 1000,
    max: 600_000,
    default: 15_000,
    hint: 'timeout ต่อ request/query ของ ERP (ms)',
  }),
} as const;

// ---------------------------------------------------------------------------
// [7] กลุ่ม ERP_SQL_*
// ---------------------------------------------------------------------------

const sqlHost = envStr('IP/hostname ของ SQL Server (รองรับ named instance เช่น SRV01\\SQLEXPRESS)', {
  pattern: SQL_HOST_RE,
});
const sqlPassword = envStr('รหัสผ่านของ login อ่านอย่างเดียว');
const sqlDatabase = envStr('ชื่อ database ของ ERP เช่น db_TCL', { pattern: SQL_DB_NAME_RE });
const sqlUserBase = envStr('login ที่มีสิทธิ์ SELECT เท่านั้น (db_datareader)');
/**
 * กฎเหล็กชั้นที่ 1 (docs/erp-integration.md): ห้ามใช้บัญชี sa ต่อ ERP
 * ถ้าใช้ sa ระบบจะถูกปฏิเสธที่ boot probe (ชั้นที่ 2) อยู่แล้ว — ดักไว้เพื่อบอกเหตุผลตรง ๆ
 *
 * ⚠️ ย้ายการตรวจไปอยู่ในด่าน cross-field ด้านล่างแล้ว เพราะต้องอ่าน
 *    `ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT` ประกอบ ซึ่ง `.refine()` ระดับฟิลด์เดียวมองไม่เห็น
 */

/** คีย์ ERP_SQL_* ที่มี default หรือเป็น optional เสมอ (ทุก driver ประกาศเหมือนกัน) */
const sqlSharedShape = {
  ERP_SQL_DIALECT: envEnum(ERP_SQL_DIALECTS, 'ชนิด DB ของ ERP (โปรเจคนี้ใช้ mssql)').default(
    'mssql',
  ),
  ERP_SQL_PORT: envInt({
    min: 1,
    max: 65535,
    default: 1433,
    hint: 'พอร์ต SQL Server (ปกติ 1433)',
  }),
  ERP_SQL_ITEMS_VIEW: envStr('ชื่อ view/ตาราง item master เช่น dbo.v_items', {
    max: 256,
    pattern: SQL_OBJECT_RE,
  }).optional(),
  ERP_SQL_ITEMS_SQL_FILE: envStr('พาธเต็มของไฟล์ .sql เช่น /config/inventory-items.sql', {
    max: 512,
    pattern: ABS_SQL_FILE_RE,
  }).optional(),
  ERP_SQL_CHARSET: envEnum(
    ERP_SQL_CHARSETS,
    'charset ของคอลัมน์ ERP (db_TCL เป็น NVARCHAR → utf8)',
  ).default('utf8'),
  ERP_SQL_ENCRYPT: envBool(false, 'true ถ้า SQL Server บังคับ TLS'),
  ERP_SQL_TRUST_SERVER_CERT: envBool(true, 'true สำหรับ self-signed cert ใน LAN'),
  ERP_SQL_POOL_MAX: envInt({
    min: 1,
    max: 20,
    default: 3,
    hint: 'เพดาน connection ต่อ DB ของ ERP (ห้ามดูดจนอิ่ม)',
  }),
} as const;

/** บังคับเมื่อ ERP_DRIVER=sql */
const sqlRequiredShape = {
  ERP_SQL_HOST: sqlHost,
  ERP_SQL_USER: sqlUserBase,
  ERP_SQL_PASSWORD: sqlPassword,
  ERP_SQL_DATABASE: sqlDatabase,
} as const;

/**
 * เส้นทางเขียนกลับ ERP (ส่งผลนับเข้า tbl_CountHdr / tbl_CountDtl)
 *
 * 🚫 บัญชีนี้ต้องแยกจากบัญชีอ่านเสมอ — บัญชีอ่านต้องพิสูจน์ได้ว่าเขียนไม่ได้
 *    ตามกฎเหล็กชั้นที่ 1 ถ้าใช้บัญชีเดียวกัน การพิสูจน์นั้นหมดความหมายทันที
 * ปิดอยู่โดยค่าเริ่มต้น — ต้องตั้ง ERP_WRITEBACK_ENABLED=true อย่างจงใจเท่านั้น
 */
const writebackShape = {
  ERP_WRITEBACK_ENABLED: envBool(
    false,
    'true = เปิดให้ส่งผลนับกลับ ERP (ต้องตั้ง ERP_SQL_WRITE_USER/PASSWORD ด้วย)',
  ),
  ERP_SQL_WRITE_USER: envStr('login ที่มีสิทธิ์เขียนเฉพาะตารางรอบนับของ ERP', {
    max: 128,
  }).optional(),
  ERP_SQL_WRITE_PASSWORD: envStr('รหัสผ่านของ ERP_SQL_WRITE_USER', { max: 256 }).optional(),
  ERP_WRITEBACK_DTL_VOUCHERNO: envBool(
    false,
    'true = ใส่ VoucherNo ลง tbl_CountDtl ด้วย (เปิดเมื่อฝ่าย ERP ยืนยันว่ามีคอลัมน์นี้)',
  ),
} as const;

/** driver อื่นไม่บังคับ แต่ยังประกาศคีย์ไว้ให้ ConfigService อ่านได้ */
const sqlOptionalShape = {
  ERP_SQL_HOST: sqlHost.optional(),
  ERP_SQL_USER: sqlUserBase.optional(),
  ERP_SQL_PASSWORD: sqlPassword.optional(),
  ERP_SQL_DATABASE: sqlDatabase.optional(),
} as const;

// ---------------------------------------------------------------------------
// [6] กลุ่ม ERP_REST_*
// ---------------------------------------------------------------------------

const restBaseUrl = envStr('base URL ของ ERP REST API เช่น http://192.168.1.20:8000/api', {
  max: 512,
}).refine(isHttpUrl, 'ต้องเป็น URL ที่ขึ้นต้นด้วย http:// หรือ https://');
const restItemsPath = envStr('path รายการสินค้า เช่น /inventory/items', {
  max: 256,
  pattern: REST_PATH_RE,
});
const restWarehouseParam = envStr(
  'ชื่อ query param สำหรับ filter คลัง (บังคับ — ไม่ filter จะได้ยอดรวมทั้งบริษัท)',
  { max: 64, pattern: QUERY_PARAM_RE },
);

/** คีย์ ERP_REST_* ที่มี default หรือ optional เสมอ */
const restSharedShape = {
  ERP_REST_AUTH_MODE: envEnum(ERP_REST_AUTH_MODES, 'โหมด auth ของ ERP REST').default('none'),
  ERP_REST_AUTH_HEADER: envStr('ชื่อ header ที่ใส่ credential เช่น Authorization', {
    max: 64,
    pattern: HEADER_NAME_RE,
  }).optional(),
  ERP_REST_AUTH_TOKEN: envStr('ค่าที่ส่งใน header นั้น', { max: 2048 }).optional(),
  ERP_REST_BASIC_USER: envStr('username สำหรับ basic auth', { max: 256 }).optional(),
  ERP_REST_BASIC_PASS: envStr('password สำหรับ basic auth', { max: 512 }).optional(),
  ERP_REST_STOCK_PATH: envStr('path ยอดสต็อกต่อคลัง เช่น /inventory/stock', {
    max: 256,
    pattern: REST_PATH_RE,
  }).optional(),
  ERP_REST_PAGINATION: envEnum(ERP_REST_PAGINATIONS, 'รูปแบบ pagination ของ ERP').default('none'),
  ERP_REST_PAGE_PARAM: envStr('ชื่อ param เลขหน้า/offset', {
    max: 64,
    pattern: QUERY_PARAM_RE,
  }).optional(),
  ERP_REST_SIZE_PARAM: envStr('ชื่อ param ขนาดหน้า', {
    max: 64,
    pattern: QUERY_PARAM_RE,
  }).optional(),
  ERP_REST_PAGE_SIZE: envInt({ min: 1, max: 10_000, default: 500, hint: 'ขนาดหน้าต่อ request' }),
  ERP_REST_CURSOR_PATH: envStr('path ของ cursor ถัดไปใน response เช่น meta.next_cursor', {
    max: 256,
    pattern: DOT_PATH_RE,
  }).optional(),
  ERP_REST_DATA_PATH: envStr('path ของ array ข้อมูลใน response (root ใช้ ".")', {
    max: 256,
    pattern: DOT_PATH_RE,
  }).default('.'),
  ERP_REST_SINCE_PARAM: envStr('ชื่อ param สำหรับ delta pull (เว้นว่าง = ERP ไม่รองรับ delta)', {
    max: 64,
    pattern: QUERY_PARAM_RE,
  }).optional(),
  ERP_REST_SINCE_FORMAT: envEnum(
    ERP_REST_SINCE_FORMATS,
    'ฟอร์แมตของ since param (date_be = วันที่ พ.ศ.)',
  ).default('iso8601'),
  ERP_REST_FIELD_MAP: envStr('พาธเต็มของไฟล์ field map .json เช่น /config/erp-fieldmap.json', {
    max: 512,
    pattern: ABS_JSON_FILE_RE,
  }).optional(),
} as const;

/** บังคับเมื่อ ERP_DRIVER=rest */
const restRequiredShape = {
  ERP_REST_BASE_URL: restBaseUrl,
  ERP_REST_ITEMS_PATH: restItemsPath,
  ERP_REST_WAREHOUSE_PARAM: restWarehouseParam,
} as const;

const restOptionalShape = {
  ERP_REST_BASE_URL: restBaseUrl.optional(),
  ERP_REST_ITEMS_PATH: restItemsPath.optional(),
  ERP_REST_WAREHOUSE_PARAM: restWarehouseParam.optional(),
} as const;

// ---------------------------------------------------------------------------
// discriminated union ตาม ERP_DRIVER
// ---------------------------------------------------------------------------

const mockEnvSchema = z.object({
  ERP_DRIVER: z.literal('mock'),
  ...commonShape,
  ...sqlSharedShape,
  ...sqlOptionalShape,
  ...writebackShape,
  ...restSharedShape,
  ...restOptionalShape,
});

const sqlEnvSchema = z.object({
  ERP_DRIVER: z.literal('sql'),
  ...commonShape,
  ...sqlSharedShape,
  ...sqlRequiredShape,
  ...writebackShape,
  ...restSharedShape,
  ...restOptionalShape,
});

const restEnvSchema = z.object({
  ERP_DRIVER: z.literal('rest'),
  ...commonShape,
  ...sqlSharedShape,
  ...sqlOptionalShape,
  ...writebackShape,
  ...restSharedShape,
  ...restRequiredShape,
});

const driverUnion = z.discriminatedUnion('ERP_DRIVER', [
  mockEnvSchema,
  sqlEnvSchema,
  restEnvSchema,
]);

/**
 * รูปร่างคอนฟิกที่ตรวจแล้ว (union ตาม ERP_DRIVER)
 * ทุก branch มีทุกคีย์ จึงอ่านได้ทั้งแบบตรง (`config.ERP_SQL_HOST` → string | undefined)
 * และแบบ narrow (`if (config.ERP_DRIVER === 'sql')` → ERP_SQL_HOST เป็น string)
 * ใช้กับ Nest ได้ตรง ๆ: `ConfigService<AppConfig, true>`
 */
export type AppConfig = z.infer<typeof driverUnion>;

/**
 * ค่าที่ไม่ trim (อาจมีช่องว่างเป็นส่วนหนึ่งของความลับจริง — ห้ามแก้เงียบ ๆ)
 * ตรวจ "ว่างหรือไม่" ด้วยค่าที่ trim แล้ว แต่ส่งค่าดิบเข้า schema
 */
const KEEP_RAW_KEYS: ReadonlySet<string> = new Set([
  'POSTGRES_PASSWORD',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'PIN_PEPPER',
  'ERP_SQL_PASSWORD',
  'ERP_REST_AUTH_TOKEN',
  'ERP_REST_BASIC_PASS',
]);

/** ทำ env ให้เป็นสตริงล้วน + ตัดคีย์ที่ค่าว่าง (ค่าว่าง = ถือว่าไม่ได้ตั้ง → default ทำงาน) */
function normalizeEnv(raw: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return normalized;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    // ค่าจาก process.env เป็น string เสมอ แต่ raw อาจมาจาก validate() ที่ส่งค่าชนิดอื่นมาได้
    // ⚠️ รับเฉพาะ scalar — String(object) = '[object Object]' จะกลายเป็นค่าคอนฟิกที่ดู
    //    "มีค่า" ทั้งที่ผิด และ String(symbol) โยน TypeError ทำให้ boot ล้มโดยไม่มีสาเหตุที่อ่านออก
    const asString =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? String(value)
          : '';
    if (asString.trim().length === 0) continue;
    normalized[key] = KEEP_RAW_KEYS.has(key) ? asString : asString.trim();
  }
  return normalized;
}

/** กฎข้ามตัวแปร — ทำงานหลัง union ผ่านแล้ว จึง narrow ตาม ERP_DRIVER ได้ */
function crossFieldRules(config: AppConfig, ctx: z.RefinementCtx): void {
  const addIssue = (variable: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [variable], message });
  };
  const requireFor = (variable: string, value: string | undefined, reason: string): void => {
    if (value === undefined) addIssue(variable, `จำเป็นเมื่อ ${reason}`);
  };

  if (config.AUTH_THROTTLE_MAX_MS < config.AUTH_THROTTLE_BASE_MS) {
    addIssue('AUTH_THROTTLE_MAX_MS', 'ต้องไม่น้อยกว่า AUTH_THROTTLE_BASE_MS (เพดานหน่วงต้องสูงกว่าค่าเริ่มต้น)');
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    addIssue(
      'JWT_REFRESH_SECRET',
      'ต้องไม่เป็นค่าเดียวกับ JWT_ACCESS_SECRET — สร้างแยกกันด้วย openssl rand -hex 32',
    );
  }

  // 🚫 กฎเหล็กชั้นที่ 1: ห้ามบัญชี sa ต่อ ERP (ฝั่งอ่าน)
  //    ผ่อนได้ด้วยสวิตช์ทดสอบเท่านั้น — boot probe ชั้นที่ 2 ก็จะเหลือแค่คำเตือนเช่นกัน
  if (
    !config.ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT &&
    config.ERP_SQL_USER &&
    config.ERP_SQL_USER.trim().toLowerCase() === 'sa'
  ) {
    addIssue(
      'ERP_SQL_USER',
      'ห้ามใช้บัญชี sa ต่อ ERP — ต้องเป็น login สิทธิ์ SELECT เท่านั้น (db_datareader) ตามกฎ ERP อ่านอย่างเดียว',
    );
  }

  if (config.ERP_WRITEBACK_ENABLED) {
    if (config.ERP_DRIVER !== 'sql') {
      addIssue(
        'ERP_WRITEBACK_ENABLED',
        "ส่งผลนับกลับ ERP ได้เฉพาะ ERP_DRIVER=sql เท่านั้น — driver อื่นไม่มีเส้นทางเขียน",
      );
    }
    // บังคับเสมอ แม้ในโหมดทดสอบ — เปิดเส้นทางเขียนโดยไม่มีบัญชีเขียน
    // จะกลายเป็น "เปิดไว้แต่ส่งไม่ได้" แบบเงียบ ๆ ซึ่งรู้ตัวตอนกดส่งจริงเท่านั้น
    if (!config.ERP_SQL_WRITE_USER || !config.ERP_SQL_WRITE_PASSWORD) {
      addIssue(
        'ERP_SQL_WRITE_USER',
        'เปิด ERP_WRITEBACK_ENABLED แล้วต้องตั้ง ERP_SQL_WRITE_USER และ ERP_SQL_WRITE_PASSWORD ด้วย',
      );
    }
    // 🚫 กฎเหล็กชั้นที่ 1: บัญชีอ่านต้องพิสูจน์ได้ว่าเขียนไม่ได้ ถ้าใช้บัญชีเดียวกับ
    //    เส้นทางเขียน การพิสูจน์นั้นหมดความหมาย และ boot probe จะปฏิเสธการ start
    if (!config.ERP_UNSAFE_ALLOW_PRIVILEGED_ACCOUNT) {
      if (
        config.ERP_SQL_WRITE_USER &&
        config.ERP_SQL_USER &&
        config.ERP_SQL_WRITE_USER.trim().toLowerCase() === config.ERP_SQL_USER.trim().toLowerCase()
      ) {
        addIssue(
          'ERP_SQL_WRITE_USER',
          'ต้องเป็นคนละบัญชีกับ ERP_SQL_USER — บัญชีที่ใช้อ่านต้องไม่มีสิทธิ์เขียนเด็ดขาด',
        );
      }
      if (config.ERP_SQL_WRITE_USER && config.ERP_SQL_WRITE_USER.trim().toLowerCase() === 'sa') {
        addIssue('ERP_SQL_WRITE_USER', 'ห้ามใช้บัญชี sa ต่อ ERP ไม่ว่ากรณีใด');
      }
    }
  }

  if (config.ERP_DRIVER === 'sql') {
    // แหล่ง query: เลือก view หรือไฟล์ .sql อย่างใดอย่างหนึ่ง (items บังคับ, stock ไม่บังคับ)
    checkSqlSource(addIssue, 'ITEMS', config.ERP_SQL_ITEMS_VIEW, config.ERP_SQL_ITEMS_SQL_FILE, true);
    if (config.ERP_SQL_DIALECT !== 'mssql') {
      addIssue(
        'ERP_SQL_DIALECT',
        "โปรเจคนี้ยืนยันแล้วว่า ERP เป็น SQL Server — driver รองรับเฉพาะ 'mssql' ในเฟสนี้",
      );
    }
  }

  if (config.ERP_DRIVER === 'rest') {
    if (config.ERP_REST_AUTH_MODE === 'header') {
      requireFor('ERP_REST_AUTH_HEADER', config.ERP_REST_AUTH_HEADER, 'ERP_REST_AUTH_MODE=header');
      requireFor('ERP_REST_AUTH_TOKEN', config.ERP_REST_AUTH_TOKEN, 'ERP_REST_AUTH_MODE=header');
    }
    if (config.ERP_REST_AUTH_MODE === 'basic') {
      requireFor('ERP_REST_BASIC_USER', config.ERP_REST_BASIC_USER, 'ERP_REST_AUTH_MODE=basic');
      requireFor('ERP_REST_BASIC_PASS', config.ERP_REST_BASIC_PASS, 'ERP_REST_AUTH_MODE=basic');
    }
    if (config.ERP_REST_PAGINATION === 'page' || config.ERP_REST_PAGINATION === 'offset') {
      const reason = `ERP_REST_PAGINATION=${config.ERP_REST_PAGINATION}`;
      requireFor('ERP_REST_PAGE_PARAM', config.ERP_REST_PAGE_PARAM, reason);
      requireFor('ERP_REST_SIZE_PARAM', config.ERP_REST_SIZE_PARAM, reason);
    }
    if (config.ERP_REST_PAGINATION === 'cursor') {
      requireFor('ERP_REST_CURSOR_PATH', config.ERP_REST_CURSOR_PATH, 'ERP_REST_PAGINATION=cursor');
    }
  }
}

function checkSqlSource(
  addIssue: (variable: string, message: string) => void,
  kind: 'ITEMS' | 'STOCK',
  view: string | undefined,
  sqlFile: string | undefined,
  mandatory: boolean,
): void {
  const viewVar = `ERP_SQL_${kind}_VIEW`;
  const fileVar = `ERP_SQL_${kind}_SQL_FILE`;
  if (view !== undefined && sqlFile !== undefined) {
    addIssue(viewVar, `ระบุมาทั้ง ${viewVar} และ ${fileVar} — เลือกอย่างใดอย่างหนึ่งเท่านั้น`);
    return;
  }
  if (mandatory && view === undefined && sqlFile === undefined) {
    addIssue(viewVar, `ต้องระบุ ${viewVar} หรือ ${fileVar} อย่างใดอย่างหนึ่ง (ERP_DRIVER=sql)`);
  }
}

/** schema เต็มของ `.env` — normalize → union ตาม driver → กฎข้ามตัวแปร */
export const envSchema: z.ZodType<AppConfig, z.ZodTypeDef, unknown> = z
  .preprocess(normalizeEnv, driverUnion)
  .superRefine(crossFieldRules);

// ---------------------------------------------------------------------------
// loadConfig — fail fast พร้อมชื่อตัวแปรที่ผิดทุกตัว (ห้ามพิมพ์ค่า)
// ---------------------------------------------------------------------------

export class EnvValidationError extends Error {
  /** ชื่อตัวแปรที่ผิด (ไม่เก็บค่าของตัวแปร เพื่อไม่ให้ความลับหลุดไปกับ log) */
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/** ตัดข้อความส่วน "received ..." ที่ zod ต่อท้ายมา — กันค่าจริงหลุดออก log */
function scrubReceived(message: string): string {
  return message.replace(/,?\s*received\s+.*$/i, '').trim();
}

function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') {
        return issue.message === 'Required' ? 'ไม่ได้ตั้งค่า (จำเป็นต้องมี)' : issue.message;
      }
      return issue.message;
    case z.ZodIssueCode.invalid_enum_value:
      return `ค่าที่รับได้: ${listOf(issue.options.map((option) => String(option)))}`;
    case z.ZodIssueCode.invalid_union_discriminator:
      return `ต้องเป็นค่าใดค่าหนึ่ง: ${listOf(issue.options.map((option) => String(option)))}`;
    default:
      return issue.message;
  }
}

function formatIssues(issues: readonly z.ZodIssue[]): { lines: string[]; variables: string[] } {
  const byVariable = new Map<string, string[]>();
  for (const issue of issues) {
    const variable = issue.path.length > 0 ? issue.path.map(String).join('.') : '(.env ทั้งไฟล์)';
    const reason = scrubReceived(describeIssue(issue));
    const reasons = byVariable.get(variable) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    byVariable.set(variable, reasons);
  }
  const variables = [...byVariable.keys()].sort((a, b) => a.localeCompare(b));
  const lines = variables.map((variable) => {
    const reasons = byVariable.get(variable) ?? [];
    return `  • ${variable}: ${reasons.join(' / ')}`;
  });
  return { lines, variables };
}

/**
 * ตรวจ `.env` แล้วคืนคอนฟิกที่ typed แล้ว
 * ผิด → throw `EnvValidationError` ที่บอกชื่อตัวแปรทุกตัวที่ผิด (บรรทัดละตัว)
 * 🚫 ไม่มีการนำ "ค่า" ของตัวแปรใส่ในข้อความ error หรือ log
 */
export function loadConfig(env: Record<string, unknown> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (result.success) return result.data;

  const { lines, variables } = formatIssues(result.error.issues);
  const message = [
    `คอนฟิก .env ไม่ผ่านการตรวจสอบ — พบปัญหา ${variables.length} ตัวแปร (ระบบไม่เริ่มทำงาน)`,
    ...lines,
    'วิธีแก้: แก้ค่าในไฟล์ .env แล้ว start ใหม่ · เทียบชื่อ key กับ .env.example · ดู docs/erp-integration.md §4',
    'หมายเหตุ: ระบบไม่พิมพ์ค่าของตัวแปรออก log เพื่อไม่ให้ความลับรั่ว',
  ].join('\n');

  throw new EnvValidationError(message, variables);
}

// ---------------------------------------------------------------------------
// NestJS module
// ---------------------------------------------------------------------------

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // ห้าม expand ตัวแปร: รหัสผ่านจริงมี $ และ ( ) ปนอยู่ จะถูกแทนค่าผิด
      expandVariables: false,
      envFilePath: ['.env'],
      validate: loadConfig,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
