import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';

import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import type { CanonicalItem } from '../erp/erp-adapter';

/**
 * CatalogService — item master ฝั่งเรา (`items_cache` + `item_barcodes`)
 *
 * 🚫 กฎเหล็ก: ไฟล์นี้เขียน **Postgres ของเราเท่านั้น** ไม่มี statement ใดวิ่งไป ERP
 *    ทางเข้าข้อมูล ERP คือ SyncService ที่เรียก `upsertItems()` / `tombstoneMissing()` ให้
 *
 * หน้าที่ 2 ฝั่ง:
 *   • ฝั่งมือถือ (อ่าน): `listSince()` delta feed ของ replica · `findByBarcode()` · `search()`
 *   • ฝั่ง sync (เขียน): `upsertItems()` · `tombstoneMissing()`
 *
 * cursor ของ delta feed = `items_cache.row_version` (bigserial ภายใน) ⚠️ ไม่ใช่เวลาของ ERP
 * (เวลา ERP มี tie/backfill/clock skew → แถวตกขอบ; ดู COMMENT ของคอลัมน์ใน db/schema.sql)
 */

// ---------------------------------------------------------------------------
// สัญญาข้อมูลที่ส่งออก
// ---------------------------------------------------------------------------

/**
 * สินค้า 1 รายการที่ส่งให้แอป
 *
 * ฟิลด์ที่ไม่มีค่าจะ **หายไปจาก JSON** (undefined) ไม่ได้ส่ง null —
 * feed คืน "แถวเต็ม" ทุกครั้ง (ไม่ใช่ patch) ดังนั้น replica ต้องเขียนทับทั้งแถว
 * ฟิลด์ที่ไม่มี = ค่าถูกล้างแล้ว
 */
export interface ItemDto {
  sku: string;
  name: string;
  nameEn?: string;
  barcodes: string[];
  loc?: string;
  unit?: string;
  onHand?: number;
  reserved?: number;
  rop?: number;
  specs: Record<string, unknown>;
  warehouseCode: string;
  /** `row_version` เป็น string เพราะ bigint เกิน Number.MAX_SAFE_INTEGER ได้ */
  rowVersion: string;
  /** ISO-8601 (timestamptz) */
  updatedAt: string;
}

/** ผลของ delta feed 1 หน้า — tombstone มาคู่กันเสมอ ไม่งั้น replica เก็บของที่ ERP ลบไว้ตลอดกาล */
export interface ItemDeltaPage {
  items: ItemDto[];
  /** sku ที่ถูก soft-delete แล้ว → replica ต้องลบทิ้ง */
  tombstones: string[];
  /** row_version สูงสุดของหน้านี้ (string) — ส่งกลับมาเป็น `since` ครั้งถัดไป */
  nextCursor: string;
  hasMore: boolean;
}

/** ชื่อเดิมที่ `catalog.module.ts` (controller) import — เป็นตัวเดียวกับ `ItemDeltaPage` */
export type ItemsDeltaPage = ItemDeltaPage;

/** named-arg form ของ delta feed ที่ controller เรียก */
export interface ItemDeltaArgs {
  warehouseCode: string;
  since: bigint | number | string;
  limit?: number;
}

export interface ItemSearchResult {
  items: ItemDto[];
  /** จำนวนที่ตรงเงื่อนไขทั้งหมด (นับแยกจากหน้าที่คืน) */
  total: number;
  truncated: boolean;
}

/** ความผิดปกติที่เจอระหว่าง upsert — caller เก็บลง `sync_runs.anomalies` (jsonb array) */
export interface CatalogAnomaly {
  kind:
    | 'duplicate_sku_in_batch'
    | 'invalid_item'
    | 'blank_name'
    | 'negative_qty'
    | 'invalid_barcode'
    | 'barcode_dup_in_batch'
    | 'barcode_reassigned'
    | 'warehouse_mismatch'
    | 'anomalies_truncated';
  sku?: string;
  barcode?: string;
  detail: string;
}

export interface UpsertItemsResult {
  upserted: number;
  barcodesUpserted: number;
  anomalies: CatalogAnomaly[];
}

/**
 * guardrail ของ tombstone (docs/erp-integration.md §5): ลบเกิน 5% ของ catalog ในรอบเดียว = abort
 * เหตุผล: ดึง ERP ไม่ครบแล้ว tombstone = สินค้าจริงหายจากทุกเครื่องในคลัง
 * caller ต้องจับ error นี้ แล้ว mark `sync_runs.status = 'partial'` (ห้ามขยับ cursor)
 */
export class TombstoneGuardrailError extends Error {
  readonly doomed: number;
  readonly liveTotal: number;
  readonly ratio: number;

