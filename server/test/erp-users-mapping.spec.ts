import { inspect } from 'node:util';

import { MockDriver } from '../src/erp/drivers/mock.driver';
import {
  DEFAULT_USER_LOGIN_SQL,
  DEFAULT_USERS_SQL,
  toErpUserRow,
} from '../src/erp/drivers/mssql.driver';
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

  it('⭐ ตัวตนมาจาก user_name (USERID) ไม่ใช่ emp_id — บน ERP จริง Employee มี 0 แถว', () => {
    // query ต้นฉบับของเจ้าของระบบ alias `user_name As USERID` = user_name คือตัวตน
    // ส่วน `emp_id` เป็นแค่ join key เข้า `Employee` ซึ่งว่างทั้งตาราง → emp_id ว่างทุกแถว
    // ถ้าใครเปลี่ยนบรรทัดนี้กลับไปเป็น `emp_id AS emp_code` ผู้ใช้จะถูกปฏิเสธ 100%
    // ด้วย EMP_CODE_RE แล้วไม่มีใครล็อกอินได้เลยสักคน
    expect(DEFAULT_USERS_SQL).toMatch(/user_name\s+AS\s+emp_code/i);
    expect(DEFAULT_USERS_SQL).toMatch(/user_name\s+AS\s+login_name/i);
    expect(DEFAULT_USERS_SQL).not.toMatch(/\bemp_id\b/i);
    // และ LEFT JOIN Employee/EmpPict ต้องไม่ถูกใส่กลับมา (ได้ NULL ทุกแถว + ไม่มีที่ลง)
    expect(DEFAULT_USERS_SQL).not.toMatch(/employee|emppict/i);
  });
});

/**
 * `DEFAULT_USER_LOGIN_SQL` — query **ตอนล็อกอิน** ที่ลูกค้าเขียนมาเอง
 *
 * ต่างจาก `DEFAULT_USERS_SQL` ตรงที่มันคือ "หาคนที่กำลังล็อกอินหนึ่งคน" (`WHERE user_name = ?cUser`)
 * ไม่ใช่ "กวาดรายชื่อทั้งตาราง" — และตั้งแต่ 5 ก.ย. 2569 เส้นทางล็อกอินใช้ตัวนี้ตัวเดียว
 */
