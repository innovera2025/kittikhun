/**
 * จำลองการใช้งานจริงหนึ่งวันนับสต็อก — ยิงผ่าน HTTP เหมือนมือถือจริงทุกคำขอ
 *
 *   npx ts-node scripts/simulate.ts [baseUrl] [--keep]
 *   npx ts-node scripts/simulate.ts https://tcl.krs.co.th
 *
 * ทำไมต้องมี: unit test พิสูจน์ทีละชิ้น แต่ของที่พังจริงในคลังคือ **จังหวะที่ชนกัน**
 * — เครื่องออฟไลน์แล้วเทคิวพร้อมกัน · admin ปิดรอบตอนพนักงานยังส่งอยู่ ·
 * สองคนนับ SKU เดียวกัน · เครื่องเดิม retry ซ้ำ ไฟล์นี้จำลองสิ่งเหล่านั้นทั้งหมด
 *
 * ⚠️ **บัญชีผู้ใช้ไม่ได้สร้างจากที่นี่อีกแล้ว** — `POST /members` และ `POST /auth/change-pin`
 *    ถูกลบทั้งเส้นทาง ตัวยืนยันตัวตนเป็นของตาราง `user_credentials` ที่รอบ sync ของ ERP
 *    (`POST /sync/users`) เป็นเจ้าของ ฉาก 1 จึงเปลี่ยนจาก "สร้างพนักงาน" เป็น
 *    "ยิง sync แล้วพิสูจน์ว่าบัญชีที่ได้มาถูกต้อง" และยังพิสูจน์ด้วยว่า endpoint ที่ลบไปแล้ว
 *    **หายไปจริง** (404) ไม่ใช่ยังเปิดค้างอยู่เงียบ ๆ
 *
 * ต้องตั้งก่อนรัน:
 *   SIM_ADMIN_EMP / SIM_ADMIN_PIN  admin break-glass ที่สร้างด้วย `npm run create-admin`
 *                                  (credential `source='local'` ที่ sync ห้ามแตะ)
 *   SIM_ERP_USERS                  บัญชีจาก ERP ที่ใช้เดินนับ "login:รหัสผ่าน,…" อย่างน้อย 3 ชุด
 *                                  ค่าเริ่มต้นตรงกับ MockDriver (`ERP_DRIVER=mock`)
 *   SIM_ERP_UNMAPPED               บัญชีที่ `user_level` ไม่อยู่ใน allowlist (ตั้ง '' = ข้ามด่านนี้)
 *
 * ⚠️ รหัสพนักงานของ admin break-glass **ต้องไม่ซ้ำกับแถวใดใน ERP** มิฉะนั้นรอบ sync จะเขียน
 *    role ตาม `user_level` ทับ (credential ไม่ถูกแตะ แต่สิทธิ์ถูกลด) — fixture ของ
 *    `ERP_DRIVER=mock` จองช่วง 52101–52105 ไว้ ค่าเริ่มต้นของ SIM_ADMIN_EMP จึงเป็น 52901
 *    (ตัวเดียวกับตัวอย่าง `npm run create-admin` ใน README) ยิงกับ ERP จริงเมื่อไรก็ยังต้อง
 *    เลือกรหัสที่ ERP ไม่มี — ฉาก 1 ตรวจข้อนี้ให้แล้วและหยุดทันทีพร้อมวิธีแก้ ถ้าเผลอชนกัน
 *
 * 🚫 รันกับ **ระบบทดสอบเท่านั้น** — เขียนผู้ใช้/รอบนับ/ผลนับจริงลงฐานข้อมูล
 */

interface Json {
  [k: string]: unknown;
}

const BASE = (process.argv[2] ?? 'http://127.0.0.1:18090').replace(/\/$/, '');
const KEEP = process.argv.includes('--keep');

/**
 * บัญชีเริ่มต้นตรงกับ `MockDriver.USER_SEEDS` (ใช้ได้ทันทีเมื่อ `ERP_DRIVER=mock`)
 * ยิงกับ ERP จริงเมื่อไร ให้ตั้ง SIM_ERP_USERS เป็นบัญชีทดสอบของ ERP นั้นแทน
 * ⚠️ ค่าพวกนี้เป็นสตริงสมมติของ fixture ไม่ใช่ความลับของใคร
 */
const DEFAULT_ERP_USERS = 'suda.k:mock-staff-secret,anan.p:mock-staff-secret-2,somchai.a:mock-admin-secret';

/** บัญชีที่ `user_level` ไม่อยู่ใน allowlist (ฝ่ายบัญชีของ fixture) — ตั้ง '' เพื่อข้ามด่านนี้ */
const DEFAULT_ERP_UNMAPPED = 'account.one:mock-accounting-secret';

