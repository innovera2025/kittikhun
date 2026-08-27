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

import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import {
  ERP_COUNT_WRITER,
  type ErpCountLine,
  type ErpCountWriteResult,
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

/**
 * namespace ของ advisory lock ที่กันสองคำขอส่งรอบเดียวกันพร้อมกัน
 *
 * ใช้รูปแบบสองจำนวนเต็ม `pg_try_advisory_lock(ns, hashtext(sessionId))`
 * เพื่อไม่ให้ชนกับ key ของงานอื่น (sync ใช้ 872001)
 */
const LOCK_NAMESPACE = 872_002;

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
  /** `true` = เอกสารอยู่ใน ERP อยู่ก่อนแล้ว รอบนี้แค่ไปเก็บเลขกลับมา ไม่ได้เขียนซ้ำ */
  reconciled: boolean;
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
    // `@Optional()` เพื่อให้เทสต์สร้าง service ตรง ๆ ได้โดยไม่ต้องมี Nest container
    @Optional() private readonly cfg?: ConfigService<AppConfig, true>,
  ) {}

  /**
   * ส่งรอบนับหนึ่งรอบเข้า ERP — คืนเลขเอกสารที่ ERP ได้รับ
   *
   * ⚠️ **mutex จริงของทั้งกระบวนการอยู่ที่ advisory lock ตรงนี้** ไม่ใช่ที่สถานะในตาราง
   *
   * เหตุผล: สถานะในตารางกันได้แค่ ณ จังหวะที่ `claim()` ทำงาน แต่การเขียนเอกสาร
   * ใช้เวลาได้นาน (`ERP_TIMEOUT_MS` เป็นเพดาน **ต่อ statement** และเราเขียนทีละแถว)
   * ถ้าใช้ lease อิงเวลา คนที่สองจะเข้ามาได้ทั้งที่คนแรกยังเขียนอยู่ และ
   * `findDocumentBySession()` มองไม่เห็น transaction ที่ยังไม่ commit → ได้เอกสารสองใบ
   *
   * advisory lock เป็น session-scope: ถือข้ามงานยาวได้โดยไม่ต้องเปิด transaction ค้าง
   * ทำงานข้าม instance ของ API และถ้า process ตาย connection ปิด Postgres ปลดล็อกให้เอง
   * — จึงไม่ต้องเดาอายุ lease ให้ถูก
   */
  async send(sessionId: string, actorEmpId: string): Promise<WritebackResult> {
    return this.db.withClient(async (client) => {
      const locked = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked`,
        [LOCK_NAMESPACE, sessionId],
      );
      if (locked.rows[0]?.locked !== true) {
        throw new ConflictException({
          code: 'ERP_WRITEBACK_IN_PROGRESS',
          message: 'รอบนี้กำลังถูกส่งอยู่จากอีกคำขอหนึ่ง — รอให้คำขอนั้นจบก่อน',
        });
      }
      try {
        return await this.sendLocked(sessionId, actorEmpId);
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock($1::int, hashtext($2)::int)`, [
            LOCK_NAMESPACE,
            sessionId,
          ])
          .catch(() => undefined);
      }
    });
  }

  private async sendLocked(sessionId: string, actorEmpId: string): Promise<WritebackResult> {
    if (!this.writer) {
      throw new ServiceUnavailableException({
        code: 'ERP_WRITEBACK_DISABLED',
        message: 'ยังไม่ได้เปิดการส่งผลนับกลับ ERP (ERP_WRITEBACK_ENABLED)',
      });
    }

    const session = await this.loadClosedSession(sessionId);
    this.assertOwnWarehouse(session);
    const { lines, skippedNotCounted } = await this.buildLines(sessionId);

    if (lines.length === 0) {
      throw new BadRequestException({
        code: 'ERP_WRITEBACK_EMPTY',
        message:
          `รอบนี้ไม่มีรายการที่นับแล้วเลย (ข้าม ${skippedNotCounted} รายการที่ยังไม่ได้นับ) — ` +
          'ไม่ส่งเอกสารเปล่าเข้า ERP',
      });
    }

    // สถานะก่อนจอง — บอกว่านี่เป็นการ "ส่งซ้ำ" หรือ "ส่งครั้งแรก"
    const previous = await this.status(sessionId);

    // จองสิทธิ์ส่งก่อนยิงจริง: แถวนี้คือด่านเดียวที่กันส่งซ้ำได้
    await this.claim(sessionId, actorEmpId);

    // ⚠️ ส่งซ้ำต้องถาม ERP ก่อนเสมอ — ถ้าครั้งก่อน commit สำเร็จแต่สายขาดตอนตอบกลับ
    //    ฝั่งเราจะบันทึกเป็น failed แล้วยอมให้ส่งใหม่ ซึ่งจะได้เอกสารสองใบใน ERP
    //    โดยไม่มีอะไรฟ้อง (ปลายทางไม่มี unique บน VoucherNo/TransactionNo)
    if (previous !== null) {
      const existing = await this.reconcile(sessionId);
      if (existing) {
        await this.markSent(sessionId, existing, session.closed_at ?? session.opened_at);
        this.logger.warn(
          `รอบ ${sessionId} มีเอกสารอยู่ใน ERP แล้ว (${existing.voucherNo}) — ` +
            'เก็บเลขเอกสารกลับมาแทนการเขียนซ้ำ',
        );
        return { sessionId, ...existing, skippedNotCounted, reconciled: true };
      }
    }

    // ⚠️ ทุกช่องเวลาของเอกสารต้องมาจาก "จุดเดียวกัน" คือเวลาปิดรอบ
    //    ก่อนหน้านี้ VoucherDate ใช้ new Date() ตอนกดส่ง ทำให้รอบที่ปิดปลายเดือน
    //    แต่กดส่งเดือนถัดไปได้ VoucherNo เป็นเดือนใหม่ คู่กับ CountDate/CountYear เดือนเก่า
    const countDate = session.closed_at ?? session.opened_at;
    // ERP มีช่องผู้ตรวจนับช่องเดียว แต่รอบของเรามีผู้นับได้หลายคน → ใช้ผู้ปิดรอบ
    // ซึ่งเป็นผู้รับผิดชอบผลของทั้งรอบ (ของจริงใน ERP บางใบก็เว้นว่าง)
    const empId = session.closed_by ?? actorEmpId;
    // ⚠️ ชื่อต้องเป็นชื่อของ empId คนเดียวกัน ไม่ใช่ชื่อคนกดส่ง — เคยผิดตรงนี้
    //    ทำให้หัวเอกสารได้รหัสคนหนึ่งกับชื่ออีกคนหนึ่งเมื่อคนกดส่งไม่ใช่คนปิดรอบ
    const actor = await this.loadActor(empId);

    let written: ErpCountWriteResult;
    try {
      const result = await this.writer.writeCountDocument(
        {
          voucherDate: countDate,
          countDate,
          empId,
          empName: actor?.name ?? null,
          countNo: '1',
          countYear: String(countDate.getFullYear()),
          countNumber: 1,
          remark: 'จากระบบ TCL Mobile',
          entryBy: actorEmpId,
          sessionId,
        },
        lines,
      );

      written = result;
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

    // ⚠️ ถึงตรงนี้ = ERP commit ไปแล้ว **ห้าม**ให้เส้นทางไหนมาร์กว่า failed อีก
    //    ถ้าบันทึกสถานะฝั่งเราล้ม ให้ดังไว้ใน log แล้วตอบสำเร็จ — รอบถัดไปที่กดส่ง
    //    จะไป reconcile เจอเอกสารเดิมแล้วซ่อมสถานะให้เอง
    await this.markSent(sessionId, written, countDate);

    this.logger.log(
      `ส่งรอบ ${sessionId} เข้า ERP แล้ว: ${written.voucherNo} ` +
        `(${written.rowCount} รายการ · ข้ามที่ยังไม่ได้นับ ${skippedNotCounted})`,
    );
    return { sessionId, ...written, skippedNotCounted, reconciled: false };
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
   * `sent` แล้วห้ามซ้ำเด็ดขาด — สถานะอื่น (`failed` / `queued` ที่เจ้าของตายไปแล้ว)
   * ลองใหม่ได้ เพราะผู้เรียกถือ advisory lock อยู่แล้ว จึงรู้แน่ว่าไม่มีใครกำลังส่งอยู่
   *
   * ⚠️ ต้องเรียกจาก {@link sendLocked} เท่านั้น — เรียกโดยไม่ถือล็อกจะเปิดช่องเอกสารซ้ำ
   */
  private async claim(sessionId: string, actorEmpId: string): Promise<void> {
    const claimed = await this.db.query<{ session_id: string }>(
      `INSERT INTO erp_writeback (session_id, status, attempts, requested_by, claimed_at)
            VALUES ($1, 'queued', 1, $2, now())
       ON CONFLICT (session_id) DO UPDATE
              SET status = 'queued',
                  attempts = erp_writeback.attempts + 1,
                  requested_by = EXCLUDED.requested_by,
                  claimed_at = now()
            WHERE erp_writeback.status <> 'sent'
        RETURNING session_id`,
      [sessionId, actorEmpId],
    );

    if (claimed.rows.length === 0) {
      const current = await this.status(sessionId);
      throw new ConflictException({
        code: 'ERP_WRITEBACK_ALREADY_SENT',
        message: `รอบนี้ส่งเข้า ERP ไปแล้วเป็นเอกสาร ${current?.voucherNo ?? '(ไม่ทราบเลขที่)'} — ส่งซ้ำไม่ได้`,
      });
    }
  }

  /**
   * รอบที่ส่งต้องเป็นของคลังเดียวกับ deployment นี้
   *
   * ⚠️ ยอดคงเหลือที่ตรึงไว้ (`frozen_on_hand`) คำนวณจาก `WAREHOUSE_CODE` ของเครื่องนี้
   *    ถ้าปล่อยให้ส่งรอบของคลังอื่น เอกสารใน ERP จะมียอดระบบของคนละคลัง
   */
  private assertOwnWarehouse(session: SessionRow): void {
    const expected = this.cfg?.get('WAREHOUSE_CODE', { infer: true });
    if (!expected) return;
    if (session.warehouse_code !== expected) {
      throw new BadRequestException({
        code: 'SESSION_WRONG_WAREHOUSE',
        message:
          `รอบนี้เป็นของคลัง ${session.warehouse_code} แต่ระบบนี้ดูแลคลัง ${expected} — ` +
          'ส่งได้เฉพาะรอบของคลังตัวเอง',
      });
    }
  }

  /**
   * ถาม ERP ว่ารอบนี้มีเอกสารอยู่แล้วหรือยัง — ใช้ก่อนเขียนซ้ำเท่านั้น
   *
   * ⚠️ ถามไม่ได้ **ไม่เท่ากับ** ไม่มีเอกสาร จึงต้องหยุดทั้งกระบวนการ
   *    เขียนซ้ำโดยไม่รู้สถานะปลายทาง = เสี่ยงได้เอกสารสองใบที่ไม่มีใครฟ้อง
   */
  private async reconcile(sessionId: string): Promise<ErpCountWriteResult | null> {
    if (!this.writer) return null;
    try {
      return await this.writer.findDocumentBySession(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.query(
        `UPDATE erp_writeback SET status = 'failed', last_error = $2 WHERE session_id = $1`,
        [sessionId, `reconcile: ${message}`.slice(0, 2000)],
      );
      this.logger.error(`ตรวจเอกสารเดิมของรอบ ${sessionId} ใน ERP ไม่ได้: ${message}`);
      throw new ServiceUnavailableException({
        code: 'ERP_WRITEBACK_RECONCILE_FAILED',
        message:
          'ตรวจกับ ERP ไม่ได้ว่ารอบนี้เคยส่งเข้าไปแล้วหรือยัง จึงไม่ยอมเขียนซ้ำ ' +
          `(กันเอกสารซ้ำ): ${message}`,
      });
    }
  }

  /** บันทึกว่าส่งสำเร็จ — ทั้งบนแถว writeback และบนตัวรอบนับเอง */
  private async markSent(
    sessionId: string,
    result: ErpCountWriteResult,
    countDate: Date,
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE erp_writeback
            SET status = 'sent', transaction_no = $2, voucher_no = $3,
                row_count = $4, last_error = NULL, sent_at = now()
          WHERE session_id = $1`,
        [sessionId, result.transactionNo, result.voucherNo, result.rowCount],
      );
    } catch (err) {
      // เอกสารอยู่ใน ERP แล้ว แต่บันทึกสถานะไม่ได้ — แถวจะค้าง queued
      // ครั้งหน้าที่กดส่ง reconcile จะเจอเอกสารเดิมแล้วซ่อมให้เอง
      this.logger.error(
        `เอกสาร ${result.voucherNo} เข้า ERP แล้วแต่บันทึกสถานะของรอบ ${sessionId} ไม่สำเร็จ: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // เลขเอกสารต้องกลับมาอยู่บนตัวรอบด้วย ไม่งั้นแอปเห็น erpVoucherNo เป็น null ตลอด
    // และ ux_count_sessions_erp_txn (ด่านกันเอกสารซ้ำชั้นที่สองที่มีอยู่แล้ว) ไม่ถูกใช้เลย
    try {
      await this.db.query(
        `UPDATE count_sessions
            SET erp_transaction_no = $2,
                erp_voucher_no = $3,
                erp_count_date = $4::date
          WHERE id = $1`,
        [sessionId, String(result.transactionNo), result.voucherNo, countDate],
      );
    } catch (err) {
      // ชนคีย์ = มีรอบอื่นอ้าง TransactionNo เดียวกันอยู่แล้ว → เอกสารใน ERP ปนกันแน่นอน
      // ไม่ throw เพราะเอกสารเข้า ERP ไปแล้ว แต่ต้องดังพอให้มีคนไปตาม
      this.logger.error(
        `บันทึกเลขเอกสาร ERP ลงรอบ ${sessionId} ไม่สำเร็จ ` +
          `(TransactionNo=${result.transactionNo} · ${result.voucherNo}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
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
