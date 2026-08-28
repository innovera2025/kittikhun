import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';

import type { AuthenticatedUser } from '../src/auth/auth.types';
import { CountDocumentService } from '../src/count/count-document.service';
import { CountService } from '../src/count/count.service';
import { ErpWritebackService } from '../src/count/erp-writeback.service';
import type { PostgresService } from '../src/db/postgres.service';
import type {
  ErpCountHeader,
  ErpCountLine,
  ErpCountWriteResult,
  ErpCountWriter,
} from '../src/erp/erp-count-writer';
import { applySchema, describeWithDb, makeDb, testConfigService, truncateAll } from './support/test-db';

/**
 * เอกสารนับแบบไม่มีรอบ (`POST /count-documents`) — ส่วนที่ต้องมี Postgres จริง
 *
 * สิ่งที่พังแล้วเสียหายจริง:
 *   - เชื่อยอดระบบที่ client ส่งมา → เขียนตัวเลขที่ไม่มีใครเคยเห็นเข้า ERP
 *   - `on_hand IS NULL` ถูกแปลงเป็น 0 → ERP อ่านว่าของหายทั้งชั้น
 *   - ส่งซ้ำแล้วเกิดเอกสารใบที่สอง → ERP ไม่มีเส้นทางลบเอกสาร
 *   - ERP ล่มแล้วเอกสารหายไปด้วย → ผลนับที่เดินเก็บมาทั้งวันหาย
 */

/** ERP ปลอมที่บันทึกสิ่งที่ถูกส่งไว้ให้ตรวจ */
class FakeWriter implements ErpCountWriter {
  calls: { header: ErpCountHeader; lines: ErpCountLine[] }[] = [];
  failWith: Error | null = null;
  private seq = 0;
  private readonly documents = new Map<string, ErpCountWriteResult>();

  async writeCountDocument(
    header: ErpCountHeader,
    lines: readonly ErpCountLine[],
  ): Promise<ErpCountWriteResult> {
    this.calls.push({ header, lines: [...lines] });
    if (this.failWith) throw this.failWith;
    this.seq += 1;
    const doc: ErpCountWriteResult = {
      transactionNo: this.seq,
      voucherNo: `CNT-2608-${String(this.seq).padStart(4, '0')}`,
      rowCount: lines.length,
    };
    this.documents.set(header.sessionId, doc);
    return doc;
  }

  async findDocumentBySession(sessionId: string): Promise<ErpCountWriteResult | null> {
    return this.documents.get(sessionId) ?? null;
  }

  async close(): Promise<void> {}
}

