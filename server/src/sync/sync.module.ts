import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { z } from 'zod';

import { CurrentUser, RequireFreshRole, Roles } from '../auth/auth.guards';
import { AuthModule } from '../auth/auth.module';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService, TombstoneGuardrailError } from '../catalog/catalog.service';
import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import {
  ERP_ADAPTER,
  type ErpAdapter,
  type ErpCountRow,
  type ErpCountSession,
  type ErpCountSessionSummary,
} from '../erp/erp-adapter';

/**
 * Sync — ดึงข้อมูลจาก ERP ตามรอบเข้า Postgres ของเราเอง
 *
 * 🚫 กฎเหล็ก: ERP (`db_TCL`) **อ่านอย่างเดียว** — ไฟล์นี้เรียกได้เฉพาะ `ErpAdapter`
 *    (interface ไม่มี method เขียน) และเขียนลง Postgres ของระบบเราเท่านั้น
 *
 * หลักการที่ต้องรักษา (docs/erp-integration.md §5):
 *  1. รอบซ้อนกันไม่ได้ → pg advisory lock (ดึง 50k แถวอาจนานกว่าคาบ cron)
 *  2. ดึงไม่ครบ = 'partial' → **ห้าม tombstone และห้ามขยับ cursor** (ไม่ set stock_as_of)
 *  3. ERP ล่ม = 'failed' + log แต่ **ห้าม throw ออกจาก scheduler** (ระบบต้องเดินด้วย cache เดิม)
 *  4. ป้าย "ข้อมูล ณ HH:MM" ในแอปอ่านจาก `sync_runs.stock_as_of` (เวลาที่ดึง ERP สำเร็จ)
 *     ไม่ใช่ `items_cache.erp_updated_at` ซึ่งจะโกหกเมื่อ ERP ไม่มีอะไรเปลี่ยน
 */

// ---------------------------------------------------------------------------
// ชนิดข้อมูลที่ export ให้โมดูลอื่นใช้
// ---------------------------------------------------------------------------

export interface SyncRunResult {
  runId: number;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  rowsRead: number;
  rowsUpserted: number;
  rowsTombstoned: number;
  error?: string;
  anomalies: unknown[];
}

/** ตรงกับ enum `sync_kind` ใน Postgres */
export type SyncKind = 'items' | 'stock' | 'count_sessions';

/** อายุข้อมูลล่าสุดต่อ kind — CountService ใช้ตัดสิน `opened_on_stale_cache` */
export interface SyncFreshness {
  stockAsOf: Date | null;
  finishedAt: Date | null;
}

/** 1 รอบใน `GET /sync/runs` — จุดแรกที่ผู้ดูแลดูเมื่อ "ทำไมสต็อกไม่อัปเดต" */
export interface SyncRunDto {
  id: number;
  driver: string;
  kind: SyncKind;
  warehouseCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  rowsUpserted: number;
  rowsTombstoned: number;
  status: SyncRunResult['status'] | 'running';
  error: string | null;
  anomalies: unknown[];
  stockAsOf: string | null;
  triggeredBy: string | null;
}

export interface SyncStatusDto {
  itemsStockAsOf: string | null;
  countSessionsAsOf: string | null;
  erpOk: boolean;
}

// ---------------------------------------------------------------------------
// ค่าคงที่ + ตัวช่วย (pure)
// ---------------------------------------------------------------------------

/**
 * key ของ advisory lock — คงที่ตลอดอายุระบบ (คนละ key ต่อ kind เพื่อให้
 * รอบ items กับรอบ count_sessions ไม่บล็อกกันเอง)
 */
const LOCK_KEY: Readonly<Record<'items' | 'count_sessions', number>> = {
  items: 872_001,
  count_sessions: 872_002,
};

/** กันไม่ให้ jsonb ของ 1 รอบบวมจนอ่านไม่ได้ */
const MAX_ANOMALIES = 200;
const MAX_ERROR_LEN = 1000;

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_ERROR_LEN ? `${raw.slice(0, MAX_ERROR_LEN)}…` : raw;
}

function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** จำกัดจำนวน anomaly ที่เก็บลง sync_runs (jsonb) ไม่ให้บวมจนอ่านไม่ได้ */
function pushAnomaly(into: unknown[], anomaly: unknown): void {
  if (into.length < MAX_ANOMALIES) into.push(anomaly);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim();
  return out !== undefined && out.length > 0 ? out : undefined;
}

