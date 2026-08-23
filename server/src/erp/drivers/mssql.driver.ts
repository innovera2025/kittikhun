import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';
import { z } from 'zod';

import type { AppConfig } from '../../config/env.config';
import {
  assertReadOnlySql,
  BaseErpDriver,
  type CanonicalItem,
  type Cursor,
} from '../erp-adapter';

/**
 * ERP driver: Microsoft SQL Server 2019 · database `db_TCL` · collation `Thai_CI_AS`
 *
 * 🚫 กฎเหล็ก: ERP เป็นแหล่ง **อ่านอย่างเดียว** — ไม่มี method เขียนในคลาสนี้ และทุก
 *    statement ที่วิ่งเข้า connection ของ ERP ต้องผ่าน assertReadOnlySql() ก่อนเสมอ
 *    (ข้อยกเว้นเดียว = write-probe ตอน boot ที่มีไว้เพื่อ *กัน* การเขียน — ดู verifyReadOnly())
 *
 * ข้อเท็จจริงของ ERP จริงที่ driver นี้ยึด (docs/erp-tcl-findings.md):
 *  - item master = `dbo.InventoryItem` · PK = (Roworder, ItemCode) → **ItemCode ซ้ำได้**
 *    → กติกา: Roworder สูงสุดชนะ (ทำด้วย ROW_NUMBER() ใน SQL / ในหน่วยความจำสำหรับ script)
 *  - ไม่มีตารางยอดคงเหลือสำเร็จรูป → ยอดระบบที่เชื่อถือได้คือ `tbl_CountDtl.MainQty` ในรอบนับ
 *  - รอบนับ = `dbo.tbl_CountHdr` + `dbo.tbl_CountDtl` join ด้วย TransactionNo
 *    `tbl_CountHdr` PK = (Roworder, TransactionNo) → **VoucherNo/TransactionNo ซ้ำได้** → dedupe เช่นกัน
 *  - คอลัมน์ nvarchar ถูก pad ช่องว่าง → LTRIM/RTRIM ทุกคอลัมน์ข้อความ
 *  - คลังจริง: WHRM / WHFG / WHWIP / WHNG (ไม่ใช่ WH-BKK-02 ที่ design เดิมสมมติไว้)
 */

const logger = new Logger('MssqlDriver');

const DRIVER_NAME = 'sql';

/** ขนาด batch ของ AsyncIterable ตามสัญญา adapter */
const ITEM_BATCH_SIZE = 500;
/** กันลูป pagination วิ่งไม่จบถ้า ERP ตอบแปลก */
const MAX_ITEM_PAGES = 2000;

const DEFAULT_ITEMS_TABLE = 'dbo.InventoryItem';

/** คลังที่พบจริงใน db_TCL — ใช้เตือน schema/config drift เท่านั้น ไม่ใช่ตัวกรองข้อมูล */
const KNOWN_WAREHOUSES: readonly string[] = ['WHRM', 'WHFG', 'WHWIP', 'WHNG'];

/** ชื่อ object ที่ยอมให้ประกอบเข้า SQL ได้ (config เท่านั้น ไม่ใช่ input ผู้ใช้) */
const SQL_IDENTIFIER_RE = /^\[?[A-Za-z_][\w$#]*\]?(\.\[?[A-Za-z_][\w$#]*\]?){0,2}$/;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type MssqlDriverErrorCode =
  | 'ERP_CONFIG' // .env / ไฟล์ .sql ผิด — ผู้ดูแลต้องแก้ก่อน start
  | 'ERP_WRITE_ALLOWED' // 🚨 login เขียน ERP ได้ — ปฏิเสธการ start
  | 'ERP_PROBE_INCONCLUSIVE' // probe ไม่สามารถสรุปได้ว่าเขียนไม่ได้
  | 'ERP_UNREACHABLE' // ต่อไม่ได้/ล็อกอินไม่ผ่าน — ไม่ควร block การ start (degraded)
  | 'ERP_THAI_DECODE' // ข้อความไทยเพี้ยน → charset ผิด
  | 'ERP_SCHEMA_DRIFT' // คอลัมน์/ชนิดข้อมูลเปลี่ยน
  | 'ERP_QUERY'; // query ล้มเหลวด้วยเหตุอื่น

export class MssqlDriverError extends Error {
  constructor(
    readonly code: MssqlDriverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MssqlDriverError';
  }
}

// ---------------------------------------------------------------------------
// zod helpers — ข้อมูลจาก ERP คือข้อมูลภายนอก ต้อง validate ทุกแถว
// ---------------------------------------------------------------------------

/** ข้อความจาก ERP: trim ช่องว่างที่ pad มา · ค่าว่าง/NULL → undefined (ไม่ใช่ '') */
const zTextOpt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  });

const zTextReq = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((text) => text.length > 0, { message: 'ค่าว่าง' });

const zNumOpt = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((value, ctx) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim().length === 0) return undefined;
    const num = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(num)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ไม่ใช่ตัวเลข' });
      return z.NEVER;
    }
    return num;
  });

/** ฟิลด์สินค้าหลัง pick ชื่อคอลัมน์แล้ว (รองรับทั้งชื่อ ERP และ snake_case จาก script) */
const ItemFieldsSchema = z.object({
  sku: zTextReq,
  name: zTextReq,
  nameEn: zTextOpt,
  unit: zTextOpt,
  loc: zTextOpt,
  lot: zTextOpt,
  rop: zNumOpt,
  onHand: zNumOpt,
  barcodeUnits: zTextOpt,
  barcodePack: zTextOpt,
  roworder: zNumOpt,
  warehouse: zTextOpt,
});

// ---------------------------------------------------------------------------
// ⚠️ เคยมี type/mapper ของ "รอบนับจาก ERP" อยู่ตรงนี้ — ตัดออกถาวร 22 ส.ค. 2569
//    ระบบนี้ดึงจาก ERP แค่จำนวนคงเหลือเท่านั้น (ดูคอมเมนต์ที่คลาส MssqlDriver)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// charset ไทย
// ---------------------------------------------------------------------------

