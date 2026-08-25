import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PostgresService } from '../db/postgres.service';
import {
  ERP_COUNT_WRITER,
  type ErpCountLine,
  type ErpCountWriter,
} from '../erp/erp-count-writer';

/**
 * ส่งผลการนับของรอบที่ปิดแล้วกลับเข้า ERP (`tbl_CountHdr` / `tbl_CountDtl`)
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  กติกาที่ตัดสินไว้แล้ว — เปลี่ยนต้องคุยกับฝ่าย ERP ก่อน
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. **ส่งเฉพาะรายการที่มีคนนับจริง** — `not_counted` ถูกตัดออกทั้งหมด
 *    เหตุผล: ตรวจ `tbl_CountDtl` ทั้ง 509 แถวใน ERP แล้วพบว่า `CountQty`
 *    **ไม่เคยเป็น NULL เลย** (เป็น 0 อยู่ 84 แถว) แปลว่า ERP ไม่มีวิธีบันทึก
 *    "ยังไม่ได้นับ" ถ้าเราส่ง 0 ไป ERP จะอ่านว่า "นับแล้วได้ศูนย์" = ของหาย
 *    ทั้งที่ยังอยู่บนชั้น → ตัดออกปลอดภัยกว่าเสมอ
 *
 * 2. **ส่งได้เฉพาะรอบที่ปิดแล้ว** — ระหว่างนับผลยังเปลี่ยนได้ และ ERP ไม่มี
 *    กลไกแก้เอกสารที่เราทราบ
 *
 * 3. **หนึ่งรอบส่งได้ครั้งเดียวตลอดกาล** — บังคับด้วย PK ของ `erp_writeback`
 *    ⚠️ นี่คือด่านเดียวที่มี: ฝั่ง ERP ไม่มี unique บน `VoucherNo` และ
 *    `TransactionNo` เดี่ยว ๆ ก็ไม่ unique จึงกันเอกสารซ้ำที่ปลายทางไม่ได้เลย
 *
 * 4. **`off_list` ก็ถูกตัดออก** — ของที่นับเจอแต่ไม่อยู่ในรอบไม่มี `MainQty`
 *    ให้เทียบ ส่งเข้า ERP แล้วจะกลายเป็นรายการที่ตีความไม่ได้
 */

/** สถานะที่ถือว่า "มีคนนับแล้ว" และส่งเข้า ERP ได้ */
const SENDABLE_STATUSES = ['match', 'over', 'short', 'conflict'] as const;

type VarianceRow = {
  sku: string;
  name: string | null;
  warehouse_code: string;
  unit: string | null;
  frozen_on_hand: string;
  final_counted_qty: string;
  status: string;
};

type SessionRow = {
  id: string;
  status: string;
  warehouse_code: string;
  opened_at: Date;
  closed_at: Date | null;
  closed_by: string | null;
  zone: string | null;
};

export type WritebackResult = {
  sessionId: string;
  transactionNo: number;
  voucherNo: string;
  rowCount: number;
  skippedNotCounted: number;
};

export type WritebackStatus = {
  sessionId: string;
  status: 'queued' | 'sent' | 'failed';
  transactionNo: number | null;
  voucherNo: string | null;
  rowCount: number | null;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
};

@Injectable()
export class ErpWritebackService {
  private readonly logger = new Logger(ErpWritebackService.name);

  constructor(
    private readonly db: PostgresService,
    @Optional() @Inject(ERP_COUNT_WRITER) private readonly writer?: ErpCountWriter,
  ) {}