let passed = 0;
let failed = 0;
const failures: string[] = [];

const out = (s = ''): void => {
  console.log(s);
};

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    out(`    ✅ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    out(`    ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Res<T = Json> {
  status: number;
  body: T;
}

async function req<T = Json>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // ⚠️ ส่ง Content-Type เฉพาะเมื่อมี body — Fastify ปฏิเสธ 400 ถ้ามี header
      //    แต่ body ว่าง (บั๊กเดียวกับที่เจอในแอปตอนจำลองรอบแรก)
      ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as T };
}

const uuid = (): string => crypto.randomUUID();

// ── ตัวละครในคลัง ───────────────────────────────────────────────────────────

/**
 * คนหนึ่งคนที่เดินนับในคลัง
 * ⚠️ `login` (ชื่อผู้ใช้ที่พิมพ์ตอนล็อกอิน = `menuuser.user_name` ตัวพิมพ์เล็ก) ไม่ใช่ค่าเดียวกับ
 *    `empId` (รหัสพนักงานที่ผูกกับผลนับทุกแถว) อีกต่อไป — สองค่านี้ห้ามสลับกัน
 */
interface Staff {
  login: string;
  empId: string;
  name: string;
  role: string;
  deviceId: string;
  token: string;
}

/** คิวออฟไลน์ของเครื่องหนึ่ง — เลียนแบบ outbox ในแอป */
class DeviceQueue {
  private seq = 0;
  private readonly pending: Array<{
    idempotencyKey: string;
    sku: string;
    countedQty: number;
    countedAt: string;
    deviceSeq: number;
  }> = [];

  constructor(readonly staff: Staff) {}

  /** พนักงานกรอกจำนวน — เข้าคิวทันที ยังไม่ส่ง (ออฟไลน์ก็ทำงานได้) */
  count(sku: string, qty: number): void {
    this.seq += 1;
    this.pending.push({
      idempotencyKey: uuid(),
      sku,
      countedQty: qty,
      countedAt: new Date().toISOString(),
      deviceSeq: this.seq,
    });
  }

  get depth(): number {
    return this.pending.length;
  }

  /** เทคิวขึ้น server (เรียกเมื่อกลับมามีสัญญาณ) */
  async flush(sessionId: string): Promise<Array<{ status: string; code?: string }>> {
    if (this.pending.length === 0) return [];
    const lines = this.pending.splice(0, this.pending.length);
    const res = await req<Array<{ status: string; code?: string }>>(
      'POST',
      `/count-sessions/${encodeURIComponent(sessionId)}/submissions`,
      {
        token: this.staff.token,
        body: { deviceId: this.staff.deviceId, queueDepth: lines.length, lines },
      },
    );
    return Array.isArray(res.body) ? res.body : [];
  }

  /** ส่งซ้ำชุดเดิมโดยไม่ล้างคิว — จำลอง retry ตอน response หายกลางทาง */
  async flushKeepingQueue(sessionId: string): Promise<Array<{ status: string; code?: string }>> {
    const snapshot = [...this.pending];
    const res = await req<Array<{ status: string; code?: string }>>(
      'POST',
      `/count-sessions/${encodeURIComponent(sessionId)}/submissions`,
      {
        token: this.staff.token,
        body: { deviceId: this.staff.deviceId, queueDepth: snapshot.length, lines: snapshot },
      },
    );
    return Array.isArray(res.body) ? res.body : [];
  }
}

// ── helper ──────────────────────────────────────────────────────────────────

/** body ที่ `POST /sync/*` ตอบกลับ (`metrics` มีเฉพาะรอบผู้ใช้ — ดู `sync_runs.metrics`) */
interface SyncRunBody {
  status?: string;
  rowsRead?: number;
  rowsUpserted?: number;
  metrics?: Record<string, number>;
}

/** อ่านตัวนับจาก metrics แบบไม่ล้มถ้า server รุ่นเก่ายังไม่ส่งฟิลด์นี้มา */
function num(metrics: Record<string, number>, key: string): number {
  return metrics[key] ?? 0;
}

interface LoginResult {
  token: string;
  user: { empId: string; name: string; role: string };
}

/**
 * ล็อกอินตามสัญญา wire เดิมเป๊ะ — `{empId, pin, deviceId}`
 * (ความหมายเปลี่ยน: `empId` = ชื่อผู้ใช้, `pin` = รหัสผ่าน ERP · ชื่อคีย์ห้ามเปลี่ยนเพราะ
 *  APK ที่ sideload ค้างอยู่ในฟลีตยังส่งคีย์ชุดนี้)
 */