describeWithDb('เอกสารนับแบบไม่มีรอบ (ต้องมี Postgres)', () => {
  let db: PostgresService;
  let svc: CountDocumentService;

  const WH = 'WH01'; // ตรงกับ WAREHOUSE_CODE ใน TEST_CONFIG
  const EMP = '52104';
  const DEVICE = 'DEV-001';
  const DOC = '0191f0c0-1111-7000-8000-000000000001';

  const ADMIN_EMP = '52999';
  const DOC_ADMIN = '0191f0c0-1111-7000-8000-000000000009';

  /**
   * ข้อความคงที่ที่ผู้เรียกซึ่งไม่ใช่ admin ต้องได้เมื่อยิง ERP ล้ม
   * เขียนตรง ๆ ที่นี่โดยเจตนา — ถ้ามีใครแก้ข้อความในโค้ดให้ต่อ error ดิบเข้าไป เทสต์ต้องดัง
   */
  const ERP_FAILED_FOR_STAFF = 'บันทึกผลนับแล้ว · ส่งเข้า ERP ไม่สำเร็จ — แจ้งผู้ดูแล';

  const staff: AuthenticatedUser = {
    empId: EMP,
    role: 'staff',
    warehouseCode: WH,
    roleVersion: 1,
  };

  const admin: AuthenticatedUser = {
    empId: ADMIN_EMP,
    role: 'admin',
    warehouseCode: WH,
    roleVersion: 1,
  };

  /** entryKey ที่อ่านออกด้วยตา — เลขท้ายต่างกันพอ */
  const key = (n: number): string => `0191f0c0-2222-7000-8000-${String(n).padStart(12, '0')}`;

  const line = (
    n: number,
    sku: string,
    systemQtyShown: number,
    countedQty: number,
  ): Record<string, unknown> => ({
    entryKey: key(n),
    sku,
    systemQtyShown,
    countedQty,
    countedAt: '2026-08-27T10:00:00+07:00',
  });

  const body = (
    lines: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    documentId: DOC,
    deviceId: DEVICE,
    lines,
    ...overrides,
  });

  /** นับแถวในตารางของเอกสารใบหนึ่ง */
  const counts = async (
    documentId = DOC,
  ): Promise<{ sessions: number; submissions: number; variance: number }> => {
    const row = await db.one<{ sessions: string; submissions: string; variance: string }>(
      `SELECT (SELECT count(*) FROM count_sessions    WHERE id = $1)         AS sessions,
              (SELECT count(*) FROM count_submissions WHERE session_id = $1) AS submissions,
              (SELECT count(*) FROM closed_variance   WHERE session_id = $1) AS variance`,
      [documentId],
    );
    return {
      sessions: Number(row?.sessions ?? 0),
      submissions: Number(row?.submissions ?? 0),
      variance: Number(row?.variance ?? 0),
    };
  };

  const seedItem = async (
    sku: string,
    onHand: number | null,
    opts: { warehouse?: string; deleted?: boolean } = {},
  ): Promise<void> => {
    await db.query(
      `INSERT INTO items_cache (sku, name, warehouse_code, unit, on_hand, deleted_at)
            VALUES ($1, $2, $3, 'กล่อง', $4::numeric, $5)
       ON CONFLICT (sku) DO UPDATE
              SET on_hand = EXCLUDED.on_hand,
                  warehouse_code = EXCLUDED.warehouse_code,
                  deleted_at = EXCLUDED.deleted_at`,
      [
        sku,
        `สินค้า ${sku}`,
        opts.warehouse ?? WH,
        onHand === null ? null : onHand.toFixed(3),
        opts.deleted === true ? new Date() : null,
      ],
    );
  };

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
            VALUES ($1, 'พนักงานคลัง', '$argon2id$fake', 'staff', $2)`,
      [EMP, WH],
    );
    // ค่าเริ่มต้น: ไม่มี writeback service = เส้นทางเขียนกลับ ERP ปิดอยู่
    svc = new CountDocumentService(db, testConfigService());
  });

  // ── สร้างเอกสาร ────────────────────────────────────────────────────────

  it('ส่งใบใหม่ 3 บรรทัด → 1 เอกสาร adhoc ที่ปิดแล้ว + submissions 3 + closed_variance 3', async () => {
    await seedItem('A-001', 10);
    await seedItem('A-002', 20);
    await seedItem('A-003', 5);

    const result = await svc.create(
      body([line(1, 'A-001', 10, 10), line(2, 'A-002', 20, 19), line(3, 'A-003', 5, 8)]),
      staff,
    );

    expect(result.documentId).toBe(DOC);
    expect(result.lineCount).toBe(3);
    expect(await counts()).toEqual({ sessions: 1, submissions: 3, variance: 3 });

    const session = await db.one<{
      kind: string;
      status: string;
      warehouse_code: string;
      closed_by: string;
      opened_at: Date;
      closed_at: Date;
    }>(
      `SELECT kind, status, warehouse_code, closed_by, opened_at, closed_at
         FROM count_sessions WHERE id = $1`,
      [DOC],
    );
    expect(session?.kind).toBe('adhoc');
    expect(session?.status).toBe('closed');
    expect(session?.warehouse_code).toBe(WH);
    expect(session?.closed_by).toBe(EMP);
    expect(session?.closed_at.getTime()).toBe(session?.opened_at.getTime());

    const statuses = await db.query<{ sku: string; status: string; diff: string }>(
      `SELECT sku, status::text AS status, diff::text AS diff
         FROM closed_variance WHERE session_id = $1 ORDER BY sku`,
      [DOC],
    );
    expect(statuses.rows.map((r) => [r.sku, r.status])).toEqual([
      ['A-001', 'match'],
      ['A-002', 'short'],
      ['A-003', 'over'],
    ]);
  });

  it('⭐ diff ในคำตอบคือ countedQty − systemQty (ทิศของจอ) — นับได้ 19 จากยอดระบบ 20 = −1', async () => {
    await seedItem('B-001', 20);
    const result = await svc.create(body([line(1, 'B-001', 20, 19)]), staff);
    expect(result.lines[0]).toEqual({ sku: 'B-001', systemQty: 20, countedQty: 19, diff: -1 });
  });

  it('⭐ ในคำตอบต้องไม่มีฟิลด์ชื่อ difQty / DifQty ที่ไหนเลย', async () => {
    await seedItem('B-002', 5);
    const result = await svc.create(body([line(1, 'B-002', 5, 3)]), staff);
    expect(JSON.stringify(result)).not.toMatch(/difqty/i);
  });

  it('รับทศนิยม 3 ตำแหน่งได้ครบ ไม่ปัดทิ้ง', async () => {
    await seedItem('B-003', 10.5);
    const result = await svc.create(body([line(1, 'B-003', 10.5, 10.25)]), staff);
    expect(result.lines[0].diff).toBeCloseTo(-0.25, 3);
  });

  // ── ส่งซ้ำ (idempotency) ───────────────────────────────────────────────

  it('⭐ ส่งซ้ำด้วย documentId เดิม + payload เดิม → คืนใบเดิม ไม่เกิดแถวซ้ำ', async () => {
    await seedItem('C-001', 10);
    const first = await svc.create(body([line(1, 'C-001', 10, 7)]), staff);
    const second = await svc.create(body([line(1, 'C-001', 10, 7)]), staff);

    expect(second.lines).toEqual(first.lines);
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });
  });

  it('ส่งซ้ำแบบสลับลำดับบรรทัด ยังถือว่าเป็น payload เดิม', async () => {
    await seedItem('C-002', 10);
    await seedItem('C-003', 4);
    await svc.create(body([line(1, 'C-002', 10, 9), line(2, 'C-003', 4, 4)]), staff);

    const replay = await svc.create(
      body([line(2, 'C-003', 4, 4), line(1, 'C-002', 10, 9)]),
      staff,
    );
    expect(replay.lines.map((l) => l.sku)).toEqual(['C-003', 'C-002']);
    expect(await counts()).toEqual({ sessions: 1, submissions: 2, variance: 2 });
  });

  it('⭐ documentId เดิมแต่ payload ต่าง → 409 DOCUMENT_PAYLOAD_MISMATCH และไม่ทับของเดิม', async () => {
    await seedItem('C-004', 10);
    await svc.create(body([line(1, 'C-004', 10, 7)]), staff);

    const err = await svc.create(body([line(1, 'C-004', 10, 9)]), staff).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DOCUMENT_PAYLOAD_MISMATCH',
    });

    const stored = await db.one<{ counted_qty: string }>(
      `SELECT final_counted_qty::text AS counted_qty FROM closed_variance WHERE session_id = $1`,
      [DOC],
    );
    expect(Number(stored?.counted_qty)).toBe(7); // ของเดิมยังอยู่
  });

  it('documentId เดิมแต่จำนวนบรรทัดต่างกัน → 409 DOCUMENT_PAYLOAD_MISMATCH', async () => {
    await seedItem('C-005', 10);
    await seedItem('C-006', 10);
    await svc.create(body([line(1, 'C-005', 10, 7)]), staff);

    const err = await svc
      .create(body([line(1, 'C-005', 10, 7), line(2, 'C-006', 10, 7)]), staff)
      .catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DOCUMENT_PAYLOAD_MISMATCH',
    });
  });

  it('⭐ สองคำขอพร้อมกันด้วย documentId เดียวกัน → ได้เอกสารใบเดียว', async () => {
    await seedItem('C-007', 10);
    const payload = body([line(1, 'C-007', 10, 6)]);

    const [a, b] = await Promise.all([svc.create(payload, staff), svc.create(payload, staff)]);
    expect(a.lines).toEqual(b.lines);
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });
  });

  // ── ยอดระบบขยับ (drift) ────────────────────────────────────────────────

  it('⭐ systemQtyShown ไม่ตรง items_cache → 409 SYSTEM_QTY_DRIFT และไม่มีแถวใดถูกเขียน', async () => {
    await seedItem('D-001', 12); // ยอดจริงขยับไปเป็น 12 แล้ว
    const err = await svc.create(body([line(1, 'D-001', 10, 8)]), staff).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'SYSTEM_QTY_DRIFT',
      drifted: [{ sku: 'D-001', shown: 10, actual: 12 }],
    });
    expect(await counts()).toEqual({ sessions: 0, submissions: 0, variance: 0 });
  });

  it('⭐ ยิงซ้ำด้วย acceptSystemQtyDrift + documentId เดิม → สำเร็จ และใช้ยอดของ server', async () => {
    await seedItem('D-002', 12);
    await expect(svc.create(body([line(1, 'D-002', 10, 8)]), staff)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const result = await svc.create(
      body([line(1, 'D-002', 10, 8)], { acceptSystemQtyDrift: true }),
      staff,
    );
    expect(result.lines[0]).toEqual({ sku: 'D-002', systemQty: 12, countedQty: 8, diff: -4 });

    const stored = await db.one<{ frozen: string }>(
      `SELECT frozen_on_hand::text AS frozen FROM closed_variance WHERE session_id = $1`,
      [DOC],
    );
    expect(Number(stored?.frozen)).toBe(12); // ⭐ ค่าจาก server ไม่ใช่ 10 ที่ client ส่งมา
  });

  it('ยืนยันทับ drift แล้วต้องมีหลักฐานใน audit_log ว่าใครยืนยันอะไร', async () => {
    await seedItem('D-003', 12);
    await svc.create(body([line(1, 'D-003', 10, 8)], { acceptSystemQtyDrift: true }), staff);

    const audit = await db.one<{ actor: string; payload: { acceptedSystemQtyDrift: unknown } }>(
      `SELECT actor, payload FROM audit_log WHERE action = 'count.document_created'`,
    );
    expect(audit?.actor).toBe(EMP);
    expect(audit?.payload.acceptedSystemQtyDrift).toEqual([
      { sku: 'D-003', shown: 10, actual: 12 },
    ]);
  });

  // ── การปฏิเสธรายบรรทัด ─────────────────────────────────────────────────

  it('⭐ on_hand IS NULL → 400 ITEM_NO_SYSTEM_QTY ไม่แปลงเป็น 0', async () => {
    await seedItem('E-001', null);
    const err = await svc.create(body([line(1, 'E-001', 0, 3)]), staff).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ITEM_NO_SYSTEM_QTY',
      noSystemQty: ['E-001'],
    });
    expect(await counts()).toEqual({ sessions: 0, submissions: 0, variance: 0 });
  });

  it('⭐ sku ซ้ำในใบเดียว → 400 DUPLICATE_SKU ปฏิเสธทั้งใบ', async () => {
    await seedItem('E-002', 10);
    const err = await svc
      .create(body([line(1, 'E-002', 10, 3), line(2, 'E-002', 10, 4)]), staff)
      .catch((e: unknown) => e);

    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'DUPLICATE_SKU',
      duplicates: ['E-002'],
    });
    expect(await counts()).toEqual({ sessions: 0, submissions: 0, variance: 0 });
  });

  it('สินค้าคลังอื่น → ปฏิเสธทั้งใบ', async () => {
    await seedItem('E-003', 10, { warehouse: 'WH-OTHER' });
    const err = await svc.create(body([line(1, 'E-003', 10, 3)]), staff).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ITEM_NO_SYSTEM_QTY',
      wrongWarehouse: ['E-003'],
    });
  });

  it('สินค้าที่ถูกลบจาก ERP แล้ว (tombstone) → ปฏิเสธทั้งใบ', async () => {
    await seedItem('E-004', 10, { deleted: true });
    const err = await svc.create(body([line(1, 'E-004', 10, 3)]), staff).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ITEM_NO_SYSTEM_QTY',
      deleted: ['E-004'],
    });
  });

  it('sku ที่ไม่มีใน items_cache → ปฏิเสธทั้งใบ', async () => {
    await seedItem('E-005', 10);
    const err = await svc
      .create(body([line(1, 'E-005', 10, 3), line(2, 'ไม่มีจริง', 1, 1)]), staff)
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ITEM_NO_SYSTEM_QTY',
      unknown: ['ไม่มีจริง'],
    });
    expect(await counts()).toEqual({ sessions: 0, submissions: 0, variance: 0 });
  });

  it('ไม่มีบรรทัดเลย → 400 EMPTY_LINES', async () => {
    const err = await svc.create(body([]), staff).catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'EMPTY_LINES' });
  });

  it('documentId ที่มี # → ถูกปฏิเสธก่อนแตะฐานข้อมูล (มาร์กเกอร์ TCL#<id># ฝั่ง ERP)', async () => {
    await seedItem('E-006', 10);
    const err = await svc
      .create(body([line(1, 'E-006', 10, 3)], { documentId: 'DOC#1' }), staff)
      .catch((e: unknown) => e);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'VALIDATION' });
  });

  it('countedQty = 0 คือ "นับแล้วได้ศูนย์" ต้องบันทึกเป็น short ไม่ใช่ข้ามทิ้ง', async () => {
    await seedItem('E-007', 6);
    const result = await svc.create(body([line(1, 'E-007', 6, 0)]), staff);
    expect(result.lines[0]).toEqual({ sku: 'E-007', systemQty: 6, countedQty: 0, diff: -6 });

    const stored = await db.one<{ status: string }>(
      `SELECT status::text AS status FROM closed_variance WHERE session_id = $1`,
      [DOC],
    );
    expect(stored?.status).toBe('short');
  });

  // ── ทางเชื่อม ERP (ทาง B: กดแล้วเข้า ERP เลย) ───────────────────────────

  it('⭐ ERP ปิดอยู่ → erp.status = disabled แต่เอกสารยังถูกบันทึกครบและตอบสำเร็จ', async () => {
    await seedItem('F-001', 10);
    const result = await svc.create(body([line(1, 'F-001', 10, 9)]), staff);

    expect(result.erp).toEqual({ status: 'disabled' });
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });
  });

  it('⭐ ยิง ERP สำเร็จ → erp.status = sent พร้อมเลขเอกสาร และเห็นบรรทัดที่ถูกส่งจริง', async () => {
    await seedItem('F-002', 10);
    const writer = new FakeWriter();
    const withErp = new CountDocumentService(
      db,
      testConfigService(),
      new ErpWritebackService(db, writer, testConfigService()),
    );

    const result = await withErp.create(body([line(1, 'F-002', 10, 7)]), staff);
    expect(result.erp.status).toBe('sent');
    expect(result.erp.voucherNo).toMatch(/^CNT-\d{4}-\d{4}$/);
    expect(result.erp.transactionNo).toBe(1);

    // ⭐ ยอดระบบที่ส่งเข้า ERP ต้องเป็นค่าของ server และแอปไม่เคยส่ง diff มาเลย
    expect(writer.calls[0].lines[0]).toMatchObject({
      sku: 'F-002',
      mainQty: 10,
      countQty: 7,
    });
    expect((await new ErpWritebackService(db, writer).status(DOC))?.status).toBe('sent');
  });

  it('⭐ ยิง ERP ล้ม → erp.status = failed แต่เอกสารยังอยู่ให้ retry ได้ (ห้าม rollback)', async () => {
    await seedItem('F-003', 10);
    const writer = new FakeWriter();
    writer.failWith = new Error('ERP ล่ม');
    const withErp = new CountDocumentService(
      db,
      testConfigService(),
      new ErpWritebackService(db, writer, testConfigService()),
    );

    const result = await withErp.create(body([line(1, 'F-003', 10, 7)]), staff);
    expect(result.erp.status).toBe('failed');
    // คนกดเป็น staff → ข้อความคงที่ (ข้อความเต็มอยู่ในเทสต์ถัดไป)
    expect(result.erp.message).toBe(ERP_FAILED_FOR_STAFF);
    expect(result.lines[0].diff).toBe(-3);
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });

    // retry ผ่านเส้นทางเดิมของผู้ดูแลต้องสำเร็จโดยไม่ต้องกรอกใหม่
    writer.failWith = null;
    const retry = await new ErpWritebackService(db, writer, testConfigService()).send(DOC, EMP);
    expect(retry.voucherNo).toBeDefined();
  });

  it('⭐ ยิง ERP ล้ม → staff ได้ข้อความคงที่ · admin ได้ข้อความเต็ม · log เต็มทั้งสองทาง', async () => {
    // ข้อความดิบแบบที่ไดรเวอร์ SQL Server คายออกมาจริง — มีชื่อ host/database/ชื่อ object ปน
    const RAW = 'Failed to connect to erp-sql.internal:1433 · TCLDB · tbl_CountHdr';
    await seedItem('F-009', 10);
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
            VALUES ($1, 'ผู้ดูแล', '$argon2id$fake', 'admin', $2)`,
      [ADMIN_EMP, WH],
    );
    const writer = new FakeWriter();
    writer.failWith = new Error(RAW);
    const withErp = new CountDocumentService(
      db,
      testConfigService(),
      new ErpWritebackService(db, writer, testConfigService()),
    );

    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const byStaff = await withErp.create(body([line(1, 'F-009', 10, 7)]), staff);
      // entryKey เป็น PK ทั้งตาราง (count_submissions.idempotency_key) → ใบที่สองต้องใช้คีย์ใหม่
      const byAdmin = await withErp.create(
        body([line(9, 'F-009', 10, 7)], { documentId: DOC_ADMIN }),
        admin,
      );

      // staff: ข้อความคงที่ และห้ามมีเศษของข้อความดิบหลุดไปในคำตอบทั้งก้อน
      expect(byStaff.erp.status).toBe('failed');
      expect(byStaff.erp.message).toBe(ERP_FAILED_FOR_STAFF);
      expect(JSON.stringify(byStaff)).not.toContain('erp-sql.internal');
      expect(JSON.stringify(byStaff)).not.toContain('TCLDB');

      // admin: ได้ข้อความเต็มเหมือนเดิม (ต้องใช้ดีบัก)
      expect(byAdmin.erp.status).toBe('failed');
      expect(byAdmin.erp.message).toContain(RAW);

      // ⭐ ทั้งสองกรณี ข้อความเต็มต้องอยู่ใน log ฝั่ง server — ห้ามกลืนข้อมูลดีบักทิ้ง
      const logLines = logged.mock.calls.map((call) => String(call[0]));
      expect(logLines.some((l) => l.includes(DOC) && l.includes(RAW))).toBe(true);
      expect(logLines.some((l) => l.includes(DOC_ADMIN) && l.includes(RAW))).toBe(true);
    } finally {
      logged.mockRestore();
    }

    // เอกสารของทั้งสองใบต้องยังอยู่ครบให้ retry ได้
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });
    expect(await counts(DOC_ADMIN)).toEqual({ sessions: 1, submissions: 1, variance: 1 });
  });

  it('⭐ ส่งซ้ำใบที่เข้า ERP ไปแล้ว → คืนเลขเอกสารเดิม ไม่เขียนซ้ำเข้า ERP', async () => {
    await seedItem('F-004', 10);
    const writer = new FakeWriter();
    const withErp = new CountDocumentService(
      db,
      testConfigService(),
      new ErpWritebackService(db, writer, testConfigService()),
    );

    const first = await withErp.create(body([line(1, 'F-004', 10, 7)]), staff);
    const second = await withErp.create(body([line(1, 'F-004', 10, 7)]), staff);

    expect(second.erp.status).toBe('sent');
    expect(second.erp.voucherNo).toBe(first.erp.voucherNo);
    expect(writer.calls).toHaveLength(1); // ⭐ ยิงไป ERP ครั้งเดียวตลอด
    expect(await counts()).toEqual({ sessions: 1, submissions: 1, variance: 1 });
  });
  // ── จอผู้ดูแล: แยก kind + รายการเอกสารที่ยังไม่เข้า ERP ─────────────────

  describe('จอผู้ดูแล', () => {
    /** รอบนับปกติ 1 รอบ — ห้ามไหลปนเข้ารายการเอกสาร และห้ามถูกอ่านผ่านเส้นทางเอกสาร */
    const SESSION_ID = 'CNT-2608-0001';
    const DOC_B = '0191f0c0-1111-7000-8000-000000000002';

    let count: CountService;

    beforeEach(() => {
      count = new CountService(db, testConfigService());
    });

    const seedNormalSession = async (): Promise<void> => {
      await db.query(
        `INSERT INTO count_sessions (id, kind, warehouse_code, status)
              VALUES ($1, 'session', $2, 'open')`,
        [SESSION_ID, WH],
      );
    };

    /** ปลอมสถานะการส่งของเอกสารใบหนึ่ง (ยังไม่มี ERP จริงให้ยิงในเทสต์ชุดนี้) */
    const seedWriteback = async (
      documentId: string,
      status: 'queued' | 'sent' | 'failed',
      lastError: string | null = null,
    ): Promise<void> => {
      await db.query(
        `INSERT INTO erp_writeback
           (session_id, status, transaction_no, voucher_no, attempts, last_error, sent_at)
         VALUES ($1, $2,
                 CASE WHEN $2 = 'sent' THEN 77 END,
                 CASE WHEN $2 = 'sent' THEN 'CNT-2608-0077' END,
                 1, $3,
                 CASE WHEN $2 = 'sent' THEN now() END)`,
        [documentId, status, lastError],
      );
    };

    const ids = (rows: { documentId: string }[]): string[] => rows.map((r) => r.documentId);

    it('⭐ รายการเอกสารต้องไม่มีรอบนับปกติปนมา (คนละเส้นทางกัน)', async () => {
      await seedNormalSession();
      await seedItem('G-001', 10);
      await svc.create(body([line(1, 'G-001', 10, 9)]), staff);

      const rows = await svc.list('all', 100, true);
      expect(ids(rows)).toEqual([DOC]);
    });

    it('⭐ status=pending = ยังไม่เข้า ERP — ใบที่ sent แล้วต้องหายไปจากรายการ', async () => {
      await seedItem('G-002', 10);
      await seedItem('G-003', 10);
      await svc.create(body([line(1, 'G-002', 10, 9)]), staff);
      await svc.create(body([line(2, 'G-003', 10, 9)], { documentId: DOC_B }), staff);
      await seedWriteback(DOC, 'sent');

      expect(ids(await svc.list('pending', 100, true))).toEqual([DOC_B]);
      expect(ids(await svc.list('sent', 100, true))).toEqual([DOC]);
      expect(ids(await svc.list('all', 100, true)).sort()).toEqual([DOC, DOC_B].sort());
    });

    it('⭐ ใบที่ยิงแล้วล้ม (failed) ยังต้องอยู่ใน pending — ไม่งั้นไม่มีใครรู้ว่าต้อง retry', async () => {
      await seedItem('G-004', 10);
      await svc.create(body([line(1, 'G-004', 10, 4)]), staff);
      await seedWriteback(DOC, 'failed', 'ต่อ SQL Server ไม่ได้');

      const rows = await svc.list('pending', 100, true);
      expect(rows).toHaveLength(1);
      expect(rows[0].erpStatus).toBe('failed');
      expect(rows[0].lastError).toBe('ต่อ SQL Server ไม่ได้');
    });

    it('ERP ปิดอยู่ → ทุกใบค้างสถานะ not_sent และยังนับจำนวนบรรทัดได้ถูกต้อง', async () => {
      await seedItem('G-005', 10);
      await seedItem('G-006', 20);
      await svc.create(body([line(1, 'G-005', 10, 9), line(2, 'G-006', 20, 20)]), staff);

      const rows = await svc.list('pending', 100, true);
      expect(rows[0]).toMatchObject({
        documentId: DOC,
        warehouseCode: WH,
        createdBy: EMP,
        lineCount: 2,
        erpStatus: 'not_sent',
        voucherNo: null,
        transactionNo: null,
        attempts: 0,
        sentAt: null,
      });
    });

    it('limit จำกัดจำนวนแถวที่คืน (จอผู้ดูแลเปิดค้างทั้งวัน ห้ามคืนทั้งตาราง)', async () => {
      await seedItem('G-007', 10);
      await seedItem('G-008', 10);
      await svc.create(body([line(1, 'G-007', 10, 9)]), staff);
      await svc.create(body([line(2, 'G-008', 10, 9)], { documentId: DOC_B }), staff);

      expect(await svc.list('pending', 1, true)).toHaveLength(1);
    });

    // ── สถานะรายใบ ───────────────────────────────────────────────────────

    it('⭐ staff เรียกดูสถานะเอกสาร → ต้องไม่มีคีย์ lastError เลย (มีชื่อ host/database ปนได้)', async () => {
      await seedItem('H-001', 10);
      await svc.create(body([line(1, 'H-001', 10, 9)]), staff);
      await seedWriteback(DOC, 'failed', 'Failed to connect to erp-sql.internal:1433 · TCLDB');

      const forStaff = await svc.detail(DOC, false);
      expect('lastError' in forStaff).toBe(false);
      expect(JSON.stringify(forStaff)).not.toContain('erp-sql.internal');
      expect(forStaff.erpStatus).toBe('failed');

      const forAdmin = await svc.detail(DOC, true);
      expect(forAdmin.lastError).toContain('erp-sql.internal');
    });

    it('สถานะเอกสารที่ส่งเข้า ERP แล้ว มีเลขเอกสารครบ', async () => {
      await seedItem('H-002', 10);
      await svc.create(body([line(1, 'H-002', 10, 9)]), staff);
      await seedWriteback(DOC, 'sent');

      const info = await svc.detail(DOC, false);
      expect(info).toMatchObject({
        erpStatus: 'sent',
        voucherNo: 'CNT-2608-0077',
        transactionNo: 77,
        lineCount: 1,
      });
      expect(info.sentAt).not.toBeNull();
    });

    it('⭐ ขอสถานะด้วย id ของรอบนับปกติ → 404 DOCUMENT_NOT_FOUND (ไม่รั่วข้ามเส้นทาง)', async () => {
      await seedNormalSession();
      const err = await svc.detail(SESSION_ID, true).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'DOCUMENT_NOT_FOUND',
      });
    });

    it('เอกสารที่ไม่มีอยู่จริง → 404 · รหัสผิดรูป → 400 VALIDATION', async () => {
      await expect(svc.detail(DOC_B, true)).rejects.toBeInstanceOf(NotFoundException);
      const bad = await svc.detail('DOC#1', true).catch((e: unknown) => e);
      expect((bad as BadRequestException).getResponse()).toMatchObject({ code: 'VALIDATION' });
    });

    // ── เส้นทางรอบนับต้องไม่ยุ่งกับเอกสาร adhoc ───────────────────────────

    it('⭐ รายงานส่วนต่าง + CSV ของเอกสาร adhoc ใช้ได้ทันทีโดยไม่ต้องแก้อะไร', async () => {
      await seedItem('I-001', 10);
      await seedItem('I-002', 4);
      await svc.create(body([line(1, 'I-001', 10, 7), line(2, 'I-002', 4, 4)]), staff);

      const rows = await count.variance(DOC);
      expect(rows.map((r) => [r.sku, r.diff])).toEqual([
        ['I-001', -3],
        ['I-002', 0],
      ]);

      const csv = await count.varianceCsv(DOC);
      expect(csv.startsWith('﻿')).toBe(true);
      expect(csv).toContain('I-001');
      expect(csv).toContain('ขาด');
      expect(csv.trimEnd().split('\r\n')).toHaveLength(3); // header + 2 บรรทัด
    });

    it('⭐ ยิงผลนับต่อท้ายเอกสาร adhoc ไม่ได้ → SESSION_NOT_FOUND (ห้ามต่อบรรทัดทีหลัง)', async () => {
      await seedItem('I-003', 10);
      await svc.create(body([line(1, 'I-003', 10, 7)]), staff);

      const res = await count.submit(
        DOC,
        [
          {
            idempotencyKey: key(9),
            sku: 'I-003',
            countedQty: 99,
            countedAt: '2026-08-27T10:00:00+07:00',
            deviceSeq: 1,
          },
        ],
        EMP,
        DEVICE,
      );
      expect(res).toEqual([
        { idempotencyKey: key(9), status: 'rejected', code: 'SESSION_NOT_FOUND' },
      ]);

      const stored = await db.one<{ counted: string }>(
        `SELECT final_counted_qty::text AS counted FROM closed_variance WHERE session_id = $1`,
        [DOC],
      );
      expect(Number(stored?.counted)).toBe(7); // ตัวเลขเดิมไม่ถูกแตะ
    });

    it('⭐ เอกสาร adhoc ไม่โผล่ในเส้นทางรอบนับ (session / activeSession / close / conflicts)', async () => {
      await seedItem('I-004', 10);
      await svc.create(body([line(1, 'I-004', 10, 7)]), staff);

      expect(await count.session(DOC)).toBeNull();
      expect(await count.activeSession(WH)).toBeNull();
      await expect(count.closeSession(DOC, EMP)).rejects.toBeInstanceOf(NotFoundException);
      await expect(count.conflicts(DOC)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('เปิดรอบนับปกติแล้วแถวต้องมี kind = session (ไม่พึ่ง DEFAULT ของคอลัมน์)', async () => {
      await db.query(
        `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code)
              VALUES ('52199', 'ผู้ดูแล', '$argon2id$fake', 'admin', $1)`,
        [WH],
      );
      await seedItem('I-005', 10);

      // ยังไม่เคย sync สำเร็จในเทสต์นี้ → ต้องยืนยัน allowStaleCache เหมือน admin ตัวจริง
      const session = await count.openSession({ allowStaleCache: true }, '52199');
      const row = await db.one<{ kind: string }>(
        `SELECT kind FROM count_sessions WHERE id = $1`,
        [session.id],
      );
      expect(row?.kind).toBe('session');
    });
  });
});