  /** ส่งรอบนับหนึ่งรอบเข้า ERP — คืนเลขเอกสารที่ ERP ได้รับ */
  async send(sessionId: string, actorEmpId: string): Promise<WritebackResult> {
    if (!this.writer) {
      throw new ServiceUnavailableException({
        code: 'ERP_WRITEBACK_DISABLED',
        message: 'ยังไม่ได้เปิดการส่งผลนับกลับ ERP (ERP_WRITEBACK_ENABLED)',
      });
    }

    const session = await this.loadClosedSession(sessionId);
    const { lines, skippedNotCounted } = await this.buildLines(sessionId);

    if (lines.length === 0) {
      throw new BadRequestException({
        code: 'ERP_WRITEBACK_EMPTY',
        message:
          `รอบนี้ไม่มีรายการที่นับแล้วเลย (ข้าม ${skippedNotCounted} รายการที่ยังไม่ได้นับ) — ` +
          'ไม่ส่งเอกสารเปล่าเข้า ERP',
      });
    }

    // จองสิทธิ์ส่งก่อนยิงจริง: แถวนี้คือด่านเดียวที่กันส่งซ้ำได้
    await this.claim(sessionId, actorEmpId);

    const actor = await this.loadActor(actorEmpId);
    const countDate = session.closed_at ?? session.opened_at;

    try {
      const result = await this.writer.writeCountDocument(
        {
          voucherDate: new Date(),
          countDate,
          // ⚠️ รอบของเรามีผู้นับได้หลายคน แต่ ERP มีช่องเดียว → ใช้ผู้ปิดรอบ
          //    ซึ่งเป็นผู้รับผิดชอบผลของทั้งรอบ (ของจริงใน ERP บางใบก็เว้นว่าง)
          empId: session.closed_by ?? actorEmpId,
          empName: actor?.name ?? null,
          countNo: '1',
          countYear: String(countDate.getFullYear()),
          countNumber: 1,
          remark: `จากระบบ TCL Mobile · รอบ ${sessionId}`,
          entryBy: actorEmpId,
        },
        lines,
      );

      await this.db.query(
        `UPDATE erp_writeback
            SET status = 'sent', transaction_no = $2, voucher_no = $3,
                row_count = $4, last_error = NULL, sent_at = now()
          WHERE session_id = $1`,
        [sessionId, result.transactionNo, result.voucherNo, result.rowCount],
      );

      this.logger.log(
        `ส่งรอบ ${sessionId} เข้า ERP แล้ว: ${result.voucherNo} ` +
          `(${result.rowCount} รายการ · ข้ามที่ยังไม่ได้นับ ${skippedNotCounted})`,
      );
      return { sessionId, ...result, skippedNotCounted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ปล่อยสถานะเป็น failed ไว้ ไม่ลบแถวทิ้ง — ต้องเห็นว่าเคยพยายามส่งแล้วล้ม
      await this.db.query(
        `UPDATE erp_writeback SET status = 'failed', last_error = $2 WHERE session_id = $1`,
        [sessionId, message.slice(0, 2000)],
      );
      this.logger.error(`ส่งรอบ ${sessionId} เข้า ERP ไม่สำเร็จ: ${message}`);
      throw new ServiceUnavailableException({
        code: 'ERP_WRITEBACK_FAILED',
        message: `ส่งเข้า ERP ไม่สำเร็จ: ${message}`,
      });
    }
  }

  /** สถานะการส่งของรอบหนึ่ง — `null` = ยังไม่เคยส่ง */
  async status(sessionId: string): Promise<WritebackStatus | null> {
    const row = await this.db.one<{
      session_id: string;
      status: string;
      transaction_no: number | null;
      voucher_no: string | null;
      row_count: number | null;
      attempts: number;
      last_error: string | null;
      sent_at: Date | null;
    }>(
      `SELECT session_id, status, transaction_no, voucher_no, row_count,
              attempts, last_error, sent_at
         FROM erp_writeback WHERE session_id = $1`,
      [sessionId],
    );
    if (!row) return null;
    return {
      sessionId: row.session_id,
      status: row.status as WritebackStatus['status'],
      transactionNo: row.transaction_no,
      voucherNo: row.voucher_no,
      rowCount: row.row_count,
      attempts: row.attempts,
      lastError: row.last_error,
      sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------
  // ภายใน
  // -------------------------------------------------------------------------

  private async loadClosedSession(sessionId: string): Promise<SessionRow> {
    const session = await this.db.one<SessionRow>(
      `SELECT id, status, warehouse_code, opened_at, closed_at, closed_by, zone
         FROM count_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: `ไม่พบรอบนับ ${sessionId}`,
      });
    }
    if (session.status !== 'closed') {
      throw new BadRequestException({
        code: 'SESSION_NOT_CLOSED',
        message: 'ส่งเข้า ERP ได้เฉพาะรอบที่ปิดแล้ว — ระหว่างนับผลยังเปลี่ยนได้',
      });
    }
    return session;
  }

  /**
   * จองสิทธิ์ส่ง — `INSERT` ที่ชนคีย์แปลว่าเคยส่งหรือกำลังส่งอยู่
   *
   * รอบที่เคย `failed` ให้ลองใหม่ได้ แต่ `sent` แล้วห้ามซ้ำเด็ดขาด
   */
  private async claim(sessionId: string, actorEmpId: string): Promise<void> {
    const claimed = await this.db.query<{ session_id: string }>(
      `INSERT INTO erp_writeback (session_id, status, attempts, requested_by)
            VALUES ($1, 'queued', 1, $2)
       ON CONFLICT (session_id) DO UPDATE
              SET status = 'queued',
                  attempts = erp_writeback.attempts + 1,
                  requested_by = EXCLUDED.requested_by
            WHERE erp_writeback.status = 'failed'
        RETURNING session_id`,
      [sessionId, actorEmpId],
    );

    if (claimed.rows.length === 0) {
      const current = await this.status(sessionId);
      throw new ConflictException({
        code: 'ERP_WRITEBACK_ALREADY_SENT',
        message:
          current?.status === 'sent'
            ? `รอบนี้ส่งเข้า ERP ไปแล้วเป็นเอกสาร ${current.voucherNo} — ส่งซ้ำไม่ได้`
            : 'รอบนี้กำลังถูกส่งอยู่ รอให้รอบก่อนหน้าจบก่อน',
      });
    }
  }

  private async loadActor(empId: string): Promise<{ name: string } | null> {
    return this.db.one<{ name: string }>(`SELECT name FROM users WHERE emp_id = $1`, [empId]);
  }

  /** ประกอบรายการจาก `closed_variance` — ตัด `not_counted` และ `off_list` ออก */
  private async buildLines(
    sessionId: string,
  ): Promise<{ lines: ErpCountLine[]; skippedNotCounted: number }> {
    const result = await this.db.query<VarianceRow>(
      `SELECT c.sku,
              i.name                AS name,
              s.warehouse_code      AS warehouse_code,
              c.unit                AS unit,
              c.frozen_on_hand::text    AS frozen_on_hand,
              c.final_counted_qty::text AS final_counted_qty,
              c.status::text        AS status
         FROM closed_variance c
         JOIN count_sessions s ON s.id = c.session_id
         LEFT JOIN items_cache i ON i.sku = c.sku
        WHERE c.session_id = $1
          AND c.status = ANY($2::variance_status[])
          AND c.final_counted_qty IS NOT NULL
          AND c.frozen_on_hand IS NOT NULL
        ORDER BY c.sku`,
      [sessionId, SENDABLE_STATUSES],
    );

    const skipped = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM closed_variance
        WHERE session_id = $1 AND status = 'not_counted'`,
      [sessionId],
    );

    const lines: ErpCountLine[] = result.rows.map((row, index) => ({
      lineNo: index + 1,
      sku: row.sku,
      // ERP ต้องมีคำอธิบาย — สินค้าที่ถูก tombstone ไปแล้วอาจไม่มีชื่อ ใช้ sku แทน
      description: row.name ?? row.sku,
      warehouse: row.warehouse_code,
      mainQty: Number(row.frozen_on_hand),
      mainUnits: row.unit,
      countQty: Number(row.final_counted_qty),
      remark: row.status === 'conflict' ? 'ตัดสินจากหลายเครื่องโดยผู้ดูแล' : null,
    }));

    return { lines, skippedNotCounted: skipped?.n ?? 0 };
  }
}
