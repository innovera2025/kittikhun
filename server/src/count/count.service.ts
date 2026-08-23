import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { canWrite, type AuthenticatedUser, type Role } from '../auth/auth.types';
import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';

/**
 * CountService — หัวใจของระบบ: รับ "จำนวนที่นับได้จริง" แล้วคำนวณ **ส่วนต่าง**
 *
 * 🚫 กฎเหล็ก: ไฟล์นี้เขียนเฉพาะ Postgres ของเราเอง — ไม่มี statement ใดวิ่งไป ERP
 *    (ERP อ่านอย่างเดียวผ่าน SyncService → items_cache → count_snapshot)
 *
 * หลักการที่ต้องรักษา:
 * - baseline เดียวที่ใช้เทียบคือ `count_snapshot.frozen_on_hand` (ไม่เชื่อยอดที่ client ส่งมา)
 * - `count_submissions` เป็น **append-only** — duplicate ห้ามเขียนทับ ให้ log anomaly แทน
 * - การจัดลำดับ "ล่าสุดชนะ" ใช้ `device_seq` + `received_at` (นาฬิกาเครื่องเชื่อไม่ได้)
 *   `counted_at` ใช้แสดงผลเท่านั้น
 * - `diff` เป็น NULL ได้ 2 กรณี (not_counted / off_list) — **ห้าม coalesce เป็น 0**
 * - ปิดรอบ = materialize `closed_variance` → เลขไม่เปลี่ยนย้อนหลังแม้ submission มาช้า
 */

// ---------------------------------------------------------------------------
// 1. สัญญาข้อมูลที่ส่งออก (controller/แอปใช้ชุดนี้)
// ---------------------------------------------------------------------------

/**
 * ผู้เรียก — ใส่ `AuthenticatedUser` ตรง ๆ หรือส่งแค่ `empId` เป็นสตริงก็ได้
 * (สิทธิ์เขียนถูกตรวจกับ DB ตอน ingest อยู่แล้ว ไม่เชื่อ role ที่ส่งมา)
 */
export type CountActor = string | Pick<AuthenticatedUser, 'empId'>;

export type CountSessionStatus = 'open' | 'closed';

export type VarianceStatus =
  | 'match'
  | 'over'
  | 'short'
  | 'not_counted'
  | 'off_list'
  | 'conflict';

/** สถานะเป็นภาษาไทย (ใช้ทั้ง CSV และหน้าจอ) */
export const VARIANCE_STATUS_TH: Record<VarianceStatus, string> = {
  match: 'ตรงกับระบบ',
  over: 'เกิน',
  short: 'ขาด',
  not_counted: 'ยังไม่ได้นับ',
  off_list: 'นอกรายการ',
  conflict: 'ขัดแย้ง(หลายเครื่อง)',
};

export interface CountSessionItemDto {
  sku: string;
  name: string | null;
  nameEn: string | null;
  loc: string | null;
  unit: string | null;
  /** ยอดระบบที่ freeze ไว้ตอนเปิดรอบ */
  frozenOnHand: number;
  zone: string | null;
}

export interface CountSessionDto {
  id: string;
  erpTransactionNo: string | null;
  erpVoucherNo: string | null;
  zone: string | null;
  warehouseCode: string;
  status: CountSessionStatus;
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  /** อายุข้อมูล ERP ตอน freeze — แอปต้องแสดงตามจริง */
  erpDataAsOf: string | null;
  erpCountDate: string | null;
  /** true = เปิดรอบบน cache เก่า (ERP ล่ม/sync ค้าง) */
  openedOnStaleCache: boolean;
  itemCount: number;
  items: CountSessionItemDto[];
}

export type SubmissionStatus = 'accepted' | 'duplicate' | 'rejected';

/**
 * code ที่แอปใช้ map ข้อความในจอ pending-review
 * - `OFF_LIST` มาพร้อม status `accepted` (นับเจอของนอกรายการ = ยอมรับ)
 * - `PAYLOAD_MISMATCH` ไม่ถูกส่งกลับเป็น reject — มันคือ anomaly ที่ log ลง audit_log
 */
export const SubmissionCode = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CLOSED: 'SESSION_CLOSED',
  SKU_NOT_FOUND: 'SKU_NOT_FOUND',
  OFF_LIST: 'OFF_LIST',
  INVALID_QTY: 'INVALID_QTY',
  INVALID_LINE: 'INVALID_LINE',
  ROLE_CHANGED: 'ROLE_CHANGED',
  PAYLOAD_MISMATCH: 'PAYLOAD_MISMATCH',
} as const;
export type SubmissionCode = (typeof SubmissionCode)[keyof typeof SubmissionCode];

export interface SubmissionResult {
  idempotencyKey: string;
  status: SubmissionStatus;
  code?: SubmissionCode;
}

export interface VarianceRow {
  sku: string;
  name: string | null;
  frozenOnHand: number | null;
  countedQty: number | null;
  /** ⚠️ null = ยังไม่ได้นับ หรือ นอกรายการ — ห้ามแปลงเป็น 0 */
  diff: number | null;
  status: VarianceStatus;
  unit: string | null;
  zone: string | null;
  warehouseCode: string | null;
  countedBy: string | null;
  countedDeviceId: string | null;
  deviceCount: number;
  submissionCount: number | null;
  supersededCount: number | null;
  isConflict: boolean;
  countedAt: string | null;
  receivedAt: string | null;
  latestSubmission: string | null;
  chosenSubmission: string | null;
  resolvedBy: string | null;
  /** live = อ่านจาก v_variance (รอบยังเปิด) · closed = อ่านจาก closed_variance */
  source: 'live' | 'closed';
}

export interface ConflictSubmissionDto {
  idempotencyKey: string;
  empId: string;
  deviceId: string;
  deviceSeq: number;
  countedQty: number;
  /** เวลาที่เครื่องบอก — แสดงผลเท่านั้น */
  countedAt: string;
  receivedAt: string;
  /** true = แถวที่ v_variance เลือกเป็น "ล่าสุด" ภายในลำดับของเครื่อง */
  isLatest: boolean;
}

export interface ConflictRow {
  sku: string;
  name: string | null;
  frozenOnHand: number | null;
  unit: string | null;
  zone: string | null;
  deviceCount: number;
  submissionCount: number;
  deviceIds: string[];
  resolved: boolean;
  chosenSubmission: string | null;
  resolvedBy: string | null;
  submissions: ConflictSubmissionDto[];
}

export interface CloseSessionResult {
  materialized: number;
  conflicts: number;
}

// ---------------------------------------------------------------------------
// 2. zod — ข้อมูลจากภายนอกทุกจุด
// ---------------------------------------------------------------------------

const SkuSchema = z.string().trim().min(1).max(64);

const IsoDateTimeSchema = z.union([z.string().trim().min(1), z.date()]).transform((value, ctx) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ต้องเป็นเวลารูปแบบ ISO 8601' });
    return z.NEVER;
  }
  return date;
});

/**
 * 1 บรรทัดผลนับจากมือถือ
 * เพดาน qty กัน numeric(18,3) overflow — ถ้าปล่อยไป DB จะ error 22003 แล้วเครื่อง retry ไม่จบ
 */
