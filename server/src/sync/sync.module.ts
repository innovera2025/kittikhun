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
/**
 * ชนิดของรอบ sync
 * ⚠️ เหลือ 'items' อย่างเดียวตั้งแต่ 22 ส.ค. 2569 — 'stock' และ 'count_sessions' ถูกตัดออก
 *    (ยอดคงเหลือมาพร้อม item master แล้ว · ไม่ mirror รอบนับของ ERP อีกต่อไป)
 *    ค่าเดิมยังมีในคอลัมน์ sync_runs.kind ของข้อมูลเก่า จึงไม่ลบออกจาก enum ใน DB
 */
export type SyncKind = 'items';

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
  erpOk: boolean;
}

// ---------------------------------------------------------------------------
// ค่าคงที่ + ตัวช่วย (pure)
// ---------------------------------------------------------------------------

/**
 * key ของ advisory lock — คงที่ตลอดอายุระบบ (คนละ key ต่อ kind เพื่อให้
 * รอบต่าง kind ไม่บล็อกกันเอง)
 */
const LOCK_KEY: Readonly<Record<SyncKind, number>> = {
  items: 872_001,
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
  private async tick(kind: SyncKind): Promise<void> {
    try {
      const result = await this.syncItems('scheduler');
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

  /*
   * ⚠️ เคยมี syncCountSessions() / runCountSessions() / mirrorSession() อยู่ตรงนี้
   *    ดึง "รอบนับที่ทำใน ERP อยู่แล้ว" มา mirror เป็น count_sessions + count_snapshot
   *
   *    ตัดออกถาวร 22 ส.ค. 2569: ระบบดึงจาก ERP แค่จำนวนคงเหลือเท่านั้น
   *    รอบนับทั้งหมดเปิดจากแอปเราเอง (CountService.openSession) แล้ว freeze
   *    ยอดจาก items_cache ซึ่งได้ยอดมาจากสูตรของฝ่าย ERP ที่แม่น 100% แล้ว
   */

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
    const [items, erpOk] = await Promise.all([this.lastSuccess('items'), this.erpOk()]);
    return {
      itemsStockAsOf: iso(items.stockAsOf),
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
    kind: SyncKind,
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
