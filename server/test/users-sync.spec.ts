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

import { AuthService } from '../src/auth/auth.service';
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
 *   "user_level ไม่อยู่ใน ERP_USER_LEVEL_ROLE_MAP" = ปัญหา **config ของเราเอง** → ห้ามลบ credential
 *   "ไม่ปรากฏในผล ERP เลย"                        = ปัญหา **คน** (ลาออก) → เข้า sweep ได้ทางเดียว
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

/** map ที่ใช้ทั้งไฟล์: 9=admin · 5=staff · 1=viewer — ค่าอื่น (เช่น '7') = ไม่ได้บัญชี */
const ROLE_MAP = '9=admin,5=staff,1=viewer';
const LEVEL_ADMIN = '9';
const LEVEL_STAFF = '5';
const LEVEL_UNMAPPED = '7';

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
  type SyncConfig = Record<string, string | number | undefined>;

  const BASE_CONFIG: SyncConfig = {
    ERP_DRIVER: 'mock',
    ERP_TIMEOUT_MS: 5_000,
    ERP_SYNC_OVERLAP_S: 60,
    ERP_USER_LEVEL_ROLE_MAP: ROLE_MAP,
    ERP_USER_DEACTIVATE_MAX_PCT: 10,
    ERP_USER_MIN_EXPECTED_ROWS: 3,
  };

  /** สร้าง SyncService ต่อเคส (คอนฟิกคนละชุดได้) — ไม่เรียก onModuleInit จึงไม่มี cron จริง */
  const makeSync = (over: SyncConfig = {}): SyncService => {
    const merged = { ...BASE_CONFIG, ...over } as Record<string, string | number>;
    const cfg = testConfigService(merged);
    return new SyncService(
      db,
      erp,
      new CatalogService(db, cfg, erp),
      new SchedulerRegistry(),
      cfg,
      auth,
    );
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
      erp.users = [erpUser('E200', { userLevel: LEVEL_ADMIN })];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      expect(res.status).toBe('failed');
      expect(res.error).toContain('create-admin');
      expect(res.rowsUpserted).toBe(0);
      // แถวใหม่ต้องไม่ถูกสร้าง และแถวเดิมต้องไม่ถูกแตะ
      expect(await userOf('E200')).toBeNull();
      expect(await credentialOf('E100')).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // allowlist — user_level ที่ไม่ได้ map คือปัญหา config ไม่ใช่การลาออก
  // ─────────────────────────────────────────────────────────────────────

  describe('allowlist ของ user_level', () => {
    it('level ไม่อยู่ใน map → ไม่ได้บัญชีเลย และ anomaly นับต่อค่า level ไม่ใช่ต่อแถว', async () => {
      await seedLocalAdmin();
      erp.users = [
        ...['U1', 'U2', 'U3', 'U4', 'U5'].map((e) => erpUser(e, { userLevel: LEVEL_UNMAPPED })),
        ...['U6', 'U7'].map((e) => erpUser(e, { userLevel: '8' })),
      ];

      const res = await makeSync().syncUsers('test');

      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ mapped: 0, unmapped: 7, unmappedKeptCredential: 0 });
      // ไม่มีใครใน 7 คนได้แถว users หรือ credential (ห้าม fallback เป็น viewer เด็ดขาด —
      // menuuser คือบัญชีของทั้งบริษัท ไม่ใช่แค่คนคลัง)
      const created = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE emp_id LIKE 'U%'`,
      );
      expect(created?.n).toBe(0);
      // 7 แถว แต่ 2 ค่า level → anomaly 2 รายการ (audit_log เป็น append-only ลบคืนไม่ได้
      // ถ้าเขียนต่อแถว บัญชีทั้ง ERP ที่ไม่เกี่ยวกับคลังจะท่วมตารางนี้ทุกชั่วโมง)
      expect((await anomalyTypes(res.runId)).filter((t) => t === 'erp_level_unmapped')).toHaveLength(
        2,
      );
      expect(
        (await auditActions()).filter((a) => a === 'users.erp_level_unmapped'),
      ).toHaveLength(2);
    });

    it('⭐ level ไม่ได้ map แต่มี credential เดิมอยู่ → ห้ามลบ ห้ามแตะ แม้รันซ้ำ', async () => {
      // นี่คือบั๊กตัวจริงที่เคยทำให้ "ค่า map ตกไปค่าเดียว = ล้าง credential ทั้งคลัง":
      // sweep เคยใช้ชุด "คนที่ map ได้รอบนี้" แทนชุด "คนที่ยังอยู่ใน ERP"
      await seedLocalAdmin();
      await seedUser({ empId: 'E501', role: 'staff', source: 'erp' });
      const before = await credentialOf('E501');
      erp.users = [
        erpUser('E501', { userLevel: LEVEL_UNMAPPED }),
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
        expect(res.metrics).toMatchObject({
          unmapped: 1,
          unmappedKeptCredential: 1,
          absent: 0,
          deactivated: 0,
        });
      }
      // ตัวเลขที่ผู้ดูแลต้องเห็นว่า "map ตกค่าไหนไป" โดยไม่ต้องเปิดโค้ด
      expect(await anomalyTypes(second.runId)).toContain('erp_level_unmapped_kept_credential');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // role เปลี่ยน — จุดที่บั๊ก RETURNING เคยทำให้ revoke ไม่เคยทำงาน
  // ─────────────────────────────────────────────────────────────────────

  describe('role เปลี่ยนตาม user_level', () => {
    /** สร้างผู้ใช้ ERP จริง ๆ ผ่านรอบ sync แล้วล็อกอินให้มี refresh token 1 ใบ */
    async function createViaSyncAndLogin(
      empId: string,
      level: string,
      password: string,
    ): Promise<SyncService> {
      await seedLocalAdmin();
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 });
      erp.users = [erpUser(empId, { userLevel: level, password })];
      const created = await sync.syncUsers('test');
      expect(created.status).toBe('success');
      await auth.login({ empId: empId.toLowerCase(), pin: password, deviceId: DEVICE });
      expect(await liveTokens(empId)).toBe(1);
      return sync;
    }

    it('⭐ ลดสิทธิ์ → role_version +1 พอดี และ refresh token ถูกตัดจริง (บั๊ก RETURNING)', async () => {
      // `UPDATE ... RETURNING role` คืนค่า **ใหม่** เสมอ → การเทียบ role เก่า/ใหม่ไม่มีทางเป็นจริง
      // และการตัด token ตอนลดสิทธิ์จะไม่เคยทำงานเลยแบบเงียบสนิท เคสนี้คือด่านของเรื่องนั้น
      const sync = await createViaSyncAndLogin('E777', LEVEL_ADMIN, 'pw-E777');
      erp.users = [erpUser('E777', { userLevel: LEVEL_STAFF, password: 'pw-E777' })];

      const res = await sync.syncUsers('test');

      expect(res.status).toBe('success');
      const user = await userOf('E777');
      expect(user?.role).toBe('staff');
      expect(user?.role_version).toBe(2); // สร้างมาที่ 1 → เปลี่ยน role ครั้งเดียว
      expect(await liveTokens('E777')).toBe(0);
      expect(await auditActions()).toContain('users.erp_role_changed');
    });

    it('เลื่อนสิทธิ์ → ไม่ตัด refresh token (ทำงานต่อได้ทันที)', async () => {
      const sync = await createViaSyncAndLogin('E778', LEVEL_STAFF, 'pw-E778');
      erp.users = [erpUser('E778', { userLevel: LEVEL_ADMIN, password: 'pw-E778' })];

      await sync.syncUsers('test');

      const user = await userOf('E778');
      expect(user?.role).toBe('admin');
      expect(user?.role_version).toBe(2);
      expect(await liveTokens('E778')).toBe(1);
    });

    it('level เดิมทุกอย่างเหมือนเดิม → ไม่แตะแถว users เลย (updated_at ไม่ขยับ)', async () => {
      const sync = await createViaSyncAndLogin('E779', LEVEL_STAFF, 'pw-E779');
      const before = await userOf('E779');

      await sync.syncUsers('test');

      const after = await userOf('E779');
      expect(after?.updated_at).toEqual(before?.updated_at);
      expect(after?.role_version).toBe(1);
      expect(await liveTokens('E779')).toBe(1);
    });

    it('ด่าน last-admin ต่อแถว: ERP สั่งลด admin คนสุดท้าย → ไม่ลด + audit ไว้', async () => {
      // admin คนเดียวที่เหลือคือ break-glass เอง (source=local) — sync ไม่แตะ credential ของเขา
      // แต่ **แตะ users.role ได้** ถ้าไม่มีด่านนี้ ระบบจะไม่เหลือ admin เลยตั้งแต่รอบแรก
      await seedLocalAdmin();
      const before = await credentialOf(LOCAL_ADMIN);
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: 'somchai.k', userLevel: LEVEL_STAFF }),
      ];

      const res = await makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 1 }).syncUsers('test');

      expect(res.status).toBe('success');
      expect((await userOf(LOCAL_ADMIN))?.role).toBe('admin');
      expect(await auditActions()).toContain('users.erp_last_admin_floor_blocked');
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
      // แถวที่ถูกปฏิเสธ (anomaly) · level ที่ไม่ได้ map (audit)
      erp.users = [
        erpUser('E401', { password: SECRET }),
        erpUser('E402', { password: `${SECRET}-เพี้ยน${REPLACEMENT_CHAR}` }),
        erpUser('E403', { password: SECRET, userLevel: LEVEL_UNMAPPED }),
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
      expect(res.metrics).toMatchObject({ absent: 3, deactivated: 0, refused: 3 });
      expect(await anomalyTypes(res.runId)).toContain('row_count_below_floor');
      // นาฬิกาไม่ถูกตั้ง = รอบถัดไปที่ดึงมาครบยังต้องเริ่มนับ grace ใหม่ตั้งแต่ศูนย์
      for (const empId of five.slice(2)) {
        expect((await credentialOf(empId))?.absent_since).toBeNull();
      }
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
      expect(res.metrics).toMatchObject({ absent: 1, deactivated: 0, refused: 1 });
      expect(await credentialOf('E05')).not.toBeNull();
    });

    it('⭐ ถ้า sweep จะทำให้ไม่เหลือ admin ที่ล็อกอินได้ → rollback ทั้งก้อน + รอบล้มเหลว', async () => {
      // สถานการณ์จริงที่ด่านต้นรอบจับไม่ได้: ลูปของรอบนี้เอง "ลดสิทธิ์" break-glass admin
      // ตามที่ ERP สั่ง (sync ไม่แตะ credential ของ source=local แต่แตะ users.role ได้)
      // → พอถึง sweep ก็เหลือ admin ที่ล็อกอินได้แค่คนที่กำลังจะถูกลบ
      await seedLocalAdmin();
      await seedUser({ empId: 'E900', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E901', role: 'staff', source: 'erp' });
      // admin ที่ **ไม่มี credential แล้ว** (ถูกปิดล็อกอินไปในรอบก่อน ๆ แต่แถว users ยังอยู่
      // ตามกติกา "ห้ามลบแถว users") — ด่านต่อแถวนับจาก `users.role` จึงยังเห็นเขาเป็นตาข่าย
      // และยอมลดสิทธิ์ break-glass ตามที่ ERP สั่ง ส่วน sweep นับจาก credential จึงเห็นว่า
      // ไม่เหลือใครล็อกอินได้จริง ช่องว่างนี้คือเหตุผลที่ชั้นที่สองยังจำเป็นเสมอ
      await db.query(
        `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
         VALUES ('E902', 'ผู้ดูแลที่ถูกปิดล็อกอินไปแล้ว', 'admin', 'กะเช้า · A', 'WH01', false)`,
      );
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2, ERP_USER_DEACTIVATE_MAX_PCT: 100 });

      // รอบที่ 1: E900 หายจาก ERP → เริ่มจับเวลา grace (ยังไม่ลบ)
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN, userLevel: LEVEL_ADMIN }),
        erpUser('E901', { password: SEED_SECRET }),
      ];
      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1);

      // รอบที่ 2: ERP ลด break-glass เป็น staff แล้ว sweep จะลบ admin คนสุดท้ายที่เหลือ
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN, userLevel: LEVEL_STAFF }),
        erpUser('E901', { password: SEED_SECRET }),
      ];
      const res = await sync.syncUsers('test');

      expect(res.status).toBe('failed');
      expect(res.error).toContain('ไม่เหลือ admin');
      expect(res.rowsTombstoned).toBe(0);
      // ไม่มีการลบไหน commit เลย — ทั้งคนที่จะโดนลบและ break-glass ยังล็อกอินได้
      expect(await credentialOf('E900')).not.toBeNull();
      expect(await credentialOf(LOCAL_ADMIN)).not.toBeNull();
      expect(await auditActions()).not.toContain('users.erp_deactivated');
      const row = await runRow(res.runId);
      expect(row?.status).toBe('failed');
      expect(await anomalyTypes(res.runId)).toContain('admin_credential_floor_blocked');
      // ตัวนับที่เดินมาได้ก่อนล้มต้องยังเห็นใน sync_runs (ไม่ใช่ศูนย์รวด)
      expect(row?.metrics.mapped).toBe(2);
      // ⚠️ พฤติกรรมจริงที่ต้องรู้: ลูปเขียนทีละแถวคนละทรานแซกชัน การลดสิทธิ์จึง commit ไปแล้ว
      //    → นี่คือเหตุผลที่ sweep ต้องนับ admin ใหม่ในทรานแซกชันของตัวเอง ไม่ใช่เชื่อด่านต้นรอบ
      expect((await userOf(LOCAL_ADMIN))?.role).toBe('staff');
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
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN, userLevel: LEVEL_ADMIN }),
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

    it('⭐ ด่านต่อแถวห้ามนับ admin ที่ credential กำลังจะถูกลบในรอบเดียวกันเป็นตาข่าย', async () => {
      // E920 เป็น admin ที่หายจาก ERP และพ้น grace แล้ว = ถูกลบท้ายรอบนี้แน่นอน
      // ถ้าด่านต่อแถวยังนับเขาเป็น "ยังมี admin อีกคน" ลูปจะยอมลดสิทธิ์ break-glass ตามที่
      // ERP สั่ง แล้วรอบนั้นก็ไปจบที่ sweep ซึ่งต้อง rollback ทั้งก้อน — เสียทั้งสิทธิ์
      // (การลดสิทธิ์ commit ไปแล้วคนละทรานแซกชัน) และเสียรอบ sync ไปพร้อมกัน
      await seedLocalAdmin();
      await seedUser({ empId: 'E920', role: 'admin', source: 'erp' });
      await seedUser({ empId: 'E921', role: 'staff', source: 'erp' });
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2, ERP_USER_DEACTIVATE_MAX_PCT: 100 });

      // รอบ 1: E920 หายจาก ERP → เริ่มจับเวลา (break-glass ยังเป็น admin ตามที่ ERP บอก)
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN, userLevel: LEVEL_ADMIN }),
        erpUser('E921', { password: SEED_SECRET }),
      ];
      await sync.syncUsers('test');
      expect(await expireGrace()).toBe(1);

      // รอบ 2: ERP สั่งลดสิทธิ์ break-glass ในรอบเดียวกับที่ E920 พ้น grace พอดี
      erp.users = [
        erpUser(LOCAL_ADMIN, { loginName: LOCAL_ADMIN_LOGIN, userLevel: LEVEL_STAFF }),
        erpUser('E921', { password: SEED_SECRET }),
      ];
      const res = await sync.syncUsers('test');

      expect((await userOf(LOCAL_ADMIN))?.role).toBe('admin');
      expect(await auditActions()).toContain('users.erp_last_admin_floor_blocked');
      // ด่านต่อแถวกันไว้ถูกตั้งแต่ต้น → sweep เดินต่อได้ตามปกติ ไม่ต้องล้มทั้งรอบ
      expect(res.status).toBe('success');
      expect(res.metrics).toMatchObject({ deactivated: 1, adminsDeactivated: 1 });
      expect(await credentialOf('E920')).toBeNull();
      expect(await credentialOf(LOCAL_ADMIN)).not.toBeNull();
      expect(await anomalyTypes(res.runId)).not.toContain('admin_credential_floor_blocked');
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
  });

  describe('บันทึกของรอบใน sync_runs', () => {
    it('metrics ครบทุกตัวนับและอ่านได้จาก GET /sync/runs · stock_as_of ต้องเป็น NULL เสมอ', async () => {
      await seedLocalAdmin();
      await seedUser({ empId: 'E601', role: 'staff', source: 'erp' });
      erp.users = [erpUser('E602'), erpUser('E603', { userLevel: LEVEL_UNMAPPED })];
      const sync = makeSync({ ERP_USER_MIN_EXPECTED_ROWS: 2 });

      const res = await sync.syncUsers('test');

      const row = await runRow(res.runId);
      // ผู้ดูแลต้องตอบได้ว่า "รอบนี้ทำอะไรไป" จากแถวเดียวโดยไม่ต้องเปิดโค้ด
      expect(Object.keys(row?.metrics ?? {}).sort()).toEqual([
        'absent',
        'adminsDeactivated',
        'deactivated',
        'graceElapsed',
        'mapped',
        'refused',
        'rejected',
        'unmapped',
        'unmappedKeptCredential',
      ]);
      expect(row?.metrics).toMatchObject({ mapped: 1, unmapped: 1, absent: 1, deactivated: 0 });
      // รอบผู้ใช้ห้ามขยับป้าย "ข้อมูล ณ HH:MM" ของสต็อก
      expect(row?.stock_as_of).toBeNull();
      const listed = await sync.listRuns(5);
      expect(listed[0]?.kind).toBe('users');
      expect(listed[0]?.metrics).toMatchObject({ mapped: 1, unmapped: 1 });
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