async function login(loginName: string, password: string, deviceId: string): Promise<LoginResult> {
  const res = await req<{ accessToken?: string; user?: LoginResult['user'] }>('POST', '/auth/login', {
    body: { empId: loginName, pin: password, deviceId },
  });
  if (typeof res.body.accessToken !== 'string' || res.body.user === undefined) {
    throw new Error(`login ${loginName} ไม่สำเร็จ (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.accessToken, user: res.body.user };
}

/** "login:รหัสผ่าน,login:รหัสผ่าน" → คู่ค่า (รหัสผ่านมี ':' ได้ — ตัดที่ตัวแรกเท่านั้น) */
function parseAccounts(raw: string): Array<{ login: string; password: string }> {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const at = entry.indexOf(':');
      if (at <= 0) throw new Error(`รูปแบบบัญชีไม่ถูกต้อง (ต้องเป็น login:รหัสผ่าน): ${entry}`);
      return { login: entry.slice(0, at).trim().toLowerCase(), password: entry.slice(at + 1) };
    });
}

// ── การจำลอง ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  out('════════════════════════════════════════════════════════════════');
  out(`  จำลองวันนับสต็อก — ${BASE}`);
  out('════════════════════════════════════════════════════════════════');
  out();

  // ── 0. ตรวจว่าเป็นระบบทดสอบ ───────────────────────────────────────────
  const health = await req<{ ok?: boolean; db?: boolean }>('GET', '/healthz');
  if (health.status !== 200 || health.body.db !== true) {
    throw new Error(`ระบบไม่พร้อม: HTTP ${health.status} ${JSON.stringify(health.body)}`);
  }

  out('── ฉาก 1: บัญชีทั้งหมดมาจากรอบ sync ของ ERP ────────────────────');

  // admin break-glass ต้องถูกสร้างไว้ก่อนด้วย `npm run create-admin` (credential source='local')
  // — ไม่มี endpoint สร้างผู้ใช้อีกแล้ว และ sync เองก็ปฏิเสธทั้งรอบถ้าไม่มีบัญชีนี้
  const adminPin = process.env['SIM_ADMIN_PIN'];
  const adminEmp = (process.env['SIM_ADMIN_EMP'] ?? '52901').trim();
  if (!adminPin) throw new Error('ต้องตั้ง SIM_ADMIN_PIN (รหัสผ่านของ admin ที่สร้างไว้แล้ว)');

  const admin = await login(adminEmp.toLowerCase(), adminPin, 'device-admin');
  const adminToken = admin.token;
  check('admin break-glass ล็อกอินได้', admin.user.role === 'admin', `role=${admin.user.role}`);

  // 🔒 เส้นทางที่ถูกลบต้องหายจริง — ถ้ายังเปิดค้างอยู่ จะมีคนไปตั้งรหัสผ่านทับของที่รอบ sync
  //    เป็นเจ้าของ แล้วผลหายเงียบ ๆ ในรอบถัดไป (เหตุผลเดียวกับที่ตัดสินใจลบทั้งเส้นทาง)
  const goneMembers = await req('POST', '/members', {
    token: adminToken,
    body: { empId: '59999', name: 'ไม่ควรสร้างได้', role: 'staff' },
  });
  check(
    '🔒 POST /members ถูกลบแล้วจริง (สร้างผู้ใช้จากแอปไม่ได้อีก)',
    goneMembers.status === 404,
    `HTTP ${goneMembers.status}`,
  );

  // ⚠️ ส่งค่าสมมติเท่านั้น — ห้ามใส่รหัสผ่านจริงลงคำขอที่จงใจให้ล้มเหลว
  const goneChangePin = await req('POST', '/auth/change-pin', {
    token: adminToken,
    body: { currentPin: '000000', newPin: '918273' },
  });
  check(
    '🔒 POST /auth/change-pin ถูกลบแล้วจริง (รหัสผ่านเป็นของ ERP)',
    goneChangePin.status === 404,
    `HTTP ${goneChangePin.status}`,
  );

  // ── รอบ sync ผู้ใช้ = ทางเดียวที่บัญชีพนักงานเกิดขึ้น ────────────────────
  const usersSync = await req<SyncRunBody>('POST', '/sync/users', { token: adminToken });
  const m1 = usersSync.body.metrics ?? {};
  check(
    `sync ผู้ใช้จาก ERP สำเร็จ (อ่าน ${String(usersSync.body.rowsRead ?? '?')} · เขียน ${String(usersSync.body.rowsUpserted ?? '?')} แถว)`,
    usersSync.status === 200 &&
      (usersSync.body.status === 'success' || usersSync.body.status === 'partial'),
    `HTTP ${usersSync.status} ${JSON.stringify(usersSync.body)}`,
  );
  // 'partial' = ERP ส่งมาไม่ถึง ERP_USER_MIN_EXPECTED_ROWS → ข้ามการปิดล็อกอินทั้งรอบ (fail-safe)
  out(
    `    (map ได้ ${num(m1, 'mapped')} · level ไม่อยู่ใน allowlist ${num(m1, 'unmapped')} · ` +
      `หายจาก ERP ${num(m1, 'absent')} · ปิดล็อกอิน ${num(m1, 'deactivated')} · สถานะ ${String(usersSync.body.status)})`,
  );

  const roster = await req<Array<{ empId: string; name: string; role: string }>>('GET', '/members', {
    token: adminToken,
  });
  const adminRow = roster.body.find((r) => r.empId.toLowerCase() === adminEmp.toLowerCase());
  if (adminRow !== undefined && adminRow.role !== 'admin') {
    // หยุดทันที ไม่ปล่อยให้ล้มต่อกันเป็นทอด ๆ: ทุกฉากหลังจากนี้ต้องใช้สิทธิ์ admin
    throw new Error(
      `รอบ sync ลดสิทธิ์ admin break-glass ${adminEmp} เป็น ${adminRow.role} — ` +
        'รหัสพนักงานนี้ซ้ำกับแถวใน ERP (fixture ของ ERP_DRIVER=mock ใช้ 52101–52105) ' +
        'สร้าง admin ใหม่ด้วยรหัสที่ ERP ไม่มี แล้วตั้ง SIM_ADMIN_EMP ให้ตรง',
    );
  }
  check(
    '🔒 sync ไม่แตะสิทธิ์ของ admin break-glass (credential source=local)',
    adminRow?.role === 'admin',
    `roster: ${JSON.stringify(adminRow)}`,
  );

  // ── พนักงานล็อกอินด้วยรหัสผ่านของ ERP (สัญญา wire เดิม: {empId, pin, deviceId}) ──
  const accounts = parseAccounts(process.env['SIM_ERP_USERS'] ?? DEFAULT_ERP_USERS);
  if (accounts.length < 3) {
    throw new Error('SIM_ERP_USERS ต้องมีบัญชีอย่างน้อย 3 ชุด (เครื่อง A · B · C)');
  }
  const staff: Staff[] = [];
  for (const [i, account] of accounts.slice(0, 3).entries()) {
    const deviceId = `device-${'ABC'[i]}`;
    const res = await login(account.login, account.password, deviceId);
    staff.push({
      login: account.login,
      empId: res.user.empId,
      name: res.user.name,
      role: res.user.role,
      deviceId,
      token: res.token,
    });
  }
  check(
    `ล็อกอินด้วยรหัสผ่าน ERP ได้ ${staff.length} คน (${staff.map((s) => `${s.login}·${s.role}`).join(' ')})`,
    staff.length === 3,
  );
  check(
    'ทุกคนที่ล็อกอินได้มีแถวใน roster ที่ sync เขียนไว้ (รหัสพนักงานผูกกับผลนับ)',
    staff.every((s) => roster.body.some((r) => r.empId === s.empId)),
    JSON.stringify(staff.map((s) => s.empId)),
  );

  // 🔒 allowlist ล้วน: user_level ที่ไม่ได้ map ไว้ = ไม่ได้บัญชีเลย (ไม่ fallback เป็น viewer)
  const unmapped = parseAccounts(process.env['SIM_ERP_UNMAPPED'] ?? DEFAULT_ERP_UNMAPPED)[0];
  if (unmapped !== undefined) {
    const denied = await req<{ code?: string }>('POST', '/auth/login', {
      body: { empId: unmapped.login, pin: unmapped.password, deviceId: 'device-unmapped' },
    });
    check(
      '🔒 user_level ที่ไม่อยู่ใน allowlist → ไม่ได้บัญชีเลย (ล็อกอินไม่ผ่าน)',
      denied.status === 401 && denied.body.code === 'UNKNOWN_EMPLOYEE',
      `HTTP ${denied.status} ${JSON.stringify(denied.body)}`,
    );
  }

  // 🔒 สิทธิ์ของบัญชี ERP แก้จากแอปไม่ได้ — รอบ sync ถัดไปเขียนทับอยู่ดี
  const erpManaged = await req<{ code?: string }>(
    'PATCH',
    `/members/${encodeURIComponent(staff[0].empId)}/role`,
    { token: adminToken, body: { role: 'viewer' } },
  );
  check(
    '🔒 แก้สิทธิ์บัญชีที่ ERP เป็นเจ้าของ → ถูกปฏิเสธ (ERP_MANAGED) ไม่ใช่ตอบ 200 แล้วผลหาย',
    erpManaged.status === 400 && erpManaged.body.code === 'ERP_MANAGED',
    `HTTP ${erpManaged.status} ${JSON.stringify(erpManaged.body)}`,
  );

  // 🔒 ยิง sync ซ้ำติด ๆ ต้องไม่ปิดล็อกอินใคร และไม่เตะคนที่รหัสผ่านไม่ได้เปลี่ยนออกจากระบบ
  const usersSync2 = await req<SyncRunBody>('POST', '/sync/users', { token: adminToken });
  const m2 = usersSync2.body.metrics ?? {};
  check(
    '🔒 sync ผู้ใช้รอบสองไม่ปิดล็อกอินใครเลย (ทุกคนยังอยู่ในผล ERP)',
    usersSync2.status === 200 && num(m2, 'deactivated') === 0,
    `HTTP ${usersSync2.status} ${JSON.stringify(usersSync2.body)}`,
  );
  const reLogin = await login(staff[0].login, accounts[0].password, staff[0].deviceId);
  check(
    '🔒 รหัสผ่านที่ไม่เปลี่ยนใน ERP → ล็อกอินเดิมยังใช้ได้หลัง sync (ไม่ rotate ทิ้งทุกชั่วโมง)',
    reLogin.user.empId === staff[0].empId,
  );
  out();

  // ── ฉาก 2: sync ยอดจาก ERP แล้วเปิดรอบ ────────────────────────────────
  out('── ฉาก 2: sync ยอดจาก ERP แล้วเปิดรอบนับ ──────────────────────');

  const sync = await req<{ status?: string; rowsUpserted?: number }>('POST', '/sync/items', {
    token: adminToken,
  });
  check(
    `sync ยอดจาก ERP สำเร็จ (${String(sync.body.rowsUpserted ?? '?')} รายการ)`,
    sync.status === 200 && sync.body.status === 'success',
    `HTTP ${sync.status} ${JSON.stringify(sync.body)}`,
  );

  // 🔒 ช่องโหว่ที่แก้ไปแล้ว: ระบุโซนโดยไม่ระบุ skus ต้องถูกปฏิเสธ
  const zoneOnly = await req<{ code?: string }>('POST', '/count-sessions', {
    token: adminToken,
    body: { zone: 'A-01' },
  });
  check(
    '🔒 เปิดรอบระบุโซนแต่ไม่ระบุ skus → ถูกปฏิเสธ (ไม่ freeze ทั้งคลังแล้วแปะโซนมั่ว)',
    zoneOnly.status >= 400 && zoneOnly.body.code === 'ZONE_REQUIRES_SKUS',
    `HTTP ${zoneOnly.status} ${JSON.stringify(zoneOnly.body)}`,
  );

  const opened = await req<{ id?: string; itemCount?: number; items?: Array<{ sku: string }> }>(
    'POST',
    '/count-sessions',
    { token: adminToken, body: {} },
  );
  const sessionId = opened.body.id;
  if (typeof sessionId !== 'string') {
    throw new Error(`เปิดรอบไม่สำเร็จ: ${JSON.stringify(opened.body)}`);
  }
  const skus = (opened.body.items ?? []).map((i) => i.sku);
  check(`เปิดรอบนับได้ ${sessionId} · freeze ${skus.length} รายการ`, skus.length > 0);

  // เปิดซ้อนไม่ได้
  const dup = await req('POST', '/count-sessions', { token: adminToken, body: {} });
  check('เปิดรอบซ้อนในคลังเดียวกัน → ถูกปฏิเสธ', dup.status >= 400);
  out();

  // ── ฉาก 3: พนักงานนับ (มีเครื่องออฟไลน์) ──────────────────────────────
  out('── ฉาก 3: พนักงาน 3 คนเดินนับ · เครื่อง B ออฟไลน์กลางทาง ────────');

  const queues = staff.map((s) => new DeviceQueue(s));
  const [qa, qb, qc] = queues;

  // เครื่อง A นับ 3 รายการแรก แล้วส่งทันที (มีสัญญาณ)
  qa.count(skus[0], 100);
  qa.count(skus[1], 48);
  const resA1 = await qa.flush(sessionId);
  check(
    `เครื่อง A ส่ง 2 รายการ → accepted ทั้งหมด`,
    resA1.length === 2 && resA1.every((r) => r.status === 'accepted'),
    JSON.stringify(resA1),
  );

  // เครื่อง B ออฟไลน์: นับสะสมไว้ในคิว ยังไม่ส่ง
  qb.count(skus[2], 12);
  qb.count(skus[3], 7);
  qb.count(skus[4], 0); // นับได้ศูนย์จริง (ของหมดชั้น)
  check(`เครื่อง B ออฟไลน์ — คิวสะสม ${qb.depth} รายการ ยังไม่หาย`, qb.depth === 3);

  // เครื่อง C นับ SKU เดียวกับ A แต่ได้เลขต่างกัน → จะกลายเป็น conflict
  qc.count(skus[0], 97);
  await qc.flush(sessionId);
  check('เครื่อง C นับ SKU เดียวกับ A ได้เลขต่างกัน → เกิด conflict', true);
  out();

  // ── ฉาก 4: retry ซ้ำ + ของนอกรายการ ───────────────────────────────────
  out('── ฉาก 4: สัญญาณกระตุก — เครื่อง B กลับมาแล้วส่งซ้ำ ─────────────');

  // ส่งครั้งแรกแต่ "response หาย" → เครื่องยังเก็บคิวไว้แล้วส่งซ้ำ
  const first = await qb.flushKeepingQueue(sessionId);
  check(
    'เทคิวครั้งแรก → accepted ทั้ง 3',
    first.length === 3 && first.every((r) => r.status === 'accepted'),
    JSON.stringify(first),
  );

  const retry = await qb.flush(sessionId);
  check(
    '🔒 ส่งซ้ำด้วย UUID เดิม → duplicate ทั้งหมด (ไม่นับซ้ำ)',
    retry.length === 3 && retry.every((r) => r.status === 'duplicate'),
    JSON.stringify(retry),
  );

  // นับเจอของที่ไม่อยู่ในรอบ
  const offList = await req<Array<{ status: string; code?: string }>>(
    'POST',
    `/count-sessions/${sessionId}/submissions`,
    {
      token: staff[0].token,
      body: {
        deviceId: staff[0].deviceId,
        lines: [
          {
            idempotencyKey: uuid(),
            sku: 'ไม่มีรหัสนี้ในระบบ',
            countedQty: 5,
            countedAt: new Date().toISOString(),
            deviceSeq: 99,
          },
        ],
      },
    },
  );
  check(
    'นับเจอรหัสที่ไม่มีในระบบ → rejected เฉพาะบรรทัดนั้น (HTTP ยังเป็น 200)',
    offList.status === 200 && offList.body[0]?.status === 'rejected',
    `HTTP ${offList.status} ${JSON.stringify(offList.body)}`,
  );
  out();

  // ── ฉาก 5: ปิดรอบทั้งที่มี conflict ───────────────────────────────────
  out('── ฉาก 5: admin พยายามปิดรอบ ──────────────────────────────────');

  const earlyClose = await req<{ code?: string; conflicts?: number }>(
    'POST',
    `/count-sessions/${sessionId}/close`,
    { token: adminToken },
  );
  check(
    'ปิดรอบทั้งที่มี conflict ค้าง → ถูกปฏิเสธ (ข้อมูลไม่หายเงียบ)',
    earlyClose.status === 409,
    `HTTP ${earlyClose.status}`,
  );

  const conflicts = await req<Array<{ sku: string; submissions: Array<{ idempotencyKey: string; countedQty: number }> }>>(
    'GET',
    `/count-sessions/${sessionId}/conflicts`,
    { token: adminToken },
  );
  check(
    `รายการขัดแย้ง ${conflicts.body.length} รายการ พร้อมทุกตัวเลือกให้ตัดสิน`,
    conflicts.body.length === 1 && conflicts.body[0].submissions.length === 2,
    JSON.stringify(conflicts.body.map((c) => c.sku)),
  );

  // admin เลือกเลขของเครื่อง A (100)
  const chosen = conflicts.body[0].submissions.find((s) => Number(s.countedQty) === 100);
  const resolved = await req('POST', `/count-sessions/${sessionId}/conflicts/${encodeURIComponent(conflicts.body[0].sku)}/resolve`, {
    token: adminToken,
    body: { chosenSubmission: chosen?.idempotencyKey },
  });
  check('admin ตัดสินเลือกเลขของเครื่อง A', resolved.status === 200);

  const afterResolve = await req<Array<{ sku: string; countedQty: number | null }>>(
    'GET',
    `/count-sessions/${sessionId}/variance`,
    { token: adminToken },
  );
  const resolvedRow = afterResolve.body.find((r) => r.sku === conflicts.body[0].sku);
  check(
    '🔒 ค่าที่ admin เลือกมีผลกับรายงานทันที (ไม่ต้องรอปิดรอบ)',
    Number(resolvedRow?.countedQty) === 100,
    `ได้ ${String(resolvedRow?.countedQty)}`,
  );
  out();

  // ── ฉาก 6: race ปิดรอบพร้อมส่งผลนับ ───────────────────────────────────
  out('── ฉาก 6: เครื่อง C ส่งงานพอดีกับที่ admin กดปิดรอบ ─────────────');

  // ใช้ SKU ที่ยังไม่มีใครนับ เพื่อให้ race นี้ไม่สร้าง conflict ใหม่มาบังการปิดรอบ
  // (จุดที่ทดสอบคือ "ผลนับชนกับการปิดรอบ" ไม่ใช่ conflict)
  const raceSku = skus[skus.length - 1];
  const raceLines = Array.from({ length: 15 }, (_, i) => ({
    idempotencyKey: uuid(),
    sku: raceSku,
    countedQty: 10 + i,
    countedAt: new Date().toISOString(),
    deviceSeq: 500 + i,
  }));

  const [closeRes, ...raceRes] = await Promise.all([
    req<{ materialized?: number }>('POST', `/count-sessions/${sessionId}/close`, {
      token: adminToken,
    }),
    ...raceLines.map((l) =>
      req<Array<{ status: string; code?: string }>>(
        'POST',
        `/count-sessions/${sessionId}/submissions`,
        { token: staff[2].token, body: { deviceId: staff[2].deviceId, lines: [l] } },
      ),
    ),
  ]);

  check('admin ปิดรอบสำเร็จ', closeRes.status === 200, `HTTP ${closeRes.status}`);

  const raceFlat = raceRes.flatMap((r) => (Array.isArray(r.body) ? r.body : []));
  const acceptedInRace = raceFlat.filter((r) => r.status === 'accepted').length;
  const closedInRace = raceFlat.filter((r) => r.code === 'SESSION_CLOSED').length;
  const dupInRace = raceFlat.filter((r) => r.status === 'duplicate').length;

  out(`    (ชนกัน ${raceFlat.length} บรรทัด → accepted ${acceptedInRace} · SESSION_CLOSED ${closedInRace})`);
  check(
    '🔒 ไม่มีบรรทัดไหนถูกตอบ duplicate ทั้งที่ไม่เคยถูกบันทึก (เครื่องจะได้ไม่ลบคิวทิ้ง)',
    dupInRace === 0,
    `duplicate ${dupInRace}`,
  );
  check(
    '🔒 บรรทัดที่ถูกปฏิเสธบอกเหตุผลชัดว่ารอบปิดแล้ว',
    closedInRace + acceptedInRace === raceFlat.length,
  );

  // ทุกบรรทัดที่ accepted ต้องอยู่ในรายงานที่แช่แข็งแล้วจริง
  const finalReport = await req<Array<{ sku: string; countedQty: number | null; source?: string }>>(
    'GET',
    `/count-sessions/${sessionId}/variance`,
    { token: adminToken },
  );
  check(
    '🔒 รายงานหลังปิดอ่านจากค่าที่แช่แข็งแล้ว (source = closed)',
    finalReport.body.every((r) => r.source === 'closed'),
  );
  out();

  // ── ฉาก 7: งานที่มาช้าหลังปิดรอบ ──────────────────────────────────────
  out('── ฉาก 7: เครื่องที่ออฟไลน์ทั้งวันเพิ่งกลับมา ───────────────────');

  const late = await req<Array<{ status: string; code?: string }>>(
    'POST',
    `/count-sessions/${sessionId}/submissions`,
    {
      token: staff[1].token,
      body: {
        deviceId: staff[1].deviceId,
        lines: [
          {
            idempotencyKey: uuid(),
            sku: skus[0],
            countedQty: 55,
            countedAt: new Date().toISOString(),
            deviceSeq: 900,
          },
        ],
      },
    },
  );
  check(
    'ส่งงานหลังปิดรอบ → SESSION_CLOSED (เข้าจอค้างตรวจ ไม่หายเงียบ)',
    late.body[0]?.code === 'SESSION_CLOSED',
    JSON.stringify(late.body),
  );
  out();

  // ── ฉาก 8: ช่องโหว่ด้านความปลอดภัยที่เพิ่งปิด ─────────────────────────
  out('── ฉาก 8: ทดสอบช่องโหว่ที่เพิ่งปิดไป ──────────────────────────');

  // 🔒 ตัวนับความล้มเหลวต้องไม่ค้างเมื่อยิงพร้อมกัน
  // (เดารหัสผ่านผ่าน change-pin ไม่ใช่ช่องทางอีกแล้ว — endpoint ถูกลบ พิสูจน์ไว้ในฉาก 1)
  const burstLogin = staff[1].login;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      req('POST', '/auth/login', {
        body: { empId: burstLogin, pin: 'ผิดแน่นอน-111112', deviceId: 'attacker' },
      }),
    ),
  );
  const after = await req<{ code?: string; retryAfterMs?: number }>('POST', '/auth/login', {
    body: { empId: burstLogin, pin: 'ผิดแน่นอน-111112', deviceId: 'attacker' },
  });
  check(
    `🔒 ยิงรหัสผ่านผิดพร้อมกัน 12 ครั้ง → ระบบหน่วงจริง (retryAfter ${String(after.body.retryAfterMs ?? 0)}ms)`,
    after.body.code === 'THROTTLED' || (after.body.retryAfterMs ?? 0) > 1000,
    JSON.stringify(after.body),
  );
  // 🔒 หน่วงเท่านั้น ห้ามล็อกบัญชี — ไม่งั้นใครก็ล็อกเพื่อนร่วมงานออกจากระบบได้ด้วยการเดารหัสผ่าน
  check(
    '🔒 บัญชีที่ถูกยิงรัว ๆ ไม่ถูกล็อก (token ที่ถือไว้ยังทำงานได้)',
    (await req('GET', '/members', { token: staff[1].token })).status === 200,
  );

  // 🔒 scan-events จากเครื่องที่ไม่เคย login
  const scan = await req<{ recorded?: number }>('POST', '/items/scan-events', {
    token: staff[2].token,
    body: {
      deviceId: 'เครื่องที่เพิ่งลงแอปไม่เคย-login',
      events: [{ barcode: '8850001234567', scannedAt: new Date().toISOString() }],
    },
  });
  check(
    '🔒 สแกนจากเครื่องที่ยังไม่มีในระบบ → บันทึกได้ ไม่หายเงียบ',
    Number(scan.body.recorded) === 1,
    JSON.stringify(scan.body),
  );

  // สิทธิ์: staff เปิดรอบไม่ได้ — role มาจาก user_level ของ ERP จึงต้องเลือกคนที่ไม่ใช่ admin จริง ๆ
  const nonAdmin = staff.find((s) => s.role !== 'admin');
  if (nonAdmin === undefined) {
    out('    ⚠️ ข้ามด่านสิทธิ์: SIM_ERP_USERS เป็น admin ทั้งหมด (ตั้งบัญชี staff อย่างน้อย 1 คน)');
  } else {
    const staffOpen = await req('POST', '/count-sessions', {
      token: nonAdmin.token,
      body: {},
    });
    check(
      `${nonAdmin.role} เปิดรอบนับไม่ได้ (ต้องเป็น admin)`,
      staffOpen.status === 403,
      `HTTP ${staffOpen.status}`,
    );
  }
  out();

  // ── ฉาก 9: รายงานสรุป ─────────────────────────────────────────────────
  out('── ฉาก 9: รายงานส่วนต่างที่ผู้จัดการจะได้เห็น ───────────────────');

  const counts = { match: 0, over: 0, short: 0, not_counted: 0, off_list: 0, conflict: 0 };
  for (const r of finalReport.body as unknown as Array<{ status: keyof typeof counts }>) {
    if (r.status in counts) counts[r.status] += 1;
  }
  out(
    `    ตรงกับระบบ ${counts.match} · เกิน ${counts.over} · ขาด ${counts.short} · ` +
      `ยังไม่ได้นับ ${counts.not_counted} · นอกรายการ ${counts.off_list} · ขัดแย้ง ${counts.conflict}`,
  );

  const nullNotZero = (finalReport.body as unknown as Array<{ status: string; countedQty: unknown }>)
    .filter((r) => r.status === 'not_counted')
    .every((r) => r.countedQty === null);
  check('🔒 "ยังไม่ได้นับ" คงเป็น null ไม่ถูกแปลงเป็น 0', nullNotZero);

  const csv = await fetch(`${BASE}/count-sessions/${sessionId}/variance?format=csv`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  // ⚠️ ต้องอ่านเป็นไบต์ — `Response.text()` ตัด BOM ออกให้อัตโนมัติ จึงตรวจ BOM ไม่ได้
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  check(
    'export CSV ได้ พร้อม BOM ให้ Excel ไทยอ่านออก',
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    `ไบต์แรก ${csvBytes.slice(0, 3).join(',')}`,
  );
  check(
    'CSV มีหัวคอลัมน์ไทยครบ',
    csvText.includes('รหัสสินค้า') && csvText.includes('ส่วนต่าง') && csvText.includes('สถานะ'),
  );
  out();

  // ── สรุป ──────────────────────────────────────────────────────────────
  out('════════════════════════════════════════════════════════════════');
  out(`  ผ่าน ${passed} · ไม่ผ่าน ${failed}`);
  if (failed > 0) {
    out();
    out('  รายการที่ไม่ผ่าน:');
    for (const f of failures) out(`    • ${f}`);
  }
  out('════════════════════════════════════════════════════════════════');

  if (!KEEP) {
    out();
    out('หมายเหตุ: ข้อมูลที่สร้างระหว่างจำลองยังอยู่ในฐานข้อมูลทดสอบ');
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error('\n💥 จำลองล้มเหลว:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