export const SubmitLineSchema = z.object({
  idempotencyKey: z.string().trim().uuid(),
  sku: SkuSchema,
  countedQty: z.number().finite().min(0).max(999_999_999_999.999),
  countedAt: IsoDateTimeSchema,
  deviceSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type SubmitLineInput = z.input<typeof SubmitLineSchema>;
type SubmitLine = z.output<typeof SubmitLineSchema>;

const MAX_BATCH_LINES = 500;

/** heartbeat ที่แนบมากับ batch (ไม่มีก็ได้ — แต่ device row ต้องถูก upsert ทุกครั้ง) */
export const DeviceHeartbeatSchema = z.object({
  queueDepth: z.number().int().min(0).max(1_000_000).optional(),
  oldestPendingAgeSeconds: z.number().finite().min(0).max(31_536_000).optional(),
  model: z.string().trim().min(1).max(64).optional(),
  appVersion: z.string().trim().min(1).max(32).optional(),
});
export type DeviceHeartbeat = z.input<typeof DeviceHeartbeatSchema>;

export const OpenSessionSchema = z.object({
  /** ตั้งรหัสรอบเองได้ (ไม่ส่ง = ระบบสร้างให้) */
  id: z.string().trim().min(1).max(64).optional(),
  zone: z.string().trim().min(1).max(64).optional(),
  /** ไม่ส่ง = ใช้ `WAREHOUSE_CODE` จาก .env */
  warehouseCode: z.string().trim().min(1).max(32).optional(),
  /** ไม่ระบุ = freeze ทุก SKU ที่ยังมีชีวิตในคลังนั้น */
  skus: z.array(SkuSchema).min(1).max(50_000).optional(),
  /**
   * admin ยืนยันเปิดรอบบน cache เก่า (ERP ล่ม) — erp-integration.md §5
   * ไม่ส่งคีย์นี้เลย = ไม่มีการยืนยัน/ไม่ gate (แค่ประทับ opened_on_stale_cache)
   * ส่ง `false` = ห้ามเปิดถ้า cache เก่ากว่า 6 ชม.
   */
  allowStaleCache: z.boolean().optional(),
});
export type OpenSessionInput = z.input<typeof OpenSessionSchema>;

/** ซอง batch แบบที่ controller ส่งมา: `{deviceId, queueDepth?, lines}` */
const SubmitEnvelopeSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  queueDepth: z.number().int().min(0).max(1_000_000).optional(),
  oldestPendingAgeSeconds: z.number().finite().min(0).max(31_536_000).optional(),
  model: z.string().trim().min(1).max(64).optional(),
  appVersion: z.string().trim().min(1).max(32).optional(),
  lines: z.array(z.unknown()),
});

// ---------------------------------------------------------------------------
// 3. แถวจาก Postgres (numeric/bigint กลับมาเป็น string จาก pg — แปลงด้วย toNumber)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  erp_transaction_no: string | null;
  erp_voucher_no: string | null;
  zone: string | null;
  warehouse_code: string;
  status: CountSessionStatus;
  opened_at: Date | string;
  closed_at: Date | string | null;
  closed_by: string | null;
  erp_data_as_of: Date | string | null;
  erp_count_date: string | null;
  opened_on_stale_cache: boolean;
}

interface SnapshotItemRow {
  sku: string;
  name: string | null;
  name_en: string | null;
  loc: string | null;
  unit: string | null;
  frozen_on_hand: string | number;
  zone: string | null;
}

interface VarianceViewRow {
  sku: string;
  name: string | null;
  frozen_on_hand: string | number | null;
  counted_qty: string | number | null;
  diff: string | number | null;
  status: VarianceStatus;
  unit: string | null;
  zone: string | null;
  warehouse_code: string | null;
  counted_by: string | null;
  counted_device_id: string | null;
  device_count: string | number | null;
  submission_count: string | number | null;
  superseded_count: string | number | null;
  is_conflict: boolean | null;
  counted_at: Date | string | null;
  received_at: Date | string | null;
  latest_submission: string | null;
  chosen_submission: string | null;
  resolved_by: string | null;
}

interface ConflictHeadRow {
  sku: string;
  name: string | null;
  frozen_on_hand: string | number | null;
  unit: string | null;
  zone: string | null;
  device_count: string | number | null;
  submission_count: string | number | null;
  device_ids: string[] | null;
  latest_submission: string | null;
  chosen_submission: string | null;
  resolved_by: string | null;
}

interface ConflictSubmissionRow {
  idempotency_key: string;
  sku: string;
  emp_id: string;
  device_id: string;
  device_seq: string | number;
  counted_qty: string | number;
  counted_at: Date | string;
  received_at: Date | string;
}

interface SkuCheckRow {
  sku: string;
  in_snapshot: boolean;
}

interface SkuDiagnosticRow {
  sku: string;
  no_on_hand: boolean;
  is_deleted: boolean;
  wrong_warehouse: boolean;
}

const AUDIT_SQL = `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`;

const SESSION_COLUMNS = `id, erp_transaction_no, erp_voucher_no, zone, warehouse_code, status,
                         opened_at, closed_at, closed_by, erp_data_as_of,
                         erp_count_date::text AS erp_count_date, opened_on_stale_cache`;

/** เรียงรายงาน: เรื่องที่ต้องตัดสินใจขึ้นก่อน แล้วค่อยของที่ตรง (alias เป็นค่าคงที่ในโค้ด ไม่ใช่ input) */
const varianceOrder = (alias: 'v' | 'c'): string => `CASE ${alias}.status
                          WHEN 'conflict'    THEN 0
                          WHEN 'over'        THEN 1
                          WHEN 'short'       THEN 2
                          WHEN 'off_list'    THEN 3
                          WHEN 'not_counted' THEN 4
                          ELSE 5
                        END`;

@Injectable()
export class CountService {
  private readonly logger = new Logger(CountService.name);
  private readonly defaultWarehouseCode: string;

  /** cache เก่ากว่านี้ = เปิดรอบบนข้อมูลเก่า (admin ต้องเห็น) */
  private static readonly STALE_CACHE_MS = 6 * 60 * 60 * 1000;