describe('DEFAULT_USER_LOGIN_SQL — query ล็อกอินทีละคนตามต้นฉบับของลูกค้า', () => {
  it('⭐ ผ่านกฎเหล็กชั้นที่ 3 (assertReadOnlySql)', () => {
    expect(() => assertReadOnlySql(DEFAULT_USER_LOGIN_SQL)).not.toThrow();
  });

  it('🔴 ชื่อผู้ใช้ถูก**ผูกเป็นพารามิเตอร์** ไม่ใช่ต่อสตริงเข้า SQL (ขอบเขต SQL injection)', () => {
    // ชื่อผู้ใช้มาจากช่องกรอกบนมือถือ = input ภายนอกล้วน ๆ · ถ้าวันไหนมีคนเปลี่ยนบรรทัดนี้
    // เป็น template literal ใส่ค่าเข้าไปตรง ๆ ERP ทั้งตัวจะเปิดให้ยิงคำสั่งอะไรก็ได้
    expect(DEFAULT_USER_LOGIN_SQL).toMatch(/WHERE\s+user_name\s*=\s*@cUser/i);
    // ห้ามมี placeholder แบบต่อสตริง (`${...}` / `'+'` / `?`) หลงเหลืออยู่
    expect(DEFAULT_USER_LOGIN_SQL).not.toContain('${');
    expect(DEFAULT_USER_LOGIN_SQL).not.toContain('?cUser');
    expect(DEFAULT_USER_LOGIN_SQL).not.toMatch(/=\s*'/);
  });

  it('คง WITH (NOLOCK) ทั้งสองตาราง และ LEFT OUTER JOIN Employee ตามที่ลูกค้าเขียน', () => {
    // ลูกค้ายืนยันรูปนี้ — `Employee` ว่างทั้งตารางบน ERP จริง แต่เป็น LEFT JOIN จึงไม่ตัดใครทิ้ง
    expect(DEFAULT_USER_LOGIN_SQL.match(/WITH\s*\(NOLOCK\)/gi)).toHaveLength(2);
    expect(DEFAULT_USER_LOGIN_SQL).toMatch(
      /LEFT\s+OUTER\s+JOIN\s+Employee\s+WITH\s*\(NOLOCK\)\s+ON\s+menuuser\.emp_id\s*=\s*Employee\.EmployeeCode/i,
    );
    expect(DEFAULT_USER_LOGIN_SQL).toMatch(/ORDER\s+BY\s+User_Name/i);
  });

  it('alias ครบทั้ง 5 คอลัมน์ที่ toErpUserRow อ่าน และตัวตนมาจาก user_name', () => {
    for (const column of ['login_name', 'password', 'user_level', 'name_thai', 'emp_code']) {
      expect(DEFAULT_USER_LOGIN_SQL).toContain(column);
    }
    expect(DEFAULT_USER_LOGIN_SQL).toMatch(/user_name\s+AS\s+emp_code/i);
  });

  it('ไม่มีตัวคั่นแบตช์ GO', () => {
    expect(/^\s*GO\s*$/im.test(DEFAULT_USER_LOGIN_SQL)).toBe(false);
  });
});

/**
 * `MockDriver.fetchUserByLogin()` — เส้นทางล็อกอินของ `ERP_DRIVER=mock` (dev/CI/demo)
 * ต้องมีพฤติกรรมเดียวกับของจริงในสามข้อที่มีผลต่อผลลัพธ์: ไม่สนตัวพิมพ์ · ไม่พบ = null ·
 * รหัสผ่านห่อด้วย ErpSecret
 */
describe('MockDriver.fetchUserByLogin — ผู้ใช้คนเดียวตอนล็อกอิน', () => {
  const driver = new MockDriver();

  it('พบชื่อผู้ใช้ → คืนแถวเดียวที่ password ถูกห่อเป็น ErpSecret', async () => {
    const row = await driver.fetchUserByLogin('somchai.a');

    expect(row).not.toBeNull();
    expect(row?.loginName).toBe('somchai.a');
    expect(row?.password).toBeInstanceOf(ErpSecret);
    expect(JSON.stringify(row)).not.toContain(row?.password.expose() ?? 'ไม่มีค่า');
  });

  it('⭐ ไม่สนตัวพิมพ์ใหญ่เล็ก (menuuser อยู่บน collation Thai_CI_AS)', async () => {
    // fixture มี `Suda.K` ตัวพิมพ์ผสมไว้เพื่อเคสนี้โดยเฉพาะ
    const upper = await driver.fetchUserByLogin('SUDA.K');
    const lower = await driver.fetchUserByLogin('suda.k');

    expect(upper?.loginName).toBe('Suda.K');
    expect(lower?.loginName).toBe('Suda.K');
  });

  it('ไม่พบ / ชื่อว่าง → null (ไม่ใช่ throw และไม่ใช่แถวเปล่า)', async () => {
    // `null` = "ERP ไม่มีคนนี้ → เข้าไม่ได้" ส่วน throw สงวนไว้ให้ "ต่อ ERP ไม่ได้" เท่านั้น
    await expect(driver.fetchUserByLogin('ไม่มีคนนี้')).resolves.toBeNull();
    await expect(driver.fetchUserByLogin('   ')).resolves.toBeNull();
  });

  it('คนเดียวกับที่อยู่ใน fetchUsers() — mock ต้องไม่มีสองแหล่งความจริง', async () => {
    const all = await driver.fetchUsers();
    const one = await driver.fetchUserByLogin('anan.p');

    const fromAll = all.find((u) => u.loginName === 'anan.p');
    expect(one?.empCode).toBe(fromAll?.empCode);
    expect(one?.password.expose()).toBe(fromAll?.password.expose());
  });
});
