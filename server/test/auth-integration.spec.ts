import { JwtService } from '@nestjs/jwt';

import { AuthService, AuthError } from '../src/auth/auth.service';
import { AuthErrorCode } from '../src/auth/auth.types';
import type { PostgresService } from '../src/db/postgres.service';
import {
  TEST_CONFIG,
  applySchema,
  describeWithDb,
  makeDb,
  testConfigService,
  truncateAll,
} from './support/test-db';

/**
 * ระบบผู้ใช้ / login — วงจรจริงกับ Postgres จริง
 *
 * README อ้างว่าเทสต์ชุดนี้ผ่าน 26/26 แต่ไฟล์ไม่เคยถูก commit
 * → แก้โค้ด auth แล้วไม่มีอะไรจับ regression เลย ไฟล์นี้คือ net ตัวนั้น
 *
 * ต้องใช้ DB จริงเพราะสิ่งที่พิสูจน์อยู่ใน engine: constraint ของ users,
 * chain การ rotate ใน refresh_tokens, และ audit_log ที่เป็น append-only
 */

const DEVICE = 'device-เครื่อง-1';
const PIN = '520417';

describeWithDb('auth — วงจรจริงกับ Postgres', () => {
  let db: PostgresService;
  let auth: AuthService;

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const jwt = new JwtService({
      secret: String(TEST_CONFIG.JWT_ACCESS_SECRET),
      signOptions: { algorithm: 'HS256' },
      verifyOptions: { algorithms: ['HS256'] },
    });
    auth = new AuthService(db, jwt, testConfigService());
  });

  /**
   * สร้างผู้ใช้ 1 คน = 2 แถว (`users` + `user_credentials`) เพราะ `login()` อ่าน secret
   * จาก `user_credentials.login_name` แล้ว ไม่ใช่ `users.pin_hash` อีกต่อไป
   *
   * `users.pin_hash` ยังถูกเขียนไว้ตามเดิมโดยตั้งใจ — เป็นตาข่ายถอยของ Cutover
   * (คอลัมน์นี้ถูกลบใน Phase 5 เท่านั้น) การเขียนไว้ทำให้เทสต์พิสูจน์ได้ด้วยว่า
   * ค่าที่ยังอยู่ในคอลัมน์เก่าไม่ถูกใช้ยืนยันตัวตนอีกแล้ว
   *
   * `source` เริ่มต้นเป็น `legacy_pin` = สภาพจริงของ Cutover Phase 2 (ทุกคนยังใช้ PIN เดิม)
   */
  async function seedUser(
    over: Partial<{
      empId: string;
      pin: string;
      role: 'admin' | 'staff' | 'viewer';
      mustChangePin: boolean;
      loginName: string;
      source: 'erp' | 'local' | 'legacy_pin';
    }> = {},
  ): Promise<string> {
    const empId = over.empId ?? '52104';
    const source = over.source ?? 'legacy_pin';
    const loginName = (over.loginName ?? empId).trim().toLowerCase();
    const hash = await auth.hashPin(over.pin ?? PIN);
    await db.query(
      `INSERT INTO users (emp_id, name, pin_hash, role, shift, warehouse_code, must_change_pin)
       VALUES ($1, $2, $3, $4, 'กะเช้า · A', 'WH01', $5)`,
      [empId, 'ทดสอบ ระบบ', hash, over.role ?? 'staff', over.mustChangePin ?? false],
    );
    await db.query(
      `INSERT INTO user_credentials
         (login_name, emp_id, secret_hash, source, erp_user_level, erp_last_seen_at)
       VALUES ($1, $2, $3, $4::user_credential_source, $5, $6)`,
      [
        loginName,
        empId,
        hash,
        source,
        // CHECK user_credentials_erp_fields บังคับว่าสองคอลัมน์นี้มีค่าเมื่อ source='erp' เท่านั้น
        source === 'erp' ? '9' : null,
        source === 'erp' ? new Date() : null,
      ],
    );
    return empId;
  }

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      throw new Error('คาดว่าจะ throw แต่ไม่ throw');
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      return e.code;
    }
  };

  // ── login ────────────────────────────────────────────────────────────

  describe('login', () => {
    it('PIN ถูก → ได้ access + refresh + โปรไฟล์', async () => {
      await seedUser();
      const res = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });

      expect(res.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(res.refreshToken.length).toBeGreaterThan(20);
      expect(res.expiresIn).toBe(900);
      expect(res.user).toMatchObject({
        empId: '52104',
        name: 'ทดสอบ ระบบ',
        role: 'staff',
        warehouseCode: 'WH01',
        mustChangePin: false,
      });
    });

    it('คำตอบ login ไม่มี pin_hash / secret_hash / pepper หลุดออกไป', async () => {
      await seedUser();
      const res = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const dump = JSON.stringify(res);
      expect(dump).not.toContain('argon2');
      expect(dump).not.toContain(String(TEST_CONFIG.PIN_PEPPER));
      expect(dump).not.toContain(PIN);
      // ⭐ ตารางย้ายที่แล้ว — ชื่อคอลัมน์ใหม่ต้องไม่หลุดตามมาด้วย
      expect(dump).not.toContain('secret_hash');
      expect(dump).not.toContain('secretHash');
      // hash จริงในตารางต้องไม่โผล่ในคำตอบ ไม่ว่าจะผ่านฟิลด์ชื่ออะไร
      const stored = await db.one<{ secret_hash: string }>(
        `SELECT secret_hash FROM user_credentials WHERE emp_id = '52104'`,
      );
      expect(stored?.secret_hash).toMatch(/^\$argon2id\$/);
      expect(dump).not.toContain(stored?.secret_hash ?? 'ไม่มีค่า');
    });

    it('⭐ รหัสผ่านแบบ ERP (ยาว ไม่ใช่ 6 หลัก) ล็อกอินได้ — schema ที่คลายแล้วไม่ปฏิเสธ', async () => {
      const erpSecret = 'ปลาทอง-2569!Warehouse';
      await seedUser({ loginName: 'somchai.p', pin: erpSecret, source: 'erp' });
      const res = await auth.login({ empId: 'Somchai.P', pin: erpSecret, deviceId: DEVICE });
      // empId ที่ส่งมาคือ login handle — โปรไฟล์ที่คืนยังเป็น users.emp_id ตามเดิม (FK anchor)
      expect(res.user.empId).toBe('52104');
    });

    it('⭐ PIN 6 หลักเดิม (source=legacy_pin) ยังล็อกอินได้ — พิสูจน์ no-lockout ของ Phase 2', async () => {
      await seedUser();
      await expect(
        auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }),
      ).resolves.toBeDefined();
    });

    it('⭐ ลบ credential = ปิดล็อกอิน แต่ users/ประวัติยังอยู่ครบ (U6)', async () => {
      await seedUser();
      await db.query(`DELETE FROM user_credentials WHERE emp_id = '52104'`);
      expect(await codeOf(auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }))).toBe(
        AuthErrorCode.UNKNOWN_EMPLOYEE,
      );
      const still = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE emp_id = '52104'`,
      );
      expect(still?.n).toBe(1);
    });

    it('access token บรรจุ sub/role/wh/rv สำหรับ guard', async () => {
      await seedUser({ role: 'admin' });
      const res = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const payload = JSON.parse(
        Buffer.from(res.accessToken.split('.')[1], 'base64url').toString('utf8'),
      );
      expect(payload).toMatchObject({ sub: '52104', role: 'admin', wh: 'WH01', rv: 1 });
    });

    it('ไม่พบรหัสพนักงาน → UNKNOWN_EMPLOYEE (design แยกข้อความจาก PIN ผิด)', async () => {
      expect(await codeOf(auth.login({ empId: '99999', pin: PIN, deviceId: DEVICE }))).toBe(
        AuthErrorCode.UNKNOWN_EMPLOYEE,
      );
    });

    it('PIN ผิด → INVALID_PIN', async () => {
      await seedUser();
      expect(await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }))).toBe(
        AuthErrorCode.INVALID_PIN,
      );
    });

    it('⭐ mustChangePin ยังอยู่ในสัญญา wire แต่เป็น false เสมอ (แม้แถวใน users จะเป็น true)', async () => {
      // แนวคิด "บังคับตั้ง PIN ใหม่" ตายไปพร้อม change-pin — credential เป็นของ ERP แล้ว
      // ฟิลด์ยังถูกส่งไปเพื่อไม่ให้ APK เก่าที่ deserialize อยู่พัง (ดูตาราง Public Contracts)
      await seedUser({ mustChangePin: true });
      const res = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      expect(res.user).toHaveProperty('mustChangePin');
      expect(res.user.mustChangePin).toBe(false);
    });
  });

  // ── กัน brute force ──────────────────────────────────────────────────

  describe('หน่วงเวลาแบบทวีคูณ (ไม่ล็อคบัญชี)', () => {
    it('PIN ผิดสะสม → failed_attempts เพิ่มและ throttle_until ถูกตั้ง', async () => {
      await seedUser();
      await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }));
      const row = await db.one<{ failed_attempts: number; throttle_until: Date | null }>(
        `SELECT failed_attempts, throttle_until FROM users WHERE emp_id = '52104'`,
      );
      expect(row?.failed_attempts).toBe(1);
      expect(row?.throttle_until).not.toBeNull();
    });

    it('หน่วงเวลาทวีคูณตามจำนวนครั้ง (1×, 2×, 4×)', async () => {
      await seedUser();
      const delays: number[] = [];
      for (let i = 0; i < 3; i++) {
        await db.query(`UPDATE users SET throttle_until = NULL WHERE emp_id = '52104'`);
        try {
          await auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE });
        } catch (e) {
          delays.push((e as AuthError).retryAfterMs ?? 0);
        }
      }
      expect(delays).toEqual([1, 2, 4]);
    });

    it('มีเพดาน — ไม่หน่วงยาวไม่จำกัด', async () => {
      await seedUser();
      await db.query(`UPDATE users SET failed_attempts = 30 WHERE emp_id = '52104'`);
      try {
        await auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE });
      } catch (e) {
        expect((e as AuthError).retryAfterMs).toBe(TEST_CONFIG.AUTH_THROTTLE_MAX_MS);
      }
    });

    it('อยู่ในช่วงหน่วง → THROTTLED ก่อนตรวจ PIN ด้วยซ้ำ (ไม่เปลือง argon2)', async () => {
      await seedUser();
      await db.query(
        `UPDATE users SET throttle_until = now() + interval '5 minutes' WHERE emp_id = '52104'`,
      );
      expect(await codeOf(auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }))).toBe(
        AuthErrorCode.THROTTLED,
      );
    });

    it("⭐ throttle_until = 'infinity' → THROTTLED ไม่ใช่ 500", async () => {
      // ใช้ปิดบัญชีถาวรโดยไม่ต้องลบ (ผลการนับอ้าง emp_id อยู่ ลบไม่ได้)
      // timestamptz เป็น infinity ได้ และ node-pg คืนค่าเป็น number ไม่ใช่ Date
      // เดิมโค้ดเรียก .getTime() บนตัวเลข → TypeError → endpoint login ตอบ 500
      await seedUser();
      await db.query(`UPDATE users SET throttle_until = 'infinity' WHERE emp_id = '52104'`);
      expect(await codeOf(auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }))).toBe(
        AuthErrorCode.THROTTLED,
      );
    });

    it("throttle_until = '-infinity' (อดีต) → ผ่านได้ตามปกติ", async () => {
      await seedUser();
      await db.query(`UPDATE users SET throttle_until = '-infinity' WHERE emp_id = '52104'`);
      await expect(
        auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }),
      ).resolves.toBeDefined();
    });

    it('เวลารอที่ส่งกลับต้องเป็นตัวเลขจริง ไม่ใช่ Infinity (JSON แปลงเป็น null)', async () => {
      await seedUser();
      await db.query(`UPDATE users SET throttle_until = 'infinity' WHERE emp_id = '52104'`);
      try {
        await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
        throw new Error('ควรถูกปฏิเสธ');
      } catch (err) {
        const retry = (err as { retryAfterMs?: number }).retryAfterMs;
        expect(Number.isFinite(retry)).toBe(true);
      }
    });

    it('⭐ บัญชีไม่ถูกล็อค — PIN ถูกหลังพ้นช่วงหน่วง ยัง login ได้และตัวนับรีเซ็ต', async () => {
      await seedUser();
      await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }));
      await db.query(`UPDATE users SET throttle_until = NULL WHERE emp_id = '52104'`);

      await expect(
        auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE }),
      ).resolves.toBeDefined();

      const row = await db.one<{ failed_attempts: number; throttle_until: Date | null }>(
        `SELECT failed_attempts, throttle_until FROM users WHERE emp_id = '52104'`,
      );
      expect(row?.failed_attempts).toBe(0);
      expect(row?.throttle_until).toBeNull();
    });

    it('หน่วงของพนักงานคนหนึ่งไม่กระทบอีกคน (กันยิง PIN ผิดเพื่อล็อคเพื่อนร่วมงาน)', async () => {
      await seedUser({ empId: '52104' });
      await seedUser({ empId: '52105' });
      await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }));
      await expect(
        auth.login({ empId: '52105', pin: PIN, deviceId: DEVICE }),
      ).resolves.toBeDefined();
    });
  });

  // ── ช่องโหว่ที่ปิดไปแล้ว (regression guard) ──────────────────────────

  /**
   * ⚠️ กลุ่มเทสต์ `changePin` เดิม (ด่าน brute force + ตัวนับร่วม + audit `auth.change_pin_failed`)
   * ถูกลบพร้อมกับเมธอด/endpoint ที่มันคุ้มครอง — credential เป็นของ ERP แล้ว รอบ sync
   * ถัดไปเขียนทับอยู่ดี (ตารางการตัดสินใจข้อ 13)
   *
   * สิ่งที่กลุ่มนั้นเคยรับประกันไว้ **ไม่ได้หายไป**: ตอนนี้ `login()` เป็นเส้นทางเดียวในระบบที่เทียบ
   * secret และมันผ่าน `assertNotThrottled` ก่อน `verifyPin` เสมอ — พิสูจน์โดยเคส
   * 'อยู่ในช่วงหน่วง → THROTTLED ก่อนตรวจ PIN ด้วยซ้ำ' ด้านบน และเคส atomic ด้านล่าง
   * ถ้ามีใครเพิ่มเส้นทางเทียบ secret เส้นที่สองกลับเข้ามา ต้องเพิ่มด่านนี้และเทสต์คู่กันด้วย
   */
  describe('⭐ ตัวนับความล้มเหลวต้อง atomic (กันยิงพร้อมกันแล้วตัวนับค้าง)', () => {
    it('🔴 ยิง PIN ผิดพร้อมกัน 10 ครั้ง → ตัวนับต้องเป็น 10 ไม่ใช่ 1', async () => {
      await seedUser();
      // ปลดหน่วงเวลาออกเพื่อให้ทุก request ผ่านด่าน throttle พร้อมกัน (จำลอง race จริง)
      await db.query(`UPDATE users SET throttle_until = NULL WHERE emp_id = '52104'`);

      await Promise.all(
        Array.from({ length: 10 }, () =>
          auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }).catch(() => undefined),
        ),
      );

      const row = await db.one<{ failed_attempts: number }>(
        `SELECT failed_attempts FROM users WHERE emp_id = '52104'`,
      );
      expect(row?.failed_attempts).toBe(10);
    });

    it('หน่วงเวลาทวีคูณจริงตามจำนวนครั้งที่สะสม', async () => {
      await seedUser();
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        await db.query(`UPDATE users SET throttle_until = NULL WHERE emp_id = '52104'`);
        try {
          await auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE });
        } catch (e) {
          delays.push((e as AuthError).retryAfterMs ?? 0);
        }
      }
      // base=1ms · เพดาน=4ms → 1, 2, 4, 4
      expect(delays).toEqual([1, 2, 4, 4]);
    });
  });

  // ── refresh ──────────────────────────────────────────────────────────

  describe('refresh token — rotate ทุกครั้ง + ผูกเครื่อง', () => {
    it('rotate แล้วได้ refresh ตัวใหม่ ไม่ใช่ตัวเดิม', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const b = await auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE });
      expect(b.refreshToken).not.toBe(a.refreshToken);
    });

    it('⭐ DB เก็บเฉพาะ sha256 ไม่เก็บ token ดิบ', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const hit = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM refresh_tokens WHERE token_hash = $1`,
        [a.refreshToken],
      );
      expect(hit?.n).toBe(0);

      const byHash = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM refresh_tokens WHERE token_hash = $1`,
        [AuthService.sha256(a.refreshToken)],
      );
      expect(byHash?.n).toBe(1);
    });

    it('ใช้ refresh ของเครื่อง A บนเครื่อง B → ปฏิเสธ (ผูกกับเครื่อง)', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      expect(
        await codeOf(auth.refresh({ refreshToken: a.refreshToken, deviceId: 'device-อื่น' })),
      ).toBe(AuthErrorCode.INVALID_REFRESH);
    });

    it('token ที่ไม่มีในระบบ → ปฏิเสธ', async () => {
      await seedUser();
      expect(
        await codeOf(auth.refresh({ refreshToken: 'ไม่เคยออกให้', deviceId: DEVICE })),
      ).toBe(AuthErrorCode.INVALID_REFRESH);
    });

    it('token หมดอายุ → ปฏิเสธ', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      // constraint refresh_tokens_ttl บังคับ expires_at > issued_at → ต้องเลื่อนทั้งคู่ย้อนหลัง
      await db.query(
        `UPDATE refresh_tokens
            SET issued_at  = now() - interval '31 days',
                expires_at = now() - interval '1 second'`,
      );
      expect(await codeOf(auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE }))).toBe(
        AuthErrorCode.INVALID_REFRESH,
      );
    });

    it('⭐ WiFi คลังหลุด — retry ด้วย token เดิมภายใน grace 60 วิ ยังผ่าน ไม่ถูกเตะออก', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      await auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE });

      const retry = await auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE });
      expect(retry.accessToken).toBeTruthy();
      expect(retry.refreshToken).not.toBe(a.refreshToken);
    });

    it('⭐ token เก่าที่พ้น grace → ถือว่าถูกขโมย เพิกถอนทั้ง family', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const b = await auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE });

      await db.query(
        `UPDATE refresh_tokens SET revoked_at = now() - interval '10 minutes'
          WHERE revoked_at IS NOT NULL`,
      );

      expect(await codeOf(auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE }))).toBe(
        AuthErrorCode.REFRESH_REUSED,
      );

      // ตัวลูกที่ยังใช้อยู่ก็ต้องถูกเพิกถอนไปด้วย
      expect(await codeOf(auth.refresh({ refreshToken: b.refreshToken, deviceId: DEVICE }))).toBe(
        AuthErrorCode.REFRESH_REUSED,
      );

      const audit = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.refresh_reused'`,
      );
      expect(audit?.n).toBeGreaterThanOrEqual(1);
    });
  });

  // ── logout ───────────────────────────────────────────────────────────

  describe('logout', () => {
    it('เพิกถอน refresh ของเครื่องนั้น → refresh ต่อไม่ได้', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      await auth.logout('52104', DEVICE);
      expect(await codeOf(auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE }))).toBe(
        AuthErrorCode.REFRESH_REUSED,
      );
    });

    it('ไม่กระทบเครื่องอื่นของพนักงานคนเดียวกัน', async () => {
      await seedUser();
      const a = await auth.login({ empId: '52104', pin: PIN, deviceId: DEVICE });
      const b = await auth.login({ empId: '52104', pin: PIN, deviceId: 'device-เครื่อง-2' });
      await auth.logout('52104', DEVICE);

      await expect(
        auth.refresh({ refreshToken: b.refreshToken, deviceId: 'device-เครื่อง-2' }),
      ).resolves.toBeDefined();
      expect(await codeOf(auth.refresh({ refreshToken: a.refreshToken, deviceId: DEVICE }))).toBe(
        AuthErrorCode.REFRESH_REUSED,
      );
    });
  });

  // ── เก็บ hash ตามรูปแบบที่ constraint บังคับ ─────────────────────────

  /**
   * เดิมกลุ่มนี้คือ `describe('changePin')` — พิสูจน์การเปลี่ยน PIN ด้วยตัวเอง
   * ทั้งกลุ่มถูกลบพร้อม endpoint (ตารางการตัดสินใจข้อ 13) เหลือไว้เฉพาะข้อรับประกันที่ยัง
   * มีความหมาย: **รูปร่างของ hash ที่เก็บจริง** ซึ่ง constraint ของตารางบังคับอยู่
   */
  describe('รูปแบบ hash ที่เก็บ', () => {
    it('secret_hash ที่ sync/backfill เขียนต้องเป็น argon2id ตาม constraint ของตาราง', async () => {
      await seedUser();
      const row = await db.one<{ secret_hash: string }>(
        `SELECT secret_hash FROM user_credentials WHERE emp_id = '52104'`,
      );
      expect(row?.secret_hash.startsWith('$argon2id$')).toBe(true);
    });

    it('🔴 hash ที่ไม่ใช่ argon2id ถูกปฏิเสธที่ระดับ engine (ไม่ต้องเชื่อโค้ดแอป)', async () => {
      await seedUser();
      await expect(
        db.query(
          `UPDATE user_credentials SET secret_hash = 'plaintext-520417' WHERE emp_id = '52104'`,
        ),
      ).rejects.toBeDefined();
    });
  });

  // ── role freshness ───────────────────────────────────────────────────

  describe('assertRoleFresh — ไม่เชื่อ role จาก JWT อย่างเดียว', () => {
    it('role_version ตรง → คืน role ปัจจุบัน', async () => {
      await seedUser({ role: 'admin' });
      await expect(auth.assertRoleFresh('52104', 1)).resolves.toBe('admin');
    });

    it('⭐ admin ถูกลดสิทธิ์ระหว่างที่ token ยังไม่หมดอายุ → token เดิมใช้ไม่ได้ทันที', async () => {
      await seedUser({ role: 'admin' });
      await db.query(
        `UPDATE users SET role = 'staff', role_version = role_version + 1 WHERE emp_id = '52104'`,
      );
      expect(await codeOf(auth.assertRoleFresh('52104', 1))).toBe(AuthErrorCode.ROLE_CHANGED);
    });

    it('ผู้ใช้ถูกลบไปแล้ว → ปฏิเสธ', async () => {
      await seedUser();
      await db.query(`DELETE FROM users WHERE emp_id = '52104'`);
      await expect(auth.assertRoleFresh('52104', 1)).rejects.toBeInstanceOf(AuthError);
    });
  });

  // ── audit ────────────────────────────────────────────────────────────

  describe('audit_log', () => {
    it('บันทึก login ที่ล้มเหลว พร้อมจำนวนครั้ง', async () => {
      await seedUser();
      await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }));
      const row = await db.one<{ action: string; payload: Record<string, unknown> }>(
        `SELECT action, payload FROM audit_log WHERE actor = '52104' ORDER BY id DESC LIMIT 1`,
      );
      expect(row?.action).toBe('auth.login_failed');
      expect(row?.payload).toMatchObject({ attempts: 1 });
    });

    it('⭐ ไม่มี secret / pepper / hash / token ดิบ รั่วเข้า audit_log เลย', async () => {
      // audit_log เป็น append-only ที่ระดับ engine — ถ้ารั่วเข้าไปแล้วลบคืนไม่ได้เลย
      // จึงต้องกวาดทุกเส้นทางที่เขียน audit ในรอบเดียว: login ล้มเหลว + refresh reuse
      const erpSecret = 'ปลาทอง-2569!Warehouse';
      await seedUser({ loginName: 'somchai.p', pin: erpSecret, source: 'erp' });
      await codeOf(auth.login({ empId: 'somchai.p', pin: '111112', deviceId: DEVICE }));
      await db.query(`UPDATE users SET throttle_until = NULL WHERE emp_id = '52104'`);

      const tokens = await auth.login({ empId: 'somchai.p', pin: erpSecret, deviceId: DEVICE });
      const next = await auth.refresh({ refreshToken: tokens.refreshToken, deviceId: DEVICE });
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = now() - interval '10 minutes'
          WHERE revoked_at IS NOT NULL`,
      );
      await codeOf(auth.refresh({ refreshToken: tokens.refreshToken, deviceId: DEVICE }));

      const stored = await db.one<{ secret_hash: string }>(
        `SELECT secret_hash FROM user_credentials WHERE emp_id = '52104'`,
      );
      const rows = await db.query<{ dump: string }>(
        `SELECT (actor || ' ' || action || ' ' || payload::text) AS dump FROM audit_log`,
      );
      const all = rows.rows.map((r) => r.dump).join('\n');
      expect(all).not.toContain(erpSecret);
      expect(all).not.toContain(PIN);
      expect(all).not.toContain('111112');
      expect(all).not.toContain(String(TEST_CONFIG.PIN_PEPPER));
      expect(all).not.toContain(stored?.secret_hash ?? 'ไม่มีค่า');
      expect(all).not.toContain(tokens.refreshToken);
      expect(all).not.toContain(next.refreshToken);
      // ต้องมีแถวจริงให้ตรวจ ไม่ใช่ผ่านเพราะตารางว่าง
      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    });

    it('⭐ append-only — UPDATE/DELETE ถูกปฏิเสธที่ระดับ engine', async () => {
      await seedUser();
      await codeOf(auth.login({ empId: '52104', pin: '111112', deviceId: DEVICE }));
      await expect(db.query(`UPDATE audit_log SET action = 'แก้ไข'`)).rejects.toBeDefined();
      await expect(db.query(`DELETE FROM audit_log`)).rejects.toBeDefined();
    });
  });
});