type ThaiCharset = 'utf8' | 'win874' | 'tis620';

/** ไบต์พิเศษของ Windows-874 ที่ไม่ได้อยู่ในบล็อก Thai */
const CP874_SPECIALS: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x85: 0x2026,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
};

function cp874ByteToCodePoint(byte: number): number {
  if (byte < 0x80) return byte;
  const special = CP874_SPECIALS[byte];
  if (special !== undefined) return special;
  // ช่วงไทยของ CP874/TIS-620 แม็ปตรงเข้าบล็อก Thai: 0xA1→U+0E01 … 0xFB→U+0E5B (offset 0x0D60)
  if ((byte >= 0xa1 && byte <= 0xda) || (byte >= 0xdf && byte <= 0xfb)) {
    return byte + 0x0d60;
  }
  return 0xfffd; // ไบต์ที่ไม่มีในตาราง → U+FFFD ให้ smoke test จับได้
}

function decodeCp874(buf: Buffer): string {
  let out = '';
  for (const byte of buf) out += String.fromCodePoint(cp874ByteToCodePoint(byte));
  return out;
}

/** ช่วง Thai Unicode U+0E01–U+0E5B */
const THAI_BLOCK_RE = /[\u0E01-\u0E5B]/;
/** U+FFFD — สัญญาณว่า decode ผิด charset */
const REPLACEMENT_CHAR = '\uFFFD';

/**
 * แปลงค่าที่ได้จาก driver ให้เป็นสตริงไทยที่ถูกต้อง
 * - NVARCHAR (`ERP_SQL_CHARSET=utf8`) = Unicode อยู่แล้ว ใช้ค่าตรง ๆ
 * - VARCHAR + Thai collation (`win874`/`tis620`) = ถ้า tedious คืน Buffer หรือ decode มาเป็น
 *   latin1 ให้ม้วนกลับเป็นไบต์แล้วแม็ปด้วยตาราง CP874 (ถ้ามีอักษรไทยอยู่แล้ว = ถูกต้อง ไม่แตะ)
 */
function decodeThai(value: unknown, charset: ThaiCharset): unknown {
  if (Buffer.isBuffer(value)) {
    return charset === 'utf8' ? value.toString('utf8') : decodeCp874(value);
  }
  if (typeof value !== 'string' || charset === 'utf8') return value;
  if (THAI_BLOCK_RE.test(value)) return value;
  return decodeCp874(Buffer.from(value, 'latin1'));
}

// ---------------------------------------------------------------------------
// utility
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readProp(err: unknown, key: string): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as Record<string, unknown>)[key];
}

const CONNECTION_ERROR_CODES = new Set([
  'ELOGIN',
  'ESOCKET',
  'ETIMEOUT',
  'ECONNCLOSED',
  'ENOTOPEN',
  'EINSTLOOKUP',
  'EDRIVER',
]);

function isConnectionError(err: unknown): boolean {
  const code = readProp(err, 'code');
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}



function* chunk<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function uniqueNonEmpty(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** อ่านค่าจากแถวแบบไม่สนตัวพิมพ์ใหญ่-เล็ก (script ของเจ้าของโปรเจคอาจตั้งชื่อคอลัมน์คนละสไตล์) */
function rowGetter(row: Record<string, unknown>): (...names: string[]) => unknown {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) lower.set(key.toLowerCase(), value);
  return (...names: string[]): unknown => {
    for (const name of names) {
      const value = lower.get(name.toLowerCase());
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
}

/**
 * แปลงค่าจาก ERP เป็น string เฉพาะเมื่อเป็น scalar จริง ๆ
 *
 * ⚠️ `String(unknown)` กับ object จะได้ `'[object Object]'` ซึ่งดู "มีค่า" ทั้งที่ไม่มี
 *    ถ้าปล่อยให้ค่านั้นกลายเป็นรหัสสินค้า จะมีสินค้าผีไหลเข้า items_cache
 *    → คืน '' เพื่อให้ผู้เรียกถือว่า "ไม่มีค่า" แล้วข้ามแถวไป
 */
function asScalarString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function pickItemFields(row: Record<string, unknown>): Record<string, unknown> {
  const get = rowGetter(row);
  return {
    sku: get('ItemCode', 'sku', 'item_code'),
    name: get('ItemName', 'name', 'item_name'),
    nameEn: get('ItemNameEng', 'name_en', 'nameEn'),
    unit: get('MainUnits', 'unit', 'main_units'),
    loc: get('Shelf', 'loc', 'location', 'shelf'),
    lot: get('LotNumber', 'lot', 'lot_number'),
    rop: get('MinStock', 'rop', 'min_stock', 'reorder_point'),
    // ยอดคงเหลือ: `dbo.InventoryItem` ไม่มีค่าที่ใช้ได้ (BalStock ตรงกับ ledger 0/56)
    // → มาจาก script ของฝ่าย ERP ที่ SUM(InOut × MainQuantity) จาก InventoryFlowDtl
    // 'Balqty' คือชื่อคอลัมน์ในสูตรต้นฉบับ — รับไว้ด้วยเผื่อ script ไม่ได้ alias เป็น on_hand
    onHand: get('on_hand', 'onHand', 'Balqty', 'BalQty'),
    barcodeUnits: get('BarCodeUnits', 'barcode', 'bar_code_units'),
    barcodePack: get('BarCodePack', 'barcode_pack', 'bar_code_pack'),
    roworder: get('Roworder', 'roworder'),
    warehouse: get('Warehouse', 'warehouse_code', 'warehouseCode'),
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'ไม่ผ่าน validation';
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const zBoolLike = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
});

const zIntLike = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const num = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(num) || num <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ต้องเป็นจำนวนเต็มบวก' });
    return z.NEVER;
  }
  return num;
});