/**
 * `count_sessions.erp_count_date` เป็นชนิด `date` — ต้องส่งเป็น YYYY-MM-DD ของ
 * **เวลาท้องถิ่น** (server ตั้ง TZ=Asia/Bangkok) ไม่ใช่ `toISOString()` ซึ่งเป็น UTC
 * และจะเลื่อนวันย้อนหลัง 7 ชม. สำหรับรอบนับที่เริ่มเที่ยงคืน
 */
function toDateOnly(value: Date | undefined): string | null {
  if (value === undefined || Number.isNaN(value.getTime())) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/**
 * ERP dedupe รอบนับด้วย Roworder สูงสุดแล้ว แต่ 1 รอบยังมี ItemCode ซ้ำได้
 * → ต้องยุบเหลือ sku ละแถว ไม่งั้น `ON CONFLICT DO UPDATE` จะ error
 * ("cannot affect row a second time") ทั้ง statement
 */
function dedupeBySku(
  rows: readonly ErpCountRow[],
  onDuplicate: (sku: string) => void,
): ErpCountRow[] {
  const bySku = new Map<string, ErpCountRow>();
  for (const row of rows) {
    const sku = row.sku.trim();
    if (sku.length === 0) continue;
    if (bySku.has(sku)) onDuplicate(sku);
    bySku.set(sku, { ...row, sku }); // แถวหลังสุดชนะ (ERP เรียงตาม Roworder)
  }
  return [...bySku.values()];
}

// ---------------------------------------------------------------------------
// แถวจาก Postgres
// ---------------------------------------------------------------------------

interface SyncRunRow {
  id: string;
  driver: string;
  kind: SyncKind;
  warehouse_code: string | null;
  started_at: Date;
  finished_at: Date | null;
  rows_read: number;
  rows_upserted: number;
  rows_tombstoned: number;
  status: SyncRunDto['status'];
  error: string | null;
  anomalies: unknown;
  stock_as_of: Date | null;
  triggered_by: string | null;
}

interface SessionStateRow {
  status: 'open' | 'closed';
  has_submission: boolean;
}

const SELECT_RUNS_SQL = `SELECT id, driver, kind, warehouse_code, started_at, finished_at,
                                rows_read, rows_upserted, rows_tombstoned, status, error,
                                anomalies, stock_as_of, triggered_by
                           FROM sync_runs
                          ORDER BY started_at DESC, id DESC
                          LIMIT $1`;

/** stock_as_of ถูก CHECK ให้มีได้เฉพาะรอบ success อยู่แล้ว — query นี้จึงเป็นแหล่งอายุข้อมูลเดียว */
const LAST_SUCCESS_SQL = `SELECT stock_as_of, finished_at
                            FROM sync_runs
                           WHERE kind = $1 AND status = 'success'
                           ORDER BY finished_at DESC NULLS LAST, id DESC
                           LIMIT 1`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);
  private readonly driver: 'sql' | 'rest' | 'mock';
  private readonly warehouseCode: string;

  constructor(
    private readonly db: PostgresService,
    @Inject(ERP_ADAPTER) private readonly erp: ErpAdapter,
    private readonly catalog: CatalogService,
    private readonly registry: SchedulerRegistry,
    private readonly cfg: ConfigService<AppConfig, true>,
  ) {
    this.driver = cfg.get('ERP_DRIVER', { infer: true });
    this.warehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true });
  }

  // ── 1. scheduler ────────────────────────────────────────────────────────
  //
  // ⚠️ @Cron('...') รับ expression ตอน decorate (compile-time) จึงอ่านค่าจาก .env
  //    ไม่ได้ → สร้าง CronJob เองใน onModuleInit แล้วฝากไว้กับ SchedulerRegistry
  //    (ScheduleModule.forRoot() ถูกลงทะเบียนแบบ global ที่ app.module.ts แล้ว
  //     Nest จะหยุด job ที่อยู่ใน registry ให้ตอน shutdown)

  onModuleInit(): void {
    const timeZone = this.cfg.get('TZ', { infer: true });

    this.registerJob('kk:sync:items', this.cfg.get('ERP_SYNC_CRON', { infer: true }), timeZone, () =>
      this.tick('items'),
    );

    // ERP ไม่มีตารางยอดคงเหลือสำเร็จ — "ยอดระบบ" มาจากรอบนับ (tbl_CountDtl.MainQty)
    // จึงให้คาบของยอดสต็อกเป็นตัวขับการ mirror รอบนับ
    this.registerJob(
      'kk:sync:count-sessions',
      this.cfg.get('ERP_SYNC_STOCK_CRON', { infer: true }),
      timeZone,
      () => this.tick('count_sessions'),
    );

    if (this.driver === 'mock') {
      this.logger.warn('ERP_DRIVER=mock — scheduler ทำงานกับข้อมูล fixture ไม่ใช่ ERP จริง');
    }
  }

  private registerJob(
    name: string,
    cronTime: string,
    timeZone: string,
    run: () => Promise<void>,
  ): void {
    try {
      const job = new CronJob(cronTime, () => void run(), null, false, timeZone);
      this.registry.addCronJob(name, job);
      job.start();
      this.logger.log(`ตั้งรอบ ${name} = "${cronTime}" (${timeZone})`);
    } catch (err) {
      // cron ผิดรูป/ชื่อซ้ำ ห้ามทำให้แอป start ไม่ขึ้น — ยัง trigger มือผ่าน POST /sync/* ได้
      this.logger.error(
        `ตั้งรอบ ${name} ไม่สำเร็จ: ${errorMessage(err)} — ใช้ POST /sync/* trigger เองได้`,
      );
    }
  }

  /** tick ของ cron — ห้าม throw ออกไปนอกนี้เด็ดขาด */
  private async tick(kind: 'items' | 'count_sessions'): Promise<void> {
    try {
      const result =
        kind === 'items'
          ? await this.syncItems('scheduler')
          : await this.syncCountSessions('scheduler');
      this.logger.log(
        `รอบ ${kind} #${result.runId}: ${result.status} · อ่าน ${result.rowsRead} · เขียน ${result.rowsUpserted} · tombstone ${result.rowsTombstoned}`,
      );
    } catch (err) {
      this.logger.error(`รอบ ${kind} ล้มแบบไม่คาดคิด: ${errorMessage(err)}`);
    }
  }

  // ── 2. syncItems ────────────────────────────────────────────────────────

  /** ดึง item master จาก ERP เข้า items_cache — ไม่ throw เมื่อ ERP ล่ม (คืน status 'failed') */
  async syncItems(triggeredBy: string): Promise<SyncRunResult> {
    return this.withLock('items', triggeredBy, (by) => this.runItems(by));
  }

  private async runItems(triggeredBy: string): Promise<SyncRunResult> {
    const anomalies: unknown[] = [];
    const runId = await this.startRun('items', triggeredBy);
    const seen = new Set<string>();
    let rowsRead = 0;
    let rowsUpserted = 0;
    let rowsTombstoned = 0;
    let streamError: string | undefined;

    // delta pull ได้เฉพาะ driver ที่มี updated-at ที่เชื่อถือได้ · ที่เหลือ = full snapshot
    const since = this.erp.capabilities().delta ? await this.computeSince('items') : undefined;

    try {
      for await (const batch of this.erp.fetchItems(since)) {
        if (batch.length === 0) continue;
        rowsRead += batch.length;
        for (const item of batch) seen.add(item.sku);
        // 1 batch = 1 transaction ย่อย (items + barcodes ต้องลงพร้อมกัน และ
        // 50k แถวห้ามค้างใน transaction เดียว — bounded memory/lock)
        const upserted = await this.db.transaction((client) =>
          this.catalog.upsertItems(batch, this.warehouseCode, client),
        );
        rowsUpserted += toCount(upserted.upserted);
        for (const anomaly of upserted.anomalies) pushAnomaly(anomalies, anomaly);
      }
    } catch (err) {
      streamError = errorMessage(err);
    }

    let status: SyncRunResult['status'];
    let error = streamError;

    if (streamError !== undefined) {
      // ดึงไม่ครบ → ห้าม tombstone และห้าม set stock_as_of (cursor ต้องไม่ขยับ)
      status = rowsRead > 0 ? 'partial' : 'failed';
      pushAnomaly(anomalies, {
        type: 'erp_stream_failed',
        kind: 'items',
        rowsRead,
        message: streamError,
      });
      this.logger.error(`ดึง items จาก ERP ไม่ครบ (อ่านได้ ${rowsRead} แถว): ${streamError}`);
    } else if (since !== undefined) {
      // delta pull: seen มีแค่ของที่เปลี่ยน → reconcile ไม่ได้ ห้าม tombstone
      status = 'success';
    } else {
      try {
        const removed = await this.db.transaction((client) =>
          this.catalog.tombstoneMissing([...seen], this.warehouseCode, client),
        );
        rowsTombstoned = toCount(removed);
        status = 'success';
      } catch (err) {
        // guardrail (ลบเกิน 5%/รอบ) กันไว้ — ของที่ upsert ไปแล้วยังใช้ได้ จึงไม่ล้มทั้งรอบ
        status = 'partial';
        error = errorMessage(err);
        pushAnomaly(
          anomalies,
          err instanceof TombstoneGuardrailError
            ? {
                type: 'tombstone_guardrail_blocked',
                seenSkus: seen.size,
                doomed: err.doomed,
                liveTotal: err.liveTotal,
                ratio: err.ratio,
                message: error,
              }
            : { type: 'tombstone_failed', seenSkus: seen.size, message: error },
        );
        this.logger.warn(`ข้าม tombstone: ${error}`);
      }
    }

    return this.finishRun(runId, { status, rowsRead, rowsUpserted, rowsTombstoned, error, anomalies });
  }

  // ── 3. syncCountSessions ────────────────────────────────────────────────

  /** mirror รอบนับของ ERP → count_sessions + freeze count_snapshot */
  async syncCountSessions(triggeredBy: string): Promise<SyncRunResult> {
    return this.withLock('count_sessions', triggeredBy, (by) => this.runCountSessions(by));
  }

  private async runCountSessions(triggeredBy: string): Promise<SyncRunResult> {
    const anomalies: unknown[] = [];
    const runId = await this.startRun('count_sessions', triggeredBy);

    let summaries: ErpCountSessionSummary[];
    try {
      summaries = await this.erp.fetchCountSessions();
    } catch (err) {
      const error = errorMessage(err);
      this.logger.error(`อ่านรายการรอบนับจาก ERP ไม่ได้: ${error}`);
      pushAnomaly(anomalies, { type: 'erp_unavailable', kind: 'count_sessions', message: error });
      return this.finishRun(runId, {
        status: 'failed',
        rowsRead: 0,
        rowsUpserted: 0,
        rowsTombstoned: 0,
        error,
        anomalies,
      });
    }

    let rowsRead = 0;
    let rowsUpserted = 0;
    let failedSessions = 0;

    for (const summary of summaries) {
      try {
        const session = await this.erp.fetchCountSession(summary.transactionNo);
        if (session === null) {
          failedSessions += 1;
          pushAnomaly(anomalies, {
            type: 'session_vanished',
            transactionNo: summary.transactionNo,
          });
          continue;
        }
        rowsRead += session.rows.length;
        rowsUpserted += await this.mirrorSession(session, anomalies);
      } catch (err) {
        failedSessions += 1;
        pushAnomaly(anomalies, {
          type: 'session_mirror_failed',
          transactionNo: summary.transactionNo,
          message: errorMessage(err),
        });
      }
    }

    let status: SyncRunResult['status'] = 'success';
    let error: string | undefined;
    if (failedSessions > 0) {
      status = rowsUpserted > 0 ? 'partial' : 'failed';
      error = `mirror รอบนับไม่สำเร็จ ${failedSessions}/${summaries.length} รอบ`;
      this.logger.warn(error);
    }

    return this.finishRun(runId, {
      status,
      rowsRead,
      rowsUpserted,
      rowsTombstoned: 0,
      error,
      anomalies,
    });
  }

  /**
   * mirror 1 รอบนับ — คืนจำนวนแถวที่เขียนจริง (header + snapshot)
   *
   * 🚫 ห้ามอ่าน `CountQty` / `DifQty` ของ ERP มาเป็นผลนับของเรา: ผลนับต้องมาจาก
   *    พนักงานผ่าน count_submissions เท่านั้น (ErpCountRow จึงมีแค่ systemQty)
   *    ถ้าวันหน้าจะเก็บยอดนับของ ERP ให้ลงได้แค่ `erp_ref_count_qty` เป็นข้อมูลอ้างอิง
   */
  private async mirrorSession(session: ErpCountSession, anomalies: unknown[]): Promise<number> {
    const sessionId = `ERP-${session.transactionNo}`;
    const warehouse = trimmed(session.warehouse) ?? this.warehouseCode;

    return this.db.transaction(async (client) => {
      // 1. header — ห้ามแตะ status/closed_at และห้าม "เปิดรอบที่ปิดแล้ว" ใหม่
      const header = await client.query(
        `INSERT INTO count_sessions
           (id, erp_transaction_no, erp_voucher_no, erp_roworder, erp_count_date,
            warehouse_code, erp_data_as_of)
         VALUES ($1, $2, $3, NULL, $4::date, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           erp_transaction_no = EXCLUDED.erp_transaction_no,
           erp_voucher_no     = EXCLUDED.erp_voucher_no,
           erp_count_date     = EXCLUDED.erp_count_date,
           warehouse_code     = EXCLUDED.warehouse_code
         WHERE count_sessions.status = 'open'`,
        [
          sessionId,
          session.transactionNo.trim(),
          trimmed(session.voucherNo) ?? null,
          toDateOnly(session.countDate),
          warehouse,
        ],
      );
      let written = header.rowCount ?? 0;

      const state = await client.query<SessionStateRow>(
        `SELECT status,
                EXISTS (SELECT 1 FROM count_submissions WHERE session_id = $1) AS has_submission
           FROM count_sessions WHERE id = $1`,
        [sessionId],
      );
      const current = state.rows.at(0);
      if (!current) return written;

      // 2. baseline ต้องนิ่ง: มีผลนับแล้ว หรือรอบปิดแล้ว = ห้าม overwrite snapshot
      if (current.has_submission) {
        pushAnomaly(anomalies, {
          type: 'snapshot_locked_has_submissions',
          sessionId,
          message: 'รอบนี้มีผลนับแล้ว — ข้ามการ freeze ใหม่เพื่อให้ baseline นิ่ง',
        });
        return written;
      }
      if (current.status === 'closed') {
        pushAnomaly(anomalies, { type: 'snapshot_locked_session_closed', sessionId });
        return written;
      }

      // 3. freeze snapshot จาก systemQty (= tbl_CountDtl.MainQty ที่ ERP คำนวณให้)
      const rows = dedupeBySku(session.rows, (sku) =>
        pushAnomaly(anomalies, { type: 'duplicate_sku_in_erp_session', sessionId, sku }),
      );
      if (rows.length === 0) return written;

      const skus = rows.map((row) => row.sku);
      const known = await client.query<{ sku: string }>(
        `SELECT sku FROM items_cache WHERE sku = ANY($1::text[])`,
        [skus],
      );
      const knownSkus = new Set(known.rows.map((row) => row.sku));
      const usable = rows.filter((row) => knownSkus.has(row.sku));
      const missing = skus.filter((sku) => !knownSkus.has(sku));

      if (missing.length > 0) {
        // FK count_snapshot.sku → items_cache จะ fail → ข้ามไว้ก่อน แล้วให้ผู้ดูแลรัน sync items
        pushAnomaly(anomalies, {
          type: 'sku_missing_in_items_cache',
          sessionId,
          count: missing.length,
          sample: missing.slice(0, 10),
          message: 'ต้อง sync items ให้เสร็จก่อน รอบถัดไปจะ freeze ครบเอง',
        });
      }
      if (usable.length === 0) return written;

      const snapshot = await client.query(
        `INSERT INTO count_snapshot
           (session_id, sku, frozen_on_hand, unit, warehouse_code, zone, erp_ref_count_qty)
         SELECT $1, s.sku, s.qty, NULLIF(btrim(s.unit), ''), $2, NULL, NULL
           FROM unnest($3::text[], $4::numeric[], $5::text[]) AS s(sku, qty, unit)
         ON CONFLICT (session_id, sku) DO UPDATE SET
           frozen_on_hand = EXCLUDED.frozen_on_hand,
           unit           = EXCLUDED.unit,
           warehouse_code = EXCLUDED.warehouse_code,
           frozen_at      = now()`,
        [
          sessionId,
          warehouse,
          usable.map((row) => row.sku),
          usable.map((row) => row.systemQty),
          usable.map((row) => row.unit),
        ],
      );
      written += snapshot.rowCount ?? 0;

      // อายุข้อมูล ERP ของ baseline = เวลาที่ freeze จริง (อัปเดตเฉพาะรอบที่ยังเปิด)
      await client.query(
        `UPDATE count_sessions SET erp_data_as_of = now() WHERE id = $1 AND status = 'open'`,
        [sessionId],
      );
      return written;
    });
  }

  // ── 4. อายุข้อมูล / รายงาน ──────────────────────────────────────────────

  /** ให้แอปและ CountService อ่านอายุข้อมูล (แหล่งเดียวของป้าย "ข้อมูล ณ HH:MM") */
  async lastSuccess(kind: SyncKind): Promise<SyncFreshness> {
    const row = await this.db.one<{ stock_as_of: Date | null; finished_at: Date | null }>(
      LAST_SUCCESS_SQL,
      [kind],
    );
    return { stockAsOf: row?.stock_as_of ?? null, finishedAt: row?.finished_at ?? null };
  }

  async listRuns(limit: number): Promise<SyncRunDto[]> {
    const result = await this.db.query<SyncRunRow>(SELECT_RUNS_SQL, [limit]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      driver: row.driver,
      kind: row.kind,
      warehouseCode: row.warehouse_code,
      startedAt: row.started_at.toISOString(),
      finishedAt: iso(row.finished_at),
      rowsRead: row.rows_read,
      rowsUpserted: row.rows_upserted,
      rowsTombstoned: row.rows_tombstoned,
      status: row.status,
      error: row.error,
      anomalies: Array.isArray(row.anomalies) ? row.anomalies : [],
      stockAsOf: iso(row.stock_as_of),
      triggeredBy: row.triggered_by,
    }));
  }

  async status(): Promise<SyncStatusDto> {
    const [items, countSessions, erpOk] = await Promise.all([
      this.lastSuccess('items'),
      this.lastSuccess('count_sessions'),
      this.erpOk(),
    ]);
    return {
      itemsStockAsOf: iso(items.stockAsOf),
      countSessionsAsOf: iso(countSessions.stockAsOf),
      erpOk,
    };
  }

  /** ERP ล่มต้องไม่ทำให้ endpoint นี้พัง — แอปยังต้องรู้ว่า cache เก่าแค่ไหน */
  private async erpOk(): Promise<boolean> {
    try {
      const health = await this.erp.healthCheck();
      return health.ok;
    } catch {
      return false;
    }
  }

  // ── 5. advisory lock + bookkeeping ──────────────────────────────────────

  /**
   * กันรอบซ้อน: `pg_try_advisory_lock` เป็น session-scope จึงต้องใช้ **client เดิม**
   * ตั้งแต่ lock จนถึง unlock — `db.transaction()` เป็นทางเดียวที่ได้ client ผูกกับ
   * connection เดียว (statement ของงาน sync วิ่งบน connection อื่นจาก pool ตามปกติ
   * transaction นี้ทำหน้าที่ถือ lock เท่านั้น จึงไม่ล็อกแถวใด)
   */
  private async withLock(
    kind: 'items' | 'count_sessions',
    triggeredBy: string,
    run: (triggeredBy: string) => Promise<SyncRunResult>,
  ): Promise<SyncRunResult> {
    const key = LOCK_KEY[kind];
    return this.db.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key],
      );
      if (lock.rows.at(0)?.locked !== true) {
        this.logger.warn(`ข้ามรอบ ${kind}: รอบก่อนหน้ายังทำงานอยู่ (advisory lock ไม่ว่าง)`);
        return this.recordSkipped(kind, triggeredBy);
      }

      try {
        return await run(triggeredBy);
      } finally {
        // ⚠️ ต้องปลดเสมอด้วย client เดิม ไม่งั้น lock ค้างจนกว่า connection จะตาย
        await client
          .query('SELECT pg_advisory_unlock($1::bigint)', [key])
          .catch((err: unknown) =>
            this.logger.error(`ปลด advisory lock ${kind} ไม่สำเร็จ: ${errorMessage(err)}`),
          );
      }
    });
  }

  private async startRun(kind: SyncKind, triggeredBy: string): Promise<number> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO sync_runs (driver, kind, warehouse_code, status, triggered_by)
       VALUES ($1, $2, $3, 'running', $4)
       RETURNING id`,
      [this.driver, kind, this.warehouseCode, triggeredBy],
    );
    if (row === null) throw new Error('บันทึกรอบ sync ลง sync_runs ไม่สำเร็จ');
    return Number(row.id);
  }

  private async finishRun(
    runId: number,
    outcome: {
      status: SyncRunResult['status'];
      rowsRead: number;
      rowsUpserted: number;
      rowsTombstoned: number;
      error?: string;
      anomalies: unknown[];
    },
  ): Promise<SyncRunResult> {
    // CHECK ใน DB: status='failed' ต้องมี error · stock_as_of มีได้เฉพาะ success
    const error =
      outcome.status === 'failed'
        ? (outcome.error ?? 'ดึงข้อมูลจาก ERP ไม่สำเร็จ (ไม่มีรายละเอียดจาก driver)')
        : (outcome.error ?? null);

    await this.db.query(
      `UPDATE sync_runs
          SET finished_at     = now(),
              rows_read       = $2,
              rows_upserted   = $3,
              rows_tombstoned = $4,
              status          = $5,
              error           = $6,
              anomalies       = $7::jsonb,
              stock_as_of     = CASE WHEN $5::sync_run_status = 'success' THEN now() ELSE NULL END
        WHERE id = $1`,
      [
        runId,
        toCount(outcome.rowsRead),
        toCount(outcome.rowsUpserted),
        toCount(outcome.rowsTombstoned),
        outcome.status,
        error,
        JSON.stringify(outcome.anomalies),
      ],
    );

    const result: SyncRunResult = {
      runId,
      status: outcome.status,
      rowsRead: toCount(outcome.rowsRead),
      rowsUpserted: toCount(outcome.rowsUpserted),
      rowsTombstoned: toCount(outcome.rowsTombstoned),
      anomalies: outcome.anomalies,
    };
    if (error !== null) result.error = error;
    return result;
  }

  /** รอบที่ถูกข้ามก็ต้องเห็นใน sync_runs ไม่งั้นผู้ดูแลจะไม่รู้ว่ารอบก่อนยังค้าง */
  private async recordSkipped(kind: SyncKind, triggeredBy: string): Promise<SyncRunResult> {
    const reason = 'ข้ามรอบ: รอบก่อนหน้ายังทำงานอยู่ (advisory lock ไม่ว่าง)';
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO sync_runs (driver, kind, warehouse_code, status, triggered_by, finished_at, error)
       VALUES ($1, $2, $3, 'skipped', $4, now(), $5)
       RETURNING id`,
      [this.driver, kind, this.warehouseCode, triggeredBy, reason],
    );
    return {
      runId: row === null ? 0 : Number(row.id),
      status: 'skipped',
      rowsRead: 0,
      rowsUpserted: 0,
      rowsTombstoned: 0,
      error: reason,
      anomalies: [],
    };
  }

  /** delta pull: ถอย overlap window กันแถวตกขอบ · ไม่เคยสำเร็จ = full snapshot */
  private async computeSince(kind: SyncKind): Promise<Date | undefined> {
    const last = await this.lastSuccess(kind);
    if (last.stockAsOf === null) return undefined;
    const overlapS = this.cfg.get('ERP_SYNC_OVERLAP_S', { infer: true });
    return new Date(last.stockAsOf.getTime() - overlapS * 1000);
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * Sync — trigger มือ + หน้าตรวจสุขภาพการดึงข้อมูล
 *
 * guard ระดับแอป (APP_GUARD) บังคับ login ทุก endpoint อยู่แล้ว
 * trigger มือติด `@RequireFreshRole()` เพราะ blast radius สูง (ทับ items_cache ทั้งคลัง)
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('items')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async runItems(@CurrentUser() user: AuthenticatedUser): Promise<SyncRunResult> {
    return this.sync.syncItems(`manual:${user.empId}`);
  }

  @Post('count-sessions')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async runCountSessions(@CurrentUser() user: AuthenticatedUser): Promise<SyncRunResult> {
    return this.sync.syncCountSessions(`manual:${user.empId}`);
  }

  /** ประวัติรอบล่าสุด — ทุก role ที่ login แล้วดูได้ */
  @Get('runs')
  async runs(@Query('limit') limit?: string): Promise<SyncRunDto[]> {
    const parsed = LimitSchema.safeParse(limit);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'limit ต้องเป็นตัวเลข 1–100' });
    }
    return this.sync.listRuns(parsed.data);
  }

  /** ป้าย "ข้อมูล ณ HH:MM" ในแอปอ่านจาก endpoint นี้ */
  @Get('status')
  async status(): Promise<SyncStatusDto> {
    return this.sync.status();
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** PostgresModule/ErpModule เป็น @Global และ ConfigModule/ScheduleModule ลงทะเบียนแบบ global แล้ว */
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
