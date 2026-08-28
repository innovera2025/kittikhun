import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { AuthenticatedUser, Role } from '../auth/auth.types';
import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import { ErpWritebackService } from './erp-writeback.service';

/**
 * CountDocumentService — "นับสต็อกแบบไม่มีรอบ" 1 ใบ = 1 เอกสาร
 *
 * เอกสารหนึ่งใบคือแถวเดียวใน `count_sessions` ที่ `kind='adhoc'` และ **เกิดมาปิดแล้ว**
 * (`status='closed'`, `opened_at = closed_at = now()`) แล้วเขียนบรรทัดลง
 * `count_submissions` (append-only เดิม) + `closed_variance` (เดิม) ในทรานแซกชันเดียว
 * → เส้นทางส่งกลับ ERP (`ErpWritebackService.buildLines`) ใช้ได้ทันทีโดยไม่ต้องแก้อะไร
 * และกลไกกันเอกสารซ้ำทั้ง 3 ชั้น (PK `erp_writeback` · advisory lock · มาร์กเกอร์
 * `TCL#<id>#`) ทำงานเหมือนเดิมเป๊ะ ๆ เพราะ `documentId` **คือ** session id
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  กติกาที่ห้ามฝ่าฝืน
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. **ยอดระบบ (MainQty) อ่านจาก `items_cache.on_hand` ฝั่ง server เสมอ**
 *    ค่าที่ client ส่งมา (`systemQtyShown`) ใช้ "เทียบ" อย่างเดียว ไม่เคยถูกเขียนลงฐาน
 *    ไม่ตรงกัน = ยอดขยับระหว่างคีย์กับกดส่ง → 409 `SYSTEM_QTY_DRIFT` ให้คนยืนยันใหม่
 *    (ได้ทั้ง "เลขที่เขียนพิสูจน์ที่มาได้" และ "ไม่มีตัวเลขที่ไม่มีมนุษย์เคยเห็นเข้า ERP")
 *
 * 2. **`on_hand IS NULL` = ห้ามนับ** ห้ามแปลงเป็น 0 เด็ดขาด — 0 แปลว่า "นับแล้วได้ศูนย์"
 *    (ของหาย) ซึ่งต่างจาก "ไม่มียอดระบบให้เทียบ" คนละเรื่องกันโดยสิ้นเชิง
 *
 * 3. **แอปไม่ส่ง `diff` ขึ้นมา และเราไม่รับ** — ส่งแต่ `systemQtyShown` + `countedQty`
 *    ค่า `diff` ใน response คือ `countedQty − systemQty` (ทิศของ "จอ") ห้ามตั้งชื่อฟิลด์
 *    ว่า `difQty`/`DifQty` เพราะจุดกลับด้านของเครื่องหมายในระบบมีจุดเดียวคือ
 *    `erpDifQty()` ใน `src/erp/drivers/mssql-count-writer.ts`
 *
 * 4. **เอกสารต้อง commit ลง Postgres สำเร็จก่อนเสมอ แล้วค่อยยิง ERP**
 *    ERP ปิดอยู่/ล่ม → ตอบ 200 พร้อม `erp.status = 'disabled'|'failed'` แต่เอกสารยังอยู่
 *    ให้ผู้ดูแลกด retry ได้ที่ `POST /count-sessions/:id/erp-writeback`
 *    ⚠️ ห้ามให้ความล้มเหลวของ ERP ทำให้ผลนับที่พนักงานเดินเก็บมาทั้งวันหาย
 */

// ---------------------------------------------------------------------------
// 1. สัญญาข้อมูลเข้า (zod) — controller ใช้ชุดนี้ชุดเดียว
// ---------------------------------------------------------------------------

/** เพดานบรรทัดต่อเอกสาร — ตรงกับ MAX_BATCH_LINES ของเส้นทาง submissions เดิม */
export const MAX_DOCUMENT_LINES = 200;

/**
 * รหัสเอกสาร = UUIDv7 จากเครื่อง และเป็น **idempotency key ทั้งใบ**
 *
 * กติกาเดียวกับ `SessionIdSchema` ของรอบนับปกติ: ห้ามมี control char / `"` / `\` / `#`
 * (`#` เป็นตัวคั่นของมาร์กเกอร์ `TCL#<id>#` ใน `tbl_CountHdr.Remark` — ถ้าอยู่ในตัว id
 *  การ reconcile ฝั่ง ERP จะจับข้ามเอกสาร = คืนเลขเอกสารผิดใบ · บังคับซ้ำที่
 *  CHECK `count_sessions_id_no_hash` ด้วย)
 */
export const CountDocumentIdSchema = z
  .string()
  .trim()
  .min(1, 'รหัสเอกสารไม่ถูกต้อง')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001F"\\#]+$/, 'รหัสเอกสารไม่ถูกต้อง')
  .max(64, 'รหัสเอกสารไม่ถูกต้อง');