const zSqlIdentifier = z
  .string()
  .trim()
  .regex(SQL_IDENTIFIER_RE, 'ต้องเป็นชื่อแบบ schema.object เท่านั้น (ห้ามมีช่องว่าง, ; หรือคำสั่ง SQL)');

/**
 * zod ซ้ำอีกชั้นเฉพาะ subset ของ driver นี้ — env.config ตรวจตอน boot แล้ว
 * แต่ driver ต้องพิสูจน์เองว่าค่าที่ได้ใช้ต่อ SQL Server ได้จริง (fail fast + บอกชื่อตัวแปร)
 */
const DriverEnvSchema = z.object({
  ERP_SQL_HOST: z.string().trim().min(1),
  ERP_SQL_PORT: zIntLike.default(1433),
  ERP_SQL_USER: z.string().min(1),
  ERP_SQL_PASSWORD: z.string().min(1),
  ERP_SQL_DATABASE: z.string().trim().min(1),
  ERP_SQL_ENCRYPT: zBoolLike.default(false),
  ERP_SQL_TRUST_SERVER_CERT: zBoolLike.default(true),
  ERP_TIMEOUT_MS: zIntLike.default(15_000),
  ERP_SQL_POOL_MAX: zIntLike.default(3),
  ERP_SQL_CHARSET: z.enum(['utf8', 'win874', 'tis620']).default('utf8'),
  ERP_SQL_ITEMS_VIEW: zSqlIdentifier.optional(),
  ERP_SQL_ITEMS_SQL_FILE: z.string().trim().min(1).optional(),
  WAREHOUSE_CODE: z.string().trim().min(1),
});

interface MssqlDriverConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly encrypt: boolean;
  readonly trustServerCert: boolean;
  readonly timeoutMs: number;
  readonly poolMax: number;
  readonly charset: ThaiCharset;
  readonly itemsTable: string;
  readonly itemsSqlFile?: string;
  readonly warehouseCode: string;
}

