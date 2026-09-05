import { ConflictException } from '@nestjs/common';

import { ErpWritebackService } from '../src/count/erp-writeback.service';
import type { PostgresService } from '../src/db/postgres.service';
import type {
  ErpCountHeader,
  ErpCountLine,
  ErpCountWriteResult,
  ErpCountWriter,
} from '../src/erp/erp-count-writer';
import { applySchema, describeWithDb, makeDb, truncateAll } from './support/test-db';

/**
 * ส่งผลนับกลับ ERP — ส่วนที่ต้องมี Postgres จริง
 *
 * สิ่งที่พังแล้วเสียหายจริง:
 *   - ส่งซ้ำ → ERP ได้เอกสารซ้ำ และปลายทางไม่มี unique กันให้เลย
 *   - ส่งรายการที่ยังไม่ได้นับเป็น 0 → ERP อ่านว่าของหายทั้งที่ยังอยู่บนชั้น
 *   - ส่งรอบที่ยังไม่ปิด → ผลยังเปลี่ยนได้หลังส่งไปแล้ว
 */

/** ERP ปลอมที่บันทึกสิ่งที่ถูกส่งไว้ให้ตรวจ */
class FakeWriter implements ErpCountWriter {
  calls: { header: ErpCountHeader; lines: ErpCountLine[] }[] = [];
  failWith: Error | null = null;
  /** จำลอง "ERP commit สำเร็จแล้วสายขาดตอนตอบกลับ" — เอกสารเข้าไปแล้วแต่ฝั่งเราเห็นเป็น error */
  commitBeforeFailing = false;
  /** เอกสารที่ "อยู่ใน ERP จริง" — เขียนล้มแล้ว rollback จะไม่มีแถวที่นี่ */
  readonly documents = new Map<string, ErpCountWriteResult>();
  /** ตั้งไว้เพื่อให้ writeCountDocument ค้าง — ใช้ทดสอบสองคำขอพร้อมกัน */
  gate: Promise<void> | null = null;
  /** resolve เมื่อเข้ามาใน writeCountDocument ครั้งแรก */
  readonly entered: Promise<void>;
  private enteredResolve!: () => void;
  private seq = 0;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.enteredResolve = resolve;
    });
  }

  async writeCountDocument(
    header: ErpCountHeader,
    lines: readonly ErpCountLine[],
  ): Promise<ErpCountWriteResult> {
    this.calls.push({ header, lines: [...lines] });
    this.enteredResolve();
    if (this.gate) await this.gate;
    this.seq += 1;
    const doc: ErpCountWriteResult = {
      transactionNo: this.seq,
      voucherNo: `CNT-2608-${String(this.seq).padStart(4, '0')}`,
      rowCount: lines.length,
    };
    if (this.failWith) {
      if (this.commitBeforeFailing) this.documents.set(header.sessionId, doc);
      throw this.failWith;
    }
    this.documents.set(header.sessionId, doc);
    return doc;
  }

  async findDocumentBySession(sessionId: string): Promise<ErpCountWriteResult | null> {
    return this.documents.get(sessionId) ?? null;
  }

  async close(): Promise<void> {}
}