const IsoDateTimeSchema = z
  .union([z.string().trim().min(1), z.date()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'เวลาที่นับไม่ถูกต้อง' });
      return z.NEVER;
    }
    return date;
  });

/**
 * 1 บรรทัดในเอกสาร
 *
 * ⚠️ **ไม่มีฟิลด์ `diff` และจะไม่มีวันมี** — แอปห้ามคำนวณผลต่างส่งขึ้นมา
 * `systemQtyShown` = ยอดที่ "จอ" แสดงตอนคนกรอก ใช้ตรวจว่ายอดระบบขยับไปหรือยัง
 */
const CountDocumentLineSchema = z.object({
  entryKey: z.string().trim().uuid('entryKey ต้องเป็น UUID'),
  sku: z.string().trim().min(1, 'รหัสสินค้าไม่ถูกต้อง').max(64, 'รหัสสินค้าไม่ถูกต้อง'),
  systemQtyShown: z.number().finite('ยอดระบบที่จอแสดงไม่ถูกต้อง'),
  countedQty: z
    .number()
    .finite('จำนวนที่นับได้ไม่ถูกต้อง')
    .min(0, 'จำนวนที่นับได้ต้องไม่ติดลบ')
    .max(999_999_999_999.999, 'จำนวนที่นับได้เกินขอบเขต'),
  countedAt: IsoDateTimeSchema,
});

export const CountDocumentSchema = z.object({
  documentId: CountDocumentIdSchema,
  deviceId: z.string().trim().min(1, 'ต้องระบุรหัสเครื่อง').max(128),
  /** ยอดระบบขยับแล้วแต่คนยืนยันว่าจะส่งด้วยยอดใหม่ของ server */
  acceptSystemQtyDrift: z.boolean().optional().default(false),
  // เช็คว่าว่างในชั้น service เพื่อให้ได้ code `EMPTY_LINES` ตามสัญญา (ไม่ใช่ VALIDATION)
  lines: z
    .array(CountDocumentLineSchema)
    .max(MAX_DOCUMENT_LINES, `ส่งได้ไม่เกิน ${MAX_DOCUMENT_LINES} บรรทัดต่อเอกสาร`),
});

export type CountDocumentInput = z.input<typeof CountDocumentSchema>;
type CountDocumentLine = z.output<typeof CountDocumentLineSchema>;

// ---------------------------------------------------------------------------
// 2. สัญญาข้อมูลออก
// ---------------------------------------------------------------------------

export interface CountDocumentLineResult {
  sku: string;
  /** ยอดระบบที่ **server** อ่านจาก items_cache (ไม่ใช่ค่าที่ client ส่งมา) */
  systemQty: number;
  countedQty: number;
  /** `countedQty − systemQty` — ทิศของ "จอ" · ห้ามเปลี่ยนชื่อเป็น difQty */
  diff: number;
}

/**
 * ผลการยิงเข้า ERP ที่แนบมากับ response
 * - `sent` เข้า ERP แล้ว มีเลขเอกสาร
 * - `queued` มีคำขออื่นกำลังส่งใบนี้อยู่ / จองคิวไว้แล้ว
 * - `disabled` ปิดเส้นทางเขียนกลับไว้ (`ERP_WRITEBACK_ENABLED=false`)
 * - `failed` ยิงแล้วล้ม — **เอกสารยังอยู่ครบ** กด retry ได้
 */
export type CountDocumentErpStatus = 'sent' | 'queued' | 'disabled' | 'failed';

export interface CountDocumentErpResult {
  status: CountDocumentErpStatus;
  voucherNo?: string;
  transactionNo?: number;
  message?: string;
}

export interface CountDocumentResult {
  documentId: string;
  lineCount: number;
  lines: CountDocumentLineResult[];
  erp: CountDocumentErpResult;
}

/**
 * สถานะการเข้า ERP ของเอกสาร 1 ใบ เมื่อมองจากจอผู้ดูแล
 * `not_sent` = ยังไม่เคยมีแถวใน `erp_writeback` เลย (ERP ปิดอยู่ หรือยังไม่มีใครกด)
 */
export type CountDocumentErpState = 'not_sent' | 'queued' | 'sent' | 'failed';

/**
 * เอกสาร 1 ใบ เมื่อมองจากภายนอก — ใช้ทั้งในรายการและในหน้ารายละเอียด (รูปเดียวกัน)
 *
 * บรรทัดผลนับไม่ได้อยู่ที่นี่โดยเจตนา: `GET /count-sessions/:id/variance` (+ `?format=csv`)
 * อ่านเอกสาร adhoc ได้อยู่แล้วเพราะมันเกิดมาปิดแล้วและมี `closed_variance` ครบ
 */