  constructor(
    private readonly db: PostgresService,
    cfg: ConfigService<AppConfig, true>,
  ) {
    this.defaultWarehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true });
  }

  // ── 1. รอบที่เปิดอยู่ ─────────────────────────────────────────────────

  /**
   * รอบ `open` ล่าสุดของคลัง + รายการที่ freeze ไว้
   * ⚠️ ไม่มีรอบเปิด → คืน `null` (ไม่ throw) เพราะแอปมีจอ "ยังไม่มีรอบตรวจนับ"
   */
  async activeSession(warehouseCode?: string): Promise<CountSessionDto | null> {
    const wh = warehouseCode?.trim() ? warehouseCode.trim() : this.defaultWarehouseCode;
    const session = await this.db.one<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
         FROM count_sessions
        WHERE warehouse_code = $1 AND status = 'open'
        ORDER BY opened_at DESC
        LIMIT 1`,
      [wh],
    );
    if (!session) return null;
    return this.buildSessionDto(session);
  }

  // ── 2. รับผลนับ (batch, idempotent, ตอบรายบรรทัด) ─────────────────────

  /**
   * รับผลนับเป็น batch → ตอบผล **รายบรรทัด** เรียงตามลำดับ input (HTTP 200 เสมอ)
   * batch 10 บรรทัดที่เสีย 1 บรรทัด ต้องไม่ทำให้ 9 บรรทัดดีตกน้ำ จึงไม่ใช้ transaction ครอบทั้งก้อน
   * (แต่ละ INSERT เป็น statement เดียว → atomic ในตัว และ idempotency_key กันซ้ำ)
   *
   * error ที่ไม่ใช่การละเมิดกติกา (DB ล่ม/พังชั่วคราว) จะ throw ออกไปให้เครื่อง retry ทั้ง batch
   * ซึ่งปลอดภัยเพราะ idempotency — ห้ามตอบ rejected เพราะเครื่องจะทิ้งงานถาวร
   */
  async submit(
    sessionId: string,
    lines: unknown,
    actor: CountActor,
    deviceId: string,
    heartbeat?: unknown,
  ): Promise<SubmissionResult[]> {
    const empId = CountService.actorId(actor);
    const id = z.string().trim().min(1).max(64).safeParse(sessionId);
    const device = z.string().trim().min(1).max(128).safeParse(deviceId);
    if (!id.success || !device.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'sessionId หรือ deviceId ไม่ถูกต้อง' });
    }
    if (!Array.isArray(lines)) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ต้องส่งรายการผลนับเป็น array' });
    }
    if (lines.length === 0) return [];
    if (lines.length > MAX_BATCH_LINES) {
      throw new BadRequestException({
        code: 'BATCH_TOO_LARGE',
        message: `ส่งได้ไม่เกิน ${MAX_BATCH_LINES} บรรทัดต่อครั้ง`,
      });
    }

    const beat = DeviceHeartbeatSchema.safeParse(heartbeat ?? {});
    // heartbeat เพี้ยนห้ามทำให้ผลนับตกน้ำ — ข้ามไปเก็บแค่ last_seen_at
    await this.touchDevice(device.data, empId, beat.success ? beat.data : {});

    // 2.1 แยกบรรทัดที่ผ่าน schema กับที่ไม่ผ่าน (คงลำดับเดิมไว้ตอบกลับ)
    const results = new Array<SubmissionResult | undefined>(lines.length);
    const valid: Array<{ index: number; line: SubmitLine }> = [];
    lines.forEach((raw, index) => {
      const parsed = SubmitLineSchema.safeParse(raw);
      if (parsed.success) {
        valid.push({ index, line: parsed.data });
        return;
      }
      const qtyIssue = parsed.error.issues.some((issue) => issue.path[0] === 'countedQty');
      results[index] = {
        idempotencyKey: CountService.rawKey(raw),
        status: 'rejected',
        code: qtyIssue ? SubmissionCode.INVALID_QTY : SubmissionCode.INVALID_LINE,
      };
    });

    const reject = (code: SubmissionCode): SubmissionResult[] => {
      for (const { index, line } of valid) {
        results[index] = { idempotencyKey: line.idempotencyKey, status: 'rejected', code };
      }
      return CountService.compact(results);
    };

    // 2.2 ตรวจสิทธิ์ที่ ingest time — คนที่ถูกลดเป็น viewer ระหว่างออฟไลน์ต้องถูกปฏิเสธ
    const roleRow = await this.db.one<{ role: Role }>(`SELECT role FROM users WHERE emp_id = $1`, [
      empId,
    ]);
    if (!roleRow || !canWrite(roleRow.role)) {
      await this.audit(empId, 'count.submissions_rejected', {
        sessionId: id.data,
        deviceId: device.data,
        code: SubmissionCode.ROLE_CHANGED,
        lines: valid.length,
      });
      return reject(SubmissionCode.ROLE_CHANGED);
    }

    // 2.3 รอบนับต้องมีอยู่และยังเปิด
    const session = await this.db.one<{ status: CountSessionStatus }>(
      `SELECT status FROM count_sessions WHERE id = $1`,
      [id.data],
    );
    if (!session) return reject(SubmissionCode.SESSION_NOT_FOUND);
    if (session.status !== 'open') {
      await this.audit(empId, 'count.submissions_rejected', {
        sessionId: id.data,
        deviceId: device.data,
        code: SubmissionCode.SESSION_CLOSED,
        lines: valid.length,
      });
      return reject(SubmissionCode.SESSION_CLOSED);
    }

    // 2.4 sku มีในคลัง? อยู่ใน snapshot ของรอบนี้? (รอบเดียว ไม่ยิงต่อบรรทัด)
    const skus = [...new Set(valid.map((entry) => entry.line.sku))];
    const known = new Map<string, boolean>();
    if (skus.length > 0) {
      const rows = await this.db.query<SkuCheckRow>(
        `SELECT i.sku, (sn.sku IS NOT NULL) AS in_snapshot
           FROM items_cache i
           LEFT JOIN count_snapshot sn ON sn.sku = i.sku AND sn.session_id = $2
          WHERE i.sku = ANY($1::text[])`,
        [skus, id.data],
      );
      for (const row of rows.rows) known.set(row.sku, row.in_snapshot);
    }

    // 2.5 เขียนทีละบรรทัด
    for (const { index, line } of valid) {
      const inSnapshot = known.get(line.sku);
      if (inSnapshot === undefined) {
        results[index] = {
          idempotencyKey: line.idempotencyKey,
          status: 'rejected',
          code: SubmissionCode.SKU_NOT_FOUND,
        };
        continue;
      }
      results[index] = await this.insertSubmission(
        id.data,
        line,
        empId,
        device.data,
        inSnapshot,
      );
    }

    return CountService.compact(results);
  }

  // ── 3. ส่วนต่าง ───────────────────────────────────────────────────────

  /** รอบเปิด → v_variance (สด) · รอบปิด → closed_variance (แช่แข็งแล้ว) */
  async variance(sessionId: string): Promise<VarianceRow[]> {
    const id = CountService.requireId(sessionId);
    const session = await this.db.one<{ status: CountSessionStatus }>(
      `SELECT status FROM count_sessions WHERE id = $1`,
      [id],
    );
    if (!session) {
      throw new NotFoundException({
        code: SubmissionCode.SESSION_NOT_FOUND,
        message: 'ไม่พบรอบตรวจนับนี้',
      });
    }

    const rows =
      session.status === 'open'
        ? await this.db.query<VarianceViewRow>(
            // ⚠️ คำตัดสิน conflict ของ admin ถูกเขียนลง closed_variance ทันทีที่ตัดสิน
            //    (ไม่ต้องรอปิดรอบ) → รายงานสดต้องใช้ค่าที่ถูกตัดสินแล้ว ไม่ใช่ submission
            //    ที่มาถึงล่าสุด มิฉะนั้น admin ตัดสินเลือก 98 แต่จอ/CSV ยังโชว์ 95
            `SELECT v.sku, i.name,
                    v.frozen_on_hand,
                    COALESCE(c.final_counted_qty, v.counted_qty) AS counted_qty,
                    COALESCE(c.diff, v.diff) AS diff,
                    v.status,
                    COALESCE(v.unit, i.unit) AS unit, v.zone, v.warehouse_code,
                    COALESCE(c.counted_by, v.counted_by) AS counted_by,
                    v.counted_device_id, v.device_count,
                    v.submission_count, v.superseded_count, v.is_conflict,
                    v.counted_at, v.received_at, v.latest_submission,
                    c.chosen_submission, c.resolved_by
               FROM v_variance v
               LEFT JOIN items_cache i     ON i.sku = v.sku
               LEFT JOIN closed_variance c ON c.session_id = v.session_id AND c.sku = v.sku
              WHERE v.session_id = $1
              ORDER BY ${varianceOrder('v')}, v.sku`,
            [id],
          )
        : await this.db.query<VarianceViewRow>(
            `SELECT c.sku, i.name,
                    c.frozen_on_hand, c.final_counted_qty AS counted_qty, c.diff, c.status,
                    COALESCE(c.unit, sn.unit, i.unit) AS unit,
                    sn.zone, COALESCE(sn.warehouse_code, s.warehouse_code) AS warehouse_code,
                    c.counted_by, NULL::text AS counted_device_id, c.device_count,
                    NULL::int AS submission_count, NULL::int AS superseded_count,
                    (c.device_count > 1) AS is_conflict,
                    NULL::timestamptz AS counted_at, NULL::timestamptz AS received_at,
                    NULL::uuid AS latest_submission,
                    c.chosen_submission, c.resolved_by
               FROM closed_variance c
               JOIN count_sessions s       ON s.id = c.session_id
               LEFT JOIN items_cache i     ON i.sku = c.sku
               LEFT JOIN count_snapshot sn ON sn.session_id = c.session_id AND sn.sku = c.sku
              WHERE c.session_id = $1
              ORDER BY ${varianceOrder('c')}, c.sku`,
            [id],
          );

    const source = session.status === 'open' ? 'live' : 'closed';
    return rows.rows.map((row) => CountService.toVarianceRow(row, source));
  }

  /**
   * CSV อ้างอิงภายใน (⚠️ **ไม่ใช่ไฟล์สำหรับคีย์กลับเข้า ERP**)
   * BOM UTF-8 + CRLF เพื่อให้ Excel ไทยอ่านไม่เป็นขยะ
   */
  async varianceCsv(sessionId: string): Promise<string> {
    const rows = await this.variance(sessionId);
    const header = [
      'รหัสสินค้า',
      'ชื่อสินค้า',
      'คลัง',
      'โซน',
      'ยอดระบบ',
      'นับได้',
      'ส่วนต่าง',
      'สถานะ',
      'ผู้นับ',
      'หน่วย',
    ];
    const lines = [header.map(CountService.csvCell).join(',')];
    for (const row of rows) {
      lines.push(
        [
          CountService.csvCell(row.sku),
          CountService.csvCell(row.name ?? ''),
          CountService.csvCell(row.warehouseCode ?? ''),
          CountService.csvCell(row.zone ?? ''),
          // ⚠️ null (ยังไม่นับ / นอกรายการ) = เซลล์ว่าง ห้ามใส่ 0
          CountService.formatQty(row.frozenOnHand),
          CountService.formatQty(row.countedQty),
          CountService.formatQty(row.diff),
          CountService.csvCell(VARIANCE_STATUS_TH[row.status]),
          CountService.csvCell(row.countedBy ?? ''),
          CountService.csvCell(row.unit ?? ''),
        ].join(','),
      );
    }
    // \uFEFF = BOM UTF-8 (เขียนเป็น escape ไม่ใช่อักขระจริง เพื่อไม่ให้หายตอนแก้ไฟล์)
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  // ── 4. เปิดรอบ (admin) ────────────────────────────────────────────────

  /**
   * เปิดรอบใหม่ + **freeze `count_snapshot`** จาก `items_cache.on_hand` ณ ตอนนี้
   * - cache เก่ากว่า 6 ชม. → `opened_on_stale_cache = true`
   *   (ส่ง `allowStaleCache: false` มาด้วย = ให้ปฏิเสธไปเลยจนกว่า admin จะยืนยัน)
   * - มีรอบ open อยู่แล้วในคลังนั้น → ปฏิเสธ (`SESSION_ALREADY_OPEN`)
   */
  async openSession(input: unknown, actor: CountActor): Promise<CountSessionDto> {
    const empId = CountService.actorId(actor);
    const parsed = OpenSessionSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'ข้อมูลเปิดรอบไม่ถูกต้อง',
      });
    }
    const { zone, skus, allowStaleCache } = parsed.data;
    const warehouseCode = parsed.data.warehouseCode ?? this.defaultWarehouseCode;
    const requested = skus ? [...new Set(skus)] : undefined;

    // ⚠️ `items_cache` **ไม่มีคอลัมน์โซน** (ERP เก็บโซนที่ระดับเอกสาร ไม่ใช่ที่ตัวสินค้า)
    //    ระบบจึงไม่มีทางรู้ว่า SKU ไหนอยู่โซนไหน
    //    เดิมถ้าระบุ zone แต่ไม่ระบุ skus จะ freeze **ทั้งคลัง** แล้วแปะป้ายโซนนั้นลงทุกแถว
    //    → ของนอกโซนกลายเป็น "ยังไม่ได้นับ" ทั้งหมด และโซนที่แอปเห็นเป็นข้อมูลที่แต่งขึ้น
    //    ปฏิเสธไปเลยดีกว่าปล่อยให้ได้รายงานที่ดูสมเหตุสมผลแต่ผิด
    if (zone !== undefined && requested === undefined) {
      throw new BadRequestException({
        code: 'ZONE_REQUIRES_SKUS',
        message:
          `เปิดรอบเฉพาะโซน "${zone}" ต้องระบุรายการสินค้า (skus) มาด้วย — ` +
          'ระบบไม่มีข้อมูลว่าสินค้าใดอยู่โซนใด (ERP เก็บโซนที่ระดับเอกสารเท่านั้น) ' +
          'ถ้าต้องการนับทั้งคลังให้เปิดรอบโดยไม่ระบุโซน',
      });
    }

    const sessionId = await this.db.transaction(async (client) => {
      // กัน admin 2 คนเปิดรอบพร้อมกันในคลังเดียว (ล็อกหลุดเองตอน commit/rollback)
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('count_open:' || $1)::bigint)`, [
        warehouseCode,
      ]);

      const open = await client.query<{ id: string }>(
        `SELECT id FROM count_sessions WHERE warehouse_code = $1 AND status = 'open' LIMIT 1`,
        [warehouseCode],
      );
      if (open.rows[0]) {
        throw new ConflictException({
          code: 'SESSION_ALREADY_OPEN',
          message: 'คลังนี้มีรอบตรวจนับที่เปิดอยู่แล้ว',
          sessionId: open.rows[0].id,
        });
      }

      // อายุข้อมูล = เวลาที่ดึง ERP สำเร็จล่าสุด (ห้ามใช้ max ของ erp_updated_at)
      const asOfRow = await client.query<{ stock_as_of: Date | string }>(
        `SELECT stock_as_of
           FROM sync_runs
          WHERE status = 'success' AND stock_as_of IS NOT NULL
            AND (warehouse_code IS NULL OR warehouse_code = $1)
          ORDER BY stock_as_of DESC
          LIMIT 1`,
        [warehouseCode],
      );
      const erpDataAsOf = asOfRow.rows[0] ? new Date(asOfRow.rows[0].stock_as_of) : null;
      const ageMs = erpDataAsOf === null ? null : Date.now() - erpDataAsOf.getTime();
      const stale = ageMs === null || ageMs > CountService.STALE_CACHE_MS;
      // admin ต้องเห็นอายุ cache แล้วยืนยันเอง (erp-integration.md §5) — ไม่ยืนยัน = ไม่เปิด
      if (stale && allowStaleCache === false) {
        throw new ConflictException({
          code: 'STALE_CACHE',
          message:
            ageMs === null
              ? 'ยังไม่เคย sync ยอดสต็อกจาก ERP สำเร็จ — ยืนยัน allowStaleCache เพื่อเปิดรอบบนข้อมูลเก่า'
              : `ยอดสต็อกอายุ ${Math.floor(ageMs / 3_600_000)} ชม. — ยืนยัน allowStaleCache เพื่อเปิดรอบบนข้อมูลเก่า`,
          erpDataAsOf: erpDataAsOf?.toISOString() ?? null,
        });
      }

      const id = parsed.data.id ?? CountService.newSessionId();
      try {
        await client.query(
          `INSERT INTO count_sessions
             (id, erp_transaction_no, zone, warehouse_code, status,
              erp_data_as_of, opened_on_stale_cache)
           VALUES ($1, $2, $3, $4, 'open', $5::timestamptz, $6)`,
          [id, null, zone ?? null, warehouseCode, erpDataAsOf, stale],
        );
      } catch (err) {
        if (CountService.pgCode(err) === '23505') {
          throw new ConflictException({
            code: 'SESSION_ALREADY_OPEN',
            message: 'มีรอบตรวจนับของคลัง/เอกสารนี้อยู่แล้ว',
          });
        }
        throw err;
      }

      if (requested) await CountService.assertSkusCountable(client, requested, warehouseCode);

      // frozen_on_hand เป็น NOT NULL → SKU ที่ยังไม่มียอดระบบถูกข้าม (ห้ามเดาเป็น 0)
      const frozen = await client.query<{ n: number }>(
        `WITH frozen AS (
           INSERT INTO count_snapshot (session_id, sku, frozen_on_hand, unit, warehouse_code, zone)
           SELECT $1, i.sku, i.on_hand, i.unit, i.warehouse_code, $2
             FROM items_cache i
            WHERE i.warehouse_code = $3
              AND i.deleted_at IS NULL
              AND i.on_hand IS NOT NULL
              AND ($4::text[] IS NULL OR i.sku = ANY($4::text[]))
           ON CONFLICT (session_id, sku) DO NOTHING
           RETURNING sku
         )
         SELECT count(*)::int AS n FROM frozen`,
        [id, zone ?? null, warehouseCode, requested ?? null],
      );
      const frozenCount = frozen.rows[0]?.n ?? 0;
      if (frozenCount === 0) {
        throw new BadRequestException({
          code: 'EMPTY_SNAPSHOT',
          message: 'ไม่มีรายการที่มียอดระบบให้ freeze — sync ยอดสต็อกจาก ERP ก่อนเปิดรอบ',
        });
      }
      const skipped = requested ? requested.length - frozenCount : 0;
      if (skipped > 0) {
        this.logger.warn(
          `เปิดรอบ ${id}: ข้าม ${skipped} SKU ที่ยังไม่มียอดระบบ (on_hand เป็น NULL)`,
        );
      }

      await this.audit(
        empId,
        'count.session_opened',
        {
          sessionId: id,
          warehouseCode,
          zone: zone ?? null,
          itemCount: frozenCount,
          skippedNoOnHand: skipped,
          erpDataAsOf: erpDataAsOf?.toISOString() ?? null,
          openedOnStaleCache: stale,
        },
        client,
      );

      this.logger.log(
        `เปิดรอบ ${id} (${warehouseCode}${zone ? `/${zone}` : ''}) ${frozenCount} รายการ` +
          `${stale ? ' ⚠️ บน cache เก่า' : ''} โดย ${empId}`,
      );
      return id;
    });

    const dto = await this.session(sessionId);
    if (!dto) {
      throw new NotFoundException({
        code: SubmissionCode.SESSION_NOT_FOUND,
        message: 'เปิดรอบแล้วแต่อ่านรอบกลับมาไม่ได้',
      });
    }
    return dto;
  }

  /** อ่านรอบตาม id (ใช้ซ้ำจาก controller หน้ารายละเอียดรอบ) */
  async session(sessionId: string): Promise<CountSessionDto | null> {
    const id = CountService.requireId(sessionId);
    const row = await this.db.one<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM count_sessions WHERE id = $1`,
      [id],
    );
    return row ? this.buildSessionDto(row) : null;
  }

  // ── 5. ปิดรอบ (admin) ─────────────────────────────────────────────────

  /**
   * ปิดรอบ = **materialize `v_variance` → `closed_variance`** ใน transaction เดียว
   * → เลขไม่เปลี่ยนย้อนหลังแม้มี submission มาช้า (บรรทัดที่มาทีหลังจะถูก reject)
   *
   * ⚠️ ยังมี conflict ที่ admin ไม่ได้ตัดสิน → throw `UNRESOLVED_CONFLICTS` (ห้าม auto-resolve;
   *    CHECK ของตารางก็บังคับว่า status='conflict' ต้องมี resolved_by)
   */
  async closeSession(sessionId: string, actor: CountActor): Promise<CloseSessionResult> {
    const empId = CountService.actorId(actor);
    const id = CountService.requireId(sessionId);

    return this.db.transaction(async (client) => {
      const locked = await client.query<{ status: CountSessionStatus }>(
        `SELECT status FROM count_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = locked.rows[0];
      if (!session) {
        throw new NotFoundException({
          code: SubmissionCode.SESSION_NOT_FOUND,
          message: 'ไม่พบรอบตรวจนับนี้',
        });
      }
      if (session.status === 'closed') {
        throw new ConflictException({
          code: 'SESSION_ALREADY_CLOSED',
          message: 'รอบนี้ถูกปิดแล้ว',
        });
      }

      const unresolved = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM v_variance v
           LEFT JOIN closed_variance c ON c.session_id = v.session_id AND c.sku = v.sku
          WHERE v.session_id = $1 AND v.is_conflict AND c.resolved_by IS NULL`,
        [id],
      );
      const pending = unresolved.rows[0]?.n ?? 0;
      if (pending > 0) {
        throw new ConflictException({
          code: 'UNRESOLVED_CONFLICTS',
          message: `ยังมี ${pending} รายการที่หลายเครื่องนับไม่ตรงกัน — ต้องตัดสินก่อนปิดรอบ`,
          conflicts: pending,
        });
      }

      // ปิดก่อน materialize เพื่อให้ submission ที่ยิงเข้ามาหลังจากนี้ถูก reject ทันที
      await client.query(
        `UPDATE count_sessions
            SET status = 'closed', closed_at = now(), closed_by = $2
          WHERE id = $1`,
        [id, empId],
      );

      // แถว conflict ถูกตัดออก: admin เขียนไว้แล้วผ่าน resolveConflict (ON CONFLICT DO NOTHING กันทับ)
      await client.query(
        `INSERT INTO closed_variance
           (session_id, sku, frozen_on_hand, final_counted_qty, status, unit,
            counted_by, device_count, chosen_submission, materialized_at)
         SELECT v.session_id, v.sku, v.frozen_on_hand, v.counted_qty, v.status,
                COALESCE(v.unit, i.unit), v.counted_by, v.device_count, v.latest_submission, now()
           FROM v_variance v
           LEFT JOIN items_cache i ON i.sku = v.sku
          WHERE v.session_id = $1 AND v.status <> 'conflict'
         ON CONFLICT (session_id, sku) DO NOTHING`,
        [id],
      );

      const tally = await client.query<{ materialized: number; conflicts: number }>(
        `SELECT count(*)::int AS materialized,
                (count(*) FILTER (WHERE resolved_by IS NOT NULL))::int AS conflicts
           FROM closed_variance
          WHERE session_id = $1`,
        [id],
      );
      const result: CloseSessionResult = {
        materialized: tally.rows[0]?.materialized ?? 0,
        conflicts: tally.rows[0]?.conflicts ?? 0,
      };

      await this.audit(empId, 'count.session_closed', { sessionId: id, ...result }, client);
      this.logger.log(
        `ปิดรอบ ${id}: materialize ${result.materialized} รายการ (conflict ที่ตัดสินแล้ว ${result.conflicts}) โดย ${empId}`,
      );
      return result;
    });
  }

  // ── 6. ตัดสิน conflict (admin) ────────────────────────────────────────

  /**
   * admin เลือกว่าจะเชื่อ submission ไหน เมื่อ 2 เครื่องนับ SKU เดียวกัน
   * เขียนแถวนั้นลง `closed_variance` พร้อม `resolved_by` + `chosen_submission` ล่วงหน้า
   * (ปิดรอบแล้ว `ON CONFLICT DO NOTHING` จะไม่ทับคำตัดสินนี้)
   *
   * ⚠️ SKU นอกรายการที่ conflict ต้องเก็บเป็น status `off_list` — CHECK ของตารางบังคับว่า
   *    status='conflict' ต้องมี frozen_on_hand (ไม่ใช่ NULL) จึงเก็บเป็น conflict ไม่ได้
   */
  async resolveConflict(
    sessionId: string,
    sku: string,
    chosenSubmissionKey: string,
    actor: CountActor,
  ): Promise<void> {
    const empId = CountService.actorId(actor);
    const id = CountService.requireId(sessionId);
    const targetSku = SkuSchema.safeParse(sku);
    const chosen = z.string().trim().uuid().safeParse(chosenSubmissionKey);
    if (!targetSku.success || !chosen.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'sku หรือ submission ที่เลือกไม่ถูกต้อง' });
    }

    await this.db.transaction(async (client) => {
      const locked = await client.query<{ status: CountSessionStatus }>(
        `SELECT status FROM count_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = locked.rows[0];
      if (!session) {
        throw new NotFoundException({
          code: SubmissionCode.SESSION_NOT_FOUND,
          message: 'ไม่พบรอบตรวจนับนี้',
        });
      }
      // ปิดรอบแล้ว = ตัวเลขถูกแช่แข็ง ห้ามแก้ย้อนหลัง
      if (session.status === 'closed') {
        throw new ConflictException({
          code: SubmissionCode.SESSION_CLOSED,
          message: 'รอบนี้ปิดแล้ว แก้ผลการตัดสินย้อนหลังไม่ได้',
        });
      }

      const owned = await client.query<{ idempotency_key: string }>(
        `SELECT idempotency_key
           FROM count_submissions
          WHERE idempotency_key = $1::uuid AND session_id = $2 AND sku = $3`,
        [chosen.data, id, targetSku.data],
      );
      if (!owned.rows[0]) {
        throw new NotFoundException({
          code: 'SUBMISSION_NOT_FOUND',
          message: 'ไม่พบผลนับที่เลือกในรอบ/SKU นี้',
        });
      }

      const updated = await client.query<{ sku: string; status: VarianceStatus }>(
        `INSERT INTO closed_variance
           (session_id, sku, frozen_on_hand, final_counted_qty, status, unit,
            counted_by, device_count, chosen_submission, resolved_by, materialized_at)
         SELECT v.session_id, v.sku, v.frozen_on_hand, s.counted_qty,
                CASE WHEN v.frozen_on_hand IS NULL
                     THEN 'off_list'::variance_status
                     ELSE 'conflict'::variance_status END,
                COALESCE(v.unit, i.unit), s.emp_id, v.device_count, s.idempotency_key, $4, now()
           FROM v_variance v
           JOIN count_submissions s
                ON s.idempotency_key = $3::uuid
               AND s.session_id = v.session_id
               AND s.sku = v.sku
           LEFT JOIN items_cache i ON i.sku = v.sku
          WHERE v.session_id = $1 AND v.sku = $2 AND v.is_conflict
         ON CONFLICT (session_id, sku) DO UPDATE SET
            frozen_on_hand    = EXCLUDED.frozen_on_hand,
            final_counted_qty = EXCLUDED.final_counted_qty,
            status            = EXCLUDED.status,
            unit              = EXCLUDED.unit,
            counted_by        = EXCLUDED.counted_by,
            device_count      = EXCLUDED.device_count,
            chosen_submission = EXCLUDED.chosen_submission,
            resolved_by       = EXCLUDED.resolved_by,
            materialized_at   = now()
         RETURNING sku, status`,
        [id, targetSku.data, chosen.data, empId],
      );
      if (!updated.rows[0]) {
        throw new BadRequestException({
          code: 'NOT_A_CONFLICT',
          message: 'รายการนี้ไม่ได้ถูกนับจากหลายเครื่อง จึงไม่ต้องตัดสิน',
        });
      }

      await this.audit(
        empId,
        'count.conflict_resolved',
        {
          sessionId: id,
          sku: targetSku.data,
          chosenSubmission: chosen.data,
          status: updated.rows[0].status,
        },
        client,
      );
      this.logger.log(
        `ตัดสิน conflict ${id}/${targetSku.data} → submission ${chosen.data} โดย ${empId}`,
      );
    });
  }

  // ── 7. รายการ conflict ให้ admin เลือก ────────────────────────────────

  /** SKU ที่ `device_count > 1` พร้อม submission ทุกตัวของ SKU นั้น */
  async conflicts(sessionId: string): Promise<ConflictRow[]> {
    const id = CountService.requireId(sessionId);
    const exists = await this.db.one<{ id: string }>(
      `SELECT id FROM count_sessions WHERE id = $1`,
      [id],
    );
    if (!exists) {
      throw new NotFoundException({
        code: SubmissionCode.SESSION_NOT_FOUND,
        message: 'ไม่พบรอบตรวจนับนี้',
      });
    }

    const heads = await this.db.query<ConflictHeadRow>(
      `SELECT v.sku, i.name, v.frozen_on_hand, COALESCE(v.unit, i.unit) AS unit, v.zone,
              v.device_count, v.submission_count, v.device_ids, v.latest_submission,
              c.chosen_submission, c.resolved_by
         FROM v_variance v
         LEFT JOIN items_cache i     ON i.sku = v.sku
         LEFT JOIN closed_variance c ON c.session_id = v.session_id AND c.sku = v.sku
        WHERE v.session_id = $1 AND v.is_conflict
        ORDER BY v.sku`,
      [id],
    );
    if (heads.rows.length === 0) return [];

    const skus = heads.rows.map((row) => row.sku);
    const submissions = await this.db.query<ConflictSubmissionRow>(
      `SELECT idempotency_key, sku, emp_id, device_id, device_seq,
              counted_qty, counted_at, received_at
         FROM count_submissions
        WHERE session_id = $1 AND sku = ANY($2::text[])
        ORDER BY sku, device_seq DESC, received_at DESC`,
      [id, skus],
    );

    const bySku = new Map<string, ConflictSubmissionRow[]>();
    for (const row of submissions.rows) {
      const list = bySku.get(row.sku);
      if (list) list.push(row);
      else bySku.set(row.sku, [row]);
    }

    return heads.rows.map((head) => ({
      sku: head.sku,
      name: head.name,
      frozenOnHand: CountService.toNumber(head.frozen_on_hand),
      unit: head.unit,
      zone: head.zone,
      deviceCount: CountService.toNumber(head.device_count) ?? 0,
      submissionCount: CountService.toNumber(head.submission_count) ?? 0,
      deviceIds: head.device_ids ?? [],
      resolved: head.resolved_by !== null,
      chosenSubmission: head.chosen_submission,
      resolvedBy: head.resolved_by,
      submissions: (bySku.get(head.sku) ?? []).map((row) => ({
        idempotencyKey: row.idempotency_key,
        empId: row.emp_id,
        deviceId: row.device_id,
        deviceSeq: CountService.toNumber(row.device_seq) ?? 0,
        countedQty: CountService.toNumber(row.counted_qty) ?? 0,
        countedAt: CountService.toIso(row.counted_at) ?? '',
        receivedAt: CountService.toIso(row.received_at) ?? '',
        isLatest: row.idempotency_key === head.latest_submission,
      })),
    }));
  }

  // ── 8. รับซองจาก controller ────────────────────────────────────────────

  /**
   * = `submit()` แต่รับซองเดียวจาก controller: `{deviceId, queueDepth?, lines}`
   * (deviceId มาในบอดี้ไม่ใช่พารามิเตอร์แยก)
   *
   * ⚠️ เคยมี alias เปล่า ๆ อีก 4 ตัวข้างเมธอดนี้ (getActiveSession/getVariance/
   *    getVarianceCsv/getConflicts) ที่ไม่มีใครเรียก — controller ใช้ชื่อจริงหมดแล้ว
   *    ตัดออกเพื่อไม่ให้เหลือ "ทางเข้าที่สอง" ที่แก้ที่เดียวแล้วลืมอีกที่
   */
  async submitBatch(
    sessionId: string,
    input: unknown,
    actor: CountActor,
  ): Promise<SubmissionResult[]> {
    const envelope = SubmitEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: envelope.error.issues[0]?.message ?? 'ข้อมูลผลนับไม่ถูกต้อง',
      });
    }
    const { deviceId, lines, ...beat } = envelope.data;
    return this.submit(sessionId, lines, actor, deviceId, beat);
  }

  // ── 9. ภายใน ──────────────────────────────────────────────────────────

  /** เขียน 1 บรรทัดแบบ idempotent — duplicate ที่ payload ต่าง = anomaly (ห้ามทับ) */
  private async insertSubmission(
    sessionId: string,
    line: SubmitLine,
    empId: string,
    deviceId: string,
    inSnapshot: boolean,
  ): Promise<SubmissionResult> {
    const hash = CountService.payloadHash(sessionId, line);
    try {
      // ⚠️ กัน TOCTOU กับการปิดรอบ: การตรวจ `status = 'open'` ก่อนหน้านี้ (ข้อ 2.3) อยู่
      //    คนละ statement กับ INSERT นี้ ระหว่างกลาง admin ปิดรอบได้ ผลคือบรรทัดถูก
      //    เขียนลงหลัง closed_variance ถูก materialize แล้ว → เครื่องได้ 'accepted'
      //    แล้วลบออกจากคิว แต่ตัวเลขไม่โผล่ในรายงานที่แช่แข็งไว้ = **ผลนับหายถาวร**
      //
      //    แก้ด้วยการย้ายเงื่อนไขเข้ามาใน INSERT เอง พร้อม `FOR SHARE` เพื่อ:
      //      - ถ้าปิดรอบไปแล้ว → EXISTS เป็นเท็จ ไม่มีแถวถูกเขียน
      //      - ถ้าปิดรอบ *กำลัง* ทำอยู่ (ถือ FOR UPDATE) → INSERT นี้จะรอจนกว่าจะ commit
      //        แล้วค่อยประเมินใหม่ เห็น 'closed' → ไม่เขียน (ไม่มีช่องว่างให้แทรก)
      const inserted = await this.db.query<{ idempotency_key: string }>(
        `INSERT INTO count_submissions
           (idempotency_key, session_id, sku, counted_qty, emp_id, device_id,
            device_seq, counted_at, payload_hash)
         SELECT $1::uuid, $2, $3, $4::numeric, $5, $6, $7::bigint, $8::timestamptz, $9
          WHERE EXISTS (
            SELECT 1 FROM count_sessions WHERE id = $2 AND status = 'open' FOR SHARE
          )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [
          line.idempotencyKey,
          sessionId,
          line.sku,
          line.countedQty.toFixed(3),
          empId,
          deviceId,
          line.deviceSeq,
          line.countedAt,
          hash,
        ],
      );
      if (inserted.rows.length > 0) {
        return {
          idempotencyKey: line.idempotencyKey,
          status: 'accepted',
          // นับเจอของนอกรายการ = ยอมรับ แต่บอกแอปให้ติดป้าย (v_variance จะ mark off_list)
          ...(inSnapshot ? {} : { code: SubmissionCode.OFF_LIST }),
        };
      }

      const existing = await this.db.one<{ payload_hash: string }>(
        `SELECT payload_hash FROM count_submissions WHERE idempotency_key = $1::uuid`,
        [line.idempotencyKey],
      );

      // ไม่ได้เขียน และไม่มีแถวเดิมอยู่ → แปลว่า EXISTS เป็นเท็จ = รอบถูกปิดไปแล้ว
      // (ไม่ใช่ duplicate) ต้องตอบ SESSION_CLOSED ให้เครื่องเก็บงานไว้ในจอค้างตรวจ
      // ห้ามตอบ 'duplicate' เด็ดขาด เพราะเครื่องจะลบออกจากคิวแล้วผลนับหายจริง
      if (!existing) {
        await this.audit(empId, 'count.submissions_rejected', {
          sessionId,
          deviceId,
          sku: line.sku,
          code: SubmissionCode.SESSION_CLOSED,
          reason: 'รอบถูกปิดระหว่างกำลังเขียนผลนับ',
        });
        return {
          idempotencyKey: line.idempotencyKey,
          status: 'rejected',
          code: SubmissionCode.SESSION_CLOSED,
        };
      }

      if (existing.payload_hash !== hash) {
        // ตารางเป็น append-only → ห้ามเขียนทับ แค่บันทึกความผิดปกติไว้ให้ผู้ดูแลตรวจ
        await this.audit(empId, 'count.submission_payload_mismatch', {
          code: SubmissionCode.PAYLOAD_MISMATCH,
          sessionId,
          sku: line.sku,
          deviceId,
          idempotencyKey: line.idempotencyKey,
          storedHash: existing.payload_hash,
          incomingHash: hash,
        });
        this.logger.warn(
          `payload ไม่ตรงกับที่เก็บไว้: ${line.idempotencyKey} (รอบ ${sessionId} · ${line.sku})`,
        );
      }
      return { idempotencyKey: line.idempotencyKey, status: 'duplicate' };
    } catch (err) {
      const code = CountService.pgCode(err);
      const constraint = CountService.pgConstraint(err);
      // ละเมิดกติกาแบบ deterministic → reject บรรทัดเดียว
      if (code === '23503' && constraint?.includes('sku')) {
        return {
          idempotencyKey: line.idempotencyKey,
          status: 'rejected',
          code: SubmissionCode.SKU_NOT_FOUND,
        };
      }
      if (code === '23514') {
        return {
          idempotencyKey: line.idempotencyKey,
          status: 'rejected',
          code: constraint?.includes('qty')
            ? SubmissionCode.INVALID_QTY
            : SubmissionCode.INVALID_LINE,
        };
      }
      // ที่เหลือ (DB ล่ม/timeout) = ปัญหาชั่วคราว → ให้เครื่อง retry ทั้ง batch (idempotent อยู่แล้ว)
      throw err;
    }
  }

  private async touchDevice(
    deviceId: string,
    empId: string,
    beat: z.output<typeof DeviceHeartbeatSchema>,
  ): Promise<void> {
    const age =
      beat.oldestPendingAgeSeconds === undefined
        ? null
        : `${Math.round(beat.oldestPendingAgeSeconds)} seconds`;
    await this.db.query(
      `INSERT INTO devices
         (device_id, last_seen_at, last_emp_id, queue_depth, oldest_pending_age, model, app_version)
       VALUES ($1, now(), $2, COALESCE($3::int, 0), $4::interval, $5, $6)
       ON CONFLICT (device_id) DO UPDATE SET
         last_seen_at       = now(),
         last_emp_id        = $2,
         queue_depth        = COALESCE($3::int, devices.queue_depth),
         oldest_pending_age = COALESCE($4::interval, devices.oldest_pending_age),
         model              = COALESCE($5, devices.model),
         app_version        = COALESCE($6, devices.app_version)`,
      [
        deviceId,
        empId,
        beat.queueDepth ?? null,
        age,
        beat.model ?? null,
        beat.appVersion ?? null,
      ],
    );
  }

  private async buildSessionDto(row: SessionRow): Promise<CountSessionDto> {
    const items = await this.db.query<SnapshotItemRow>(
      `SELECT sn.sku, i.name, i.name_en, i.loc,
              COALESCE(sn.unit, i.unit) AS unit,
              sn.frozen_on_hand, sn.zone
         FROM count_snapshot sn
         LEFT JOIN items_cache i ON i.sku = sn.sku
        WHERE sn.session_id = $1
        ORDER BY sn.zone NULLS FIRST, i.loc NULLS LAST, sn.sku`,
      [row.id],
    );
    const mapped: CountSessionItemDto[] = items.rows.map((item) => ({
      sku: item.sku,
      name: item.name,
      nameEn: item.name_en,
      loc: item.loc,
      unit: item.unit,
      frozenOnHand: CountService.toNumber(item.frozen_on_hand) ?? 0,
      zone: item.zone,
    }));
    return {
      id: row.id,
      erpTransactionNo: row.erp_transaction_no,
      erpVoucherNo: row.erp_voucher_no,
      zone: row.zone,
      warehouseCode: row.warehouse_code,
      status: row.status,
      openedAt: CountService.toIso(row.opened_at) ?? '',
      closedAt: CountService.toIso(row.closed_at),
      closedBy: row.closed_by,
      erpDataAsOf: CountService.toIso(row.erp_data_as_of),
      erpCountDate: row.erp_count_date,
      openedOnStaleCache: row.opened_on_stale_cache,
      itemCount: mapped.length,
      items: mapped,
    };
  }

  private async audit(
    actor: string,
    action: string,
    payload: Record<string, unknown>,
    client?: PoolClient,
  ): Promise<void> {
    const params = [actor, action, JSON.stringify(payload)];
    if (client) await client.query(AUDIT_SQL, params);
    else await this.db.query(AUDIT_SQL, params);
  }

  /** SKU ที่เปิดรอบด้วยต้องมีจริง อยู่คลังนั้น และไม่ถูก tombstone — ผิดตัวเดียวก็หยุด (งาน admin) */
  private static async assertSkusCountable(
    client: PoolClient,
    skus: readonly string[],
    warehouseCode: string,
  ): Promise<void> {
    const rows = await client.query<SkuDiagnosticRow>(
      `SELECT sku,
              (on_hand IS NULL)                AS no_on_hand,
              (deleted_at IS NOT NULL)         AS is_deleted,
              (warehouse_code <> $2)           AS wrong_warehouse
         FROM items_cache
        WHERE sku = ANY($1::text[])`,
      [skus, warehouseCode],
    );
    const found = new Map(rows.rows.map((row) => [row.sku, row]));
    const unknown = skus.filter((sku) => !found.has(sku));
    const wrongWarehouse = rows.rows.filter((row) => row.wrong_warehouse).map((row) => row.sku);
    const deleted = rows.rows.filter((row) => row.is_deleted).map((row) => row.sku);
    if (unknown.length > 0 || wrongWarehouse.length > 0 || deleted.length > 0) {
      throw new BadRequestException({
        code: SubmissionCode.SKU_NOT_FOUND,
        message: 'มี SKU ที่ไม่อยู่ในคลังนี้ (ไม่พบ / คลังไม่ตรง / ถูกลบจาก ERP แล้ว)',
        unknown,
        wrongWarehouse,
        deleted,
      });
    }
  }

  private static toVarianceRow(row: VarianceViewRow, source: 'live' | 'closed'): VarianceRow {
    return {
      sku: row.sku,
      name: row.name,
      frozenOnHand: CountService.toNumber(row.frozen_on_hand),
      countedQty: CountService.toNumber(row.counted_qty),
      // ⚠️ คง null ไว้ (not_counted / off_list) — ห้าม coalesce เป็น 0
      diff: CountService.toNumber(row.diff),
      status: row.status,
      unit: row.unit,
      zone: row.zone,
      warehouseCode: row.warehouse_code,
      countedBy: row.counted_by,
      countedDeviceId: row.counted_device_id,
      deviceCount: CountService.toNumber(row.device_count) ?? 0,
      submissionCount: CountService.toNumber(row.submission_count),
      supersededCount: CountService.toNumber(row.superseded_count),
      isConflict: row.is_conflict === true,
      countedAt: CountService.toIso(row.counted_at),
      receivedAt: CountService.toIso(row.received_at),
      latestSubmission: row.latest_submission,
      chosenSubmission: row.chosen_submission,
      resolvedBy: row.resolved_by,
      source,
    };
  }

  /**
   * sha256 ของ (sessionId|sku|countedQty|countedAt|deviceSeq)
   * normalize ก่อน hash (qty 3 ตำแหน่ง, เวลาเป็น ISO UTC) ไม่งั้น 5 กับ 5.000
   * จากเครื่องเดียวกันจะกลายเป็น PAYLOAD_MISMATCH ปลอม
   */
  private static payloadHash(sessionId: string, line: SubmitLine): string {
    const canonical = [
      sessionId,
      line.sku,
      line.countedQty.toFixed(3),
      line.countedAt.toISOString(),
      String(line.deviceSeq),
    ].join('|');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  private static newSessionId(): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    return `CS-${stamp}-${randomUUID().slice(0, 4)}`;
  }

  /** รับได้ทั้ง `AuthenticatedUser` และ empId ที่เป็นสตริง */
  private static actorId(actor: CountActor): string {
    const empId = (typeof actor === 'string' ? actor : actor.empId).trim();
    if (empId.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ไม่พบรหัสพนักงานผู้ดำเนินการ' });
    }
    return empId;
  }

  private static requireId(sessionId: string): string {
    const parsed = z.string().trim().min(1).max(64).safeParse(sessionId);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'sessionId ไม่ถูกต้อง' });
    }
    return parsed.data;
  }

  /** echo key กลับให้เครื่อง ack outbox ได้ แม้บรรทัดนั้นรูปแบบผิด */
  private static rawKey(raw: unknown): string {
    if (typeof raw === 'object' && raw !== null) {
      const value = (raw as { idempotencyKey?: unknown }).idempotencyKey;
      if (typeof value === 'string') return value.trim().slice(0, 64);
    }
    return '';
  }

  private static compact(results: ReadonlyArray<SubmissionResult | undefined>): SubmissionResult[] {
    return results.map(
      (result) =>
        result ?? { idempotencyKey: '', status: 'rejected', code: SubmissionCode.INVALID_LINE },
    );
  }

  /** numeric/bigint จาก pg มาเป็น string — null ต้องคงเป็น null */
  private static toNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
  }

  private static toIso(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** ตัวเลขในรายงาน: null = ช่องว่าง (ยังไม่นับ/นอกรายการ) · ตัดศูนย์ท้ายทิ้ง */
  private static formatQty(value: number | null): string {
    if (value === null) return '';
    return value.toFixed(3).replace(/\.?0+$/, '');
  }

  /**
   * escape CSV: ชื่อสินค้าไทยมีลูกน้ำ/อัญประกาศได้
   * และกัน formula injection ของ Excel เฉพาะช่องข้อความ (ตัวเลขเราฟอร์แมตเองอยู่แล้ว)
   */
  private static csvCell(value: string): string {
    const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  }

  private static pgCode(err: unknown): string | undefined {
    return typeof err === 'object' && err !== null
      ? (err as { code?: string }).code
      : undefined;
  }

  private static pgConstraint(err: unknown): string | undefined {
    return typeof err === 'object' && err !== null
      ? (err as { constraint?: string }).constraint
      : undefined;
  }
}
