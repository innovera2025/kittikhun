import { inspect } from 'node:util';

import { DEFAULT_USERS_SQL, toErpUserRow } from '../src/erp/drivers/mssql.driver';
import { assertReadOnlySql } from '../src/erp/erp-adapter';
import { ErpSecret } from '../src/erp/erp-secret';

/**
 * แถวจาก `menuuser` → `ErpUserRow` — **จุดเดียวในระบบที่ plaintext ของ ERP ข้ามเข้ามา**
 *
 * ทำไมต้องมีไฟล์นี้: เทสต์รอบ sync (`users-sync.spec.ts`) ใช้ ERP ปลอมที่ fixture ถูกห่อเป็น
 * `ErpSecret` มาให้เรียบร้อยแล้ว → บรรทัดที่ห่อค่าจริงจาก ERP ไม่เคยถูกเทสต์แตะเลยสักครั้ง
 * ถ้ามีใครแก้บรรทัดนั้นเป็น string ดิบ จะไม่มีอะไรแดง จนกว่ารหัสผ่านจะไปโผล่ใน log/anomaly
 * ของจริง ซึ่ง `audit_log` เป็น append-only ที่ระดับ engine — รั่วแล้วลบคืนไม่ได้เลย
 *
 * mapping ถูกแยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้เทสต์ชุดนี้ไม่ต้องมี SQL Server จริง
 * (ทุกอย่างที่ต้องพิสูจน์อยู่ในตัวการแปลงค่า ไม่ได้อยู่ในตัว connection)
 */
describe('toErpUserRow — แถว menuuser ที่ข้ามเข้าระบบเรา', () => {
  const PLAINTEXT = 'ลับสุดยอด-Pa55word!';
  const MASK = '[ErpSecret]';

  const rawRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    login_name: 'somchai.k',
    password: PLAINTEXT,
    user_level: '9',
    name_thai: 'สมชาย เก่งมาก',
    emp_code: 'E001',
    ...over,
  });

  it('map ครบทุกคอลัมน์ตามสัญญาของ ErpUserRow', () => {
    const row = toErpUserRow(rawRow());

    expect(row.loginName).toBe('somchai.k');
    expect(row.userLevel).toBe('9');
    expect(row.nameThai).toBe('สมชาย เก่งมาก');
    expect(row.empCode).toBe('E001');
  });

  it('⭐ password ถูกห่อเป็น ErpSecret ตั้งแต่บรรทัดที่ข้าม boundary ของ driver', () => {
    const row = toErpUserRow(rawRow());

    // ห้ามเป็น string ดิบเด็ดขาด — `instanceof` คือสิ่งเดียวที่แยกสองอย่างนี้ออกจากกันได้
    expect(row.password).toBeInstanceOf(ErpSecret);
    expect(typeof row.password).not.toBe('string');
    // และต้องเป็นค่าจริง ไม่ใช่ค่าที่เพี้ยนไประหว่างทาง (ไม่งั้นคนนั้นล็อกอินไม่ได้ตลอดไป)
    expect(row.password.expose()).toBe(PLAINTEXT);
  });

  it('🚫 JSON.stringify / util.inspect / template literal ของแถวที่ map แล้ว ต้องไม่มี plaintext', () => {
    const row = toErpUserRow(rawRow());

    // เส้นทางที่ payload ของ audit_log และ sync_runs.anomalies วิ่งผ่านจริง
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(row)).toContain(MASK);
    // เส้นทางของ Nest Logger / console.log / debug dump
    expect(inspect(row, { depth: 5 })).not.toContain(PLAINTEXT);
    // เส้นทางที่พลาดง่ายที่สุด: log บรรทัดเดียวที่เผลอใส่ทั้งแถวลงไป
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`แถวจาก ERP: ${row.password}`).toBe(`แถวจาก ERP: ${MASK}`);
    // ทั้งอาเรย์แบบที่ fetchUsers() คืนออกไปจริงก็ต้องสะอาดเหมือนกัน
    expect(JSON.stringify([toErpUserRow(rawRow()), toErpUserRow(rawRow())])).not.toContain(
      PLAINTEXT,
    );
  });

  it('⭐ ห้าม trim รหัสผ่าน — ERP เทียบ a_Password แบบ string เป๊ะ ช่องว่างท้ายมีความหมาย', () => {
    const padded = '  รหัสมีช่องว่าง  ';

    expect(toErpUserRow(rawRow({ password: padded })).password.expose()).toBe(padded);
  });

  it('คอลัมน์ที่ไม่ใช่ scalar → สตริงว่าง ไม่ใช่ "[object Object]"', () => {
    // ค่าจาก ERP เป็น unknown จริง ๆ (NULL / Buffer / object ได้ทั้งนั้น) — ถ้าเผลอ String()
    // จะได้ค่าที่ "ดูเหมือนมี" แล้วถูก hash เก็บเป็นรหัสผ่านของคนนั้นไปตลอด
    const row = toErpUserRow(rawRow({ password: null, emp_code: { weird: true } }));

    expect(row.password).toBeInstanceOf(ErpSecret);
    expect(row.password.expose()).toBe('');
    expect(row.empCode).toBe('');
  });
});

describe('DEFAULT_USERS_SQL — query ดึงผู้ใช้ที่ใช้เมื่อไม่ได้ตั้งไฟล์ .sql', () => {
  it('⭐ ผ่านกฎเหล็กชั้นที่ 3 (assertReadOnlySql) เหมือน script จากภายนอกทุกประการ', () => {
    // ค่า default ของเราเองก็ต้องผ่าน guard — ไม่มีทางลัดให้ statement ของ "ฝั่งเรา"
    expect(() => assertReadOnlySql(DEFAULT_USERS_SQL)).not.toThrow();
  });

  it('ไม่มีตัวคั่นแบตช์ GO (driver ปฏิเสธ script ที่มี GO)', () => {
    expect(/^\s*GO\s*$/im.test(DEFAULT_USERS_SQL)).toBe(false);
  });

  it('alias ครบทั้ง 5 คอลัมน์ที่ toErpUserRow อ่าน — ชื่อไม่ตรง = ได้แถวว่างเปล่าเงียบ ๆ', () => {
    for (const column of ['login_name', 'password', 'user_level', 'name_thai', 'emp_code']) {
      expect(DEFAULT_USERS_SQL).toContain(column);
    }
  });
});
