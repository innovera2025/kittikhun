import type { CanonicalItem, ErpAdapter, ErpUserRow } from '../../src/erp/erp-adapter';
import { ErpSecret } from '../../src/erp/erp-secret';

/**
 * ERP ปลอมสำหรับเทสต์ที่ต้องพิสูจน์เส้นทาง **ล็อกอินผ่าน ERP**
 *
 * ตั้งแต่ 5 ก.ย. 2569 `AuthService.login()` ถาม ERP สด ๆ ทุกครั้ง (query ของลูกค้า
 * `WHERE user_name = ?cUser`) ตัวนี้จึงเลียนพฤติกรรมที่มีผลต่อผลลัพธ์จริง 3 อย่าง:
 *  - เทียบชื่อผู้ใช้แบบ **ไม่สนตัวพิมพ์** (`menuuser` อยู่บน collation `Thai_CI_AS`)
 *  - ไม่พบ = `null` · ต่อไม่ได้ = **throw** (สองกรณีนี้ต้องแยกกันได้ที่ผู้เรียก)
 *  - `password` ห่อด้วย `ErpSecret` เหมือน driver จริงเป๊ะ — fixture ห้ามถือ plaintext
 *    เป็น string ดิบ ไม่งั้นเทสต์เองจะเป็นทางรั่วที่คลาสนั้นตั้งใจปิดไว้
 */
export interface FakeErp extends ErpAdapter {
  users: ErpUserRow[];
  /** ตั้งค่า = ทุกครั้งที่ถูกถามจะโยน error นี้ (จำลอง ERP ล่ม / เน็ตคลังหลุด) */
  failWith: Error | null;
  /** ชื่อที่ถูกถามตามลำดับ — ใช้พิสูจน์ว่าเส้นทาง break-glass ไม่แตะ ERP เลย */
  lookups: string[];
}

/** 1 แถวจาก `menuuser` (ค่า default ตรงกับ `DEFAULT_USER_LOGIN_SQL` ที่ empCode = user_name) */
export function erpUser(
  loginName: string,
  password: string,
  over: Partial<{ userLevel: string; nameThai: string; empCode: string }> = {},
): ErpUserRow {
  return {
    loginName,
    password: ErpSecret.of(password),
    userLevel: over.userLevel ?? '5',
    nameThai: over.nameThai ?? 'ทดสอบ ระบบ',
    empCode: over.empCode ?? loginName,
  };
}

export function makeFakeErp(): FakeErp {
  const fake: FakeErp = {
    users: [],
    failWith: null,
    lookups: [],
    capabilities: () => ({ delta: false }),
    init: () => Promise.resolve(),
    close: () => Promise.resolve(),
    healthCheck: () => Promise.resolve({ ok: true, driver: 'fake' }),
    // eslint-disable-next-line require-yield
    async *fetchItems(): AsyncGenerator<CanonicalItem[]> {
      return;
    },
    fetchItemsBySku: () => Promise.resolve([]),
    fetchUsers: () =>
      fake.failWith !== null ? Promise.reject(fake.failWith) : Promise.resolve(fake.users),
    fetchUserByLogin: (loginName: string) => {
      fake.lookups.push(loginName);
      if (fake.failWith !== null) return Promise.reject(fake.failWith);
      const wanted = loginName.trim().toLowerCase();
      const found = fake.users.find((u) => u.loginName.trim().toLowerCase() === wanted);
      return Promise.resolve(found ?? null);
    },
  };
  return fake;
}