export interface CountDocumentInfo {
  documentId: string;
  warehouseCode: string;
  /** เวลาที่สร้างเอกสาร (adhoc เกิดมาปิดแล้ว → opened_at = closed_at) */
  createdAt: string;
  createdBy: string | null;
  lineCount: number;
  erpStatus: CountDocumentErpState;
  voucherNo: string | null;
  transactionNo: number | null;
  attempts: number;
  sentAt: string | null;
  erpDataAsOf: string | null;
  createdOnStaleCache: boolean;
  /**
   * ⚠️ **admin เท่านั้น** — เป็นข้อความ error ดิบของ SQL Server ซึ่งมีชื่อ host/database ปนได้
   *    เมื่อผู้เรียกเป็น staff ฟิลด์นี้ถูกตัดทิ้ง **ทั้งคีย์** (ไม่ใช่ตั้งค่าเป็น null)
   */
  lastError?: string | null;
}

/** ตัวกรองของ `GET /count-documents?status=` — pending = ยังไม่เข้า ERP */
export type CountDocumentListFilter = 'pending' | 'sent' | 'all';

/** ค่าเริ่มต้น/เพดานของ `?limit=` — จอผู้ดูแลเปิดค้างไว้ทั้งวัน ห้ามคืนทั้งตาราง */
export const DOCUMENT_LIST_DEFAULT_LIMIT = 100;
export const DOCUMENT_LIST_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// 3. แถวจาก Postgres
// ---------------------------------------------------------------------------

interface ItemRow {
  sku: string;
  warehouse_code: string;
  on_hand: string | null;
  deleted_at: Date | null;
}

interface StoredLineRow {
  sku: string;
  frozen_on_hand: string;
  final_counted_qty: string;
}

interface DocumentInfoRow {
  id: string;
  warehouse_code: string;
  created_at: Date;
  created_by: string | null;
  line_count: number;
  erp_data_as_of: Date | null;
  created_on_stale_cache: boolean;
  erp_status: string | null;
  voucher_no: string | null;
  transaction_no: number | null;
  attempts: number | null;
  sent_at: Date | null;
  last_error: string | null;
}

/**
 * เอกสาร adhoc + สถานะการเข้า ERP ในคำสั่งเดียว
 *
 * LEFT JOIN เพราะ **ปกติ** จะยังไม่มีแถวใน `erp_writeback` เลย: ตราบใดที่
 * `ERP_WRITEBACK_ENABLED=false` ทุกใบจะค้างสถานะ `not_sent` — INNER JOIN จะทำให้
 * รายการว่างเปล่าและไม่มีใครรู้ว่ามีเอกสารค้างอยู่กี่ใบ
 */
const DOCUMENT_INFO_SELECT = `
  SELECT s.id,
         s.warehouse_code,
         s.opened_at             AS created_at,
         s.closed_by             AS created_by,
         s.erp_data_as_of,
         s.opened_on_stale_cache AS created_on_stale_cache,
         (SELECT count(*)::int FROM closed_variance c WHERE c.session_id = s.id) AS line_count,
         w.status                AS erp_status,
         w.voucher_no, w.transaction_no, w.attempts, w.sent_at, w.last_error
    FROM count_sessions s
    LEFT JOIN erp_writeback w ON w.session_id = s.id
   WHERE s.kind = 'adhoc'`;

/** ตัวกรองของรายการ — ค่าคงที่ในโค้ดทั้งหมด ไม่มีอะไรจากผู้ใช้ต่อเข้า SQL */
const DOCUMENT_FILTER_SQL: Record<CountDocumentListFilter, string> = {
  // "ยังไม่เข้า ERP" = ไม่เคยส่ง หรือส่งแล้วแต่ยังไม่ถึงสถานะ sent (queued/failed)
  pending: `(w.session_id IS NULL OR w.status <> 'sent')`,
  sent: `w.status = 'sent'`,
  all: `TRUE`,
};

/** cache เก่ากว่านี้ = สร้างเอกสารบนข้อมูลเก่า (ต้องเห็นในรายงาน) — เกณฑ์เดียวกับการเปิดรอบ */
const STALE_CACHE_MS = 6 * 60 * 60 * 1000;

const AUDIT_SQL = `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`;

/**
 * ข้อความที่ผู้เรียกซึ่ง **ไม่ใช่ admin** เห็นเมื่อยิง ERP ไม่สำเร็จ — คงที่เสมอ
 *
 * ⚠️ ห้ามต่อข้อความจริงของไดรเวอร์เข้าไปในนี้ ข้อความดิบของ SQL Server มีชื่อ host /
 *    database / ชื่อ object ปนมาได้ (เหตุผลเดียวกับที่ `lastError` ถูกตัดทิ้งใน
 *    `GET /count-documents/:id` และที่ `GET /count-sessions/:id/erp-writeback`
 *    จำกัดไว้เฉพาะ admin) ข้อความเต็มไปอยู่ใน log ฝั่ง server เสมอ ไม่ว่าใครเป็นคนกด
 *
 * ประโยคต้องบอกความจริงครบ 2 ท่อน: ผลนับ **ถูกบันทึกแล้ว** (ห้ามให้พนักงานกรอกซ้ำ)
 * และ **ยังไม่ถึง ERP** (ห้ามซ่อน) พร้อมบอกว่าต้องทำอะไรต่อ
 */