describeWithDb('ส่งผลนับกลับ ERP (ต้องมี Postgres)', () => {
  let db: PostgresService;
  let writer: FakeWriter;
  let svc: ErpWritebackService;

  const SESSION = 'CS-TEST-0001';
  const WH = 'WHFG';

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    writer = new FakeWriter();
    svc = new ErpWritebackService(db, writer);
  });

  /** รอบที่ปิดแล้วพร้อมผลใน closed_variance */
  const seedClosedSession = async (
    rows: { sku: string; system: number | null; counted: number | null; status: string }[],
  ): Promise<void> => {
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
       VALUES ('52104','ผู้ดูแลระบบ','$argon2id$fake','admin',$1)`,
      [WH],
    );
    await db.query(
      `INSERT INTO count_sessions (id, warehouse_code, status, closed_by, closed_at)
       VALUES ($1, $2, 'closed', '52104', now())`,
      [SESSION, WH],
    );
    for (const r of rows) {
      await db.query(
        `INSERT INTO items_cache (sku, name, warehouse_code, unit)
         VALUES ($1, $2, $3, 'กล่อง') ON CONFLICT (sku) DO NOTHING`,
        [r.sku, `สินค้า ${r.sku}`, WH],
      );
      await db.query(
        `INSERT INTO closed_variance
           (session_id, sku, frozen_on_hand, final_counted_qty, status, unit, resolved_by)
         VALUES ($1,$2,$3,$4,$5::variance_status,'กล่อง',$6)`,
        [SESSION, r.sku, r.system, r.counted, r.status, r.status === 'conflict' ? '52104' : null],
      );
    }
  };

  it('ส่งรอบที่ปิดแล้ว → ได้เลขเอกสารกลับมาและบันทึกสถานะ sent', async () => {
    await seedClosedSession([{ sku: 'A-001', system: 10, counted: 8, status: 'short' }]);

    const result = await svc.send(SESSION, '52104');
    expect(result.voucherNo).toMatch(/^CNT-\d{4}-\d{4}$/);
    expect(result.rowCount).toBe(1);

    const status = await svc.status(SESSION);
    expect(status?.status).toBe('sent');
    expect(status?.voucherNo).toBe(result.voucherNo);
  });

  it('⭐ ส่งซ้ำรอบเดิมต้องถูกปฏิเสธ — ERP ไม่มี unique กันเอกสารซ้ำ', async () => {
    await seedClosedSession([{ sku: 'A-001', system: 10, counted: 8, status: 'short' }]);
    await svc.send(SESSION, '52104');

    await expect(svc.send(SESSION, '52104')).rejects.toBeInstanceOf(ConflictException);
    expect(writer.calls).toHaveLength(1); // ต้องไม่ยิงไป ERP รอบสอง
  });

  it('⭐ รายการที่ยังไม่ได้นับต้องไม่ถูกส่งเป็น 0', async () => {
    await seedClosedSession([
      { sku: 'A-001', system: 10, counted: 8, status: 'short' },
      { sku: 'A-002', system: 20, counted: null, status: 'not_counted' },
      { sku: 'A-003', system: 30, counted: null, status: 'not_counted' },
    ]);

    const result = await svc.send(SESSION, '52104');
    expect(result.rowCount).toBe(1);
    expect(result.skippedNotCounted).toBe(2);

    const sentSkus = writer.calls[0].lines.map((l) => l.sku);
    expect(sentSkus).toEqual(['A-001']);
    expect(writer.calls[0].lines.every((l) => l.countQty !== null)).toBe(true);
  });

  it('ส่ง match / over / short / conflict ครบ และเรียงลำดับ Number ต่อเนื่องจาก 1', async () => {
    await seedClosedSession([
      { sku: 'B-002', system: 5, counted: 5, status: 'match' },
      { sku: 'B-001', system: 5, counted: 9, status: 'over' },
      { sku: 'B-004', system: 5, counted: 1, status: 'short' },
      { sku: 'B-003', system: 5, counted: 7, status: 'conflict' },
    ]);

    const result = await svc.send(SESSION, '52104');
    expect(result.rowCount).toBe(4);

    const lines = writer.calls[0].lines;
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
    expect(lines.map((l) => l.sku)).toEqual(['B-001', 'B-002', 'B-003', 'B-004']);
  });

  it('รายการที่เคยขัดแย้งติดหมายเหตุไปด้วย', async () => {
    await seedClosedSession([{ sku: 'C-001', system: 5, counted: 7, status: 'conflict' }]);
    await svc.send(SESSION, '52104');
    expect(writer.calls[0].lines[0].remark).toContain('ผู้ดูแล');
  });

  it('⭐ รอบที่ยังไม่ปิดส่งไม่ได้ — ผลยังเปลี่ยนได้', async () => {
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
       VALUES ('52104','ผู้ดูแลระบบ','$argon2id$fake','admin',$1)`,
      [WH],
    );
    await db.query(
      `INSERT INTO count_sessions (id, warehouse_code, status)
       VALUES ($1, $2, 'open')`,
      [SESSION, WH],
    );
    await expect(svc.send(SESSION, '52104')).rejects.toThrow();
    expect(writer.calls).toHaveLength(0);
  });

  it('รอบที่ไม่มีรายการนับเลย → ไม่ส่งเอกสารเปล่า', async () => {
    await seedClosedSession([{ sku: 'D-001', system: 10, counted: null, status: 'not_counted' }]);
    await expect(svc.send(SESSION, '52104')).rejects.toThrow();
    expect(writer.calls).toHaveLength(0);
  });

  it('⭐ ส่งล้มเหลว → สถานะเป็น failed แล้วลองใหม่ได้', async () => {
    await seedClosedSession([{ sku: 'E-001', system: 10, counted: 8, status: 'short' }]);
    writer.failWith = new Error('ERP ล่ม');

    await expect(svc.send(SESSION, '52104')).rejects.toThrow();
    expect((await svc.status(SESSION))?.status).toBe('failed');

    writer.failWith = null;
    const retry = await svc.send(SESSION, '52104');
    expect(retry.voucherNo).toBeDefined();

    const after = await svc.status(SESSION);
    expect(after?.status).toBe('sent');
    expect(after?.attempts).toBe(2);
  });

  it('ยังไม่เคยส่ง → status คืน null', async () => {
    await seedClosedSession([{ sku: 'F-001', system: 1, counted: 1, status: 'match' }]);
    expect(await svc.status(SESSION)).toBeNull();
  });

  it('ปิดการส่งไว้ (ไม่มี writer) → ปฏิเสธอย่างชัดเจน ไม่เงียบ', async () => {
    await seedClosedSession([{ sku: 'G-001', system: 1, counted: 1, status: 'match' }]);
    const disabled = new ErpWritebackService(db, undefined);
    await expect(disabled.send(SESSION, '52104')).rejects.toThrow();
  });

  it('⭐ ERP commit สำเร็จแต่สายขาดตอนตอบกลับ → ส่งใหม่ต้องไม่ได้เอกสารซ้ำ', async () => {
    await seedClosedSession([{ sku: 'H-001', system: 10, counted: 8, status: 'short' }]);

    // เขียนเข้า ERP สำเร็จแล้ว แต่ฝั่งเราเห็นเป็น error → บันทึกเป็น failed
    writer.commitBeforeFailing = true;
    writer.failWith = new Error('ECONNRESET ตอนอ่าน response');
    await expect(svc.send(SESSION, '52104')).rejects.toThrow();
    expect((await svc.status(SESSION))?.status).toBe('failed');
    expect(writer.documents.size).toBe(1);

    // กดส่งใหม่: ต้องไปถาม ERP ก่อน แล้วเก็บเลขเอกสารเดิมกลับมา ไม่เขียนซ้ำ
    writer.failWith = null;
    const retry = await svc.send(SESSION, '52104');
    expect(retry.reconciled).toBe(true);
    expect(retry.voucherNo).toBe('CNT-2608-0001');
    expect(writer.calls).toHaveLength(1); // ⭐ ยิงไป ERP แค่ครั้งเดียวตลอด
    expect((await svc.status(SESSION))?.status).toBe('sent');
  });

  it('⭐ ถาม ERP ไม่ได้ว่าเคยส่งไปแล้วหรือยัง → ต้องไม่เขียนซ้ำแบบเดา', async () => {
    await seedClosedSession([{ sku: 'H-002', system: 10, counted: 8, status: 'short' }]);
    writer.failWith = new Error('ERP ล่ม');
    await expect(svc.send(SESSION, '52104')).rejects.toThrow();

    writer.failWith = null;
    jest
      .spyOn(writer, 'findDocumentBySession')
      .mockRejectedValueOnce(new Error('ต่อ ERP ไม่ได้'));

    await expect(svc.send(SESSION, '52104')).rejects.toThrow();
    expect(writer.calls).toHaveLength(1); // ไม่มีการเขียนรอบสอง
  });

  it('⭐ Emp_ID กับ Emp_Name ต้องเป็นคนเดียวกัน แม้คนกดส่งจะไม่ใช่คนปิดรอบ', async () => {
    await seedClosedSession([{ sku: 'I-001', system: 5, counted: 5, status: 'match' }]);
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
       VALUES ('90001','ผู้ดูแลอีกคน','$argon2id$fake','admin',$1)`,
      [WH],
    );

    await svc.send(SESSION, '90001'); // คนกดส่ง ≠ closed_by ('52104')

    const header = writer.calls[0].header;
    expect(header.empId).toBe('52104');
    expect(header.empName).toBe('ผู้ดูแลระบบ'); // ชื่อของ 52104 ไม่ใช่ของคนกดส่ง
    expect(header.entryBy).toBe('90001'); // ผู้บันทึกเอกสารยังเป็นคนกดส่ง
  });

  it('⭐ VoucherDate / CountDate / CountYear ต้องมาจากเวลาปิดรอบจุดเดียวกัน', async () => {
    await seedClosedSession([{ sku: 'J-001', system: 5, counted: 5, status: 'match' }]);
    const closedAt = new Date('2026-08-31T17:30:00+07:00');
    // ⚠️ ต้องเลื่อน opened_at ตามไปด้วย ไม่ใช่แค่ closed_at — `seedClosedSession` เปิดรอบ
    // ด้วย now() ถ้าปล่อยไว้ วันที่คงที่ข้างบนจะกลายเป็น "ปิดก่อนเปิด" ทันทีที่นาฬิกาจริง
    // เดินผ่าน 31 ส.ค. 2569 แล้วชน CHECK count_sessions_close_consistent
    // (เทสต์เคยเขียวเพราะบังเอิญรันก่อนวันนั้น ไม่ใช่เพราะถูก)
    await db.query(
      // ต้อง cast $2 เอง — ถ้าปล่อยไว้ Postgres เดาชนิดจาก `$2 - interval` เป็น interval
      `UPDATE count_sessions
          SET opened_at = $2::timestamptz - interval '1 hour', closed_at = $2::timestamptz
        WHERE id = $1`,
      [SESSION, closedAt],
    );

    await svc.send(SESSION, '52104');

    const header = writer.calls[0].header;
    expect(header.voucherDate.getTime()).toBe(header.countDate.getTime());
    expect(header.countDate.getTime()).toBe(closedAt.getTime());
    expect(header.countYear).toBe(String(closedAt.getFullYear()));
    expect(header.sessionId).toBe(SESSION);
  });

  it('⭐ ส่งสำเร็จแล้วเลขเอกสารต้องกลับมาอยู่บนตัวรอบนับด้วย', async () => {
    await seedClosedSession([{ sku: 'K-001', system: 5, counted: 4, status: 'short' }]);
    const result = await svc.send(SESSION, '52104');

    const row = await db.one<{
      erp_transaction_no: string | null;
      erp_voucher_no: string | null;
      erp_count_date: Date | null;
    }>(
      `SELECT erp_transaction_no, erp_voucher_no, erp_count_date
         FROM count_sessions WHERE id = $1`,
      [SESSION],
    );
    expect(row?.erp_transaction_no).toBe(String(result.transactionNo));
    expect(row?.erp_voucher_no).toBe(result.voucherNo);
    expect(row?.erp_count_date).not.toBeNull();
  });

  it('⭐ รอบของคลังอื่นส่งจากเครื่องนี้ไม่ได้', async () => {
    await seedClosedSession([{ sku: 'L-001', system: 5, counted: 5, status: 'match' }]);
    const cfgStub = { get: () => 'WH-OTHER' } as unknown as ConstructorParameters<
      typeof ErpWritebackService
    >[2];
    const scoped = new ErpWritebackService(db, writer, cfgStub);

    await expect(scoped.send(SESSION, '52104')).rejects.toThrow();
    expect(writer.calls).toHaveLength(0);
  });

  it('⭐ แถวที่ค้างสถานะ queued (process ตายกลางทาง) → กดส่งใหม่ได้ ไม่ต้องแก้ DB ด้วยมือ', async () => {
    await seedClosedSession([{ sku: 'M-001', system: 5, counted: 3, status: 'short' }]);
    await db.query(
      `INSERT INTO erp_writeback (session_id, status, attempts, requested_by, claimed_at)
            VALUES ($1, 'queued', 1, '52104', now() - interval '1 day')`,
      [SESSION],
    );

    const result = await svc.send(SESSION, '52104');
    expect(result.voucherNo).toBeDefined();
    expect((await svc.status(SESSION))?.status).toBe('sent');
  });

  it('⭐ แถว queued ที่ claimed_at เป็น NULL (DB ที่อัปเกรดมา) ก็ต้องกดใหม่ได้', async () => {
    await seedClosedSession([{ sku: 'M-002', system: 5, counted: 3, status: 'short' }]);
    // แถวที่มีอยู่ก่อนคอลัมน์ claimed_at ถูกเพิ่ม
    await db.query(
      `INSERT INTO erp_writeback (session_id, status, attempts, requested_by)
            VALUES ($1, 'queued', 1, '52104')`,
      [SESSION],
    );
    await db.query(`UPDATE erp_writeback SET claimed_at = NULL WHERE session_id = $1`, [SESSION]);

    const result = await svc.send(SESSION, '52104');
    expect(result.voucherNo).toBeDefined();
  });

  it('⭐ สองคำขอพร้อมกันบนรอบเดียว → เขียนเข้า ERP ได้ใบเดียว', async () => {
    await seedClosedSession([{ sku: 'N-001', system: 5, counted: 4, status: 'short' }]);

    let release!: () => void;
    writer.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = svc.send(SESSION, '52104');
    await writer.entered; // คำขอแรกถือ advisory lock และค้างอยู่กลางการเขียนแล้ว

    const second = await svc.send(SESSION, '52104').catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ConflictException);

    release();
    await expect(first).resolves.toMatchObject({ reconciled: false });
    expect(writer.calls).toHaveLength(1); // ⭐ ยิงไป ERP ครั้งเดียว
    expect(writer.documents.size).toBe(1);
  });

  it('⭐ ส่งสำเร็จแล้วห้ามถูกมาร์กเป็น failed แม้บันทึกสถานะฝั่งเราจะล้ม', async () => {
    await seedClosedSession([{ sku: 'O-001', system: 5, counted: 4, status: 'short' }]);
    const original = db.query.bind(db);
    jest
      .spyOn(db, 'query')
      .mockImplementation((sqlText: string, params?: readonly unknown[]) =>
        /UPDATE erp_writeback\s+SET status = 'sent'/.test(sqlText)
          ? Promise.reject(new Error('Postgres สะดุด'))
          : original(sqlText, params),
      );

    const result = await svc.send(SESSION, '52104');
    expect(result.reconciled).toBe(false);
    jest.restoreAllMocks();
    expect((await svc.status(SESSION))?.status).not.toBe('failed');
  });
});
