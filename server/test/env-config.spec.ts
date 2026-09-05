/**
 * ⚠️ ต้องอยู่ก่อน import ทุกบรรทัด (ts-jest ยก `jest.mock` ขึ้นไปบนสุดให้เองอยู่แล้ว)
 *
 * `env.config.ts` เรียก `ConfigModule.forRoot({ validate: loadConfig })` ตั้งแต่ระดับโมดูล →
 * แค่ `import { loadConfig }` ก็เท่ากับสั่ง **ตรวจไฟล์ตั้งค่าของเครื่องที่รันเทสต์** ทันที
 * เครื่อง dev/CI ที่ไม่มีไฟล์นั้น (หรือมีค่า placeholder) จะตายตั้งแต่ยังไม่เริ่มเทสต์ และเพราะ
 * ของจริงคืน Promise ตัวที่โยนออกมาจะเป็น unhandled rejection ที่มาถึงทีหลังจนดูเหมือน
 * "เทสต์ผ่านครบแต่ suite ล้ม" — ตัดทิ้งด้วยวิธีเดียวกับ `users-sync.spec.ts`
 */
jest.mock('@nestjs/config', () => {
  const actual = jest.requireActual<typeof import('@nestjs/config')>('@nestjs/config');
  class TestConfigModule extends actual.ConfigModule {
    static forRoot(): ReturnType<typeof actual.ConfigModule.forRoot> {
      return Promise.resolve({ module: TestConfigModule, providers: [], exports: [] });
    }
  }
  return { ...actual, ConfigModule: TestConfigModule };
});

import { EnvValidationError, loadConfig } from '../src/config/env.config';

/**
 * ด่าน boot ของคอนฟิกรอบผู้ใช้ (`loadConfig`) หลังเลิกใช้ `ERP_USER_LEVEL_ROLE_MAP`
 *
 * ทำไมต้องมีไฟล์นี้: กฎเดิม "ต้องมีอย่างน้อย 1 level ที่ map เป็น admin" ถูกถอดออกเพราะ
 * ตอนนี้ทุกคนจาก ERP ได้ role เดียวกันหมด (`ERP_USER_FIXED_ROLE` ค่าเริ่มต้น `staff`) กฎนั้น
 * จะบล็อก boot ตลอดกาล การถอดกฎด้านความปลอดภัยออกโดยไม่มีเทสต์คุมสิ่งที่มาแทน คือวิธีที่
 * ด่านจะหายไปเงียบ ๆ ในการแก้ครั้งถัดไป เทสต์ชุดนี้จึงตรึงไว้ว่าอะไรยังต้องหยุด boot อยู่
 * ส่วนความจริงที่ตรวจใน `.env` ไม่ได้ (มีบัญชี break-glass อยู่จริงไหม) ถูกคุมโดย
 * `users-sync.spec.ts` → "ด่าน 0" และ "ด่านเดียวกันตอน boot (onModuleInit)"
 *
 * ไม่ต้องใช้ Postgres — `loadConfig` เป็นฟังก์ชัน pure ล้วน (และต้องเป็นแบบนั้นตลอดไป)
 */

/** คอนฟิกขั้นต่ำที่ผ่านทุกกฎ — ค่าปลอมล้วน ห้ามใช้จริง */
const VALID_ENV: Record<string, string> = {
  ERP_DRIVER: 'mock',
  WAREHOUSE_CODE: 'WH01',
  POSTGRES_PASSWORD: 'test-postgres-pw',
  DATABASE_URL: 'postgres://tcl:testpw@localhost:5432/tcl_test',
  JWT_ACCESS_SECRET: 'test-access-secret-ห้ามใช้จริง-อย่างน้อย32ตัวอักษร',
  JWT_REFRESH_SECRET: 'test-refresh-secret-ห้ามใช้จริง-อย่างน้อย32ตัวอักษร',
  PIN_PEPPER: 'test-pepper-ห้ามใช้จริง',
};

/** เปิดสวิตช์คัตโอเวอร์พร้อมค่าที่คู่กันครบ (ชุดที่ควรบูตขึ้นได้จริง) */
const SYNC_ON: Record<string, string> = {
  ...VALID_ENV,
  ERP_USER_SYNC_ENABLED: 'true',
  ERP_USER_MIN_EXPECTED_ROWS: '3',
};

/** ชื่อตัวแปรที่ด่าน boot ฟ้อง — `loadConfig` เก็บไว้ใน error โดยไม่มี "ค่า" ติดมาด้วย */
const failedVariables = (env: Record<string, string>): readonly string[] => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof EnvValidationError) return err.variables;
    throw err;
  }
  throw new Error('คาดว่า loadConfig จะปฏิเสธคอนฟิกชุดนี้ แต่กลับผ่าน');
};