const ERP_FAILED_MESSAGE_FOR_STAFF = 'บันทึกผลนับแล้ว · ส่งเข้า ERP ไม่สำเร็จ — แจ้งผู้ดูแล';

/** ตัวเลขทุกตัวเทียบกันที่ 3 ตำแหน่ง = ความละเอียดจริงของ numeric(18,3) */
function qty3(value: number): string {
  return value.toFixed(3);
}

/** แกะสัญญา error `{code, message}` ของทั้งระบบออกจาก exception ที่ ErpWritebackService โยน */
function erpError(err: unknown): { code?: string; message: string } {
  const body = err instanceof HttpException ? err.getResponse() : undefined;
  const fields = typeof body === 'object' ? (body as { code?: unknown; message?: unknown }) : {};
  const fallback = err instanceof Error ? err.message : String(err);
  return {
    code: typeof fields.code === 'string' ? fields.code : undefined,
    message: typeof fields.message === 'string' ? fields.message : fallback,
  };
}

@Injectable()
export class CountDocumentService {
  private readonly logger = new Logger(CountDocumentService.name);
  private readonly warehouseCode: string;

  constructor(
    private readonly db: PostgresService,
    cfg: ConfigService<AppConfig, true>,
    // `@Optional()` เพื่อให้เทสต์สร้าง service ตรง ๆ ได้โดยไม่ต้องมี Nest container
    // ไม่มี = ถือว่าเส้นทางเขียนกลับ ERP ปิดอยู่ (เอกสารยังถูกบันทึกครบเหมือนเดิม)
    @Optional() private readonly writeback?: ErpWritebackService,
  ) {
    this.warehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true });
  }

  /**
   * สร้างเอกสารนับ 1 ใบ แล้วพยายามส่งเข้า ERP ต่อทันทีในคำขอเดียวกัน
   *
   * ⚠️ ลำดับนี้ห้ามสลับ: Postgres commit ให้จบก่อน แล้วค่อยคุยกับ ERP
   *    ถ้าผูก ERP ไว้ในทรานแซกชันเดียวกัน ERP ล่ม = ผลนับทั้งใบหายไปด้วย
   */
  async create(input: unknown, actor: AuthenticatedUser): Promise<CountDocumentResult> {
    const parsed = CountDocumentSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'ข้อมูลเอกสารนับไม่ถูกต้อง',
      });
    }
    const { documentId, deviceId, acceptSystemQtyDrift, lines } = parsed.data;
    const empId = actor.empId.trim();

    if (lines.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_LINES',
        message: 'เอกสารนับต้องมีอย่างน้อย 1 รายการ',
      });
    }

    const duplicates = CountDocumentService.duplicateSkus(lines);
    if (duplicates.length > 0) {
      throw new BadRequestException({
        code: 'DUPLICATE_SKU',
        message: `มีสินค้าซ้ำในเอกสารเดียวกัน: ${duplicates.join(', ')}`,
        duplicates,
      });
    }

    const stored = await this.db.transaction(async (client) => {
      // กันสองคำขอที่ถือ documentId เดียวกันเข้ามาพร้อมกัน (ล็อกหลุดเองตอน commit/rollback)
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('count_doc:' || $1)::bigint)`, [
        documentId,
      ]);

      const existing = await client.query<{ kind: string }>(
        `SELECT kind FROM count_sessions WHERE id = $1 FOR UPDATE`,
        [documentId],
      );
      if (existing.rows[0]) {
        return this.replay(client, documentId, existing.rows[0].kind, lines);
      }
      return this.insertDocument(client, {
        documentId,
        deviceId,
        empId,
        acceptSystemQtyDrift,
        lines,
      });
    });

    const erp = await this.sendToErp(documentId, empId, actor.role);
    return { documentId, lineCount: stored.length, lines: stored, erp };
  }

  // -------------------------------------------------------------------------
  // อ่าน — จอผู้ดูแล
  // -------------------------------------------------------------------------

  /**
   * รายการเอกสารนับของคลังนี้ — ค่าเริ่มต้นคือ "ยังไม่เข้า ERP"
   *
   * ⚠️ ตัวเลขจำนวนใบที่ค้างต้องเป็น **ป้ายถาวรบนจอผู้ดูแล ไม่ใช่ toast**
   *    ระหว่างที่ `ERP_WRITEBACK_ENABLED=false` ทุกใบจะค้างอยู่ตรงนี้ทั้งหมด
   *    ห้ามซ่อนความจริงว่าผลนับยังไม่ถึง ERP
   *
   * @param includeLastError เปิดเฉพาะผู้เรียกที่เป็น admin (ดู `CountDocumentInfo.lastError`)
   */
  async list(
    filter: CountDocumentListFilter,
    limit: number,
    includeLastError: boolean,
  ): Promise<CountDocumentInfo[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), DOCUMENT_LIST_MAX_LIMIT);
    const rows = await this.db.query<DocumentInfoRow>(
      `${DOCUMENT_INFO_SELECT}
          AND s.warehouse_code = $1
          AND ${DOCUMENT_FILTER_SQL[filter]}
        ORDER BY s.opened_at DESC, s.id DESC
        LIMIT $2`,
      [this.warehouseCode, capped],
    );
    return rows.rows.map((row) => CountDocumentService.toInfo(row, includeLastError));
  }

  /**
   * สถานะเอกสาร 1 ใบ (staff เรียกได้ — เป็นใบที่ตัวเองเพิ่งส่ง)
   *
   * ⚠️ `includeLastError = false` สำหรับ staff: `erp_writeback.last_error` คือข้อความดิบ
   *    ของไดรเวอร์ SQL Server ซึ่งมีชื่อ host/database ปนมาได้ (เหตุผลเดียวกับที่
   *    `GET /count-sessions/:id/erp-writeback` จำกัดไว้เฉพาะ admin)
   */
  async detail(documentId: string, includeLastError: boolean): Promise<CountDocumentInfo> {
    const id = CountDocumentIdSchema.safeParse(documentId);
    if (!id.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: id.error.issues[0]?.message ?? 'รหัสเอกสารไม่ถูกต้อง',
      });
    }
    const row = await this.db.one<DocumentInfoRow>(
      `${DOCUMENT_INFO_SELECT} AND s.id = $1 AND s.warehouse_code = $2`,
      [id.data, this.warehouseCode],
    );
    if (!row) {
      // รอบนับปกติที่ถูกเรียกผิดเส้นทางก็ตกมาที่นี่ (query กรอง kind='adhoc' ไว้แล้ว)
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: `ไม่พบเอกสารนับ ${id.data}`,
      });
    }
    return CountDocumentService.toInfo(row, includeLastError);
  }

  private static toInfo(row: DocumentInfoRow, includeLastError: boolean): CountDocumentInfo {
    const info: CountDocumentInfo = {
      documentId: row.id,
      warehouseCode: row.warehouse_code,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
      lineCount: row.line_count,
      // ไม่มีแถวใน erp_writeback = ยังไม่เคยมีใครพยายามส่งใบนี้เลย
      erpStatus: (row.erp_status as CountDocumentErpState | null) ?? 'not_sent',
      voucherNo: row.voucher_no,
      transactionNo: row.transaction_no,
      attempts: row.attempts ?? 0,
      sentAt: row.sent_at ? row.sent_at.toISOString() : null,
      erpDataAsOf: row.erp_data_as_of ? row.erp_data_as_of.toISOString() : null,
      createdOnStaleCache: row.created_on_stale_cache,
    };
    // staff ต้องไม่เห็นคีย์นี้เลย — ตัดทิ้งทั้งคีย์ ไม่ใช่ตั้งเป็น null
    if (includeLastError) info.lastError = row.last_error;
    return info;
  }

  // -------------------------------------------------------------------------
  // ภายใน — เส้นทางเอกสารใหม่
  // -------------------------------------------------------------------------

  private async insertDocument(
    client: PoolClient,
    args: {
      documentId: string;
      deviceId: string;
      empId: string;
      acceptSystemQtyDrift: boolean;
      lines: CountDocumentLine[];
    },
  ): Promise<CountDocumentLineResult[]> {
    const { documentId, deviceId, empId, acceptSystemQtyDrift, lines } = args;

    const systemQty = await this.loadSystemQty(client, lines);
    const drifted = lines
      .filter((line) => qty3(systemQty.get(line.sku) as number) !== qty3(line.systemQtyShown))
      .map((line) => ({
        sku: line.sku,
        shown: line.systemQtyShown,
        actual: systemQty.get(line.sku) as number,
      }));

    // ⚠️ throw ตรงนี้ = ทรานแซกชัน rollback → **ยังไม่มีแถวใดถูกเขียน** ตามสัญญา
    if (drifted.length > 0 && !acceptSystemQtyDrift) {
      throw new ConflictException({
        code: 'SYSTEM_QTY_DRIFT',
        message: `ยอดระบบของ ${drifted.length} รายการเปลี่ยนไปหลังจากที่กรอก — ตรวจแล้วยืนยันอีกครั้ง`,
        drifted,
      });
    }

    // FK ของ count_submissions ต้องมีแถวเครื่องอยู่ก่อน
    await client.query(
      `INSERT INTO devices (device_id, last_seen_at, last_emp_id)
            VALUES ($1, now(), $2)
       ON CONFLICT (device_id) DO UPDATE
              SET last_seen_at = now(), last_emp_id = $2`,
      [deviceId, empId],
    );

    // อายุข้อมูล = เวลาที่ดึง ERP สำเร็จล่าสุด (ห้ามใช้ max ของ erp_updated_at)
    const asOfRow = await client.query<{ stock_as_of: Date | string }>(
      `SELECT stock_as_of
         FROM sync_runs
        WHERE status = 'success' AND stock_as_of IS NOT NULL
          AND (warehouse_code IS NULL OR warehouse_code = $1)
        ORDER BY stock_as_of DESC
        LIMIT 1`,
      [this.warehouseCode],
    );
    const erpDataAsOf = asOfRow.rows[0] ? new Date(asOfRow.rows[0].stock_as_of) : null;
    const stale = erpDataAsOf === null || Date.now() - erpDataAsOf.getTime() > STALE_CACHE_MS;

    // ⚠️ เอกสาร adhoc "เกิดมาปิดแล้ว" — บังคับซ้ำที่ CHECK count_sessions_adhoc_born_closed
    //    ถ้าเผลอเป็น 'open' แม้ใบเดียว ux_count_sessions_open จะบล็อกการเปิดรอบของทั้งคลัง
    //    now() ในคำสั่งเดียวกันคือเวลาเดียวกัน → closed_at >= opened_at เสมอ
    await client.query(
      `INSERT INTO count_sessions
         (id, kind, warehouse_code, status, opened_at, closed_at, closed_by,
          erp_data_as_of, opened_on_stale_cache)
       VALUES ($1, 'adhoc', $2, 'closed', now(), now(), $3, $4::timestamptz, $5)`,
      [documentId, this.warehouseCode, empId, erpDataAsOf, stale],
    );

    // device_seq ต้อง > 0 และเป็นลำดับการนับภายในใบนี้ — ไม่ได้อยู่ใน payload_hash
    // โดยตั้งใจ เพื่อให้ส่งซ้ำแบบสลับลำดับบรรทัดยังถือว่าเป็น payload เดิม
    const entryKeys = lines.map((line) => line.entryKey);
    const skus = lines.map((line) => line.sku);
    const countedQty = lines.map((line) => qty3(line.countedQty));
    const countedAt = lines.map((line) => line.countedAt.toISOString());
    const hashes = lines.map((line) => CountDocumentService.payloadHash(documentId, line));
    const seqs = lines.map((_line, index) => index + 1);

    try {
      await client.query(
        `INSERT INTO count_submissions
           (idempotency_key, session_id, sku, counted_qty, emp_id, device_id,
            device_seq, counted_at, payload_hash)
         SELECT u.k, $2, u.s, u.q, $3, $4, u.seq, u.t, u.h
           FROM unnest($1::uuid[], $5::text[], $6::numeric[], $7::bigint[],
                       $8::timestamptz[], $9::text[])
                AS u(k, s, q, seq, t, h)`,
        [entryKeys, documentId, empId, deviceId, skus, countedQty, seqs, countedAt, hashes],
      );
    } catch (err) {
      // entryKey ถูกใช้ไปแล้วในเอกสารอื่น = ฝั่งเครื่องสร้างคีย์ซ้ำ ห้ามเขียนทับของเดิม
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'DOCUMENT_PAYLOAD_MISMATCH',
          message: 'มี entryKey ในเอกสารนี้ถูกใช้ไปแล้วกับผลนับอีกใบ — ตรวจข้อมูลในเครื่องก่อนส่งใหม่',
        });
      }
      throw err;
    }

    const results = lines.map((line) => {
      const system = systemQty.get(line.sku) as number;
      return {
        sku: line.sku,
        systemQty: system,
        countedQty: line.countedQty,
        diff: Number((line.countedQty - system).toFixed(3)),
      };
    });

    await client.query(
      `INSERT INTO closed_variance
         (session_id, sku, frozen_on_hand, final_counted_qty, status, unit,
          counted_by, device_count, chosen_submission, materialized_at)
       SELECT $1, x.s, x.f, x.c, x.st::variance_status, i.unit, $2, 1, x.k, now()
         FROM unnest($3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::uuid[])
              AS x(s, f, c, st, k)
         LEFT JOIN items_cache i ON i.sku = x.s`,
      [
        documentId,
        empId,
        skus,
        results.map((row) => qty3(row.systemQty)),
        countedQty,
        results.map((row) => CountDocumentService.varianceStatus(row.diff)),
        entryKeys,
      ],
    );

    await client.query(AUDIT_SQL, [
      empId,
      'count.document_created',
      JSON.stringify({
        documentId,
        warehouseCode: this.warehouseCode,
        deviceId,
        lineCount: lines.length,
        erpDataAsOf: erpDataAsOf?.toISOString() ?? null,
        createdOnStaleCache: stale,
        // ยืนยันส่งทั้งที่ยอดระบบขยับ = เรื่องที่ต้องตามได้ภายหลัง ต้องมีหลักฐานว่าใครยืนยัน
        acceptedSystemQtyDrift: drifted.length > 0 ? drifted : null,
      }),
    ]);

    this.logger.log(
      `สร้างเอกสารนับ ${documentId} (${this.warehouseCode}) ${lines.length} รายการ โดย ${empId}` +
        `${drifted.length > 0 ? ` ⚠️ ยืนยันทับยอดระบบที่ขยับ ${drifted.length} รายการ` : ''}` +
        `${stale ? ' ⚠️ บน cache เก่า' : ''}`,
    );
    return results;
  }

  /**
   * ยอดระบบรายบรรทัดจาก `items_cache` — ผิดตัวเดียวก็ปฏิเสธทั้งใบ
   *
   * ⚠️ `on_hand IS NULL` ไม่ใช่ 0 — ปฏิเสธเสมอ ห้ามเดา
   */
  private async loadSystemQty(
    client: PoolClient,
    lines: readonly CountDocumentLine[],
  ): Promise<Map<string, number>> {
    const skus = lines.map((line) => line.sku);
    const rows = await client.query<ItemRow>(
      `SELECT sku, warehouse_code, on_hand::text AS on_hand, deleted_at
         FROM items_cache
        WHERE sku = ANY($1::text[])`,
      [skus],
    );
    const found = new Map(rows.rows.map((row) => [row.sku, row]));

    const unknown: string[] = [];
    const deleted: string[] = [];
    const wrongWarehouse: string[] = [];
    const noSystemQty: string[] = [];
    const systemQty = new Map<string, number>();

    for (const sku of skus) {
      const row = found.get(sku);
      if (!row) {
        unknown.push(sku);
      } else if (row.deleted_at !== null) {
        deleted.push(sku);
      } else if (row.warehouse_code !== this.warehouseCode) {
        wrongWarehouse.push(sku);
      } else if (row.on_hand === null) {
        noSystemQty.push(sku);
      } else {
        systemQty.set(sku, Number(row.on_hand));
      }
    }

    if (systemQty.size !== skus.length) {
      throw new BadRequestException({
        code: 'ITEM_NO_SYSTEM_QTY',
        message:
          'มีรายการที่นับไม่ได้ในเอกสารนี้ (ไม่พบสินค้า / คลังไม่ตรง / ถูกลบจาก ERP แล้ว / ' +
          'ยังไม่มียอดคงเหลือในระบบ) — ยอดคงเหลือที่ไม่มีค่า ห้ามส่งเป็น 0',
        unknown,
        deleted,
        wrongWarehouse,
        noSystemQty,
      });
    }
    return systemQty;
  }

  // -------------------------------------------------------------------------
  // ภายใน — เส้นทางส่งซ้ำ (idempotent)
  // -------------------------------------------------------------------------

  /**
   * เอกสารใบนี้เคยถูกสร้างไปแล้ว: payload เดิม → คืนใบเดิม · payload ต่าง → 409
   *
   * เทียบด้วย `payload_hash` ของ `count_submissions` ที่เก็บไว้ (คีย์ด้วย entryKey)
   * จึงไม่ขึ้นกับลำดับบรรทัดที่ส่งมา
   */
  private async replay(
    client: PoolClient,
    documentId: string,
    kind: string,
    lines: readonly CountDocumentLine[],
  ): Promise<CountDocumentLineResult[]> {
    const mismatch = (reason: string): never => {
      throw new ConflictException({
        code: 'DOCUMENT_PAYLOAD_MISMATCH',
        message: `รหัสเอกสารนี้ถูกใช้ไปแล้วกับข้อมูลชุดอื่น (${reason}) — ห้ามเขียนทับผลนับที่บันทึกไว้`,
      });
    };

    // id ไปชนกับ "รอบนับปกติ" = คนละเส้นทางกันโดยสิ้นเชิง ห้ามแตะแถวนั้น
    if (kind !== 'adhoc') mismatch('รหัสนี้เป็นรอบนับปกติ');

    const storedHashes = await client.query<{ idempotency_key: string; payload_hash: string }>(
      `SELECT idempotency_key, payload_hash FROM count_submissions WHERE session_id = $1`,
      [documentId],
    );
    const stored = new Map(storedHashes.rows.map((row) => [row.idempotency_key, row.payload_hash]));
    if (stored.size !== lines.length) mismatch('จำนวนรายการไม่ตรงกับใบเดิม');
    for (const line of lines) {
      if (stored.get(line.entryKey) !== CountDocumentService.payloadHash(documentId, line)) {
        mismatch(`รายการ ${line.sku} ไม่ตรงกับใบเดิม`);
      }
    }

    const rows = await client.query<StoredLineRow>(
      `SELECT sku, frozen_on_hand::text AS frozen_on_hand,
              final_counted_qty::text   AS final_counted_qty
         FROM closed_variance WHERE session_id = $1`,
      [documentId],
    );
    const byKey = new Map(rows.rows.map((row) => [row.sku, row]));
    return lines.map((line) => {
      const row = byKey.get(line.sku);
      // ใบเดิมมี submission ครบแล้วแต่ closed_variance หาย = ข้อมูลถูกแก้ด้วยมือ
      if (!row) return mismatch(`ไม่พบผลของ ${line.sku} ในใบเดิม`);
      const systemQty = Number(row.frozen_on_hand);
      const countedQty = Number(row.final_counted_qty);
      return {
        sku: line.sku,
        systemQty,
        countedQty,
        diff: Number((countedQty - systemQty).toFixed(3)),
      };
    });
  }

  // -------------------------------------------------------------------------
  // ภายใน — ยิงเข้า ERP (ทำหลัง commit เสมอ)
  // -------------------------------------------------------------------------

  /**
   * ⚠️ เมธอดนี้ **ห้าม throw** — เอกสารอยู่ใน Postgres เรียบร้อยแล้ว
   *    ความล้มเหลวของ ERP ต้องกลายเป็นสถานะใน response ไม่ใช่ error ที่ทำให้แอปเห็นว่า
   *    "ส่งไม่สำเร็จ" แล้วผู้ใช้กรอกซ้ำทั้งใบ
   *
   * @param role สิทธิ์ของ **คนที่กดส่ง** ใช้ตัดสินว่า `message` ที่คืนออกไปเป็นข้อความเต็ม
   *             (admin — ต้องใช้ดีบัก) หรือข้อความคงที่ (ที่เหลือ) ไม่ว่าทางไหน
   *             ข้อความเต็มถูก log ฝั่ง server เสมอ
   */
  private async sendToErp(
    documentId: string,
    empId: string,
    role: Role,
  ): Promise<CountDocumentErpResult> {
    if (!this.writeback) return { status: 'disabled' };
    try {
      const result = await this.writeback.send(documentId, empId);
      return {
        status: 'sent',
        voucherNo: result.voucherNo,
        transactionNo: result.transactionNo,
      };
    } catch (err) {
      const { code, message } = erpError(err);
      if (code === 'ERP_WRITEBACK_DISABLED') return { status: 'disabled' };
      if (code === 'ERP_WRITEBACK_IN_PROGRESS') return { status: 'queued', message };
      if (code === 'ERP_WRITEBACK_ALREADY_SENT') {
        // ส่งซ้ำใบที่เข้า ERP ไปแล้ว → คืนเลขเอกสารเดิม ไม่ใช่ error
        const status = await this.writeback.status(documentId).catch(() => null);
        if (status?.status === 'sent') {
          return {
            status: 'sent',
            voucherNo: status.voucherNo ?? undefined,
            transactionNo: status.transactionNo ?? undefined,
          };
        }
        return { status: 'queued', message };
      }
      // log ข้อความเต็มเสมอ ไม่ว่าใครเป็นคนกด — นี่คือหลักฐานชิ้นเดียวที่ผู้ดูแลใช้ตามเรื่อง
      // ต่อ ห้ามกลืนทิ้งเพียงเพราะคนกดเป็น staff
      this.logger.error(`ส่งเอกสาร ${documentId} เข้า ERP ไม่สำเร็จ: ${message}`);
      // ที่ตอบกลับ: admin ได้ข้อความเต็ม · ที่เหลือได้ข้อความคงที่ (ดู ERP_FAILED_MESSAGE_FOR_STAFF)
      return {
        status: 'failed',
        message: role === 'admin' ? message : ERP_FAILED_MESSAGE_FOR_STAFF,
      };
    }
  }

  // -------------------------------------------------------------------------
  // ภายใน — helper บริสุทธิ์
  // -------------------------------------------------------------------------

  private static duplicateSkus(lines: readonly CountDocumentLine[]): string[] {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const line of lines) {
      if (seen.has(line.sku)) dup.add(line.sku);
      seen.add(line.sku);
    }
    return [...dup];
  }

  /**
   * sha256 ของ `(documentId|sku|countedQty|countedAt)` — normalize ก่อน hash
   * (qty 3 ตำแหน่ง, เวลาเป็น ISO UTC) ไม่งั้น `5` กับ `5.000` จากเครื่องเดียวกัน
   * จะกลายเป็น payload mismatch ปลอม
   */
  private static payloadHash(documentId: string, line: CountDocumentLine): string {
    const canonical = [
      documentId,
      line.sku,
      qty3(line.countedQty),
      line.countedAt.toISOString(),
    ].join('|');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /** เอกสารนับมีแต่รายการที่ "นับแล้ว" เสมอ → เหลือแค่ 3 สถานะนี้ */
  private static varianceStatus(diff: number): 'match' | 'over' | 'short' {
    if (diff > 0) return 'over';
    if (diff < 0) return 'short';
    return 'match';
  }
}