  constructor(doomed: number, liveTotal: number, ratio: number) {
    super(
      `ยกเลิก tombstone: จะ soft-delete ${doomed} จาก ${liveTotal} รายการ ` +
        `(${(ratio * 100).toFixed(1)}% > เพดาน ${(TOMBSTONE_MAX_RATIO * 100).toFixed(0)}%) — ` +
        'น่าจะดึง ERP ไม่ครบ ให้ mark รอบนี้เป็น partial แล้วไม่ต้องขยับ cursor',
    );
    this.name = 'TombstoneGuardrailError';
    this.doomed = doomed;
    this.liveTotal = liveTotal;
    this.ratio = ratio;
  }
}

// ---------------------------------------------------------------------------
// zod: ข้อมูลจากภายนอก (telemetry การสแกนจากมือถือ)
// ---------------------------------------------------------------------------

export const ScanEventSchema = z.object({
  barcode: z.string().trim().min(1).max(64),
  /** null = สแกนแล้วไม่พบในคลัง (สัญญาณว่าฉลาก/ข้อมูลไม่ตรง) */
  sku: z.string().trim().min(1).max(64).nullish(),
  scannedAt: z.coerce.date(),
});
export type ScanEventInput = z.input<typeof ScanEventSchema>;

// ---------------------------------------------------------------------------
// ค่าคงที่
// ---------------------------------------------------------------------------

const DEFAULT_FEED_LIMIT = 500;
const MAX_FEED_LIMIT = 2000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 500;
const MAX_QUERY_LENGTH = 64;
const MAX_ANOMALIES = 200;
const TOMBSTONE_MAX_RATIO = 0.05;

/** ขอบเขตตาม CHECK ใน db/schema.sql */
const MAX_SKU_LENGTH = 64;
const MAX_BARCODE_LENGTH = 64;
const MAX_WAREHOUSE_LENGTH = 32;

/**
 * ค่าที่ `item_barcodes.source` รับได้ (CHECK ใน schema)
 * ⚠️ ห้ามใช้ค่าอื่น เช่น 'itemcode_code128' — CHECK จะปฏิเสธและทำให้ sync ล้มทั้งรอบ
 */
const BARCODE_SOURCE_ERP = 'erp_unit';
const BARCODE_SOURCE_LABEL = 'item_code_label';

// ---------------------------------------------------------------------------
// แถวจาก Postgres (ใช้ type alias เพื่อให้เข้ากับ constraint QueryResultRow ของ pg)
// ---------------------------------------------------------------------------

type ItemRow = {
  sku: string;
  name: string;
  name_en: string | null;
  loc: string | null;
  /** numeric(18,3) จาก pg มาเป็น string เสมอ */
  on_hand: string | null;
  reserved: string | null;
  rop: string | null;
  unit: string | null;
  specs: Record<string, unknown> | null;
  warehouse_code: string;
  row_version: string;
  updated_at: Date;
  deleted_at: Date | null;
  barcodes: string[] | null;
};

type BarcodeUpsertRow = {
  barcode: string;
  new_sku: string;
  old_sku: string | null;
};

type TombstoneScopeRow = { live_total: number; doomed: number };

// ---------------------------------------------------------------------------
// SQL fragment (คงที่ ไม่มีค่าจากภายนอกต่อเข้าไป — ค่าทุกตัวผ่าน parameter $n)
// ---------------------------------------------------------------------------

const ITEM_COLUMNS = `
      i.sku, i.name, i.name_en, i.loc, i.on_hand, i.reserved, i.rop, i.unit, i.specs,
      i.warehouse_code, i.row_version::text AS row_version, i.updated_at, i.deleted_at,
      COALESCE(b.barcodes, ARRAY[]::text[]) AS barcodes`;

/** barcode ต่อ sku ในคิวรีเดียว (ไม่ N+1) · แถวที่ tombstone แล้วไม่ต้อง agg */
const BARCODE_LATERAL = `
      LEFT JOIN LATERAL (
        SELECT array_agg(ib.barcode ORDER BY ib.barcode) AS barcodes
          FROM item_barcodes ib
         WHERE ib.sku = i.sku
      ) b ON i.deleted_at IS NULL`;

