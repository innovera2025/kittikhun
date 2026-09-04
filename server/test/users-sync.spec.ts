/**
 * ⚠️ ต้องอยู่ก่อน import ทุกบรรทัด (ts-jest ยก `jest.mock` ขึ้นไปบนสุดให้เองอยู่แล้ว)
 *
 * `sync.module.ts` ดึง **ค่าจริง** จาก `config/env.config.ts` (`parseUserLevelRoleMap`) และไฟล์นั้น
 * เรียก `ConfigModule.forRoot({ validate: loadConfig })` ตั้งแต่ระดับโมดูล → แค่เขียน
 * `import { SyncService }` ก็เท่ากับสั่ง **ตรวจ .env ของเครื่องที่รันเทสต์** ทันที เครื่อง dev
 * หรือ CI ที่ไม่มี .env (หรือมีแต่ค่า placeholder อย่าง ERP_SQL_USER=sa) จะตายตั้งแต่ยังไม่เริ่มเทสต์
 *
 * ไฟล์นี้ไม่ได้ boot แอปจริง — ประกอบ service เองทีละตัวด้วย `testConfigService()` จึงตัดเฉพาะ
 * **ด่าน boot** ออก ส่วน `ConfigService` และของอื่นใน `@nestjs/config` ยังเป็นของจริงทั้งหมด
 */
jest.mock('@nestjs/config', () => {
  const actual = jest.requireActual<typeof import('@nestjs/config')>('@nestjs/config');
  class TestConfigModule extends actual.ConfigModule {
    /**
     * ไม่อ่าน .env ไม่ validate — คืนโมดูลเปล่าที่ไม่มีใครในไฟล์นี้เอาไปประกอบจริง
     *
     * ⚠️ ของจริงคืน **Promise** (async) — ตัวที่โยนออกมาจึงเป็น unhandled rejection ที่มาถึงทีหลัง
     *    จนดูเหมือน "เทสต์ผ่านครบแต่ suite ล้ม" ถ้าไม่ตัดตรงนี้จะไล่หาสาเหตุกันนาน
     */
    static forRoot(): ReturnType<typeof actual.ConfigModule.forRoot> {
      return Promise.resolve({ module: TestConfigModule, providers: [], exports: [] });
    }
  }
  return { ...actual, ConfigModule: TestConfigModule };
});

import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AuthError, AuthService } from '../src/auth/auth.service';
import type { Role } from '../src/auth/auth.types';
import { CatalogService } from '../src/catalog/catalog.service';
import type { PostgresService } from '../src/db/postgres.service';
import type { CanonicalItem, ErpAdapter, ErpUserRow } from '../src/erp/erp-adapter';
import { ErpSecret } from '../src/erp/erp-secret';
import { SyncService, type SyncRunResult } from '../src/sync/sync.module';
import {
  TEST_CONFIG,
  applySchema,
  describeWithDb,
  makeDb,
  testConfigService,
  truncateAll,
} from './support/test-db';

/**
 * รอบ sync ผู้ใช้จาก ERP (`SyncService.runUsers`) — ประตูเดียวที่ **สิทธิ์และการล็อกอิน
 * ของทุกคนในคลังเปลี่ยนได้เองโดยไม่มีมนุษย์กด**
 *
 * ทำไมต้องมีไฟล์นี้: รอบนี้ลบแถว `user_credentials` ได้ = ปิดล็อกอินคนได้จริง ถ้ามันตัดสินผิด
 * รอบเดียว ทุกคนรวมทั้ง admin จะล็อกอินไม่ได้ และคนที่จะกด `POST /sync/users` เพื่อซ่อมก็ต้อง
 * เป็น admin ที่ล็อกอินได้ก่อน — ไม่มีทางกลับเข้าระบบเลย เทสต์ชุดนี้คือด่านที่ต้องแดงก่อนของจริง
 *
 * ⚠️ สองเรื่องที่ห้ามปนกันเด็ดขาด และเป็นบั๊กที่เคยเกิดจริง:
 *   "แถวใช้ไม่ได้ แต่ยังปรากฏใน ERP" (ตัวตนผิดรูป · login ซ้ำ · รหัสผ่านเพี้ยน)
 *                                    = ปัญหา **ข้อมูล** → ห้ามลบ credential
 *   "ไม่ปรากฏในผล ERP เลย"            = ปัญหา **คน** (ลาออก) → เข้า sweep ได้ทางเดียว
 *
 * ต้องใช้ Postgres จริงเพราะสิ่งที่พิสูจน์อยู่ในตัว engine ทั้งหมด: `SELECT ... FOR UPDATE`
 * ของด่าน last-admin, การ rollback ทั้งก้อนเมื่อ sweep โยน, นาฬิกา grace ที่คิดด้วย
 * `now() - interval`, CHECK/trigger ของ `user_credentials` และ `audit_log` แบบ append-only
 * — mock DB พิสูจน์อะไรพวกนี้ไม่ได้เลยแม้แต่ข้อเดียว
 *
 * ไม่ตั้ง `TEST_DATABASE_URL` → `describeWithDb` ข้ามทั้ง suite เหมือนชุด DB อื่นของ repo นี้
 * (ดูวิธีเปิด DB ชั่วคราวใน `test/support/test-db.ts`)
 */

/** argon2id ตั้งไว้ ~250ms/ครั้ง — 1 เคสมีทั้ง seed + verify หลายสิบครั้ง ต้องผ่อนเวลาให้ */
jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// ค่าคงที่ของ fixture
// ---------------------------------------------------------------------------

/** break-glass admin ที่ `create-admin` สร้าง — ด่าน 0 ของรอบ sync บังคับให้มีก่อนเสมอ */
const LOCAL_ADMIN = 'A001';
const LOCAL_ADMIN_LOGIN = 'a001';

/**
 * role เดียวที่ทุกคนจาก ERP ได้เหมือนกันหมด (`ERP_USER_FIXED_ROLE`) — ไม่มี allowlist ของ
 * `user_level` อีกแล้วตั้งแต่ 5 ก.ย. 2569 สิทธิ์จึงมาจากคอนฟิกล้วน ไม่ใช่จากข้อมูลของ ERP
 */
const FIXED_ROLE: Role = 'staff';

/**
 * ค่า `user_level` ที่ยังถูกเก็บลง `user_credentials.erp_user_level` ตามเดิม
 * (CHECK `user_credentials_erp_fields` บังคับให้มีค่า) แต่ **ไม่ตัดสินสิทธิ์อะไรแล้ว**
 */
const LEVEL_STAFF = '5';
/** เดิม '7' = บัญชีฝ่ายอื่นที่ allowlist กันไว้ — ตอนนี้ได้บัญชีเหมือนคนอื่นทุกประการ */
const LEVEL_OUTSIDER = '7';

/** รหัสผ่านที่ seed ไว้ในแถวเดิม (ยังไม่เคยผ่าน sync) */
const SEED_SECRET = 'รหัสเดิมของแถวที่ seed';
const DEVICE = 'device-เครื่อง-ทดสอบ';

/**
 * U+FFFD ในรหัสผ่าน = decode charset ผิดตั้งแต่ฝั่ง driver
 *
 * เขียนเป็น escape ไม่ใช่ตัวอักษรจริงโดยตั้งใจ — ตัวจริงมองไม่เห็นในโค้ดและหายง่ายเวลาไฟล์
 * ถูก re-encode ซึ่งจะทำให้เคสนี้กลายเป็นเทสต์ที่ผ่านฟรีโดยไม่มีใครรู้
 */
const REPLACEMENT_CHAR = '\uFFFD';

// ---------------------------------------------------------------------------
// ERP ปลอม — คืนเฉพาะ `fetchUsers()` ส่วนที่เหลือมีไว้ให้ครบ interface เท่านั้น
// ---------------------------------------------------------------------------

type FakeErp = ErpAdapter & { users: ErpUserRow[]; failWith: Error | null };

const makeFakeErp = (): FakeErp => {
  const fake: FakeErp = {
    users: [],
    failWith: null,
    capabilities: () => ({ delta: false }),
    init: async () => {},
    close: async () => {},
    healthCheck: async () => ({ ok: true, driver: 'fake' }),
    // eslint-disable-next-line require-yield
    async *fetchItems(): AsyncGenerator<CanonicalItem[]> {
      return;
    },
    fetchItemsBySku(): Promise<CanonicalItem[]> {
      return Promise.resolve([]);
    },
    fetchUsers(): Promise<ErpUserRow[]> {
      if (fake.failWith !== null) return Promise.reject(fake.failWith);
      return Promise.resolve(fake.users);
    },
  };
  return fake;
};

/**
 * 1 แถวจาก `menuuser`
 *
 * 🚫 `password` เป็น `ErpSecret` เหมือนของจริง — fixture ห้ามถือ plaintext เป็น string ดิบ
 *    ไม่งั้นเทสต์เองจะเป็นทางรั่วที่ `.toString()` ของคลาสนั้นตั้งใจปิดไว้
 */
const erpUser = (
  empCode: string,
  over: Partial<{ loginName: string; userLevel: string; nameThai: string; password: string }> = {},
): ErpUserRow => ({
  empCode,
  loginName: over.loginName ?? empCode.toLowerCase(),
  userLevel: over.userLevel ?? LEVEL_STAFF,
  nameThai: over.nameThai ?? `พนักงาน ${empCode}`,
  password: ErpSecret.of(over.password ?? `pw-${empCode}`),
});

