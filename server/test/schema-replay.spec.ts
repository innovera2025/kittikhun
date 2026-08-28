import type { PostgresService } from '../src/db/postgres.service';
import { applySchema, describeWithDb, makeDb, truncateAll } from './support/test-db';

/**
 * schema.sql ต้อง replay ซ้ำได้ + ด่านของ count_sessions.kind ต้องบังคับที่ฐานข้อมูลจริง
 *
 * สิ่งที่พังแล้วเสียหายจริง:
 *   - replay รอบสองล้ม → deploy ครั้งถัดไปหยุดกลางทาง (npm run migrate = psql replay ทั้งไฟล์)
 *   - เอกสาร adhoc ที่เผลอเป็น status='open' → ux_count_sessions_open บล็อกการเปิดรอบทั้งคลัง
 *   - id ที่มี '#' → มาร์กเกอร์ TCL#<id># ฝั่ง ERP จับข้ามเอกสาร = คืนเลขเอกสารผิดใบ
 */
describeWithDb('schema.sql — replay + ด่าน count_sessions.kind', () => {
  let db: PostgresService;

  beforeAll(async () => {
    db = makeDb();
    // replay 3 รอบติด — รอบ 2/3 คือของจริงที่ deploy เจอ (ตารางมีอยู่แล้ว)
    await applySchema(db);
    await applySchema(db);
    await applySchema(db);
  }, 60_000);

  afterAll(async () => {
    await truncateAll(db);
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  const insert = (id: string, status: 'open' | 'closed', kind: string, warehouse = 'WHRM') =>
    db.query(
      `INSERT INTO count_sessions (id, warehouse_code, status, kind, opened_at, closed_at)
       VALUES ($1, $2, $3::count_session_status, $4::text, now(), CASE WHEN $5::boolean THEN now() END)`,
      [id, warehouse, status, kind, status === 'closed'],
    );

  it('แถวที่ไม่ระบุ kind ได้ค่า default session', async () => {
    await db.query(
      `INSERT INTO count_sessions (id, warehouse_code, status, opened_at) VALUES ('S1', 'WHRM', 'open', now())`,
    );
    const rows = await db.query<{ kind: string }>(`SELECT kind FROM count_sessions WHERE id = 'S1'`);
    expect(rows.rows[0]?.kind).toBe('session');
  });

  it('ปฏิเสธ kind นอกเหนือ session/adhoc', async () => {
    await expect(insert('S2', 'closed', 'weird')).rejects.toThrow(/count_sessions_kind_ok/);
  });

  it('ปฏิเสธเอกสาร adhoc ที่ยังไม่ปิด (ห้ามไปกิน slot ของ ux_count_sessions_open)', async () => {
    await expect(insert('A1', 'open', 'adhoc')).rejects.toThrow(
      /count_sessions_adhoc_born_closed/,
    );
  });

  it('เอกสาร adhoc ปิดแล้ว 2 ใบในคลังเดียวกัน + รอบนับที่เปิดอยู่ อยู่ร่วมกันได้', async () => {
    await insert('A2', 'closed', 'adhoc');
    await insert('A3', 'closed', 'adhoc');
    await insert('S3', 'open', 'session');
    const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM count_sessions`);
    expect(rows.rows[0]?.n).toBe('3');
  });

  it('ปฏิเสธ id ที่มี #', async () => {
    await expect(insert('BAD#1', 'closed', 'adhoc')).rejects.toThrow(/count_sessions_id_no_hash/);
  });

  it('มี index สำหรับ query เอกสาร adhoc', async () => {
    const rows = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'count_sessions'`,
    );
    const names = rows.rows.map((r) => r.indexname);
    expect(names).toContain('idx_count_sessions_adhoc');
    // ด่านเดิมต้องยังอยู่ครบ
    expect(names).toContain('ux_count_sessions_open');
    expect(names).toContain('ux_count_sessions_erp_txn');
  });
});