function readDriverConfig(cfg: ConfigService<AppConfig, true>): MssqlDriverConfig {
  const parsed = DriverEnvSchema.safeParse({
    ERP_SQL_HOST: cfg.get('ERP_SQL_HOST', { infer: true }),
    ERP_SQL_PORT: cfg.get('ERP_SQL_PORT', { infer: true }),
    ERP_SQL_USER: cfg.get('ERP_SQL_USER', { infer: true }),
    ERP_SQL_PASSWORD: cfg.get('ERP_SQL_PASSWORD', { infer: true }),
    ERP_SQL_DATABASE: cfg.get('ERP_SQL_DATABASE', { infer: true }),
    ERP_SQL_ENCRYPT: cfg.get('ERP_SQL_ENCRYPT', { infer: true }),
    ERP_SQL_TRUST_SERVER_CERT: cfg.get('ERP_SQL_TRUST_SERVER_CERT', { infer: true }),
    ERP_TIMEOUT_MS: cfg.get('ERP_TIMEOUT_MS', { infer: true }),
    ERP_SQL_POOL_MAX: cfg.get('ERP_SQL_POOL_MAX', { infer: true }),
    ERP_SQL_CHARSET: cfg.get('ERP_SQL_CHARSET', { infer: true }),
    ERP_SQL_ITEMS_VIEW: cfg.get('ERP_SQL_ITEMS_VIEW', { infer: true }),
    ERP_SQL_ITEMS_SQL_FILE: cfg.get('ERP_SQL_ITEMS_SQL_FILE', { infer: true }),
    WAREHOUSE_CODE: cfg.get('WAREHOUSE_CODE', { infer: true }),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new MssqlDriverError(
      'ERP_CONFIG',
      `คอนฟิก ERP driver "sql" ไม่ถูกต้อง — แก้ไฟล์ .env ตามนี้:\n${detail}`,
    );
  }

  const env = parsed.data;
  return {
    host: env.ERP_SQL_HOST,
    port: env.ERP_SQL_PORT,
    user: env.ERP_SQL_USER,
    password: env.ERP_SQL_PASSWORD,
    database: env.ERP_SQL_DATABASE,
    encrypt: env.ERP_SQL_ENCRYPT,
    trustServerCert: env.ERP_SQL_TRUST_SERVER_CERT,
    timeoutMs: env.ERP_TIMEOUT_MS,
    poolMax: env.ERP_SQL_POOL_MAX,
    charset: env.ERP_SQL_CHARSET,
    itemsTable: env.ERP_SQL_ITEMS_VIEW ?? DEFAULT_ITEMS_TABLE,
    itemsSqlFile: env.ERP_SQL_ITEMS_SQL_FILE,
    warehouseCode: env.WAREHOUSE_CODE,
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * item master แบบ dedupe แล้ว
 * ⚠️ ItemCode ซ้ำได้ (85 รหัส / 172 แถว) → ROW_NUMBER() เอา Roworder สูงสุด (รายการใหม่สุด) ชนะ
 * LTRIM/RTRIM ทุกคอลัมน์ข้อความเพราะ ERP pad ช่องว่าง
 */
function itemsPageSql(itemsTable: string): string {
  return `WITH ranked AS (
  SELECT
    LTRIM(RTRIM(ItemCode))    AS ItemCode,
    LTRIM(RTRIM(ItemName))    AS ItemName,
    LTRIM(RTRIM(ItemNameEng)) AS ItemNameEng,
    LTRIM(RTRIM(MainUnits))   AS MainUnits,
    MinStock                  AS MinStock,
    LTRIM(RTRIM(BarCodeUnits)) AS BarCodeUnits,
    LTRIM(RTRIM(BarCodePack))  AS BarCodePack,
    LTRIM(RTRIM(Shelf))       AS Shelf,
    LTRIM(RTRIM(LotNumber))   AS LotNumber,
    Roworder                  AS Roworder,
    ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(ItemCode)) ORDER BY Roworder DESC) AS rn
  FROM ${itemsTable}
  WHERE IsActive = 1 AND IsStock = 1
)
SELECT ItemCode, ItemName, ItemNameEng, MainUnits, MinStock,
       BarCodeUnits, BarCodePack, Shelf, LotNumber, Roworder
FROM ranked
WHERE rn = 1
ORDER BY ItemCode
OFFSET @offset ROWS FETCH NEXT @batch ROWS ONLY`;
}

/**
 * หัวรอบนับแบบ dedupe แล้ว
 * ⚠️ tbl_CountHdr PK = (Roworder, TransactionNo) → TransactionNo/VoucherNo ซ้ำได้
 *    → เอา Roworder สูงสุดต่อ TransactionNo
 */
/**
 * ตรวจสิทธิ์ของ login ที่ใช้ต่อ ERP — **SELECT ล้วน ไม่แตะข้อมูล**
 *
 * ใช้แทน write-probe เดิมที่ยิง CREATE TABLE + INSERT จริง (ดู MssqlDriver.verifyReadOnly)
 * ทุกคอลัมน์คืน 1 = มี · 0 = ไม่มี · NULL = ตอบไม่ได้ (ต้องถือว่าสรุปไม่ได้ ห้ามปล่อยผ่าน)
 */
const PERMISSION_PROBE_SQL = `SELECT
  IS_SRVROLEMEMBER('sysadmin')                           AS is_sysadmin,
  IS_ROLEMEMBER('db_owner')                              AS is_db_owner,
  IS_ROLEMEMBER('db_ddladmin')                           AS is_db_ddladmin,
  IS_ROLEMEMBER('db_datawriter')                         AS is_db_datawriter,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT')     AS can_insert,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE')     AS can_update,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE')     AS can_delete,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER')      AS can_alter,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create_table,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT')     AS can_select`;

interface PermissionRow {
  is_sysadmin: number | null;
  is_db_owner: number | null;
  is_db_ddladmin: number | null;
  is_db_datawriter: number | null;
  can_insert: number | null;
  can_update: number | null;
  can_delete: number | null;
  can_alter: number | null;
  can_create_table: number | null;
  can_select: number | null;
}

/*
 * ⚠️ เคยมี COUNT_HEADER_CTE / COUNT_SESSIONS_SQL / COUNT_SESSION_SQL / COUNT_LINES_SQL
 *    สำหรับดึงรอบนับของ ERP — ตัดออกถาวร 22 ส.ค. 2569
 */

/** smoke test ภาษาไทย — อ่านจากตาราง item master จริงของ db_TCL */
const THAI_SAMPLE_SQL = `SELECT TOP (1) LTRIM(RTRIM(ItemName)) AS SampleText
FROM ${DEFAULT_ITEMS_TABLE}
WHERE ItemName IS NOT NULL AND LTRIM(RTRIM(ItemName)) <> ''
ORDER BY Roworder DESC`;

type SqlParams = Readonly<Record<string, string | number | Date>>;

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export class MssqlDriver extends BaseErpDriver {
  private readonly sqlCfg: MssqlDriverConfig;
  private poolPromise?: Promise<sql.ConnectionPool>;
  private itemsSqlCache?: string;
  private readOnlyVerified = false;

  constructor(cfg: ConfigService<AppConfig, true>) {
    super();
    this.sqlCfg = readDriverConfig(cfg);

    if (!KNOWN_WAREHOUSES.includes(this.sqlCfg.warehouseCode)) {
      logger.warn(
        `WAREHOUSE_CODE=${this.sqlCfg.warehouseCode} ไม่ตรงกับคลังที่พบจริงใน db_TCL ` +
          `(${KNOWN_WAREHOUSES.join(' / ')}) — ตรวจ .env ก่อนใช้งานจริง`,
      );
    }
  }

  /** ERP นี้ไม่มี updated-at ที่เชื่อถือได้ → full snapshot + diff ฝั่ง server เท่านั้น */
  capabilities() {
    return { delta: false as const };
  }

  /**
   * ลำดับ boot ของ driver (เรียกจาก ErpModule):
   * 1. เชื่อมต่อ pool
   * 2. ชั้นที่ 2 ของกฎเหล็ก — พิสูจน์ว่า login เขียน ERP ไม่ได้ (ไม่ผ่าน = ไม่ start)
   * 3. smoke test ภาษาไทย
   */
  async init(): Promise<void> {
    await this.getPool();
    await this.verifyReadOnly();
    await this.verifyThaiText();
  }

  async close(): Promise<void> {
    const pending = this.poolPromise;
    this.poolPromise = undefined;
    this.readOnlyVerified = false;
    if (!pending) return;
    const pool = await pending.catch(() => undefined);
    await pool?.close().catch((err: unknown) => {
      logger.warn(`ปิด connection pool ของ ERP ไม่สำเร็จ: ${errMessage(err)}`);
    });
  }

  /**
   * ชั้นที่ 2 ของกฎเหล็ก — พิสูจน์ว่า login ที่คอนฟิกไว้ **เขียน ERP ไม่ได้**
   *
   * ⚠️ เดิมทำด้วย write-probe: ยิง `CREATE TABLE` + `INSERT` จริงลง ERP แล้วดูว่าถูกปฏิเสธไหม
   *    วิธีนั้นมีข้อเสียร้ายแรง — ถ้า login **เขียนได้จริง** (เช่นเผลอใส่บัญชีผู้ดูแล)
   *    probe จะ **เขียนลง ERP สำเร็จ** ก่อนที่จะรู้ตัว ซึ่งขัดกับกฎ "ห้ามเขียน ERP ทุกกรณี"
   *    การลบตารางคืนทีหลังไม่ได้ทำให้การเขียนนั้นไม่เคยเกิดขึ้น
   *
   *    เปลี่ยนมาถามสิทธิ์จาก metadata แทน (22 ส.ค. 2569) — ได้คำตอบเดียวกัน
   *    โดย **ไม่แตะข้อมูลใน ERP เลยแม้แต่ไบต์เดียว** ทุก statement เป็น SELECT ล้วน
   */
  async verifyReadOnly(): Promise<void> {
    const pool = await this.getPool();

    let row: PermissionRow | undefined;
    try {
      const result = await pool.request().query<PermissionRow>(PERMISSION_PROBE_SQL);
      row = result.recordset[0];
    } catch (err) {
      if (isConnectionError(err)) {
        throw new MssqlDriverError(
          'ERP_UNREACHABLE',
          `ต่อ ERP (${this.sqlCfg.host}:${this.sqlCfg.port}/${this.sqlCfg.database}) ไม่ได้ ` +
            `จึงยังพิสูจน์สิทธิ์ read-only ไม่ได้: ${errMessage(err)}`,
        );
      }
      throw new MssqlDriverError(
        'ERP_PROBE_INCONCLUSIVE',
        'อ่านสิทธิ์ของ login จาก ERP ไม่ได้ จึงสรุปไม่ได้ว่าเขียนไม่ได้จริง: ' +
          `${errMessage(err)} · ตรวจสิทธิ์ของ ERP_SQL_USER (ต้องเป็น db_datareader) แล้วลองใหม่`,
      );
    }

    if (!row) {
      throw new MssqlDriverError(
        'ERP_PROBE_INCONCLUSIVE',
        'query ตรวจสิทธิ์ไม่คืนผลลัพธ์ — สรุปไม่ได้ว่า login เขียน ERP ไม่ได้',
      );
    }

    // ⚠️ ค่า NULL แปลว่า "ตอบไม่ได้" ไม่ใช่ "ไม่มีสิทธิ์" → ต้องถือว่าสรุปไม่ได้ ห้ามปล่อยผ่าน
    const unknown = Object.entries(row)
      .filter(([, value]) => value === null || value === undefined)
      .map(([key]) => key);
    if (unknown.length > 0) {
      throw new MssqlDriverError(
        'ERP_PROBE_INCONCLUSIVE',
        `ตรวจสิทธิ์ได้ไม่ครบ (${unknown.join(', ')} ตอบเป็น NULL) — สรุปไม่ได้ว่าเขียน ERP ไม่ได้`,
      );
    }

    const granted = ([
      ['เป็นสมาชิก sysadmin', row.is_sysadmin],
      ['เป็นสมาชิก db_owner', row.is_db_owner],
      ['เป็นสมาชิก db_ddladmin', row.is_db_ddladmin],
      ['เป็นสมาชิก db_datawriter', row.is_db_datawriter],
      ['มีสิทธิ์ INSERT', row.can_insert],
      ['มีสิทธิ์ UPDATE', row.can_update],
      ['มีสิทธิ์ DELETE', row.can_delete],
      ['มีสิทธิ์ ALTER', row.can_alter],
      ['มีสิทธิ์ CREATE TABLE', row.can_create_table],
    ] as const)
      .filter(([, value]) => value === 1)
      .map(([label]) => label);

    if (granted.length > 0) {
      throw new MssqlDriverError(
        'ERP_WRITE_ALLOWED',
        `🚨 ปฏิเสธการ start: login ERP_SQL_USER="${this.sqlCfg.user}" **เขียนฐานข้อมูล ERP ` +
          `${this.sqlCfg.database} ได้** (${granted.join(' · ')})\n` +
          'ระบบนี้อ่าน ERP อย่างเดียวเท่านั้น — ให้สร้าง login ใหม่ที่มีสิทธิ์เฉพาะ ' +
          '`db_datareader` (หรือ GRANT SELECT เฉพาะ object ที่ใช้) แล้วแก้ ERP_SQL_USER / ' +
          'ERP_SQL_PASSWORD ในไฟล์ตั้งค่า · ห้ามใช้ `sa`',
      );
    }

    if (row.can_select !== 1) {
      throw new MssqlDriverError(
        'ERP_CONFIG',
        `login ERP_SQL_USER="${this.sqlCfg.user}" ไม่มีสิทธิ์ SELECT บน ${this.sqlCfg.database} — ` +
          'ต้องเป็น db_datareader (หรือ GRANT SELECT เฉพาะ object ที่ใช้)',
      );
    }

    this.readOnlyVerified = true;
    logger.log(
      `✅ พิสูจน์แล้ว: login "${this.sqlCfg.user}" อ่าน ${this.sqlCfg.database} ได้และเขียนไม่ได้ ` +
        '(ตรวจจาก metadata — ไม่มีการเขียนใด ๆ ลง ERP)',
    );
  }

  /**
   * smoke test ภาษาไทย: ดึงชื่อสินค้าไทย 1 แถว แล้วตรวจว่า decode ถูก
   * ผิด charset → ข้อมูลไทยจะเพี้ยนเงียบ ๆ ทั้งระบบ จึง fail ทันทีพร้อมบอกตัวแปรที่ต้องแก้
   */
  async verifyThaiText(): Promise<void> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.runQuery('thai-smoke-test', THAI_SAMPLE_SQL);
    } catch (err) {
      if (err instanceof MssqlDriverError && err.code === 'ERP_UNREACHABLE') throw err;
      logger.warn(
        `ข้าม smoke test ภาษาไทย: ดึงตัวอย่างชื่อสินค้าจาก ${DEFAULT_ITEMS_TABLE} ไม่ได้ — ` +
          errMessage(err),
      );
      return;
    }

    const sample = rows[0]?.['SampleText'];
    if (typeof sample !== 'string' || sample.length === 0) {
      logger.warn('ข้าม smoke test ภาษาไทย: ไม่พบชื่อสินค้าที่มีข้อความให้ตรวจ');
      return;
    }

    if (sample.includes(REPLACEMENT_CHAR)) {
      throw new MssqlDriverError(
        'ERP_THAI_DECODE',
        `ข้อความไทยจาก ERP decode ไม่ได้ (พบ U+FFFD): "${sample}" — ` +
          `ERP_SQL_CHARSET=${this.sqlCfg.charset} น่าจะผิด ` +
          '(NVARCHAR ใช้ utf8 · VARCHAR + Thai collation ใช้ win874)',
      );
    }

    if (!THAI_BLOCK_RE.test(sample)) {
      throw new MssqlDriverError(
        'ERP_THAI_DECODE',
        `ตัวอย่างชื่อสินค้า "${sample}" ไม่มีอักขระในช่วง Thai (U+0E01–U+0E5B) — ` +
          `ERP_SQL_CHARSET=${this.sqlCfg.charset} น่าจะผิด หรือคอลัมน์ ItemName ไม่ใช่ข้อมูลไทย`,
      );
    }

    logger.log(`✅ smoke test ภาษาไทยผ่าน (charset=${this.sqlCfg.charset}): "${sample}"`);
  }

  /** SELECT 1 + วัด latency — ERP ล่มที่นี่ต้องไม่ทำให้ /healthz ของ API เป็น unhealthy */
  async healthCheck() {
    const startedAt = Date.now();
    try {
      await this.runQuery('healthcheck', 'SELECT 1 AS ok');
      return {
        ok: true as const,
        driver: DRIVER_NAME,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false as const,
        driver: DRIVER_NAME,
        latencyMs: Date.now() - startedAt,
        error: errMessage(err),
      };
    }
  }

  /**
   * item master → CanonicalItem เป็น batch ละ 500
   * `since` ถูกละเว้นโดยเจตนา: capabilities().delta === false (ERP ไม่มี updated-at ที่เชื่อถือได้)
   */
  async *fetchItems(since?: Cursor): AsyncIterableIterator<CanonicalItem[]> {
    if (since !== undefined) {
      logger.debug(
        `driver sql ไม่รองรับ delta (delta=false) — ละเว้น since=${String(since)} ` +
          'และดึงแบบ full snapshot',
      );
    }

    const source = this.sqlCfg.itemsSqlFile
      ? this.readItemRowsFromScript(this.sqlCfg.itemsSqlFile)
      : this.readItemRowsFromTable();

    let mapped = 0;
    let skipped = 0;
    for await (const rawBatch of source) {
      const items: CanonicalItem[] = [];
      for (const raw of rawBatch) {
        const result = this.toCanonicalItem(raw);
        if (result.ok) {
          items.push(result.item);
          continue;
        }
        skipped += 1;
        if (skipped <= 3) logger.warn(`ข้ามแถวสินค้าที่ไม่ผ่าน validation — ${result.reason}`);
      }

      // ทุกแถวในหน้าเดียวพังหมด = คอลัมน์เปลี่ยน ไม่ใช่ข้อมูลเสียรายแถว → หยุดรอบนี้
      if (items.length === 0 && rawBatch.length > 0) {
        throw new MssqlDriverError(
          'ERP_SCHEMA_DRIFT',
          `แถวสินค้าทั้ง ${rawBatch.length} แถวไม่ผ่าน validation — คอลัมน์ที่ ERP ส่งมาน่าจะเปลี่ยน ` +
            '(ตรวจ ERP_SQL_ITEMS_VIEW / ERP_SQL_ITEMS_SQL_FILE)',
        );
      }

      mapped += items.length;
      yield items;
    }

    logger.log(`ดึง item master จาก ERP สำเร็จ: ${mapped} รายการ (ข้าม ${skipped} แถว)`);
  }

  /*
   * ⚠️ เคยมี fetchStockSnapshot() ตรงนี้ที่ throw อย่างเดียวและไม่มีใครเรียก
   *    ยอดคงเหลือมาพร้อม item master แล้ว (sql/erp/inventory-items-with-balance.sql)
   *    ไหลเข้าระบบทาง fetchItems() → CanonicalItem.onHand ไม่ต้องมีเส้นทางแยก
   */

  /*
   * ⚠️ เคยมี fetchCountSessions() / fetchCountSession() อยู่ตรงนี้ — ดึง "รอบนับที่ทำใน ERP
   *    อยู่แล้ว" (tbl_CountHdr / tbl_CountDtl) มา mirror เป็นรอบนับของระบบเรา
   *
   *    ตัดออกถาวร 22 ส.ค. 2569 ตามขอบเขตที่เจ้าของโปรเจคยืนยัน:
   *    ระบบนี้ดึงจาก ERP แค่ **จำนวนคงเหลือ** เท่านั้น ไม่เอาข้อมูลอื่น
   *    เดิมจำเป็นเพราะยังไม่มีสูตรคำนวณยอด ต้องยืมยอดจากรอบนับของ ERP
   *    ตอนนี้สูตรจากฝ่าย ERP แม่น 100% แล้ว (docs/erp-tcl-findings.md §6.6)
   *    รอบนับทั้งหมดเปิดจากแอปเราเอง แล้ว freeze ยอดจาก items_cache
   */

  // -------------------------------------------------------------------------
  // ภายใน
  // -------------------------------------------------------------------------

  private async getPool(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.createPool();
    try {
      return await this.poolPromise;
    } catch (err) {
      this.poolPromise = undefined; // ต่อไม่ได้รอบนี้ ให้รอบถัดไปลองใหม่ได้
      throw err;
    }
  }

  private async createPool(): Promise<sql.ConnectionPool> {
    const cfg = this.sqlCfg;
    const poolConfig: sql.config = {
      server: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      // หมายเหตุ: mssql รับ requestTimeout/connectionTimeout ที่ระดับ config ราก
      // (ไม่ใช่ใน options) — ค่ามาจาก ERP_TIMEOUT_MS ตัวเดียวกัน
      connectionTimeout: cfg.timeoutMs,
      requestTimeout: cfg.timeoutMs,
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCert,
        // อ่านค่า datetime เป็น UTC ตรงตัว เพื่อให้วันที่ ISO ไม่เลื่อนตาม timezone ของ container
        useUTC: true,
        // ชั้นที่ 5 ของกฎเหล็ก — บอก SQL Server ว่า connection นี้ตั้งใจอ่านอย่างเดียว
        // (เอกสารระบุชั้นนี้ไว้ตั้งแต่แรกแต่ไม่เคยถูกใส่จริง)
        // ⚠️ มีผลบังคับจริงเฉพาะเมื่อ ERP อยู่หลัง Availability Group listener ที่ตั้ง
        //    read-only routing ไว้ — ที่อื่น SQL Server จะเพิกเฉย จึงเป็นชั้นเสริม
        //    ไม่ใช่ชั้นที่พึ่งพาได้เดี่ยว ๆ (ชั้น 1-4 ยังเป็นตัวบังคับหลัก)
        readOnlyIntent: true,
      },
      pool: { max: cfg.poolMax, min: 0, idleTimeoutMillis: 30_000 },
    };

    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', (err: unknown) => {
      logger.error(`connection pool ของ ERP ผิดพลาด: ${errMessage(err)}`);
    });

    try {
      await pool.connect();
    } catch (err) {
      throw new MssqlDriverError(
        'ERP_UNREACHABLE',
        `เชื่อมต่อ ERP ไม่ได้ (${cfg.host}:${cfg.port}/${cfg.database}, encrypt=${cfg.encrypt}): ` +
          errMessage(err),
      );
    }

    logger.log(
      `เชื่อมต่อ ERP แล้ว: ${cfg.host}:${cfg.port}/${cfg.database} ` +
        `(pool max ${cfg.poolMax}, timeout ${cfg.timeoutMs}ms, charset ${cfg.charset})`,
    );
    return pool;
  }

  /**
   * จุดเดียวที่ส่ง SQL เข้า ERP
   * - ชั้นที่ 3 ของกฎเหล็ก: assertReadOnlySql() ก่อนทุกครั้ง
   * - ค่าจากภายนอกผูกด้วย parameter เสมอ (ห้าม concat เข้า SQL)
   * - ยังไม่พิสูจน์ read-only = พิสูจน์ก่อน (เช่นกรณี ERP ล่มตอน boot แล้วกลับมาทีหลัง)
   */
  private async runQuery(
    label: string,
    text: string,
    params: SqlParams = {},
  ): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(text);

    if (!this.readOnlyVerified) await this.verifyReadOnly();

    const pool = await this.getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'number') {
        request.input(name, Number.isInteger(value) ? sql.Int : sql.Float, value);
      } else if (value instanceof Date) {
        request.input(name, sql.DateTime2, value);
      } else {
        request.input(name, sql.NVarChar(4000), value);
      }
    }

    try {
      const result = await request.query(text);
      const rows = (result.recordset ?? []) as unknown as Record<string, unknown>[];
      return rows.map((row) => this.normalizeRow(row));
    } catch (err) {
      if (isConnectionError(err)) {
        throw new MssqlDriverError(
          'ERP_UNREACHABLE',
          `query "${label}" ต่อ ERP ไม่ได้: ${errMessage(err)}`,
        );
      }
      throw new MssqlDriverError('ERP_QUERY', `query "${label}" ล้มเหลว: ${errMessage(err)}`);
    }
  }

  /** decode ข้อความไทยตาม ERP_SQL_CHARSET (NVARCHAR = ผ่านตรง ๆ) */
  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = decodeThai(value, this.sqlCfg.charset);
    }
    return out;
  }

  /** อ่าน item master จากตาราง/view ด้วย OFFSET/FETCH — ไม่โหลดทั้งก้อนเข้า memory */
  private async *readItemRowsFromTable(): AsyncIterableIterator<Record<string, unknown>[]> {
    const text = itemsPageSql(this.sqlCfg.itemsTable);

    for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
      const rows = await this.runQuery('items-page', text, {
        offset: page * ITEM_BATCH_SIZE,
        batch: ITEM_BATCH_SIZE,
      });
      if (rows.length > 0) yield rows;
      if (rows.length < ITEM_BATCH_SIZE) return;
    }

    throw new MssqlDriverError(
      'ERP_SCHEMA_DRIFT',
      `ดึง item master เกิน ${MAX_ITEM_PAGES} หน้า (${MAX_ITEM_PAGES * ITEM_BATCH_SIZE} แถว) ` +
        'แล้วยังไม่จบ — หยุดรอบนี้เพื่อกันลูปไม่สิ้นสุด',
    );
  }

  /**
   * อ่าน item master จาก script .sql ที่เจ้าของโปรเจคส่งมอบ (สัญญาของ driver)
   * script คุม ORDER BY/สูตรเอง จึงไม่แบ่งหน้าใน SQL — รันครั้งเดียวแล้วซอยเป็น batch 500
   * (item master ของ ERP นี้อยู่ระดับหลายร้อยแถว จึงยังรับได้ในหน่วยความจำ)
   *
   * พารามิเตอร์ที่ผูกให้เสมอ (script จะใช้หรือไม่ใช้ก็ได้ — T-SQL ยอมให้ประกาศแล้วไม่อ้างถึง):
   *   `@warehouse` = WAREHOUSE_CODE ของ deployment นี้
   *   `@asOf`      = เวลาที่เริ่มรอบ sync (ยอดคงเหลือ ณ เวลานี้)
   * มีไว้เพื่อให้ script เดียวใช้ได้ทุกคลังโดยไม่ต้องแก้ไฟล์ต่อ deployment
   */
  private async *readItemRowsFromScript(
    path: string,
  ): AsyncIterableIterator<Record<string, unknown>[]> {
    const text = this.loadItemsSqlFile(path);
    const rows = await this.runQuery('items-script', text, {
      warehouse: this.sqlCfg.warehouseCode,
      asOf: new Date(),
    });
    for (const batch of chunk(this.dedupeItemRows(rows), ITEM_BATCH_SIZE)) yield batch;
  }

  private loadItemsSqlFile(path: string): string {
    if (this.itemsSqlCache) return this.itemsSqlCache;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new MssqlDriverError(
        'ERP_CONFIG',
        `อ่านไฟล์ ERP_SQL_ITEMS_SQL_FILE ไม่ได้: ${path} — ${errMessage(err)}`,
      );
    }

    text = text.replace(/^\uFEFF/, '').trim();
    if (text.length === 0) {
      throw new MssqlDriverError('ERP_CONFIG', `ไฟล์ ERP_SQL_ITEMS_SQL_FILE ว่างเปล่า: ${path}`);
    }
    if (/^\s*GO\s*$/im.test(text)) {
      throw new MssqlDriverError(
        'ERP_CONFIG',
        `ERP_SQL_ITEMS_SQL_FILE ต้องเป็นคำสั่ง SELECT เดียว ห้ามมีตัวคั่นแบตช์ GO: ${path}`,
      );
    }

    // ชั้นที่ 3: script จากภายนอกต้องผ่าน guard ก่อนแตะ connection ของ ERP
    assertReadOnlySql(text);
    this.itemsSqlCache = text;
    logger.log(`ใช้ script ดึง item master จาก ${path} (${text.length} ตัวอักษร)`);
    return text;
  }

  /**
   * ⚠️ ItemCode ซ้ำได้ → Roworder สูงสุดชนะ
   * ใช้กับผลจาก script เท่านั้น (เส้นทางตาราง/view dedupe ด้วย ROW_NUMBER() ใน SQL แล้ว)
   */
  private dedupeItemRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    const best = new Map<string, { row: Record<string, unknown>; roworder: number }>();
    let duplicates = 0;
    let withoutSku = 0;

    for (const row of rows) {
      const get = rowGetter(row);
      // ⚠️ ค่าจาก ERP เป็น unknown — ถ้าเป็น object แล้วเผลอ String() จะได้ '[object Object]'
      //    กลายเป็น "รหัสสินค้า" ปลอมที่ไหลเข้า items_cache → ข้ามแถวไปเลยปลอดภัยกว่า
      const sku = asScalarString(get('ItemCode', 'sku', 'item_code')).trim();
      if (sku.length === 0) {
        withoutSku += 1;
        continue;
      }
      const rawOrder = Number(get('Roworder', 'roworder') ?? 0);
      const roworder = Number.isFinite(rawOrder) ? rawOrder : 0;
      const current = best.get(sku);
      if (!current) {
        best.set(sku, { row, roworder });
        continue;
      }
      duplicates += 1;
      if (roworder > current.roworder) best.set(sku, { row, roworder });
    }

    if (duplicates > 0) {
      logger.warn(
        `script ส่ง ItemCode ซ้ำ ${duplicates} แถว — ใช้กติกา Roworder สูงสุดชนะ ` +
          `(เหลือ ${best.size} รหัส)`,
      );
    }
    if (withoutSku > 0) {
      logger.warn(`script ส่งแถวที่ไม่มี ItemCode/sku ${withoutSku} แถว — ข้าม`);
    }

    return [...best.values()].map((entry) => entry.row);
  }

  private toCanonicalItem(
    row: Record<string, unknown>,
  ): { ok: true; item: CanonicalItem } | { ok: false; reason: string } {
    const parsed = ItemFieldsSchema.safeParse(pickItemFields(row));
    if (!parsed.success) {
      return { ok: false, reason: firstIssue(parsed.error) };
    }

    const fields = parsed.data;

    // บาร์โค้ด: ItemCode เองต้องอยู่ด้วยเสมอ เพราะโปรเจคนี้พิมพ์ฉลาก Code128 จาก ItemCode
    // (BarCodeUnits/BarCodePack มีจริงแค่ ~2% ของรายการ)
    const barcodes = uniqueNonEmpty([fields.sku, fields.barcodeUnits, fields.barcodePack]);

    const item: CanonicalItem = {
      sku: fields.sku,
      barcodes,
      name: fields.name,
      nameEn: fields.nameEn,
      loc: fields.loc, // Shelf ว่าง 100% ในข้อมูลจริง → ปกติเป็น undefined
      // ERP ไม่มียอดคงเหลือสำเร็จรูป — ค่านี้มีเฉพาะเมื่อ script ของเจ้าของโปรเจคคำนวณ on_hand มาให้
      onHand: fields.onHand,
      reserved: undefined, // PendingQTY ว่าง 100%
      rop: fields.rop !== undefined && fields.rop > 0 ? fields.rop : undefined, // 0 = ไม่ได้ตั้ง ROP
      // MainUnits ครบ 100% ในข้อมูลจริง — '' เป็น fallback กันกรณีคอลัมน์ว่างผิดคาด
      unit: fields.unit ?? '',
      vendor: undefined, // ต้อง join tbl_SupItem/Supplier — ยังไม่อยู่ในสัญญานี้
      lot: fields.lot, // LotNumber ว่าง 100%
      lastCountDate: undefined, // มาจากรอบนับ (tbl_CountHdr) ไม่ใช่ item master
      updatedAt: undefined, // ERP ไม่มี updated-at ที่เชื่อถือได้ → delta=false
      // item master ของ ERP นี้ไม่มีคอลัมน์คลัง (เป็นระดับบริษัท) — ประทับคลังของ deployment นี้ไว้
      warehouseCode: fields.warehouse ?? this.sqlCfg.warehouseCode,
    };

    return { ok: true, item };
  }
}

