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
  private seq = 0;

  async writeCountDocument(
    header: ErpCountHeader,
    lines: readonly ErpCountLine[],
  ): Promise<ErpCountWriteResult> {
    this.calls.push({ header, lines: [...lines] });
    if (this.failWith) throw this.failWith;
    this.seq += 1;
    return {
      transactionNo: this.seq,
      voucherNo: `CNT-2608-${String(this.seq).padStart(4, '0')}`,
      rowCount: lines.length,
    };
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
});
