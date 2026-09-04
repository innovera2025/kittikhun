import { BadRequestException } from '@nestjs/common';

import { MembersService } from '../src/members/members.service';
import type { PostgresService } from '../src/db/postgres.service';
import { applySchema, describeWithDb, makeDb, truncateAll } from './support/test-db';

/**
 * ด่าน last-admin ของ `MembersService.changeRole` — ประตูที่ **มนุษย์** ลดสิทธิ์กันเองได้
 *
 * ทำไมต้องมีไฟล์นี้: รอบ sync ปิดล็อกอินคนที่ออกจาก ERP ด้วยการลบ **เฉพาะแถว
 * `user_credentials`** และไม่แตะแถว `users` เลย (FK 9 ตารางชี้มา และ count_submissions
 * เป็น ON DELETE RESTRICT) คนที่ออกไปแล้วจึงค้างเป็น `role='admin'` ใน `users` ตลอดกาล
 * ทั้งที่ล็อกอินไม่ได้ — ถ้าด่านนี้นับ admin จาก `users` ล้วน ๆ "admin ผี" พวกนั้นจะถูก
 * นับเป็นตาข่าย แล้ว UI สมาชิกจะยอมลดสิทธิ์ admin ตัวจริงคนสุดท้าย = ไม่มีใครเข้าระบบได้อีก
 *
 * ต้องใช้ Postgres จริงเพราะสิ่งที่พิสูจน์คือผลของ `SELECT ... FOR UPDATE OF u` ที่ JOIN
 * `user_credentials` และ CHECK/FK ของสองตารางนั้น — mock DB พิสูจน์ไม่ได้
 *
 * ไม่ตั้ง `TEST_DATABASE_URL` → `describeWithDb` ข้ามทั้ง suite เหมือนชุด DB อื่นของ repo นี้
 */
describeWithDb('เปลี่ยนสิทธิ์สมาชิก — ด่าน last-admin', () => {
  let db: PostgresService;
  let members: MembersService;

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
    members = new MembersService(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  /**
   * `withCredential: false` = "admin ผี" — แถว users ยังอยู่แต่ credential ถูกลบไปแล้ว
   *
   * ⚠️ secret_hash เป็นค่าปลอมที่แค่ผ่าน CHECK `user_credentials_hash_argon` โดยตั้งใจ
   *    เคสนี้ไม่แตะการล็อกอินเลย ขอแค่ "มีแถว credential อยู่จริง" (argon2 จริงกิน ~250ms/ครั้ง)
   */
  async function seed(
    empId: string,
    role: 'admin' | 'staff',
    withCredential: boolean,
  ): Promise<void> {
    await db.query(
      `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
       VALUES ($1, $2, $3::user_role, 'กะเช้า · A', 'WH01', false)`,
      [empId, `พนักงาน ${empId}`, role],
    );
    if (!withCredential) return;
    await db.query(
      `INSERT INTO user_credentials (login_name, emp_id, secret_hash, source)
       VALUES ($1, $2, '$argon2id$ค่าปลอมสำหรับเทสต์', 'local')`,
      [empId.toLowerCase(), empId],
    );
  }

  const roleOf = async (empId: string): Promise<string | undefined> =>
    (await db.one<{ role: string }>(`SELECT role FROM users WHERE emp_id = $1`, [empId]))?.role;

  it('⭐ admin ผี (ไม่มี credential แล้ว) ไม่ใช่ตาข่าย → ลดสิทธิ์ admin ตัวจริงคนสุดท้ายไม่ได้', async () => {
    await seed('A001', 'admin', true); //  admin ตัวจริงคนเดียวที่ล็อกอินได้
    await seed('G001', 'admin', false); // ออกจาก ERP ไปแล้ว แถว users ยังค้างเป็น admin

    await expect(members.changeRole('A001', 'staff', 'A001')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // ห้ามเขียนอะไรลงไปเลยเมื่อด่านปฏิเสธ
    expect(await roleOf('A001')).toBe('admin');
  });

  it('มี admin ตัวจริงเหลืออีกคน → ลดสิทธิ์ได้ตามปกติ (ด่านต้องไม่กันเกินเหตุ)', async () => {
    await seed('A001', 'admin', true);
    await seed('A002', 'admin', true);

    const res = await members.changeRole('A001', 'staff', 'A002');

    expect(res).toEqual({ empId: 'A001', role: 'staff' });
    expect(await roleOf('A001')).toBe('staff');
  });

  it('ลดสิทธิ์ admin ผีเองได้ ตราบใดที่ยังมี admin ตัวจริงเหลืออยู่ (เก็บกวาด roster)', async () => {
    await seed('A001', 'admin', true);
    await seed('G001', 'admin', false);

    const res = await members.changeRole('G001', 'staff', 'A001');

    expect(res).toEqual({ empId: 'G001', role: 'staff' });
    expect(await roleOf('A001')).toBe('admin');
  });
});