/** เงื่อนไขค้นหา — $1 = warehouse_code, $2 = ILIKE pattern หรือ NULL (= เอาทั้งคลัง) */
const SEARCH_PREDICATE = `
       i.warehouse_code = $1
   AND i.deleted_at IS NULL
   AND (
         $2::text IS NULL
      OR i.name ILIKE $2
      OR i.name_en ILIKE $2
      OR i.sku ILIKE $2
      OR EXISTS (SELECT 1 FROM item_barcodes ib WHERE ib.sku = i.sku AND ib.barcode ILIKE $2)
       )`;

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly defaultWarehouseCode: string;

  constructor(
    private readonly db: PostgresService,
    cfg: ConfigService<AppConfig, true>,
  ) {
    this.defaultWarehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true }).trim();
  }

  // ── 1. delta feed สำหรับ replica บนเครื่อง ──────────────────────────────

  /**
   * แถวที่ `row_version > cursor` เรียงตาม row_version (รวมแถวที่ tombstone แล้ว)
   *
   * `limit` ส่ง `undefined` ได้เพื่อใช้ค่าเริ่มต้น (500) — ลำดับพารามิเตอร์ยึดตามสัญญา API
   */
  async listSince(
    cursor: bigint | number | string,
    limit: number | undefined = DEFAULT_FEED_LIMIT,
    warehouseCode?: string,
  ): Promise<ItemDeltaPage> {
    const wh = this.resolveWarehouse(warehouseCode);
    const since = CatalogService.normalizeCursor(cursor);
    const take = CatalogService.clamp(limit, 1, MAX_FEED_LIMIT, DEFAULT_FEED_LIMIT);

    const result = await this.db.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM items_cache i
         ${BARCODE_LATERAL}
        WHERE i.warehouse_code = $1
          AND i.row_version > $2::bigint
        ORDER BY i.row_version
        LIMIT $3`,
      [wh, since.toString(), take],
    );

    const rows: ItemRow[] = result.rows;
    const items: ItemDto[] = [];
    const tombstones: string[] = [];
    for (const row of rows) {
      if (row.deleted_at !== null) tombstones.push(row.sku);
      else items.push(CatalogService.toDto(row));
    }

    // เรียงตาม row_version แล้ว → แถวสุดท้ายคือค่าสูงสุดของหน้านี้
    const last = rows[rows.length - 1];
    return {
      items,
      tombstones,
      nextCursor: last ? last.row_version : since.toString(),
      hasMore: rows.length === take,
    };
  }

  /** รูปแบบ named-arg ของ `listSince()` (controller ใช้ตัวนี้) — ตรรกะเดียวกันทั้งหมด */
  getDelta(args: ItemDeltaArgs): Promise<ItemDeltaPage> {
    return this.listSince(args.since, args.limit, args.warehouseCode);
  }

  // ── 2. สแกนบาร์โค้ด ─────────────────────────────────────────────────────

  /**
   * exact-match บน `item_barcodes.barcode` (PK) ก่อน แล้ว fallback เป็น `items_cache.sku`
   * (โปรเจคนี้พิมพ์ฉลาก Code128 จาก ItemCode — เครื่องอาจสแกนได้ค่าเท่ากับ sku ตรง ๆ)
   *
   * ⚠️ trim ก่อนค้นเสมอ: scanner บางรุ่นต่อท้ายด้วย \r\n หรือช่องว่าง
   */
  async findByBarcode(code: string, warehouseCode?: string): Promise<ItemDto | null> {
    const needle = typeof code === 'string' ? code.trim() : '';
    if (needle.length === 0 || needle.length > MAX_BARCODE_LENGTH) return null;
    const wh = this.resolveWarehouse(warehouseCode);

    const row = await this.db.one<ItemRow>(
      `WITH hit AS (
         SELECT ib.sku AS sku, 0 AS pri
           FROM item_barcodes ib
           JOIN items_cache ic ON ic.sku = ib.sku
          WHERE ib.barcode = $1
            AND ic.warehouse_code = $2
            AND ic.deleted_at IS NULL
         UNION ALL
         SELECT ic.sku AS sku, 1 AS pri
           FROM items_cache ic
          WHERE ic.sku = $1
            AND ic.warehouse_code = $2
            AND ic.deleted_at IS NULL
       )
       SELECT ${ITEM_COLUMNS}
         FROM hit
         JOIN items_cache i ON i.sku = hit.sku
         ${BARCODE_LATERAL}
        ORDER BY hit.pri
        LIMIT 1`,
      [needle, wh],
    );

    return row ? CatalogService.toDto(row) : null;
  }

  // ── 3. ค้นหาด้วยข้อความ ─────────────────────────────────────────────────

  /**
   * substring แบบไม่สนตัวพิมพ์ บน name + name_en + sku + barcode
   * (มี GIN trigram รองรับ — pattern สั้นกว่า 3 ตัวอักษรจะ scan)
   *
   * `q` ว่าง = คืนรายการแรก ๆ เรียงตามชื่อ · `total` นับจริงทั้งหมดแยกจากหน้าที่คืน
   */
  async search(q: string, warehouseCode?: string, limit = DEFAULT_SEARCH_LIMIT): Promise<ItemSearchResult> {
    const wh = this.resolveWarehouse(warehouseCode);
    const take = CatalogService.clamp(limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
    const term = (typeof q === 'string' ? q.trim() : '').slice(0, MAX_QUERY_LENGTH);
    const pattern = term.length > 0 ? `%${CatalogService.escapeLike(term)}%` : null;

    // นับแยกจากหน้าที่คืน: ไม่ใช้ count(*) OVER () เพราะจะบังคับให้ join barcode ทุกแถวที่ match
    const counted = await this.db.one<{ total: number }>(
      `SELECT count(*)::int AS total
         FROM items_cache i
        WHERE ${SEARCH_PREDICATE}`,
      [wh, pattern],
    );
    const total = counted?.total ?? 0;

    const result = await this.db.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM items_cache i
         ${BARCODE_LATERAL}
        WHERE ${SEARCH_PREDICATE}
        ORDER BY i.name, i.sku
        LIMIT $3`,
      [wh, pattern, take],
    );

    const rows: ItemRow[] = result.rows;
    return { items: rows.map(CatalogService.toDto), total, truncated: total > take };
  }

  // ── 4. telemetry การสแกน ────────────────────────────────────────────────

  /**
   * batch insert เข้า `scan_events` (ใครสแกนอะไรเมื่อไร) — event ที่ผิดรูปจะถูกข้าม
   * คืนจำนวนแถวที่บันทึกได้จริง
   *
   * ⚠️ เป็น telemetry: FK พลาด (เครื่อง/พนักงานยังไม่มีแถว) จะ log warn แล้วคืน 0
   *    ห้ามให้การบันทึกประวัติสแกนทำให้ flow การนับของพนักงานพัง
   */
  async recordScanEvents(events: unknown, empId: string, deviceId: string): Promise<number> {
    if (!Array.isArray(events) || events.length === 0) return 0;

    const valid: Array<{ barcode: string; sku: string | null; scanned_at: string }> = [];
    let skipped = 0;
    for (const raw of events) {
      const parsed = ScanEventSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      valid.push({
        barcode: parsed.data.barcode,
        sku: parsed.data.sku ?? null,
        scanned_at: parsed.data.scannedAt.toISOString(),
      });
    }
    if (skipped > 0) {
      this.logger.warn(`ข้าม scan event ที่ผิดรูป ${skipped} รายการ (device=${deviceId})`);
    }
    if (valid.length === 0) return 0;

    try {
      return await this.db.transaction(async (client) => {
        // ⚠️ ต้อง upsert แถว device ก่อนเสมอ ตามสัญญาของ schema ที่ว่า "ทุกเส้นทางที่
        //    รับ device_id ต้อง upsert devices"
        //    เดิมไม่ทำ → เครื่องที่ยังไม่เคย login ผ่าน API ตัวนี้ (ลงแอปใหม่แล้วสแกน
        //    ก่อน login หรือ deviceId คนละตัวกับตอน login) จะชน FK ทั้ง batch
        //    แล้วถูกกลืนเป็น {recorded:0} + HTTP 200 → แอปคิดว่าส่งสำเร็จ ลบคิวทิ้ง
        //    ประวัติการสแกนของเครื่องนั้นหายถาวรและเกิดซ้ำทุกครั้ง
        await client.query(
          `INSERT INTO devices (device_id, last_emp_id, last_seen_at)
           VALUES ($1, $2, now())
           ON CONFLICT (device_id) DO UPDATE
              SET last_emp_id = EXCLUDED.last_emp_id, last_seen_at = now()`,
          [deviceId, empId],
        );

        const result = await client.query(
          `INSERT INTO scan_events (emp_id, device_id, barcode, sku, scanned_at)
           SELECT $2, $3, s.barcode, s.sku, s.scanned_at
             FROM jsonb_to_recordset($1::jsonb)
               AS s(barcode text, sku text, scanned_at timestamptz)`,
          [JSON.stringify(valid), empId, deviceId],
        );
        return result.rowCount ?? 0;
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23503') {
        // foreign_key_violation — ไม่มีแถว users/devices
        this.logger.warn(
          `บันทึก scan_events ไม่ได้: emp_id/device_id ยังไม่มีในระบบ (emp=${empId}, device=${deviceId})`,
        );
        return 0;
      }
      throw err;
    }
  }

  // ── 5. upsert จาก ERP (เรียกโดย SyncService) ─────────────────────────────

  /**
   * เขียน item master ลง `items_cache` + `item_barcodes` แบบ batch (UNNEST ผ่าน jsonb — ไม่ยิงทีละแถว)
   *
   * - `row_version` ไม่ได้ตั้งเอง: trigger `items_cache_bump_row_version` bump เฉพาะเมื่อเนื้อข้อมูลเปลี่ยนจริง
   * - `deleted_at = NULL` ทุกครั้ง = ปลุกสินค้าที่กลับมาปรากฏใน ERP
   * - `specs` ถูกเขียนทับทั้งก้อนจาก ERP (vendor/lot/lastCountDate) — ERP เป็นเจ้าของค่าเหล่านี้
   * - barcode ที่ย้าย sku ไม่ทำให้รอบล้ม แต่คืนเป็น anomaly ให้ caller เก็บลง sync_runs
   *
   * 🚫 ไม่มี statement ใดในนี้แตะ ERP — เขียน Postgres ของเราเท่านั้น
   */
  async upsertItems(
    items: readonly CanonicalItem[],
    warehouseCode?: string,
    client?: PoolClient,
  ): Promise<UpsertItemsResult> {
    const anomalies: CatalogAnomaly[] = [];
    const empty: UpsertItemsResult = { upserted: 0, barcodesUpserted: 0, anomalies };
    if (!Array.isArray(items) || items.length === 0) return empty;

    const fallbackWh = this.resolveWarehouse(warehouseCode);

    // 1) normalize + dedupe ตาม sku (ERP: PK คือ (Roworder, ItemCode) → ItemCode ซ้ำได้)
    //    ไม่มี Roworder ใน CanonicalItem → ใช้ updatedAt ใหม่สุดชนะ, เสมอกันให้แถวหลังชนะ
    const bySku = new Map<string, ItemUpsertPayload>();
    for (const item of items) {
      const normalized = CatalogService.normalizeItem(item, fallbackWh, anomalies);
      if (!normalized) continue;
      const previous = bySku.get(normalized.sku);
      if (previous) {
        CatalogService.pushAnomaly(anomalies, {
          kind: 'duplicate_sku_in_batch',
          sku: normalized.sku,
          detail: 'sku ซ้ำในชุดเดียวกัน — เลือกแถวที่ erp_updated_at ใหม่กว่า',
        });
        if (!CatalogService.isNewer(normalized.erp_updated_at, previous.erp_updated_at)) continue;
      }
      bySku.set(normalized.sku, normalized);
    }
    if (bySku.size === 0) return empty;

    // ส่งเฉพาะคีย์ที่เป็นคอลัมน์จริง (ไม่ยัด barcodes เข้าไปด้วย — payload บวมเปล่า ๆ ที่ 50k แถว)
    const payload = [...bySku.values()].map((row) => ({
      sku: row.sku,
      name: row.name,
      name_en: row.name_en,
      loc: row.loc,
      on_hand: row.on_hand,
      reserved: row.reserved,
      rop: row.rop,
      unit: row.unit,
      specs: row.specs,
      warehouse_code: row.warehouse_code,
      erp_updated_at: row.erp_updated_at,
    }));
    const itemsResult = await this.exec(
      client,
      `INSERT INTO items_cache (
         sku, name, name_en, loc, on_hand, reserved, rop, unit, specs, warehouse_code,
         erp_updated_at, deleted_at
       )
       SELECT s.sku, s.name, s.name_en, s.loc, s.on_hand, s.reserved, s.rop, s.unit,
              COALESCE(s.specs, '{}'::jsonb), s.warehouse_code, s.erp_updated_at, NULL
         FROM jsonb_to_recordset($1::jsonb)
           AS s(
             sku text, name text, name_en text, loc text,
             on_hand numeric, reserved numeric, rop numeric, unit text,
             specs jsonb, warehouse_code text, erp_updated_at timestamptz
           )
       ON CONFLICT (sku) DO UPDATE
          SET name           = EXCLUDED.name,
              name_en        = EXCLUDED.name_en,
              loc            = EXCLUDED.loc,
              on_hand        = EXCLUDED.on_hand,
              reserved       = EXCLUDED.reserved,
              rop            = EXCLUDED.rop,
              unit           = EXCLUDED.unit,
              specs          = EXCLUDED.specs,
              warehouse_code = EXCLUDED.warehouse_code,
              erp_updated_at = EXCLUDED.erp_updated_at,
              deleted_at     = NULL`,
      [JSON.stringify(payload)],
    );
    const upserted = itemsResult.rowCount ?? 0;

    // 2) barcode ของทุก sku ที่เพิ่ง upsert (FK ชี้ items_cache จึงต้องมาหลังข้อ 1)
    const barcodes = CatalogService.collectBarcodes(bySku, anomalies);
    let barcodesUpserted = 0;
    if (barcodes.length > 0) {
      const barcodeResult = await this.exec<BarcodeUpsertRow>(
        client,
        `WITH incoming AS (
           SELECT s.barcode, s.sku, s.source, s.erp_updated_at
             FROM jsonb_to_recordset($1::jsonb)
               AS s(barcode text, sku text, source text, erp_updated_at timestamptz)
         ),
         before AS (
           SELECT b.barcode, b.sku AS old_sku
             FROM item_barcodes b
             JOIN incoming i ON i.barcode = b.barcode
         ),
         upserted AS (
           INSERT INTO item_barcodes (barcode, sku, source, erp_updated_at)
           SELECT barcode, sku, source, erp_updated_at FROM incoming
           ON CONFLICT (barcode) DO UPDATE
              SET sku            = EXCLUDED.sku,
                  source         = EXCLUDED.source,
                  erp_updated_at = EXCLUDED.erp_updated_at
           RETURNING barcode, sku
         )
         SELECT u.barcode, u.sku AS new_sku, bf.old_sku
           FROM upserted u
           LEFT JOIN before bf ON bf.barcode = u.barcode`,
        [JSON.stringify(barcodes)],
      );
      const barcodeRows: BarcodeUpsertRow[] = barcodeResult.rows;
      barcodesUpserted = barcodeRows.length;
      for (const row of barcodeRows) {
        if (row.old_sku !== null && row.old_sku !== row.new_sku) {
          // barcode ชนกันข้าม sku → ตัวใหม่ชนะ (deterministic) แต่ต้องให้ผู้ดูแลเห็น
          CatalogService.pushAnomaly(anomalies, {
            kind: 'barcode_reassigned',
            barcode: row.barcode,
            sku: row.new_sku,
            detail: `barcode ย้ายจาก sku ${row.old_sku} ไป ${row.new_sku}`,
          });
        }
      }
    }

    if (anomalies.length > 0) {
      this.logger.warn(
        `upsertItems: ${upserted} รายการ / ${barcodesUpserted} barcode พร้อมความผิดปกติ ${anomalies.length} รายการ`,
      );
    }
    return { upserted, barcodesUpserted, anomalies };
  }

  // ── 6. tombstone สินค้าที่หายจาก ERP ────────────────────────────────────

  /**
   * soft-delete sku ที่ไม่อยู่ใน `seenSkus` (เฉพาะรอบ full-reconcile ที่ยืนยันว่าดึงครบ)
   *
   * ⚠️ guardrail: จะลบเกิน 5% ของ catalog → `TombstoneGuardrailError` (ไม่ลบอะไรเลย)
   *    caller ต้อง mark รอบเป็น `partial` และไม่ขยับ cursor
   * ⚠️ `seenSkus` ว่าง = ดึง ERP ไม่ได้ → ปฏิเสธทันที (ไม่ใช่ "ERP ไม่มีสินค้าแล้ว")
   */
  async tombstoneMissing(
    seenSkus: readonly string[],
    warehouseCode: string | undefined,
    client: PoolClient,
  ): Promise<number> {
    const wh = this.resolveWarehouse(warehouseCode);
    const seen = [
      ...new Set(
        (Array.isArray(seenSkus) ? seenSkus : [])
          .map((sku) => (typeof sku === 'string' ? sku.trim() : ''))
          .filter((sku) => sku.length > 0 && sku.length <= MAX_SKU_LENGTH),
      ),
    ];
    if (seen.length === 0) {
      throw new TombstoneGuardrailError(0, 0, 1);
    }

    const scope = await this.exec<TombstoneScopeRow>(
      client,
      `SELECT count(*)::int AS live_total,
              count(*) FILTER (WHERE NOT (i.sku = ANY($1::text[])))::int AS doomed
         FROM items_cache i
        WHERE i.warehouse_code = $2
          AND i.deleted_at IS NULL`,
      [seen, wh],
    );
    const liveTotal = scope.rows[0]?.live_total ?? 0;
    const doomed = scope.rows[0]?.doomed ?? 0;
    if (doomed === 0) return 0;

    const ratio = liveTotal > 0 ? doomed / liveTotal : 1;
    if (ratio > TOMBSTONE_MAX_RATIO) {
      throw new TombstoneGuardrailError(doomed, liveTotal, ratio);
    }

    const deleted = await this.exec(
      client,
      `UPDATE items_cache
          SET deleted_at = now()
        WHERE warehouse_code = $2
          AND deleted_at IS NULL
          AND NOT (sku = ANY($1::text[]))`,
      [seen, wh],
    );
    const count = deleted.rowCount ?? 0;
    this.logger.log(`tombstone ${count} รายการในคลัง ${wh} (จาก ${liveTotal} รายการที่ยังมีชีวิต)`);
    return count;
  }

  // ── 7. helper ───────────────────────────────────────────────────────────

  /** ยิง SQL บน client ของ transaction ที่ caller ส่งมา หรือบน pool กลางเมื่อไม่มี */
  private exec<T extends QueryResultRow = QueryResultRow>(
    client: PoolClient | undefined,
    sql: string,
    params: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return client ? client.query<T>(sql, params as unknown[]) : this.db.query<T>(sql, params);
  }

  private resolveWarehouse(code?: string): string {
    const trimmed = code?.trim() ?? '';
    return trimmed.length > 0 && trimmed.length <= MAX_WAREHOUSE_LENGTH
      ? trimmed
      : this.defaultWarehouseCode;
  }

  /** cursor ผิดรูป/ติดลบ → 0 (เริ่มโหลดใหม่ทั้งก้อน ปลอดภัยกว่าการข้ามแถว) */
  private static normalizeCursor(cursor: bigint | number | string): bigint {
    try {
      const value =
        typeof cursor === 'bigint'
          ? cursor
          : BigInt(typeof cursor === 'number' ? Math.trunc(cursor) : cursor.trim() || '0');
      return value > 0n ? value : 0n;
    } catch {
      return 0n;
    }
  }

  private static clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), min), max);
  }

  /**
   * escape wildcard ของ ILIKE (ค่าเริ่มต้นของ escape char คือ backslash)
   * ไม่ escape แล้วผู้ใช้พิมพ์ `%` จะได้ทั้งคลัง และ `_` จะ match ตัวอะไรก็ได้
   */
  private static escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  private static isNewer(candidate: string | null, current: string | null): boolean {
    if (candidate === null) return false;
    if (current === null) return true;
    return candidate >= current; // ISO-8601 UTC เทียบเป็นสตริงได้ตรงกับเทียบเวลา
  }

  /** ตัดค่าที่ CHECK ใน schema จะปฏิเสธออกก่อน แทนที่จะให้ batch ทั้งชุดล้ม */
  private static normalizeItem(
    item: CanonicalItem,
    fallbackWh: string,
    anomalies: CatalogAnomaly[],
  ): ItemUpsertPayload | null {
    const sku = typeof item?.sku === 'string' ? item.sku.trim() : '';
    if (sku.length === 0 || sku.length > MAX_SKU_LENGTH) {
      CatalogService.pushAnomaly(anomalies, {
        kind: 'invalid_item',
        detail: `sku ว่างหรือยาวเกิน ${MAX_SKU_LENGTH} ตัวอักษร — ข้ามรายการนี้`,
      });
      return null;
    }

    let name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name.length === 0) {
      // name เป็น NOT NULL + CHECK btrim <> '' — ใช้ sku แทนเพื่อให้สินค้ายังนับได้
      name = sku;
      CatalogService.pushAnomaly(anomalies, {
        kind: 'blank_name',
        sku,
        detail: 'ERP ไม่ส่งชื่อสินค้า — ใช้ sku เป็นชื่อชั่วคราว',
      });
    }

    // ── warehouse scope (docs/erp-integration.md §5) ──
    // deployment 1 ชุด = 1 คลัง ตาม WAREHOUSE_CODE ใน .env → **config ชนะเสมอ**
    // ถ้า ERP ส่งรหัสคลังอื่นมา ห้ามเก็บตามนั้น (ข้อมูลจะไม่ปรากฏให้ผู้ใช้คลังนี้เลย = หายเงียบ)
    // แต่ต้องบันทึกเป็น anomaly เพราะอาจหมายถึง query ของ ERP ไม่ได้ filter คลัง
    const itemWh = CatalogService.trimTo(item.warehouseCode, MAX_WAREHOUSE_LENGTH);
    if (itemWh !== undefined && itemWh !== fallbackWh) {
      CatalogService.pushAnomaly(anomalies, {
        kind: 'warehouse_mismatch',
        sku,
        detail: `ERP ส่งคลัง '${itemWh}' แต่ deployment นี้คือ '${fallbackWh}' — ประทับเป็น '${fallbackWh}' (ตรวจว่า query ของ ERP filter คลังถูกต้องหรือไม่)`,
      });
    }
    const wh = fallbackWh;

    // CHECK: reserved/rop ต้อง >= 0 หรือ NULL (on_hand ติดลบได้ — ERP ให้ยอดติดลบจริง)
    const reserved = CatalogService.nonNegative(item.reserved, sku, 'reserved', anomalies);
    const rop = CatalogService.nonNegative(item.rop, sku, 'rop', anomalies);

    const specs: Record<string, unknown> = {};
    const vendor = CatalogService.trimTo(item.vendor, 128);
    const lot = CatalogService.trimTo(item.lot, 64);
    if (vendor !== undefined) specs.vendor = vendor;
    if (lot !== undefined) specs.lot = lot;
    if (item.lastCountDate instanceof Date && !Number.isNaN(item.lastCountDate.getTime())) {
      specs.lastCountDate = item.lastCountDate.toISOString();
    }

    return {
      sku,
      name,
      name_en: CatalogService.trimTo(item.nameEn, 256) ?? null,
      loc: CatalogService.trimTo(item.loc, 64) ?? null,
      on_hand: CatalogService.finiteOrNull(item.onHand),
      reserved,
      rop,
      unit: CatalogService.trimTo(item.unit, 32) ?? null,
      specs,
      warehouse_code: wh,
      erp_updated_at:
        item.updatedAt instanceof Date && !Number.isNaN(item.updatedAt.getTime())
          ? item.updatedAt.toISOString()
          : null,
      barcodes: Array.isArray(item.barcodes) ? item.barcodes : [],
    };
  }

  /**
   * รวม barcode ของทุกสินค้าในชุด + เพิ่ม sku เองเป็นฉลาก Code128 ที่เราพิมพ์
   * dedupe ในชุด: ON CONFLICT DO UPDATE แก้แถวเดิมซ้ำในคำสั่งเดียวไม่ได้ (Postgres ปฏิเสธ)
   */
  private static collectBarcodes(
    bySku: ReadonlyMap<string, ItemUpsertPayload>,
    anomalies: CatalogAnomaly[],
  ): BarcodeUpsertPayload[] {
    const byBarcode = new Map<string, BarcodeUpsertPayload>();

    const put = (row: BarcodeUpsertPayload): void => {
      const existing = byBarcode.get(row.barcode);
      if (existing) {
        if (existing.sku === row.sku) return;
        CatalogService.pushAnomaly(anomalies, {
          kind: 'barcode_dup_in_batch',
          barcode: row.barcode,
          sku: row.sku,
          detail: `barcode เดียวกันมาพร้อม sku ${existing.sku} และ ${row.sku} ในชุดเดียว — เลือกที่ erp_updated_at ใหม่กว่า`,
        });
        if (!CatalogService.isNewer(row.erp_updated_at, existing.erp_updated_at)) return;
      }
      byBarcode.set(row.barcode, row);
    };

    for (const item of bySku.values()) {
      for (const raw of item.barcodes) {
        const barcode = typeof raw === 'string' ? raw.trim() : '';
        if (barcode.length === 0 || barcode.length > MAX_BARCODE_LENGTH) {
          CatalogService.pushAnomaly(anomalies, {
            kind: 'invalid_barcode',
            sku: item.sku,
            detail: `barcode ว่างหรือยาวเกิน ${MAX_BARCODE_LENGTH} ตัวอักษร — ข้าม barcode นี้`,
          });
          continue;
        }
        put({
          barcode,
          sku: item.sku,
          // แยก unit/pack จาก CanonicalItem ไม่ได้ → ค่าที่เท่ากับ sku คือฉลากที่เราพิมพ์เอง
          source: barcode === item.sku ? BARCODE_SOURCE_LABEL : BARCODE_SOURCE_ERP,
          erp_updated_at: item.erp_updated_at,
        });
      }
      // ฉลาก Code128 จาก ItemCode ที่เราพิมพ์เอง (ERP มี BarCodeUnits แค่ ~1.9%)
      if (item.sku.length <= MAX_BARCODE_LENGTH) {
        put({
          barcode: item.sku,
          sku: item.sku,
          source: BARCODE_SOURCE_LABEL,
          erp_updated_at: item.erp_updated_at,
        });
      }
    }

    return [...byBarcode.values()];
  }

  private static pushAnomaly(anomalies: CatalogAnomaly[], anomaly: CatalogAnomaly): void {
    if (anomalies.length < MAX_ANOMALIES) {
      anomalies.push(anomaly);
      return;
    }
    if (anomalies.length === MAX_ANOMALIES) {
      anomalies.push({
        kind: 'anomalies_truncated',
        detail: `ความผิดปกติเกิน ${MAX_ANOMALIES} รายการ — ตัดส่วนที่เหลือออกจากรายงาน`,
      });
    }
  }

  private static trimTo(value: string | undefined | null, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
  }

  private static finiteOrNull(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private static nonNegative(
    value: number | undefined,
    sku: string,
    field: string,
    anomalies: CatalogAnomaly[],
  ): number | null {
    const num = CatalogService.finiteOrNull(value);
    if (num === null) return null;
    if (num < 0) {
      CatalogService.pushAnomaly(anomalies, {
        kind: 'negative_qty',
        sku,
        detail: `${field} ติดลบจาก ERP — เก็บเป็น NULL (CHECK ในสคีมาไม่ยอมรับค่าติดลบ)`,
      });
      return null;
    }
    return num;
  }

  private static toDto(row: ItemRow): ItemDto {
    const dto: ItemDto = {
      sku: row.sku,
      name: row.name,
      barcodes: row.barcodes ?? [],
      specs: row.specs ?? {},
      warehouseCode: row.warehouse_code,
      rowVersion: row.row_version,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
    if (row.name_en !== null) dto.nameEn = row.name_en;
    if (row.loc !== null) dto.loc = row.loc;
    if (row.unit !== null) dto.unit = row.unit;

    // numeric(18,3) จาก pg เป็น string → แปลงเป็น number ให้ทุก endpoint เหมือนกัน
    // (ยอดสต็อกจริงไม่แตะเพดาน 2^53 · ถ้าอนาคตต้องคง precision ต้องเปลี่ยนเป็น string ทั้งเส้น)
    const onHand = CatalogService.parseNumeric(row.on_hand);
    const reserved = CatalogService.parseNumeric(row.reserved);
    const rop = CatalogService.parseNumeric(row.rop);
    if (onHand !== undefined) dto.onHand = onHand;
    if (reserved !== undefined) dto.reserved = reserved;
    if (rop !== undefined) dto.rop = rop;
    return dto;
  }

  private static parseNumeric(value: string | null): number | undefined {
    if (value === null) return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
}

// ---------------------------------------------------------------------------
// รูปข้อมูลภายในที่ส่งเข้า jsonb_to_recordset (ชื่อคีย์ = ชื่อคอลัมน์)
// ---------------------------------------------------------------------------

type ItemUpsertPayload = {
  sku: string;
  name: string;
  name_en: string | null;
  loc: string | null;
  on_hand: number | null;
  reserved: number | null;
  rop: number | null;
  unit: string | null;
  specs: Record<string, unknown>;
  warehouse_code: string;
  erp_updated_at: string | null;
  /** ไม่ได้ส่งเข้า SQL — ใช้ต่อในขั้น barcode */
  barcodes: string[];
};

type BarcodeUpsertPayload = {
  barcode: string;
  sku: string;
  source: string;
  erp_updated_at: string | null;
};