describeWithDb('sync ผู้ใช้จาก ERP — วงจรจริงกับ Postgres', () => {
  let db: PostgresService;
  let auth: AuthService;
  let erp: FakeErp;

  /** argon2 แพง — hash ค่าเดิมซ้ำทุกเคสไม่ได้อะไรเพิ่ม (pepper คงที่ทั้งไฟล์) */
  const hashCache = new Map<string, string>();

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
    const jwt = new JwtService({
      secret: String(TEST_CONFIG.JWT_ACCESS_SECRET),
      signOptions: { algorithm: 'HS256' },
      verifyOptions: { algorithms: ['HS256'] },
    });
    auth = new AuthService(db, jwt, testConfigService());
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    erp = makeFakeErp();
  });

  // ── ตัวช่วย ───────────────────────────────────────────────────────────

  const hashOnce = async (secret: string): Promise<string> => {
    const cached = hashCache.get(secret);
    if (cached !== undefined) return cached;
    const hash = await auth.hashPin(secret);
    hashCache.set(secret, hash);
    return hash;
  };

  /**
   * คอนฟิกของรอบผู้ใช้
   *
   * ยอมให้ค่าเป็น `undefined` ได้โดยตั้งใจ — "ไม่ได้ตั้ง `ERP_USER_MIN_EXPECTED_ROWS`"
   * เป็นสถานะจริงที่ต้องทดสอบ (ยิง `POST /sync/users` ด้วยมือขณะสวิตช์ปิดอยู่)
   */
  type SyncConfig = Record<string, string | number | boolean | undefined>;

  const BASE_CONFIG: SyncConfig = {
    ERP_DRIVER: 'mock',
    ERP_TIMEOUT_MS: 5_000,
    ERP_SYNC_OVERLAP_S: 60,
    ERP_USER_FIXED_ROLE: FIXED_ROLE,
    ERP_USER_DEACTIVATE_MAX_PCT: 10,
    ERP_USER_ELEVATE_MAX_PCT: 10,
    ERP_USER_MIN_EXPECTED_ROWS: 3,
    // ค่าเริ่มต้นจริงของระบบคือ 2 ชม. — `expireGrace()` ย้อนนาฬิกาไป 48 ชม. จึงพ้นเสมอ
    ERP_USER_ABSENCE_GRACE_HOURS: 2,
  };

  /**
   * สร้าง SyncService ต่อเคส (คอนฟิกคนละชุดได้) — ไม่เรียก `onModuleInit` จึงไม่มี cron จริง
   * ยกเว้นเคสที่ทดสอบด่าน boot โดยตรง ซึ่งส่ง `registry` ของตัวเองเข้ามาเพื่ออ่านผลลัพธ์
   */
  const makeSync = (
    over: SyncConfig = {},
    registry: SchedulerRegistry = new SchedulerRegistry(),
  ): SyncService => {
    const merged = { ...BASE_CONFIG, ...over } as unknown as Record<string, string | number>;
    const cfg = testConfigService(merged);
    return new SyncService(db, erp, new CatalogService(db, cfg, erp), registry, cfg, auth);
  };

  /** ผู้ใช้ 1 คน = แถว `users` + แถว `user_credentials` (คนละตารางโดยตั้งใจ ดู U6) */
  async function seedUser(opts: {
    empId: string;
    role?: Role;
    source?: 'erp' | 'local' | 'legacy_pin';
    loginName?: string;
    secret?: string;
    name?: string;
  }): Promise<void> {
    const source = opts.source ?? 'erp';
    const login = (opts.loginName ?? opts.empId).trim().toLowerCase();
    // ⚠️ ไม่เขียน users.pin_hash เลย — คอลัมน์ถูกผ่อนเป็น nullable แล้ว และการล็อกอิน
    //    อ่านจาก user_credentials.secret_hash เท่านั้น (แถวที่ seed ต้องเป็นสภาพหลัง migrate จริง)
    await db.query(
      `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
       VALUES ($1, $2, $3::user_role, 'กะเช้า · A', 'WH01', false)`,
      [opts.empId, opts.name ?? `พนักงาน ${opts.empId}`, opts.role ?? 'staff'],
    );
    await db.query(
      `INSERT INTO user_credentials
         (login_name, emp_id, secret_hash, source, erp_user_level, erp_last_seen_at)
       VALUES ($1, $2, $3, $4::user_credential_source, $5, $6)`,
      [
        login,
        opts.empId,
        await hashOnce(opts.secret ?? SEED_SECRET),
        source,
        // CHECK user_credentials_erp_fields: สองคอลัมน์นี้มีค่าได้เฉพาะ source='erp'
        source === 'erp' ? LEVEL_STAFF : null,
        source === 'erp' ? new Date() : null,
      ],
    );
  }

  /** ด่าน 0 ของรอบ sync บังคับให้มีคนนี้ก่อน มิฉะนั้นปฏิเสธทั้ง run */
  const seedLocalAdmin = (): Promise<void> =>
    seedUser({
      empId: LOCAL_ADMIN,
      role: 'admin',
      source: 'local',
      loginName: LOCAL_ADMIN_LOGIN,
      name: 'ผู้ดูแล break-glass',
    });

  const credentialOf = (
    empId: string,
  ): Promise<{
    login_name: string;
    source: string;
    secret_hash: string;
    secret_rotated_at: Date;
    absent_since: Date | null;
    created_at: Date;
  } | null> =>
    db.one(
      `SELECT login_name, source, secret_hash, secret_rotated_at, absent_since, created_at
         FROM user_credentials WHERE emp_id = $1`,
      [empId],
    );

  const userOf = (
    empId: string,
  ): Promise<{ role: Role; name: string; role_version: number; updated_at: Date } | null> =>
    db.one(`SELECT role, name, role_version, updated_at FROM users WHERE emp_id = $1`, [empId]);

  const runRow = (
    runId: number,
  ): Promise<{
    status: string;
    error: string | null;
    /** payload ต่างชนิดกันต่อ `type` — เคสที่ต้องดูฟิลด์อื่นด้วยจึงอ่านเป็น record ดิบ */
    anomalies: Record<string, unknown>[];
    metrics: Record<string, number>;
    stock_as_of: Date | null;
    rows_tombstoned: number;
  } | null> =>
    db.one(
      `SELECT status, error, anomalies, metrics, stock_as_of, rows_tombstoned
         FROM sync_runs WHERE id = $1`,
      [runId],
    );

  const anomalyTypes = async (runId: number): Promise<string[]> => {
    const row = await runRow(runId);
    return (row?.anomalies ?? []).map((a) => String(a['type']));
  };

  /** anomaly ก้อนเต็มของชนิดที่ระบุ — สำหรับเคสที่ต้องดูตัวเลขใน payload ไม่ใช่แค่ชนิด */
  const anomalyOf = async (
    runId: number,
    type: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const row = await runRow(runId);
    return (row?.anomalies ?? []).find((a) => a['type'] === type);
  };

  const auditActions = async (): Promise<string[]> => {
    const r = await db.query<{ action: string }>(
      `SELECT action FROM audit_log ORDER BY id`,
    );
    return r.rows.map((x) => x.action);
  };

  const liveTokens = async (empId: string): Promise<number> => {
    const r = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE emp_id = $1 AND revoked_at IS NULL`,
      [empId],
    );
    return r?.n ?? 0;
  };

  /**
   * ย้อนนาฬิกา grace ให้ "หายไปนานพอจะลบได้แล้ว"
   *
   * แตะเฉพาะแถวที่ sweep ตั้งนาฬิกาไว้เองรอบก่อนหน้า (`absent_since IS NOT NULL`)
   * → ถ้ารอบก่อนไม่ได้ตั้งนาฬิกาให้ใคร ฟังก์ชันนี้จะไม่ทำอะไรเลย และเคสที่คาดว่าจะลบ
   *   จะแดงทันที ซึ่งเป็นสิ่งที่ต้องการ
   */
  const expireGrace = async (): Promise<number> => {
    const r = await db.query(
      `UPDATE user_credentials SET absent_since = now() - interval '48 hours'
        WHERE absent_since IS NOT NULL`,
    );
    return r.rowCount ?? 0;
  };

  /** ตารางทุกใบที่รอบ sync เขียนถึง — ใช้พิสูจน์ว่า plaintext ไม่ตกค้างที่ไหนเลย */
  const PERSISTED_TABLES = [
    'users',
    'user_credentials',
    'audit_log',
    'sync_runs',
    'refresh_tokens',
    'devices',
  ] as const;

  const dumpAllRows = async (): Promise<string> => {
    const parts: string[] = [];
    for (const table of PERSISTED_TABLES) {
      // ชื่อตารางมาจากอาเรย์ literal ด้านบนเท่านั้น (ไม่มี input จากภายนอก)
      const row = await db.one<{ dump: string }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(t))::text, '[]') AS dump FROM ${table} t`,
      );
      parts.push(row?.dump ?? '[]');
    }
    return parts.join('\n');
  };

  // ─────────────────────────────────────────────────────────────────────
  // ด่าน 0 — ต้องมีทางกลับเข้าระบบก่อนเสมอ
  // ─────────────────────────────────────────────────────────────────────

  describe('ด่าน 0 — break-glass admin', () => {
    it('ไม่มี credential source=local ที่เป็น admin → ปฏิเสธทั้ง run ไม่เขียนอะไรเลย', async () => {
      await seedUser({ empId: 'E100', role: 'staff', source: 'erp' });
      erp.users = [erpUser('E200')];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      expect(res.status).toBe('failed');
      expect(res.error).toContain('create-admin');
      expect(res.rowsUpserted).toBe(0);
      // แถวใหม่ต้องไม่ถูกสร้าง และแถวเดิมต้องไม่ถูกแตะ
      expect(await userOf('E200')).toBeNull();
      expect(await credentialOf('E100')).not.toBeNull();
    });

    /**
     * ⭐ ด่านเดียวกันฝั่ง boot — แทนที่กฎเดิม "ต้องมี level ที่ map เป็น admin" ใน `.env`
     *
     * ตั้งแต่ทุกคนได้ `ERP_USER_FIXED_ROLE` เท่ากันหมด ERP ไม่มีทางสร้าง admin ให้ใครได้อีก
     * ทางเข้าระดับ admin จึงเหลือทางเดียวคือ break-glass — ถ้าไม่มี ระบบต้องไม่ยอมตั้งรอบ
     * sync ผู้ใช้ให้เดินเองทุกชั่วโมงโดยไม่มีใครล็อกอินเข้ามาซ่อมได้เลย
     */
    describe('ด่านเดียวกันตอน boot (onModuleInit)', () => {
      const BOOT: SyncConfig = {
        TZ: 'Asia/Bangkok',
        ERP_SYNC_CRON: '*/30 * * * *',
        ERP_USER_SYNC_CRON: '17 * * * *',
        ERP_USER_SYNC_ENABLED: true,
      };

      /** cron ที่ถูกตั้งจริงต้องถูกหยุด ไม่งั้น timer ค้างจน jest ไม่ยอมจบ */
      const bootAndListJobs = async (over: SyncConfig = {}): Promise<string[]> => {
        const registry = new SchedulerRegistry();
        await makeSync({ ...BOOT, ...over }, registry).onModuleInit();
        const jobs = registry.getCronJobs();
        const names = [...jobs.keys()];
        for (const job of jobs.values()) job.stop();
        return names;
      };

      it('⭐ เปิดสวิตช์แต่ไม่มี break-glass admin → ไม่ตั้ง cron รอบผู้ใช้ (รอบ items ยังตั้งตามปกติ)', async () => {
        const names = await bootAndListJobs();

        expect(names).not.toContain('kk:sync:users');
        // ห้ามลามไปดับรอบ items หรือดับทั้งเซิร์ฟเวอร์ — API ที่ดับคือการล็อกคนทั้งคลังออก
        expect(names).toContain('kk:sync:items');
      });

      it('มี break-glass admin แล้ว → ตั้ง cron รอบผู้ใช้ตามปกติ', async () => {
        await seedLocalAdmin();

        const names = await bootAndListJobs();

        expect(names).toEqual(expect.arrayContaining(['kk:sync:items', 'kk:sync:users']));
      });

      it('ปิดสวิตช์อยู่ → ไม่ตั้ง cron รอบผู้ใช้ แม้มี break-glass admin ครบ', async () => {
        await seedLocalAdmin();

        const names = await bootAndListJobs({ ERP_USER_SYNC_ENABLED: false });

        expect(names).not.toContain('kk:sync:users');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // role เดียวกันทุกคน (ERP_USER_FIXED_ROLE) — allowlist ของ user_level ถูกถอดออกแล้ว
  // ─────────────────────────────────────────────────────────────────────

  describe('role เดียวกันทุกคน (ERP_USER_FIXED_ROLE)', () => {
    it('⭐ ทุก user_level ได้ role เดียวกันหมด — บัญชีที่ allowlist เคยกันไว้ ตอนนี้ได้บัญชีแล้ว', async () => {
      // 🚨 นี่คือ **ด่านที่หายไป** ตามคำสั่งลูกค้า ไม่ใช่บั๊ก: เดิม `ERP_USER_LEVEL_ROLE_MAP`
      //    เป็นประตูเดียวที่กันบัญชี ERP ที่ไม่เกี่ยวกับคลัง (บัญชี · ขาย · จัดซื้อ · superuser)
      //    ไม่ให้ล็อกอินเข้าแอปนี้ เพราะ query ของ `menuuser` ไม่มี WHERE กรองแผนกเลย
      //    ตอนนี้ทุกแถวที่อ่านตัวตนออกได้บัญชีทันที เคสนี้มีไว้ให้ความจริงข้อนั้นแดงทันที
      //    ถ้ามีใครเผลอเติม allowlist กลับมาโดยไม่ได้คุยกับลูกค้าก่อน
      await seedLocalAdmin();
      erp.users = [
        ...['U1', 'U2', 'U3'].map((e) => erpUser(e, { userLevel: LEVEL_OUTSIDER })),
        ...['U6', 'U7'].map((e) => erpUser(e, { userLevel: '8' })),
        erpUser('U8', { userLevel: LEVEL_STAFF }),
      ];

      const res = await makeSync().syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 6, rejected: 0 });
      for (const empId of ['U1', 'U2', 'U3', 'U6', 'U7', 'U8']) {
        expect((await userOf(empId))?.role).toBe(FIXED_ROLE);
        expect(await credentialOf(empId)).not.toBeNull();
      }
      // ตัวนับ/anomaly ของ allowlist ต้องหายไปทั้งชุด ไม่ใช่เหลือค้างเป็น 0 ให้เข้าใจผิด
      expect(await anomalyTypes(res.runId)).not.toContain('erp_level_unmapped');
      expect(await auditActions()).not.toContain('users.erp_level_unmapped');
      expect(Object.keys(res.metrics ?? {})).not.toContain('unmapped');
    });

    it('เปลี่ยน ERP_USER_FIXED_ROLE เป็น viewer → ทุกคนเป็น viewer (สลับได้ด้วยคอนฟิกบรรทัดเดียว)', async () => {
      await seedLocalAdmin();
      erp.users = ['V1', 'V2', 'V3'].map((e) => erpUser(e, { userLevel: LEVEL_OUTSIDER }));

      const res = await makeSync({ ERP_USER_FIXED_ROLE: 'viewer' }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 3 });
      for (const empId of ['V1', 'V2', 'V3']) expect((await userOf(empId))?.role).toBe('viewer');
    });

    it('⭐ แถวที่ยังอยู่ใน ERP แต่ตกด่านรูปแบบ → ห้ามลบ ห้ามเริ่มนาฬิกา แม้รันซ้ำ', async () => {
      // นี่คือบั๊กตัวจริงที่เคยทำให้ "ข้อมูล ERP เพี้ยนชั่วคราว = ล้าง credential":
      // sweep เคยใช้ชุด "คนที่เขียนสำเร็จรอบนี้" แทนชุด "คนที่ยังอยู่ใน ERP"
      // เดิมพิสูจน์ผ่าน level ที่ไม่ได้ map — ตอนนี้ไม่มี allowlist แล้ว รูปแบบที่เหลือของ
      // บั๊กเดียวกันคือแถวที่ `screenUserRows` ปฏิเสธ (ที่นี่: รหัสผ่าน decode เพี้ยน)
      await seedLocalAdmin();
      await seedUser({ empId: 'E501', role: 'staff', source: 'erp' });
      const before = await credentialOf('E501');
      erp.users = [
        erpUser('E501', { password: `พัง${REPLACEMENT_CHAR}` }),
        erpUser('E601'),
        erpUser('E602'),
      ];

      const sync = makeSync();
      const first = await sync.syncUsers('test');
      // ย้อนนาฬิกาแล้วรันซ้ำ: ถ้าเผลอนับ E501 เป็น "หายไปจาก ERP" รอบที่สองจะลบเขาทันที
      await expireGrace();
      const second = await sync.syncUsers('test');

      const after = await credentialOf('E501');
      expect(after).not.toBeNull();
      expect(after?.secret_hash).toBe(before?.secret_hash);
      expect(after?.login_name).toBe(before?.login_name);
      expect(after?.source).toBe('erp');
      // ยังอยู่ใน ERP → นาฬิกา grace ต้องไม่ถูกตั้งเลยตั้งแต่แรก
      expect(after?.absent_since).toBeNull();
      // role เดิมต้องไม่ถูกแตะ (ไม่ใช่ทั้งลด ไม่ใช่ทั้งเลื่อน)
      expect((await userOf('E501'))?.role).toBe('staff');
      for (const res of [first, second]) {
        expect(res.status).toBe('success');
        expect(res.rowsTombstoned).toBe(0);
        expect(res.metrics).toMatchObject({ mapped: 2, rejected: 1, absent: 0, deactivated: 0 });
      }
      expect(await anomalyTypes(second.runId)).toContain('rejected_row');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // role เปลี่ยน — จุดที่บั๊ก RETURNING เคยทำให้ revoke ไม่เคยทำงาน
  // ─────────────────────────────────────────────────────────────────────

  describe('role เปลี่ยนตาม ERP_USER_FIXED_ROLE', () => {
    /**
     * สร้างผู้ใช้ ERP จริง ๆ ผ่านรอบ sync (ด้วย role ที่ระบุ) แล้วล็อกอินให้มี refresh token 1 ใบ
     *
     * ⚠️ role มาจากคอนฟิกของรอบนั้น ไม่ใช่จากข้อมูล ERP อีกแล้ว → เคสที่อยากทดสอบ "สิทธิ์
     *    เปลี่ยน" จึงต้องรันรอบถัดไปด้วย `SyncService` อีกตัวที่ตั้ง `ERP_USER_FIXED_ROLE` ต่างกัน
     */
    async function createViaSyncAndLogin(
      empId: string,
      role: Role,
      password: string,
    ): Promise<void> {
      await seedLocalAdmin();
      erp.users = [erpUser(empId, { password })];
      const created = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 1,
        ERP_USER_FIXED_ROLE: role,
      }).syncUsers('test');
      expect(created.status).toBe('success');
      expect((await userOf(empId))?.role).toBe(role);
      await auth.login({ empId: empId.toLowerCase(), pin: password, deviceId: DEVICE });
      expect(await liveTokens(empId)).toBe(1);
    }

    it('⭐ ลดสิทธิ์ → role_version +1 พอดี และ refresh token ถูกตัดจริง (บั๊ก RETURNING)', async () => {
      // `UPDATE ... RETURNING role` คืนค่า **ใหม่** เสมอ → การเทียบ role เก่า/ใหม่ไม่มีทางเป็นจริง
      // และการตัด token ตอนลดสิทธิ์จะไม่เคยทำงานเลยแบบเงียบสนิท เคสนี้คือด่านของเรื่องนั้น
      await createViaSyncAndLogin('E777', 'admin', 'pw-E777');
      erp.users = [erpUser('E777', { password: 'pw-E777' })];

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 1,
        ERP_USER_FIXED_ROLE: 'staff',
      }).syncUsers('test');

      expect(res.status).toBe('success');
      const user = await userOf('E777');
      expect(user?.role).toBe('staff');
      expect(user?.role_version).toBe(2); // สร้างมาที่ 1 → เปลี่ยน role ครั้งเดียว
      expect(await liveTokens('E777')).toBe(0);
      expect(await auditActions()).toContain('users.erp_role_changed');
    });

    it('เลื่อนสิทธิ์ → ไม่ตัด refresh token (ทำงานต่อได้ทันที)', async () => {
      await createViaSyncAndLogin('E778', 'viewer', 'pw-E778');
      erp.users = [erpUser('E778', { password: 'pw-E778' })];

      await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 1,
        ERP_USER_FIXED_ROLE: 'staff',
      }).syncUsers('test');

      const user = await userOf('E778');
      expect(user?.role).toBe('staff');
      expect(user?.role_version).toBe(2);
      expect(await liveTokens('E778')).toBe(1);
    });

    it('คอนฟิกเดิมทุกอย่างเหมือนเดิม → ไม่แตะแถว users เลย (updated_at ไม่ขยับ)', async () => {
      await createViaSyncAndLogin('E779', FIXED_ROLE, 'pw-E779');
      const before = await userOf('E779');

      await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      const after = await userOf('E779');
      expect(after?.updated_at).toEqual(before?.updated_at);
      expect(after?.role_version).toBe(1);
      expect(await liveTokens('E779')).toBe(1);
    });

    it('⭐ ERP สั่งลดสิทธิ์บัญชี break-glass → ไม่ลด + audit ไว้ + ไม่แตะ credential', async () => {
      // admin คนเดียวที่เหลือคือ break-glass เอง (source=local) — sync ไม่แตะ credential ของเขา
      // และ **ห้ามแตะ users.role ของเขาด้วย** ถ้าไม่มีด่านนี้ ระบบจะไม่เหลือ admin เลยตั้งแต่
      // รอบแรก และการลดสิทธิ์นั้น commit ไปแล้วคนละทรานแซกชัน = ไม่มีทางกลับเข้าระบบ
      await seedLocalAdmin();
      const before = await credentialOf(LOCAL_ADMIN);
      const userBefore = await userOf(LOCAL_ADMIN);
      erp.users = [erpUser(LOCAL_ADMIN, { loginName: 'somchai.k' })];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect((await userOf(LOCAL_ADMIN))?.role).toBe('admin');
      // ไม่ทำตาม ERP = ต้องเห็นใน audit ไม่ใช่เงียบหาย
      expect(await auditActions()).toContain('users.erp_local_role_ignored');
      expect(await auditActions()).not.toContain('users.erp_role_changed');
      // ไม่แตะแถว users เลย → role_version ต้องไม่ขยับ (token ทุกเครื่องไม่เสียเปล่า)
      expect((await userOf(LOCAL_ADMIN))?.role_version).toBe(userBefore?.role_version);
      // credential ของ break-glass ต้องไม่ถูกแก้แม้แต่คอลัมน์เดียว
      const after = await credentialOf(LOCAL_ADMIN);
      expect(after?.source).toBe('local');
      expect(after?.login_name).toBe(LOCAL_ADMIN_LOGIN);
      expect(after?.secret_hash).toBe(before?.secret_hash);
      expect(after?.secret_rotated_at).toEqual(before?.secret_rotated_at);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // รหัสผ่าน — เปลี่ยนที่ ERP แล้วต้องตามทัน แต่ห้าม rotate ทุกชั่วโมงโดยไม่จำเป็น
  // ─────────────────────────────────────────────────────────────────────

  describe('รหัสผ่านจาก ERP', () => {
    it('รหัสผ่านเปลี่ยนที่ ERP → hash ใหม่ + ตัดทุกเซสชัน + ล็อกอินด้วยรหัสใหม่ได้', async () => {
      await seedLocalAdmin();
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 });
      erp.users = [erpUser('E301', { password: 'เก่า-1' })];
      await sync.syncUsers('test');
      const before = await credentialOf('E301');
      await auth.login({ empId: 'e301', pin: 'เก่า-1', deviceId: DEVICE });

      erp.users = [erpUser('E301', { password: 'ใหม่-2' })];
      await sync.syncUsers('test');

      const after = await credentialOf('E301');
      expect(after?.secret_hash).not.toBe(before?.secret_hash);
      expect(after?.secret_rotated_at.getTime()).toBeGreaterThan(
        before?.secret_rotated_at.getTime() ?? 0,
      );
      expect(await liveTokens('E301')).toBe(0);
      expect(await auditActions()).toContain('users.erp_secret_rotated');
      // พิสูจน์ว่า hash ที่เขียนคือรหัสผ่านใหม่จริง ไม่ใช่ค่าที่เพี้ยน
      const res = await auth.login({ empId: 'e301', pin: 'ใหม่-2', deviceId: DEVICE });
      expect(res.user.empId).toBe('E301');
    });

    it('รหัสผ่านเดิม → ไม่ rotate ไม่ตัด token (ไม่งั้นทุกคนหลุดทุกชั่วโมง)', async () => {
      await seedLocalAdmin();
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 });
      erp.users = [erpUser('E302', { password: 'คงที่-3' })];
      await sync.syncUsers('test');
      const before = await credentialOf('E302');
      await auth.login({ empId: 'e302', pin: 'คงที่-3', deviceId: DEVICE });

      await sync.syncUsers('test');

      const after = await credentialOf('E302');
      expect(after?.secret_rotated_at).toEqual(before?.secret_rotated_at);
      expect(after?.secret_hash).toBe(before?.secret_hash);
      expect(await liveTokens('E302')).toBe(1);
    });

    it('🚫 plaintext ของ ERP ไม่ตกค้างในแถวไหนเลย ทั้งของที่สำเร็จและของที่ถูกปฏิเสธ', async () => {
      const SECRET = 'ลับสุดยอด-Pa55word!';
      await seedLocalAdmin();
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 });
      // เดินให้ครบทุกเส้นทางที่ "จับ plaintext ไว้ในมือ": สร้างใหม่ · verify · rotate ·
      // แถวที่ถูกปฏิเสธเพราะ decode เพี้ยน (anomaly) · แถวที่ login ซ้ำในรอบเดียว (anomaly)
      erp.users = [
        erpUser('E401', { password: SECRET }),
        erpUser('E402', { password: `${SECRET}-เพี้ยน${REPLACEMENT_CHAR}` }),
        erpUser('E403', { password: SECRET, loginName: 'e401' }),
      ];
      await sync.syncUsers('test');
      await auth.login({ empId: 'e401', pin: SECRET, deviceId: DEVICE });
      erp.users = [erpUser('E401', { password: `${SECRET}-หมุนแล้ว` })];
      const res = await sync.syncUsers('test');

      const dump = await dumpAllRows();
      // กันเทสต์ว่างเปล่า: ถ้า dump ไม่มีข้อมูลจริง การ assert ข้างล่างจะผ่านฟรี ๆ
      expect(dump).toContain('E401');
      expect(dump).toContain('users.erp_secret_rotated');
      expect(dump).not.toContain(SECRET);
      expect(dump).not.toContain(String(TEST_CONFIG.PIN_PEPPER));
      // ค่าที่คืนออกไปทาง API (`POST /sync/users`) ก็ต้องสะอาดเหมือนกัน
      expect(JSON.stringify(res)).not.toContain(SECRET);
      // hash ที่เก็บต้องเป็น argon2id เท่านั้น
      expect((await credentialOf('E401'))?.secret_hash).toMatch(/^\$argon2id\$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // deactivation sweep — การ์ดสี่ชั้น ถอดชั้นไหนออกก็ล็อกคนทั้งคลังได้
  // ─────────────────────────────────────────────────────────────────────

  describe('deactivation sweep', () => {
    /** seed พนักงาน ERP หลายคนแบบเดียวกันทั้งชุด */
    const seedStaff = async (empIds: readonly string[]): Promise<void> => {
      for (const empId of empIds) await seedUser({ empId, role: 'staff', source: 'erp' });
    };

    const ALL = Array.from({ length: 12 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);

    it('⭐⭐ ลาออกแล้วล็อกอินไม่ได้จริง — พิสูจน์ผ่าน AuthService.login เส้นทางเดียวกับแอป', async () => {
      // นี่คือข้อกำหนดของลูกค้าตรง ๆ: "ซิ้งเวลาเขาลาออก กลับมาถ้าหาไม่เจอก็เข้าไม่ได้"
      // เคสอื่นในไฟล์นี้พิสูจน์แค่ว่า "แถว credential ถูกลบ" ซึ่งยัง **ไม่ใช่** สิ่งที่ลูกค้าขอ —
      // เคสนี้เดินเส้นทางล็อกอินจริงทั้งก่อนและหลัง จึงเป็นเคสเดียวที่ตอบคำถามนั้นได้
      const PW = 'รหัสของคนที่กำลังจะลาออก';
      const LEAVER = 'E42';
      const STAYS = Array.from({ length: 10 }, (_, i) => `K${String(i + 1).padStart(2, '0')}`);
      await seedLocalAdmin();
      // เพดานจริงทั้งสองตัวเปิดใช้อยู่ (ไม่ใช่ค่าที่ผ่อนให้เคสผ่าน): ลบ 1 จาก 11 = 9% ≤ 10%
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 10, ERP_USER_DEACTIVATE_MAX_PCT: 10 });

      // ── รอบ 1: ยังอยู่ใน menuuser → ได้บัญชีและล็อกอินได้จริง ──────────────────
      erp.users = [
        erpUser(LEAVER, { password: PW }),
        ...STAYS.map((e) => erpUser(e, { password: SEED_SECRET })),
      ];
      const first = await sync.syncUsers('round-1');
      expect(first.status).toBe('success');
      const session = await auth.login({ empId: 'e42', pin: PW, deviceId: DEVICE });
      expect(session.user.empId).toBe(LEAVER);
      expect(session.user.role).toBe(FIXED_ROLE);

      // ── รอบ 2: หายจาก menuuser แล้ว แต่ยังไม่พ้น grace → **ยังต้องล็อกอินได้** ──────
      // ถ้าเคสนี้แดง แปลว่าการ์ดกันการอ่าน ERP เพี้ยนรอบเดียวหายไป (คนละเรื่องกับลาออก)
      erp.users = STAYS.map((e) => erpUser(e, { password: SEED_SECRET }));
      const second = await sync.syncUsers('round-2');
      expect(second.metrics).toMatchObject({ absent: 1, graceElapsed: 0, deactivated: 0 });
      expect((await credentialOf(LEAVER))?.absent_since).not.toBeNull();
      const stillIn = await auth.login({ empId: 'e42', pin: PW, deviceId: DEVICE });
      expect(stillIn.user.empId).toBe(LEAVER);

      // ── รอบ 3: หายต่อเนื่องจนพ้น grace → ปิดล็อกอินจริง ───────────────────────
      expect(await expireGrace()).toBe(1);
      const third = await sync.syncUsers('round-3');
      expect(third.status).toBe('success');
      expect(third.metrics).toMatchObject({ deactivated: 1, adminsDeactivated: 0 });

      // ⭐ ของจริงที่ต้องพิสูจน์: ล็อกอินด้วยรหัสที่ถูกต้องเป๊ะ ๆ ต้องไม่ผ่านอีกต่อไป
      await expect(
        auth.login({ empId: 'e42', pin: PW, deviceId: DEVICE }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_EMPLOYEE' });
      // และเซสชันที่ค้างอยู่บนเครื่องต้องต่ออายุไม่ได้ด้วย — ไม่งั้นเขาทำงานต่อได้อีกถึง 30 วัน
      // ทั้งที่ล็อกอินใหม่ไม่ได้แล้ว (แถว `users` ยังอยู่ครบ refresh จึงจะสำเร็จถ้าไม่เพิกถอน)
      expect(await liveTokens(LEAVER)).toBe(0);
      await expect(
        auth.refresh({ refreshToken: session.refreshToken, deviceId: DEVICE }),
      ).rejects.toBeInstanceOf(AuthError);
      // คนที่ยังอยู่ต้องล็อกอินได้ตามปกติ — ห้ามเก็บใครไปด้วย
      const survivor = await auth.login({ empId: 'k01', pin: SEED_SECRET, deviceId: DEVICE });
      expect(survivor.user.empId).toBe('K01');
      expect(await auditActions()).toContain('users.erp_deactivated');
    });

    it('⭐ หน้าต่าง grace มาจาก ERP_USER_ABSENCE_GRACE_HOURS จริง ไม่ใช่ค่าฝังตาย', async () => {
      // ถ้าค่านี้ยังฝังตายที่ 24 ชม. เคสนี้จะแดงครึ่งหลัง (6 ชม. ไม่พอให้ลบใครเลย)
      await seedLocalAdmin();
      await seedStaff(ALL);
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5, ERP_USER_ABSENCE_GRACE_HOURS: 5 });
      erp.users = ALL.slice(0, 11).map((e) => erpUser(e, { password: SEED_SECRET }));

      await sync.syncUsers('test'); // รอบ 1: E12 หาย → นาฬิกาเริ่มเดิน

      // หายมา 3 ชม. — ยังไม่ถึง 5 ชม. ที่ตั้งไว้ → ห้ามลบ
      await db.query(
        `UPDATE user_credentials SET absent_since = now() - interval '3 hours'
          WHERE absent_since IS NOT NULL`,
      );
      const beforeWindow = await sync.syncUsers('test');
      expect(beforeWindow.metrics).toMatchObject({ absent: 1, graceElapsed: 0, deactivated: 0 });
      expect(await credentialOf('E12')).not.toBeNull();

      // หายมา 6 ชม. — พ้น 5 ชม. แล้ว → ลบได้
      await db.query(
        `UPDATE user_credentials SET absent_since = now() - interval '6 hours'
          WHERE absent_since IS NOT NULL`,
      );
      const afterWindow = await sync.syncUsers('test');
      expect(afterWindow.metrics).toMatchObject({ absent: 1, graceElapsed: 1, deactivated: 1 });
      expect(await credentialOf('E12')).toBeNull();
    });

    it('หายรอบเดียวยังไม่ลบ — ตั้งนาฬิกา grace ไว้ก่อน', async () => {
      await seedLocalAdmin();
      await seedStaff(ALL);
      erp.users = ALL.slice(0, 11).map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.rowsTombstoned).toBe(0);
      expect(res.metrics).toMatchObject({ absent: 1, graceElapsed: 0, deactivated: 0, refused: 0 });
      const cred = await credentialOf('E12');
      expect(cred).not.toBeNull();
      expect(cred?.absent_since).not.toBeNull();
    });

    it('หายนานเกิน grace → ลบ credential จริง ตัด token แต่แถว users ยังอยู่ครบ', async () => {
      await seedLocalAdmin();
      await seedStaff(ALL);
      await auth.login({ empId: 'e12', pin: SEED_SECRET, deviceId: DEVICE });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 });
      erp.users = ALL.slice(0, 11).map((e) => erpUser(e, { password: SEED_SECRET }));

      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1); // มีคนเดียวที่นาฬิกาเดินอยู่
      const res = await sync.syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.rowsTombstoned).toBe(1);
      expect(res.metrics).toMatchObject({ absent: 1, graceElapsed: 1, deactivated: 1, refused: 0 });
      // คนที่ถูกลบเป็น staff → ห้ามส่งสัญญาณ "เสีย admin" (ไม่งั้นสัญญาณจะเฟ้อจนไม่มีใครดู)
      expect(res.metrics).toMatchObject({ adminsDeactivated: 0 });
      expect(await anomalyTypes(res.runId)).not.toContain('admin_credentials_deactivated');
      expect(await credentialOf('E12')).toBeNull();
      expect(await liveTokens('E12')).toBe(0);
      // ⚠️ ห้ามลบแถว users — count_submissions เป็น ON DELETE RESTRICT และอีก 9 ตารางอ้าง FK มา
      expect(await userOf('E12')).not.toBeNull();
      expect(await auditActions()).toContain('users.erp_deactivated');
      // คนที่ยังอยู่ต้องไม่โดนอะไรเลย
      expect(await credentialOf('E11')).not.toBeNull();
    });

    it('เพดาน % — หายทีเดียว 30% → ไม่ลบใครเลย + anomaly + นับ refused ไว้', async () => {
      const ten = ALL.slice(0, 10);
      await seedLocalAdmin();
      await seedStaff(ten);
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 });
      erp.users = ten.slice(0, 7).map((e) => erpUser(e, { password: SEED_SECRET }));

      await sync.syncUsers('test');
      await expireGrace();
      const res = await sync.syncUsers('test');

      expect(res.rowsTombstoned).toBe(0);
      expect(res.metrics).toMatchObject({ absent: 3, graceElapsed: 3, deactivated: 0, refused: 3 });
      expect(await anomalyTypes(res.runId)).toContain('deactivate_guardrail_blocked');
      for (const empId of ten.slice(7)) expect(await credentialOf(empId)).not.toBeNull();
    });

    it('ERP ส่งมาน้อยกว่าเพดานแถวขั้นต่ำ → partial และไม่แตะแม้แต่นาฬิกา grace', async () => {
      const five = ALL.slice(0, 5);
      await seedLocalAdmin();
      await seedStaff(five);
      erp.users = five.slice(0, 2).map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 }).syncUsers('test');

      expect(res.status).toBe('partial');
      expect(res.rowsTombstoned).toBe(0);
      // `refused` = "พ้น grace แล้วแต่ไม่ได้ถูกลบ" เหมือนรอบปกติเป๊ะ ๆ — สามคนนี้นาฬิกา
      // ยังไม่เคยเริ่มเดินด้วยซ้ำ จึงยังไม่ใช่คนที่ถูกปฏิเสธ (รอบปกติก็ยังไม่ลบเขาอยู่ดี)
      expect(res.metrics).toMatchObject({ absent: 3, graceElapsed: 0, deactivated: 0, refused: 0 });
      expect(await anomalyTypes(res.runId)).toContain('row_count_below_floor');
      // นาฬิกาไม่ถูกตั้ง = รอบถัดไปที่ดึงมาครบยังต้องเริ่มนับ grace ใหม่ตั้งแต่ศูนย์
      for (const empId of five.slice(2)) {
        expect((await credentialOf(empId))?.absent_since).toBeNull();
      }
    });

    it('⭐ รอบที่ตกเพดานแถวขั้นต่ำ — refused นับเฉพาะคนที่พ้น grace แล้ว ไม่ใช่ absent ทั้งหมด', async () => {
      // เส้นทางนี้เคยใส่ "absent ทั้งหมด" ลงช่อง refused แล้วปล่อย graceElapsed เป็น 0 →
      // เลขเดียวกันในสองรอบหมายถึงคนละเรื่อง ผู้ดูแลเทียบรอบต่อรอบไม่ได้เลย
      const six = ALL.slice(0, 6);
      await seedLocalAdmin();
      await seedStaff(six);
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 });

      // รอบ 1 (ผ่านเพดานแถว): E06 หายไปคนเดียว → นาฬิกาเริ่มเดินให้เขาคนเดียว
      erp.users = six.slice(0, 5).map((e) => erpUser(e, { password: SEED_SECRET }));
      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1);

      // รอบ 2 (ตกเพดานแถว): ตอนนี้ absent = E04, E05, E06 แต่มีแค่ E06 ที่พ้น grace แล้ว
      erp.users = six.slice(0, 3).map((e) => erpUser(e, { password: SEED_SECRET }));
      const res = await sync.syncUsers('test');

      expect(res.status).toBe('partial');
      expect(res.metrics).toMatchObject({ absent: 3, graceElapsed: 1, deactivated: 0, refused: 1 });
      expect(await anomalyOf(res.runId, 'row_count_below_floor')).toMatchObject({
        absent: 3,
        graceElapsed: 1,
      });
      // ปฏิเสธ = ไม่ลบจริง ๆ (คนที่พ้น grace แล้วต้องยังล็อกอินได้อยู่)
      expect(await credentialOf('E06')).not.toBeNull();
    });

    it('⭐ รอบที่ตกเพดานแถวขั้นต่ำ ต้องล้างนาฬิกาของคนที่กลับมาพบใน ERP แล้ว', async () => {
      // คำสั่งล้างเคยอยู่ใน sweep ซึ่งรอบนี้ไม่ได้ทำงาน → นาฬิกาของคนที่ ERP ส่งชื่อมาแล้ว
      // เดินต่อไปเรื่อย ๆ พอถึงรอบที่เขาหายไปจริงครั้งแรก เขาจะถูกลบทันทีโดยไม่มี grace เลย
      const six = ALL.slice(0, 6);
      await seedLocalAdmin();
      await seedStaff(six);
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 5 });

      // รอบ 1 (ผ่านเพดานแถว): E06 หาย → นาฬิกาเริ่มเดิน
      erp.users = six.slice(0, 5).map((e) => erpUser(e, { password: SEED_SECRET }));
      await sync.syncUsers('test');
      expect((await credentialOf('E06'))?.absent_since).not.toBeNull();

      // รอบ 2 (ตกเพดานแถว): E06 กลับมาแล้ว — ต้องหยุดนาฬิกาให้เขาแม้ sweep ไม่ได้ทำงาน
      erp.users = [erpUser('E06', { password: SEED_SECRET }), erpUser('E01', { password: SEED_SECRET })];
      const second = await sync.syncUsers('test');

      expect(second.status).toBe('partial');
      expect((await credentialOf('E06'))?.absent_since).toBeNull();
      // ไม่มีนาฬิกาเรือนไหนเดินค้างอยู่เลย (รอบนี้ห้ามเริ่มจับเวลาให้ใครใหม่ด้วย)
      expect(await expireGrace()).toBe(0);

      // รอบ 3 (ผ่านเพดานแถว): E06 หายอีกครั้ง → ต้องได้ grace เต็มใหม่ ไม่ใช่ถูกลบทันที
      erp.users = six.slice(0, 5).map((e) => erpUser(e, { password: SEED_SECRET }));
      const third = await sync.syncUsers('test');

      expect(third.metrics).toMatchObject({ absent: 1, graceElapsed: 0, deactivated: 0 });
      expect(await credentialOf('E06')).not.toBeNull();
    });

    it('ไม่ได้ตั้ง ERP_USER_MIN_EXPECTED_ROWS → ถือว่าไม่ผ่านเพดานเสมอ ห้าม deactivate ใคร', async () => {
      // ยิง `POST /sync/users` ด้วยมือได้แม้สวิตช์คัตโอเวอร์ปิดอยู่ — ตรงนั้นต้องไม่กลายเป็น
      // ทางลัดที่ไม่มีเพดานแถวขั้นต่ำ
      const five = ALL.slice(0, 5);
      await seedLocalAdmin();
      await seedStaff(five);
      erp.users = five.slice(0, 4).map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: undefined }).syncUsers('test');

      expect(res.status).toBe('partial');
      // นาฬิกาของ E05 ยังไม่เคยเริ่มเดิน → absent 1 แต่ยังไม่มีใครพ้น grace ให้ปฏิเสธ
      expect(res.metrics).toMatchObject({ absent: 1, graceElapsed: 0, deactivated: 0, refused: 0 });
      expect(await credentialOf('E05')).not.toBeNull();
    });

    it('⭐ "admin ผี" ที่ไม่มี credential แล้ว ห้ามถูกนับเป็นตาข่ายของด่าน last-admin', async () => {
      // เคสที่เคยล็อกทั้งคลังออกได้จริง: E902 เป็น admin ที่ **ไม่มี credential แล้ว**
      // (ถูกปิดล็อกอินไปในรอบก่อน ๆ แต่แถว users ยังอยู่ตามกติกา "ห้ามลบแถว users")
      // ถ้าด่าน last-admin นับจาก `users.role` ล้วน ๆ เขาจะถูกนับเป็น "ยังมี admin อีกคน"
      // แล้วลูปจะยอมลดสิทธิ์ break-glass ตามที่ ERP สั่ง — และการลดสิทธิ์นั้น commit ไปแล้ว
      // คนละทรานแซกชัน กู้ไม่ได้แม้ sweep จะจับได้ทีหลังแล้ว rollback ตัวเอง
      await seedLocalAdmin();
      await seedUser({ empId: 'E900', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E901', role: 'staff', source: 'erp' });
      await db.query(
        `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
         VALUES ('E902', 'ผู้ดูแลที่ถูกปิดล็อกอินไปแล้ว', 'admin', 'กะเช้า · A', 'WH01', false)`,
      );
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2, ERP_USER_DEACTIVATE_MAX_PCT: 100 });

      // รอบที่ 1: E900 หายจาก ERP → เริ่มจับเวลา grace (ยังไม่ลบ)
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN }),
        erpUser('E901', { password: SEED_SECRET }),
      ];
      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1);
      // break-glass ต้องยังทำงานต่อได้ตลอด → ล็อกอินค้างไว้ 1 เครื่องเพื่อดูว่า token ถูกตัดไหม
      await auth.login({ empId: LOCAL_ADMIN_LOGIN, pin: SEED_SECRET, deviceId: DEVICE });
      expect(await liveTokens(LOCAL_ADMIN)).toBe(1);

      // รอบที่ 2: ERP สั่งลด break-glass เป็น staff พร้อมกับที่ E900 พ้น grace พอดี
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN }),
        erpUser('E901', { password: SEED_SECRET }),
      ];
      const res = await sync.syncUsers('test');

      // ⭐ หัวใจของเคสนี้: ทางกลับเข้าระบบต้องอยู่ครบทั้ง role และ session
      expect((await userOf(LOCAL_ADMIN))?.role).toBe('admin');
      expect(await liveTokens(LOCAL_ADMIN)).toBe(1);
      expect(await credentialOf(LOCAL_ADMIN)).not.toBeNull();
      expect(await auditActions()).not.toContain('users.erp_role_changed');
      expect(await auditActions()).toContain('users.erp_local_role_ignored');
      // ไม่มีอะไรถูกลดสิทธิ์ → sweep เหลือ admin ที่ล็อกอินได้จริง (break-glass) จึงเดินต่อได้
      // ตามปกติ ไม่ต้อง rollback ทั้งก้อนเหมือนที่เคยจบแบบล้มทั้งรอบ
      const row = await runRow(res.runId);
      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 2, deactivated: 1, adminsDeactivated: 1 });
      expect(row?.metrics.mapped).toBe(2);
      expect(await anomalyTypes(res.runId)).not.toContain('admin_credential_floor_blocked');
      // E900 หายจาก ERP เกิน grace จริง → ปิดล็อกอินได้ถูกต้องแล้ว
      expect(await credentialOf('E900')).toBeNull();
      expect(await auditActions()).toContain('users.erp_deactivated');
    });

    it('⭐ ลบ credential ของ admin → anomaly เฉพาะทาง + ตัวนับใน sync_runs (ห้ามเงียบ)', async () => {
      // เพดาน last-admin ปล่อยรอบนี้ผ่านอย่างถูกต้อง เพราะ break-glass ยังอยู่ครบ —
      // แต่ถ้ารอบจบเป็น 'success' เฉย ๆ จะไม่มีอะไรบอกผู้ดูแลว่าคลังเพิ่งเสีย admin ตัวจริง
      // ไปทั้งหมด และจะรู้ตัวอีกทีตอนไม่มีใครเปิด/ปิดรอบนับได้
      await seedLocalAdmin();
      await seedUser({ empId: 'E910', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E911', role: 'staff', source: 'erp' });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2, ERP_USER_DEACTIVATE_MAX_PCT: 100 });
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN }),
        erpUser('E911', { password: SEED_SECRET }),
      ];

      await sync.syncUsers('test'); // รอบ 1: E910 หายจาก ERP → เริ่มจับเวลา grace
      expect(await expireGrace()).toBe(1);
      const res = await sync.syncUsers('test'); // รอบ 2: พ้น grace → ลบจริง

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ deactivated: 1, adminsDeactivated: 1 });
      expect(await credentialOf('E910')).toBeNull();
      // สภาพจริงหลังรอบนี้: admin ที่ล็อกอินได้เหลือแต่ break-glass เท่านั้น
      const erpAdmins = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_credentials c JOIN users u ON u.emp_id = c.emp_id
          WHERE u.role = 'admin' AND c.source <> 'local'`,
      );
      expect(erpAdmins?.n).toBe(0);
      // ต้องอ่านออกจากแถวเดียวใน sync_runs โดยไม่ต้องเปิดโค้ดหรือไล่ audit_log
      const row = await runRow(res.runId);
      expect(row?.metrics.adminsDeactivated).toBe(1);
      expect(await anomalyOf(res.runId, 'admin_credentials_deactivated')).toMatchObject({
        deactivated: 1,
        empIds: ['E910'],
        localAdminsLeft: 1,
        otherAdminsLeft: 0,
      });
    });

    it('⭐ break-glass ถูกลดสิทธิ์ไม่ได้ แม้ในรอบเดียวกับที่ admin อีกคนถูกลบพอดี', async () => {
      // E920 เป็น admin ที่หายจาก ERP และพ้น grace แล้ว = ถูกลบท้ายรอบนี้แน่นอน
      // ถ้าลูปยอมลดสิทธิ์ break-glass ตามที่ ERP สั่งในรอบเดียวกันนี้ รอบนั้นจะไปจบที่ sweep
      // ซึ่งต้อง rollback ทั้งก้อน — เสียทั้งสิทธิ์ (การลดสิทธิ์ commit ไปแล้วคนละทรานแซกชัน)
      // และเสียรอบ sync ไปพร้อมกัน
      await seedLocalAdmin();
      await seedUser({ empId: 'E920', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E921', role: 'staff', source: 'erp' });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2, ERP_USER_DEACTIVATE_MAX_PCT: 100 });

      // รอบ 1: E920 หายจาก ERP → เริ่มจับเวลา (break-glass ยังเป็น admin ตามที่ ERP บอก)
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN }),
        erpUser('E921', { password: SEED_SECRET }),
      ];
      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1);

      // รอบ 2: ERP สั่งลดสิทธิ์ break-glass ในรอบเดียวกับที่ E920 พ้น grace พอดี
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN }),
        erpUser('E921', { password: SEED_SECRET }),
      ];
      const res = await sync.syncUsers('test');

      expect((await userOf(LOCAL_ADMIN))?.role).toBe('admin');
      expect(await auditActions()).toContain('users.erp_local_role_ignored');
      // ด่านกันไว้ถูกตั้งแต่ต้น → sweep เดินต่อได้ตามปกติ ไม่ต้องล้มทั้งรอบ
      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ deactivated: 1, adminsDeactivated: 1 });
      expect(await credentialOf('E920')).toBeNull();
      expect(await credentialOf(LOCAL_ADMIN)).not.toBeNull();
      expect(await anomalyTypes(res.runId)).not.toContain('admin_credential_floor_blocked');
    });

    it('⭐ sweep ชนด่าน last-admin → rollback ทั้งก้อน แต่ตัวนับของรอบต้องไม่หายไปเป็นศูนย์', async () => {
      // รอบที่ผู้ดูแลต้องอ่านมากที่สุดในชีวิตระบบ = รอบที่ระบบเกือบไม่เหลือ admin
      // ถ้า metrics เป็น 0 ทั้งแถวเพราะการ throw ข้ามบรรทัดที่ copy ค่าลง metrics ไป
      // รอบนี้จะดูเหมือน "รอบที่ไม่ได้ทำอะไรเลย" ทั้งที่มันคือรอบที่เกือบล็อกทุกคนออก
      //
      // ⚠️ สภาพนี้เกิดจาก ERP อย่างเดียวไม่ได้ (ด่าน 0 + ภูมิคุ้มกันของ source='local'
      //    การันตีว่ามี admin ที่ล็อกอินได้เสมอ) — จำลอง "มีคนลดสิทธิ์ break-glass นอกรอบ
      //    sync" (MembersService หรือแก้ SQL ด้วยมือ) ให้เกิด **หลังด่าน 0 ผ่านไปแล้ว**
      //    ซึ่งเป็นเหตุผลเดียวที่ด่านนี้ยังต้องมีอยู่
      await seedLocalAdmin();
      await seedUser({ empId: 'E930', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E931', role: 'staff', source: 'erp' });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1, ERP_USER_DEACTIVATE_MAX_PCT: 100 });

      erp.users = [erpUser('E931', { password: SEED_SECRET })];
      await sync.syncUsers('test'); // รอบ 1: E930 (admin) หายจาก ERP → เริ่มจับเวลา
      expect(await expireGrace()).toBe(1);

      // ด่าน 0 อ่านค่าไปแล้วตอนต้นรอบ · fetchUsers ถูกเรียกหลังจากนั้น = ช่องที่ของจริงเปลี่ยนได้
      const fetchUsers = erp.fetchUsers.bind(erp);
      erp.fetchUsers = async () => {
        await db.query(`UPDATE users SET role = 'staff' WHERE emp_id = $1`, [LOCAL_ADMIN]);
        return fetchUsers();
      };
      const res = await sync.syncUsers('test');

      // ลบแล้วจะไม่เหลือ admin ที่ล็อกอินได้เลย → ไม่ลบสักแถว และรอบถูกบันทึกว่าล้มเหลว
      expect(res.status).toBe('failed');
      expect(await credentialOf('E930')).not.toBeNull();
      expect(await auditActions()).not.toContain('users.erp_deactivated');
      expect(await anomalyTypes(res.runId)).toContain('admin_credential_floor_blocked');
      // ⭐ หัวใจของเคสนี้: ตัวนับของ sweep ต้องเดินทางออกมากับ error มาถึง sync_runs
      const row = await runRow(res.runId);
      expect(row?.metrics).toMatchObject({
        absent: 1,
        graceElapsed: 1,
        deactivated: 0,
        adminsDeactivated: 0,
        refused: 1,
      });
      expect(res.metrics).toMatchObject({ absent: 1, graceElapsed: 1, refused: 1 });
    });

    it('credential source=local ไม่เข้า sweep แม้ไม่ปรากฏใน ERP เลย', async () => {
      const three = ALL.slice(0, 3);
      await seedLocalAdmin();
      await seedStaff(three);
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 3 });
      erp.users = three.map((e) => erpUser(e, { password: SEED_SECRET }));

      await sync.syncUsers('test');
      await expireGrace();
      const res = await sync.syncUsers('test');

      expect(res.metrics).toMatchObject({ absent: 0, deactivated: 0 });
      const cred = await credentialOf(LOCAL_ADMIN);
      expect(cred).not.toBeNull();
      expect(cred?.absent_since).toBeNull(); // นาฬิกาไม่เคยเริ่มเดินให้ break-glass
    });

    it('legacy_pin ที่ ERP รู้จัก → เปลี่ยนสัญชาติในแถวเดิม ไม่ลบสร้างใหม่', async () => {
      await seedLocalAdmin();
      await seedUser({ empId: 'E410', role: 'staff', source: 'legacy_pin', loginName: 'e410' });
      const before = await credentialOf('E410');
      erp.users = [erpUser('E410', { loginName: 'Somsri.T', password: 'รหัสจาก-ERP' })];

      await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      const after = await credentialOf('E410');
      expect(after?.login_name).toBe('somsri.t');
      expect(after?.source).toBe('erp');
      // created_at เดิม = แถวเดียวกันถูก UPDATE ไม่ใช่ DELETE + INSERT
      expect(after?.created_at).toEqual(before?.created_at);
      expect(after?.absent_since).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // เพดานการ "ให้" สิทธิ์ — คู่ตรงข้ามของเพดานการถอนสิทธิ์
  // ─────────────────────────────────────────────────────────────────────

  describe('เพดานการเลื่อนสิทธิ์ (ERP_USER_ELEVATE_MAX_PCT)', () => {
    const SIX = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06'];

    const seedSix = async (): Promise<void> => {
      for (const empId of SIX) await seedUser({ empId, role: 'staff', source: 'erp' });
    };

    it('⭐ ตั้ง ERP_USER_FIXED_ROLE=admin จนคนทั้งคลังได้เป็น admin → คงสิทธิ์เดิมไว้ทุกคน + anomaly', async () => {
      // `ERP_USER_DEACTIVATE_MAX_PCT` กันการ "ถอน" สิทธิ์ทีละมาก ๆ ไว้แล้ว แต่การ "ให้"
      // สิทธิ์ไม่เคยมีการ์ดเลย — ตอนนี้ยิ่งง่ายกว่าเดิม: แก้คอนฟิกบรรทัดเดียวเป็น `admin`
      // คือคนทั้งคลังเป็น admin ในรอบเดียว โดยไม่มีมนุษย์คนไหนกด และรอบนั้นรายงาน 'success' เงียบ ๆ
      await seedLocalAdmin();
      await seedSix();
      const before = await userOf('P01');
      erp.users = SIX.map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 6,
        ERP_USER_FIXED_ROLE: 'admin',
      }).syncUsers('test');

      expect(res.status).toBe('success');
      for (const empId of SIX) expect((await userOf(empId))?.role).toBe('staff');
      expect(res.metrics).toMatchObject({ mapped: 6, elevated: 0, elevationsRefused: 6 });
      expect(await anomalyOf(res.runId, 'elevate_guardrail_blocked')).toMatchObject({
        elevations: 6,
        // ตัวหาร = คนที่ ERP คุมรอบนี้ (ไม่ใช่จำนวนแถวใน user_credentials — ดูสองเคสถัดไป)
        governed: 6,
      });
      // ไม่ได้แตะแถว users เลย → role_version ไม่ขยับ และไม่มี audit ว่า role เปลี่ยน
      expect((await userOf('P01'))?.role_version).toBe(before?.role_version);
      expect(await auditActions()).not.toContain('users.erp_role_changed');
      // การ์ดนี้กันแค่ "สิทธิ์" — ส่วนที่เหลือของรอบต้องเดินตามปกติ (ไม่ใช่ล้มทั้งรอบ)
      expect((await credentialOf('P01'))?.source).toBe('erp');
      expect((await credentialOf('P01'))?.absent_since).toBeNull();
    });

    it('⭐ รอบแรกของระบบ (ทุกคนเป็นคนใหม่) ต้องไม่ถูกเพดานนี้บล็อก', async () => {
      // คนใหม่ไม่มี "สิทธิ์เดิม" ให้เทียบ → ไม่ใช่การเลื่อนสิทธิ์ ถ้าเผลอนับคนใหม่เป็นการเลื่อน
      // สิทธิ์ด้วย การเปิดใช้ระบบครั้งแรกจะไม่มีทางสร้าง admin จาก ERP ได้เลยสักคน
      const eight = Array.from({ length: 8 }, (_, i) => `N${String(i + 1).padStart(2, '0')}`);
      await seedLocalAdmin();
      erp.users = eight.map((e) => erpUser(e));

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 8,
        ERP_USER_FIXED_ROLE: 'admin',
      }).syncUsers('test');

      expect(res.status).toBe('success');
      for (const empId of eight) expect((await userOf(empId))?.role).toBe('admin');
      expect(res.metrics).toMatchObject({ mapped: 8, elevated: 0, elevationsRefused: 0 });
      expect(await anomalyTypes(res.runId)).not.toContain('elevate_guardrail_blocked');
    });

    it('เลื่อนสิทธิ์ทีละไม่กี่คน → ผ่านตามปกติ (เพดาน % ล้วนจะบล็อกคลังเล็กไปตลอด)', async () => {
      // 3 จาก 6 คน = 50% เกินเพดาน 10% แต่เป็นจำนวนที่ผู้ดูแลตั้งใจให้เกิดได้จริง —
      // ถ้าการ์ดบล็อกเคสนี้ คลังเล็กจะเลื่อนสิทธิ์ใครไม่ได้เลยตลอดกาลโดยไม่มีอะไรฟ้อง
      // (สามคนแรกเป็น viewer อยู่เดิม → รอบนี้ถูกเลื่อนเป็น staff · อีกสามคนเป็น staff อยู่แล้ว)
      await seedLocalAdmin();
      for (const [i, empId] of SIX.entries()) {
        await seedUser({ empId, role: i < 3 ? 'viewer' : 'staff', source: 'erp' });
      }
      erp.users = SIX.map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 6 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 6, elevated: 3, elevationsRefused: 0 });
      for (const empId of SIX) expect((await userOf(empId))?.role).toBe('staff');
      expect(await anomalyTypes(res.runId)).not.toContain('elevate_guardrail_blocked');
      // เลื่อนสิทธิ์ = ไม่ตัด token (คนละเรื่องกับการลดสิทธิ์)
      expect(await auditActions()).toContain('users.erp_role_changed');
    });

    it('⭐ ก่อน cutover — แถว legacy_pin ที่ backfill ไว้ ห้ามทำให้ตัวหารพองจนเพดานหลวม', async () => {
      // schema.sql เติมแถว legacy_pin ให้ใหม่ทุก deploy จนกว่ารอบ users จะสำเร็จรอบแรก →
      // ถ้าตัวหารคือ `count(*) WHERE source IN ('erp','legacy_pin')` เพดานจะหลวมที่สุดพอดี
      // ในรอบแรก ๆ ที่ค่า ERP_USER_FIXED_ROLE ยังไม่เคยถูกพิสูจน์ ซึ่งคือช่วงที่เสี่ยงที่สุด
      //
      // เคสนี้: คนที่ ERP คุมจริงมี 6 คนและถูกเลื่อนเป็น admin ทั้งหมด = 100% ต้องถูกบล็อก
      // แต่ถ้านับแถว legacy_pin อีก 18 แถวที่ ERP ไม่เคยพูดถึงเข้าไปด้วยจะเหลือ 6/24 = 25%
      // พอดีเพดาน = ผ่านฉลุยทั้งที่เป็นเคสเดียวกับ role map พิมพ์ผิดเป๊ะ ๆ
      await seedLocalAdmin();
      for (const empId of SIX) await seedUser({ empId, role: 'staff', source: 'legacy_pin' });
      for (let i = 1; i <= 18; i++) {
        // คนที่ยังใช้ PIN เดิมอยู่และ ERP ไม่ได้ส่งมาในรอบนี้ (ยังไม่ถึงคิว cutover)
        await seedUser({
          empId: `L${String(i).padStart(2, '0')}`,
          role: 'staff',
          source: 'legacy_pin',
        });
      }
      erp.users = SIX.map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 6,
        ERP_USER_ELEVATE_MAX_PCT: 25,
        ERP_USER_FIXED_ROLE: 'admin',
      }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 6, elevated: 0, elevationsRefused: 6 });
      for (const empId of SIX) expect((await userOf(empId))?.role).toBe('staff');
      expect(await anomalyOf(res.runId, 'elevate_guardrail_blocked')).toMatchObject({
        elevations: 6,
        governed: 6, // ไม่ใช่ 24 — แถว legacy_pin ที่ ERP ยังไม่ได้คุมไม่นับเป็นตัวหาร
      });
    });

    it('⭐ หลัง cutover — ตัวหารต้องตัดสินเหมือนเดิม (การ์ดห้ามเข้มขึ้นเงียบ ๆ)', async () => {
      // หลัง cutover ทุกแถวเป็น source='erp' และอยู่ในผล ERP รอบนี้ครบ → "คนที่ ERP คุม"
      // กับ "แถว credential ที่มีอยู่" เป็นคนกลุ่มเดียวกัน ตัวหารจึงได้ 24 เท่ากันทั้งสองนิยาม
      // เลื่อน 6 คน = 25% พอดีเพดาน ต้องยังผ่านเหมือนเดิม ถ้าเคสนี้กลายเป็นบล็อกเมื่อไร
      // แปลว่าตัวหารใหม่ไม่ได้แปลว่า "คนที่ ERP คุม" อย่างที่อ้าง
      // (หกคนแรกเป็น viewer อยู่เดิม → ถูกเลื่อนเป็น staff · อีก 18 คนเป็น staff อยู่แล้ว)
      const cutover = Array.from({ length: 24 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
      await seedLocalAdmin();
      for (const [i, empId] of cutover.entries()) {
        await seedUser({ empId, role: i < 6 ? 'viewer' : 'staff', source: 'erp' });
      }
      erp.users = cutover.map((e) => erpUser(e, { password: SEED_SECRET }));

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 24,
        ERP_USER_ELEVATE_MAX_PCT: 25,
      }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 24, elevated: 6, elevationsRefused: 0 });
      for (const empId of cutover) expect((await userOf(empId))?.role).toBe('staff');
      expect(await anomalyTypes(res.runId)).not.toContain('elevate_guardrail_blocked');
    });

    it('⭐ นับเฉพาะแถวที่ลูปหลักจะรับจริง — แถวที่ถูกปฏิเสธห้ามดันจำนวนจนชนเพดาน', async () => {
      // ด่านเพดานเคยกรองแค่ "ตัวตนอ่านออก + map เป็น role ได้" ส่วนลูปหลักปฏิเสธ login ซ้ำ
      // กันเองในรอบเดียว / รหัสผ่าน decode เพี้ยน / ตัวตนผิดรูปเพิ่มอีกชั้น → นับได้ 6 ทั้งที่จะ
      // เลื่อนสิทธิ์จริงแค่ 3 แล้วการ์ดก็โยนการเลื่อนสิทธิ์ที่ถูกต้องทิ้งด้วยตัวเลขที่ไม่มีวันเกิดขึ้น
      await seedLocalAdmin();
      await seedSix();
      erp.users = [
        ...SIX.slice(0, 3).map((e) => erpUser(e, { password: SEED_SECRET })),
        // ⚠️ ชื่อไทยว่าง **ไม่ใช่แถวเสียแล้ว** (ERP จริงปล่อยว่างได้ — ดู `blank_name_thai`)
        //    แถวที่ยังถูกปฏิเสธจริงในกลุ่มนี้คือ "ตัวตนผิดรูป" แทน
        erpUser('P 4'),
        erpUser('P05', { password: `พัง${REPLACEMENT_CHAR}` }),
        erpUser('P06', { loginName: 'p01' }), // ซ้ำ P01 ในรอบเดียวกัน
      ];

      const res = await makeSync({
        ERP_USER_MIN_EXPECTED_ROWS: 6,
        ERP_USER_FIXED_ROLE: 'admin',
      }).syncUsers('test');

      expect(res.status).toBe('success');
      // 3 คนที่แถวใช้ได้จริง ไม่เกิน ELEVATE_ALWAYS_ALLOWED → ต้องเลื่อนสิทธิ์ได้ตามปกติ
      expect(res.metrics).toMatchObject({
        mapped: 3,
        rejected: 3,
        elevated: 3,
        elevationsRefused: 0,
      });
      for (const empId of SIX.slice(0, 3)) expect((await userOf(empId))?.role).toBe('admin');
      for (const empId of SIX.slice(3)) expect((await userOf(empId))?.role).toBe('staff');
      const types = await anomalyTypes(res.runId);
      expect(types).not.toContain('elevate_guardrail_blocked');
      // ด่านรูปแบบชุดเดียวกันต้องยังแยกชนิด anomaly ได้เหมือนเดิม
      expect(types.filter((t) => t === 'rejected_row')).toHaveLength(2);
      expect(types.filter((t) => t === 'duplicate_login')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // แถวที่ใช้ไม่ได้ + บันทึกของรอบ
  // ─────────────────────────────────────────────────────────────────────

  describe('แถวที่ใช้ไม่ได้', () => {
    it('emp_id ผิดรูป / login ยาวเกิน / รหัสผ่าน decode เพี้ยน / login ซ้ำ → ปฏิเสธเป็นรายแถว', async () => {
      await seedLocalAdmin();
      erp.users = [
        erpUser('E 1', { loginName: 'space' }), // emp_id ผิด CHECK users_emp_id_fmt
        erpUser('E502', { loginName: 'x'.repeat(65) }), // ยาวเกิน 64
        erpUser('E503', { password: `พัง${REPLACEMENT_CHAR}` }), // decode charset ผิด
        erpUser('E504', { loginName: 'dup' }),
        erpUser('E505', { loginName: 'DUP' }), // ชนกันเองในรอบเดียว (ไม่สนตัวพิมพ์)
      ];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      // แถวเสียห้ามล้มทั้งรอบ — คนที่เหลือต้องได้บัญชีตามปกติ
      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 1, rejected: 4 });
      const types = await anomalyTypes(res.runId);
      expect(types.filter((t) => t === 'rejected_row')).toHaveLength(3);
      expect(types.filter((t) => t === 'duplicate_login')).toHaveLength(1);
      expect(await credentialOf('E504')).not.toBeNull();
      expect(await credentialOf('E505')).toBeNull();
      expect(await userOf('E503')).toBeNull();
    });

    it('⭐ login_name ชนกับแถวเดิมของ emp_id อื่น → ข้ามแค่แถวนั้น รอบยังเดินจนถึง sweep', async () => {
      // `seenLoginNames` เห็นการชนกันเองภายในรอบเดียวเท่านั้น — คนใหม่ที่ชื่อล็อกอินไปตรงกับ
      // แถวเก่าของคนอื่นจะชน PK ที่ INSERT ตรง ๆ ถ้าปล่อยให้ 23505 หลุดไปถึง catch ของทั้งรอบ:
      // แถวที่เหลือถูกข้ามทั้งหมด **และ sweep ไม่ได้ทำงานเลย** แล้วรอบถัด ๆ ไปก็ล้มซ้ำแบบเดิม
      // ตลอดไป (ข้อมูล ERP ไม่ซ่อมตัวเอง) = เปิดบัญชีใหม่ก็ไม่ได้ ปิดบัญชีคนลาออกก็ไม่ได้
      await seedLocalAdmin();
      await seedUser({ empId: 'E10', role: 'staff', source: 'erp', loginName: 'dup01' });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 3, ERP_USER_DEACTIVATE_MAX_PCT: 50 });
      // E30 ถือ login_name เดียวกับ E10 ที่ persist ไว้แล้ว และ E10 ไม่ได้อยู่ในผลรอบนี้
      // (เขาคือคนที่กำลังจะถูก sweep ลบพอดี) — ในรอบเดียวจึงไม่มีอะไรเห็นการชนนี้ล่วงหน้าเลย
      erp.users = [erpUser('E30', { loginName: 'dup01' }), erpUser('E31'), erpUser('E32')];

      const first = await sync.syncUsers('test');

      // แถวที่ชนถูกข้ามเป็นรายแถว — คนที่อยู่ถัดจากมันในผล ERP ต้องยังได้บัญชีครบ
      expect(first.status).toBe('success');
      expect(first.metrics).toMatchObject({ mapped: 2, rejected: 1 });
      expect(await anomalyOf(first.runId, 'login_name_conflict')).toMatchObject({
        empCode: 'E30',
        login: 'dup01',
      });
      // 🚫 anomaly เก็บได้แค่ตัวระบุ — รหัสผ่านของแถวที่ชนห้ามติดไปด้วย
      expect(JSON.stringify(await runRow(first.runId))).not.toContain('pw-E30');
      expect(await credentialOf('E31')).not.toBeNull();
      expect(await credentialOf('E32')).not.toBeNull();
      // ทรานแซกชันของแถวที่ชน rollback ทั้งก้อน — ห้ามเหลือแถว users ค้างไว้ครึ่ง ๆ กลาง ๆ
      expect(await userOf('E30')).toBeNull();
      // เจ้าของ login_name เดิมต้องไม่ถูกแย่งชื่อไป
      expect((await credentialOf('E10'))?.login_name).toBe('dup01');

      // ⭐ ของจริงที่ต้องพิสูจน์: sweep ยังได้ทำงานในรอบที่มีแถวชน (ทั้งการตั้งนาฬิกา
      //    grace รอบแรก และการลบจริงในรอบถัดมา)
      expect(await expireGrace()).toBe(1); // E10 เริ่มนับ grace ตั้งแต่รอบแรก
      const second = await sync.syncUsers('test');

      expect(second.status).toBe('success');
      expect(second.rowsTombstoned).toBe(1);
      expect(second.metrics).toMatchObject({ mapped: 2, rejected: 1, deactivated: 1 });
      expect(await credentialOf('E10')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // รูปทรงของ ERP จริง (43.229.134.162 / db_TCL)
  // `Employee` มี 0 แถว → `menuuser.emp_id` ว่างทุกแถว → ตัวตนคือ `user_name` (USERID)
  // driver จึงส่ง user_name มาเป็นทั้ง `empCode` และ `loginName` ของแถวเดียวกัน
  // ─────────────────────────────────────────────────────────────────────

  describe('ตัวตนจาก ERP = user_name (USERID)', () => {
    /** 3 แถวจริงของ menuuser — สะกดตามที่ ERP เก็บ (ตัวพิมพ์ใหญ่) */
    const REAL = ['ADMIN', 'KRS', 'TEST'];

    /** แถวแบบที่ driver จริงผลิต: empCode = loginName = user_name ดิบ */
    const erpIdentityRow = (
      userName: string,
      over: Partial<{ userLevel: string; nameThai: string }> = {},
    ): ErpUserRow => erpUser(userName, { loginName: userName, ...over });

    it('⭐ USERID เป็นทั้ง users.emp_id และ login_name → ได้บัญชีครบทุกคน ไม่มีแถวไหนถูกปฏิเสธ', async () => {
      // ก่อนแก้: sync ใช้ `menuuser.emp_id` เป็นตัวตน ซึ่งว่างทุกแถวบน ERP จริง →
      // EMP_CODE_RE ปฏิเสธ 100% ของแถว = ไม่มีใครล็อกอินได้เลยสักคน
      await seedLocalAdmin();
      erp.users = REAL.map((u) => erpIdentityRow(u));

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 3 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 3, rejected: 0 });
      // `users.emp_id` เก็บ USERID **ตามที่ ERP สะกด** ส่วน `login_name` ถูก lower
      // ตาม CHECK `user_credentials_login_fmt` — สองค่านี้มาจากคอลัมน์เดียวกันแต่ไม่ใช่
      // สตริงเดียวกัน การเผลอ normalize ฝั่ง emp_id ทำให้ FK ทั้งเว็บชี้ไปคนละรหัส
      for (const userName of REAL) {
        expect(await userOf(userName)).not.toBeNull();
        expect((await credentialOf(userName))?.login_name).toBe(userName.toLowerCase());
      }
    });

    it('⭐ name_thai ว่าง → ใช้ USERID เป็นชื่อ + anomaly ไม่ใช่ปฏิเสธทั้งแถว', async () => {
      // `users.name` เป็น NOT NULL + CHECK `users_name_notblank` → เขียนค่าว่างไม่ได้
      // แต่ปฏิเสธทั้งแถวแปลว่าคนนั้นล็อกอินไม่ได้เลยเพราะ ERP ไม่ได้กรอกช่องที่ไม่บังคับ
      await seedLocalAdmin();
      erp.users = [
        erpIdentityRow('KRS', { nameThai: '' }),
        erpIdentityRow('TEST', { nameThai: '   ' }), // ช่องว่างล้วน = ว่างเหมือนกัน
        erpIdentityRow('ADMIN', { nameThai: 'ผู้ดูแลระบบ' }),
        // บัญชีฝ่ายขายที่ allowlist เคยกันไว้ — ตอนนี้ได้บัญชีเหมือนคนอื่น (มีชื่อจึงไม่เข้า fallback)
        erpIdentityRow('SALES01', { nameThai: 'ฝ่ายขาย หนึ่ง', userLevel: LEVEL_OUTSIDER }),
      ];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 4 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 4, rejected: 0 });
      expect((await userOf('KRS'))?.name).toBe('KRS');
      expect((await userOf('TEST'))?.name).toBe('TEST');
      expect((await userOf('ADMIN'))?.name).toBe('ผู้ดูแลระบบ');
      expect((await userOf('SALES01'))?.name).toBe('ฝ่ายขาย หนึ่ง');
      // ผู้ดูแลต้องเห็นจาก sync_runs ว่าชื่อไหนเป็นค่าแทน — สองคน ไม่ใช่สามหรือสี่
      const types = await anomalyTypes(res.runId);
      expect(types.filter((t) => t === 'blank_name_thai')).toHaveLength(2);
      expect(await anomalyOf(res.runId, 'blank_name_thai')).toMatchObject({ empCode: 'KRS' });
    });
  });

  describe('บันทึกของรอบใน sync_runs', () => {
    it('metrics ครบทุกตัวนับและอ่านได้จาก GET /sync/runs · stock_as_of ต้องเป็น NULL เสมอ', async () => {
      await seedLocalAdmin();
      await seedUser({ empId: 'E601', role: 'staff', source: 'erp' });
      erp.users = [erpUser('E602'), erpUser('E603', { userLevel: LEVEL_OUTSIDER })];
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2 });

      const res = await sync.syncUsers('test');

      const row = await runRow(res.runId);
      // ผู้ดูแลต้องตอบได้ว่า "รอบนี้ทำอะไรไป" จากแถวเดียวโดยไม่ต้องเปิดโค้ด
      // ⚠️ `unmapped`/`unmappedKeptCredential` ต้อง **ไม่มีแล้ว** — ตัวนับที่เป็น 0 ตลอดกาล
      //    หลอกให้เชื่อว่ายังมี allowlist ทำงานอยู่ ทั้งที่ถูกถอดออกไปแล้ว
      expect(Object.keys(row?.metrics ?? {}).sort()).toEqual([
        'absent',
        'adminsDeactivated',
        'deactivated',
        'elevated',
        'elevationsRefused',
        'graceElapsed',
        'mapped',
        'refused',
        'rejected',
      ]);
      expect(row?.metrics).toMatchObject({ mapped: 2, absent: 1, deactivated: 0 });
      // รอบผู้ใช้ห้ามขยับป้าย "ข้อมูล ณ HH:MM" ของสต็อก
      expect(row?.stock_as_of).toBeNull();
      const listed = await sync.listRuns(5);
      expect(listed[0]?.kind).toBe('users');
      expect(listed[0]?.metrics).toMatchObject({ mapped: 2, absent: 1 });
    });

    it('รอบซ้อนกันไม่ได้ — ตัวที่สองได้ skipped จาก advisory lock', async () => {
      await seedLocalAdmin();
      erp.users = [erpUser('E701'), erpUser('E702')];
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2 });

      const results: SyncRunResult[] = await Promise.all([
        sync.syncUsers('test-a'),
        sync.syncUsers('test-b'),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual(['skipped', 'success']);
    });

    it('ERP ล่ม → รอบล้มเหลวแต่ไม่ throw ออกไป และไม่มีใครถูกลบ', async () => {
      await seedLocalAdmin();
      await seedUser({ empId: 'E801', role: 'staff', source: 'erp' });
      erp.failWith = new Error('ต่อ ERP ไม่ได้');

      const res = await makeSync().syncUsers('test');

      expect(res.status).toBe('failed');
      expect(res.rowsTombstoned).toBe(0);
      expect(await credentialOf('E801')).not.toBeNull();
    });
  });
});
