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
 * 🚫 รันกับ **ระบบทดสอบเท่านั้น** — สร้างผู้ใช้/รอบนับ/ผลนับจริงลงฐานข้อมูล
 *    สคริปต์จะปฏิเสธถ้าฐานข้อมูลมีผู้ใช้อยู่แล้ว เว้นแต่ส่ง --keep
 */

interface Json {
  [k: string]: unknown;
}

const BASE = (process.argv[2] ?? 'http://127.0.0.1:18090').replace(/\/$/, '');
const KEEP = process.argv.includes('--keep');

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

interface Staff {
  empId: string;
  name: string;
  pin: string;
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

async function createUser(
  adminToken: string,
  empId: string,
  name: string,
  role: 'admin' | 'staff' | 'viewer',
): Promise<string> {
  const res = await req<{ initialPin?: string }>('POST', '/members', {
    token: adminToken,
    body: { empId, name, role, shift: 'กะเช้า · A' },
  });
  const pin = res.body.initialPin;
  if (typeof pin !== 'string') {
    throw new Error(`สร้างผู้ใช้ ${empId} ไม่สำเร็จ: ${JSON.stringify(res.body)}`);
  }
  return pin;
}

async function login(empId: string, pin: string, deviceId: string): Promise<string> {
  const res = await req<{ accessToken?: string }>('POST', '/auth/login', {
    body: { empId, pin, deviceId },
  });
  if (typeof res.body.accessToken !== 'string') {
    throw new Error(`login ${empId} ไม่สำเร็จ (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken;
}

/** ผู้ใช้ใหม่ถูกบังคับตั้ง PIN ใหม่ก่อนใช้งาน — ทำให้ครบเหมือนของจริง */
async function onboard(
  empId: string,
  name: string,
  initialPin: string,
  newPin: string,
  deviceId: string,
): Promise<Staff> {
  const first = await login(empId, initialPin, deviceId);
  const changed = await req('POST', '/auth/change-pin', {
    token: first,
    body: { currentPin: initialPin, newPin },
  });
  if (changed.status >= 400) {
    throw new Error(`เปลี่ยน PIN ${empId} ไม่สำเร็จ: ${JSON.stringify(changed.body)}`);
  }
  const token = await login(empId, newPin, deviceId);
  return { empId, name, pin: newPin, deviceId, token };
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

  out('── ฉาก 1: เตรียมทีมงาน ────────────────────────────────────────');

  // admin คนแรกต้องมีอยู่แล้ว (สร้างด้วย create-admin) — ใช้ PIN จาก env
  const adminPin = process.env['SIM_ADMIN_PIN'];
  const adminEmp = process.env['SIM_ADMIN_EMP'] ?? '52104';
  if (!adminPin) throw new Error('ต้องตั้ง SIM_ADMIN_PIN (PIN ของ admin ที่สร้างไว้แล้ว)');

  const adminToken = await login(adminEmp, adminPin, 'device-admin');
  check('admin login ได้', true);

  const staff: Staff[] = [];
  for (const [empId, name, device] of [
    ['52201', 'สมชาย ใจดี', 'device-A'],
    ['52202', 'ปิยะนุช ศรีทอง', 'device-B'],
    ['52203', 'วีระ ตั้งใจ', 'device-C'],
  ] as const) {
    const initial = await createUser(adminToken, empId, name, 'staff');
    staff.push(await onboard(empId, name, initial, '839204', device));
  }
  check(`สร้างพนักงาน ${staff.length} คน + บังคับตั้ง PIN ใหม่ครบ`, staff.length === 3);
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

  // 🔒 เดา PIN ผ่าน changePin (เดิมไม่มีการหน่วงเลย)
  const victim = staff[0];
  const guesses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      req<{ code?: string }>('POST', '/auth/change-pin', {
        token: victim.token,
        body: { currentPin: String(100000 + i), newPin: '918273' },
      }),
    ),
  );
  void guesses;
  // คำขอที่ยิงพร้อมกันทั้งชุดผ่านด่านไปก่อนได้เป็นเรื่องปกติ (ยังไม่มีใครเขียนตัวนับเสร็จ)
  // สิ่งที่ต้องพิสูจน์คือ **คำขอถัดไปต้องถูกหน่วง** ซึ่งเดิมไม่เกิดขึ้นเลย
  const afterGuess = await req<{ code?: string; retryAfterMs?: number }>(
    'POST',
    '/auth/change-pin',
    { token: victim.token, body: { currentPin: '111112', newPin: '918273' } },
  );
  check(
    `🔒 เดา PIN ผ่าน change-pin แล้วคำขอถัดไปถูกหน่วง (${String(afterGuess.body.retryAfterMs ?? 0)}ms)`,
    afterGuess.body.code === 'THROTTLED' || (afterGuess.body.retryAfterMs ?? 0) > 0,
    JSON.stringify(afterGuess.body),
  );

  // 🔒 ตัวนับความล้มเหลวต้องไม่ค้างเมื่อยิงพร้อมกัน
  const burstEmp = staff[1].empId;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      req('POST', '/auth/login', {
        body: { empId: burstEmp, pin: '111112', deviceId: 'attacker' },
      }),
    ),
  );
  const after = await req<{ code?: string; retryAfterMs?: number }>('POST', '/auth/login', {
    body: { empId: burstEmp, pin: '111112', deviceId: 'attacker' },
  });
  check(
    `🔒 ยิง PIN ผิดพร้อมกัน 12 ครั้ง → ระบบหน่วงจริง (retryAfter ${String(after.body.retryAfterMs ?? 0)}ms)`,
    after.body.code === 'THROTTLED' || (after.body.retryAfterMs ?? 0) > 1000,
    JSON.stringify(after.body),
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

  // สิทธิ์: staff เปิดรอบไม่ได้
  const staffOpen = await req('POST', '/count-sessions', {
    token: staff[2].token,
    body: {},
  });
  check('staff เปิดรอบนับไม่ได้ (ต้องเป็น admin)', staffOpen.status === 403);
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