describe('ด่าน boot ของคอนฟิกรอบผู้ใช้', () => {
  describe('ERP_USER_FIXED_ROLE — role เดียวของทุกคนจาก ERP', () => {
    it('⭐ เปิด sync ผู้ใช้โดยไม่ตั้งค่านี้ → บูตขึ้นได้ และได้ staff เป็นค่าเริ่มต้น', () => {
      // กฎเดิม ("ต้องมี level ที่ map เป็น admin") จะทำให้ชุดคอนฟิกที่ถูกต้องนี้บูตไม่ขึ้น
      // ตลอดกาล — เคสนี้คือหลักฐานว่ากฎนั้นถูกถอดออกจริง ไม่ใช่แค่ผ่อนปรน
      const config = loadConfig(SYNC_ON);

      expect(config.ERP_USER_FIXED_ROLE).toBe('staff');
    });

    it('ตั้งเป็น admin หรือ viewer ได้ด้วยการแก้บรรทัดเดียว', () => {
      expect(loadConfig({ ...SYNC_ON, ERP_USER_FIXED_ROLE: 'admin' }).ERP_USER_FIXED_ROLE).toBe(
        'admin',
      );
      expect(loadConfig({ ...SYNC_ON, ERP_USER_FIXED_ROLE: 'viewer' }).ERP_USER_FIXED_ROLE).toBe(
        'viewer',
      );
    });

    it('role ที่ไม่มีจริง → ไม่บูต (ห้ามเดาค่าสิทธิ์ให้เอง)', () => {
      expect(failedVariables({ ...SYNC_ON, ERP_USER_FIXED_ROLE: 'superadmin' })).toContain(
        'ERP_USER_FIXED_ROLE',
      );
    });
  });

  describe('ERP_USER_LEVEL_ROLE_MAP — คีย์ที่ถูกยกเลิก', () => {
    it('⭐ ยังตั้งค้างไว้ → ไม่บูต พร้อมชี้ไปที่คีย์ใหม่', () => {
      // ถ้าปล่อยให้เป็นคีย์ที่ไม่มีใครอ่าน ผู้ดูแลที่ยังเห็น `9=admin` จะเชื่อว่าคนระดับ 9
      // ยังได้ admin อยู่ ทั้งที่ทุกคนได้ ERP_USER_FIXED_ROLE เท่ากันหมดไปแล้ว
      const env = { ...SYNC_ON, ERP_USER_LEVEL_ROLE_MAP: '9=admin,5=staff,1=viewer' };

      expect(failedVariables(env)).toContain('ERP_USER_LEVEL_ROLE_MAP');
      expect(() => loadConfig(env)).toThrow(/ERP_USER_FIXED_ROLE/);
    });

    it('ไม่ได้ตั้งไว้เลย → บูตได้ตามปกติ', () => {
      expect(() => loadConfig(SYNC_ON)).not.toThrow();
    });
  });

  describe('ERP_USER_ABSENCE_GRACE_HOURS — หน้าต่างกันการอ่าน ERP เพี้ยนรอบเดียว', () => {
    it('ไม่ตั้ง → ค่าเริ่มต้น 2 ชม.', () => {
      expect(loadConfig(SYNC_ON).ERP_USER_ABSENCE_GRACE_HOURS).toBe(2);
    });

    it('⭐ ตั้ง 0 ไม่ได้ — การป้องกันถูกบีบให้แคบลงได้ แต่ถอดออกไม่ได้', () => {
      expect(failedVariables({ ...SYNC_ON, ERP_USER_ABSENCE_GRACE_HOURS: '0' })).toContain(
        'ERP_USER_ABSENCE_GRACE_HOURS',
      );
    });

    it('ตั้งค่าที่รับได้ → ใช้ค่านั้นจริง', () => {
      expect(loadConfig({ ...SYNC_ON, ERP_USER_ABSENCE_GRACE_HOURS: '6' })
        .ERP_USER_ABSENCE_GRACE_HOURS).toBe(6);
    });
  });

  describe('การ์ดอื่นของรอบผู้ใช้ต้องไม่หลุดไปพร้อมกัน', () => {
    it('เปิด sync ผู้ใช้แต่ไม่ตั้ง ERP_USER_MIN_EXPECTED_ROWS → ไม่บูต', () => {
      // เพดานแถวขั้นต่ำคือด่านหลักที่กัน "ERP อ่านมาไม่ครบแล้วล็อกคนทั้งคลังออก"
      const { ERP_USER_MIN_EXPECTED_ROWS: _omitted, ...withoutFloor } = SYNC_ON;

      expect(failedVariables(withoutFloor)).toContain('ERP_USER_MIN_EXPECTED_ROWS');
    });

    it('ปิดสวิตช์อยู่ → ไม่บังคับเพดานแถวขั้นต่ำ (ยังไม่มีรอบไหนเดินเอง)', () => {
      expect(() => loadConfig(VALID_ENV)).not.toThrow();
    });

    it('🚫 ข้อความ error ห้ามมี "ค่า" ของตัวแปรติดไปด้วย', () => {
      const env = { ...SYNC_ON, ERP_USER_LEVEL_ROLE_MAP: '9=admin', ERP_USER_FIXED_ROLE: 'ผิด' };

      expect(() => loadConfig(env)).toThrow(EnvValidationError);
      const message = (() => {
        try {
          loadConfig(env);
        } catch (err) {
          return (err as Error).message;
        }
        return '';
      })();
      expect(message).toContain('ERP_USER_FIXED_ROLE');
      expect(message).not.toContain('9=admin');
      expect(message).not.toContain(VALID_ENV['PIN_PEPPER']);
      expect(message).not.toContain(VALID_ENV['POSTGRES_PASSWORD']);
    });
  });
});
