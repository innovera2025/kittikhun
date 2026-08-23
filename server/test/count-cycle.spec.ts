import { randomUUID } from 'node:crypto';

import { CountService, type SubmissionResult } from '../src/count/count.service';
import type { PostgresService } from '../src/db/postgres.service';
import {
  applySchema,
  describeWithDb,
  makeDb,
  testConfigService,
  truncateAll,
} from './support/test-db';

/**
 * วงจรนับสต็อกเต็มวงจร — Postgres จริง
 *
 * README อ้างว่าเทสต์ชุดนี้ผ่าน 31/31 แต่ไฟล์ไม่เคยถูก commit
 *
 * ทุกเคสที่นี่พิสูจน์คำสัญญาที่ถ้าพังจะทำให้ **ตัวเลขสต็อกผิดโดยไม่มีใครรู้**:
 *   - freeze ยอดระบบตอนเปิดรอบ (sync ทับทีหลังต้องไม่ขยับตัวเลขในรอบ)
 *   - idempotency: ส่งซ้ำจากคิวออฟไลน์ต้องไม่นับซ้ำ
 *   - ผลรายบรรทัด: 1 บรรทัดเสียต้องไม่ล้มทั้ง batch
 *   - conflict: 2 เครื่องนับ SKU เดียวกัน admin ต้องตัดสิน ห้าม auto-resolve
 *   - null ≠ 0 สำหรับ "ยังไม่ได้นับ" และ "นอกรายการ"
 *   - ปิดรอบแล้วตัวเลขไม่เปลี่ยนย้อนหลัง
 */

const ADMIN = '52104';
const STAFF_A = '52105';
const STAFF_B = '52106';
const DEV_A = 'device-A';
const DEV_B = 'device-B';

describeWithDb('วงจรนับสต็อก — Postgres จริง', () => {
  let db: PostgresService;
  let count: CountService;

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    count = new CountService(db, testConfigService());
    await seedUsers();
  });

  async function seedUsers(): Promise<void> {
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$ปลอมสำหรับเทสต์$ปลอมสำหรับเทสต์';
    for (const [empId, role] of [
      [ADMIN, 'admin'],
      [STAFF_A, 'staff'],
      [STAFF_B, 'staff'],
    ] as const) {
      await db.query(
        `INSERT INTO users (emp_id, name, pin_hash, role, warehouse_code, must_change_pin)
         VALUES ($1, $2, $3, $4, 'WH01', false)`,
        [empId, `พนักงาน ${empId}`, hash, role],
      );
    }
  }

  async function seedItems(
    items: Array<{ sku: string; name: string; onHand: number; unit?: string }>,
  ): Promise<void> {
    for (const it of items) {
      await db.query(
        `INSERT INTO items_cache (sku, name, on_hand, unit, warehouse_code)
         VALUES ($1, $2, $3, $4, 'WH01')`,
        [it.sku, it.name, it.onHand, it.unit ?? 'ชิ้น'],
      );
    }
  }

  const line = (
    sku: string,
    countedQty: number,
    deviceSeq: number,
    idempotencyKey = randomUUID(),
  ) => ({
    idempotencyKey,
    sku,
    countedQty,
    countedAt: '2026-08-19T03:00:00.000Z',
    deviceSeq,
  });

  const varianceBySku = async (sessionId: string) => {
    const rows = await count.variance(sessionId);
    return new Map(rows.map((r) => [r.sku, r]));
  };

  const statusOf = (results: SubmissionResult[], key: string) =>
    results.find((r) => r.idempotencyKey === key);

  // ── เปิดรอบ + freeze ──────────────────────────────────────────────────

  describe('เปิดรอบนับ', () => {
    it('freeze ทุก SKU ที่ยังมีชีวิตในคลัง', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต 3 นิ้ว', onHand: 100 },
        { sku: 'A-002', name: 'สกรูเกลียวปล่อย', onHand: 50 },
      ]);
      const s = await count.openSession({}, ADMIN);

      expect(s.status).toBe('open');
      expect(s.items).toHaveLength(2);
      expect(s.items.find((i) => i.sku === 'A-001')?.frozenOnHand).toBe(100);
    });

    it('ระบุ skus → freeze เฉพาะที่ระบุ', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'A-002', name: 'สกรู', onHand: 50 },
      ]);
      const s = await count.openSession({ skus: ['A-001'] }, ADMIN);
      expect(s.items.map((i) => i.sku)).toEqual(['A-001']);
    });

    it('สินค้าที่ ERP เอาออกแล้ว (tombstone) ไม่ถูก freeze เข้ารอบ', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'A-DEL', name: 'ของเลิกขาย', onHand: 7 },
      ]);
      await db.query(`UPDATE items_cache SET deleted_at = now() WHERE sku = 'A-DEL'`);
      const s = await count.openSession({}, ADMIN);
      expect(s.items.map((i) => i.sku)).toEqual(['A-001']);
    });

    it('🔴 ระบุโซนแต่ไม่ระบุ skus → ปฏิเสธ (ระบบไม่รู้ว่าสินค้าใดอยู่โซนใด)', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'B-001', name: 'ของโซนอื่น', onHand: 50 },
      ]);
      await expect(count.openSession({ zone: 'A-01' }, ADMIN)).rejects.toMatchObject({
        response: { code: 'ZONE_REQUIRES_SKUS' },
      });

      // ต้องไม่มีอะไรถูกสร้างค้างไว้
      const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM count_sessions`);
      expect(n?.n).toBe(0);
    });

    it('ระบุโซนพร้อม skus → เปิดได้ และ freeze เฉพาะที่ระบุ', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'B-001', name: 'ของโซนอื่น', onHand: 50 },
      ]);
      const s = await count.openSession({ zone: 'A-01', skus: ['A-001'] }, ADMIN);
      expect(s.items.map((i) => i.sku)).toEqual(['A-001']);
      expect(s.zone).toBe('A-01');
    });

    it('ไม่ระบุโซน → นับทั้งคลังได้ตามเดิม', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'B-001', name: 'สกรู', onHand: 50 },
      ]);
      const s = await count.openSession({}, ADMIN);
      expect(s.items).toHaveLength(2);
    });

    it('มีรอบเปิดอยู่แล้วในคลังเดียวกัน → ปฏิเสธ (กัน admin 2 คนเปิดชนกัน)', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 10 }]);
      await count.openSession({}, ADMIN);
      await expect(count.openSession({}, ADMIN)).rejects.toBeDefined();
    });

    it('activeSession คืนรอบที่เปิดอยู่พร้อมรายการที่ freeze', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 10 }]);
      const opened = await count.openSession({}, ADMIN);
      const active = await count.activeSession('WH01');
      expect(active?.id).toBe(opened.id);
      expect(active?.items).toHaveLength(1);
    });

    it('ไม่มีรอบเปิด → คืน null ไม่ throw (แอปมีจอ "ยังไม่มีรอบตรวจนับ")', async () => {
      await expect(count.activeSession('WH01')).resolves.toBeNull();
    });

    it('⭐ freeze จริง — sync ทับ items_cache แล้วยอดระบบในรอบไม่ขยับ', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);

      await db.query(`UPDATE items_cache SET on_hand = 999 WHERE sku = 'A-001'`);

      const v = await varianceBySku(s.id);
      expect(v.get('A-001')?.frozenOnHand).toBe(100);
    });
  });

  // ── ส่งผลนับ ─────────────────────────────────────────────────────────

  describe('ส่งผลนับ', () => {
    async function openWith(onHand = 100) {
      await seedItems([{ sku: 'A-001', name: 'น็อต 3 นิ้ว', onHand }]);
      return count.openSession({}, ADMIN);
    }

    it('นับตรงกับระบบ → status match, diff = 0', async () => {
      const s = await openWith(100);
      await count.submit(s.id, [line('A-001', 100, 1)], STAFF_A, DEV_A);
      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.status).toBe('match');
      expect(row?.diff).toBe(0);
    });

    it('นับได้เกิน → status over, diff เป็นบวก', async () => {
      const s = await openWith(100);
      await count.submit(s.id, [line('A-001', 103, 1)], STAFF_A, DEV_A);
      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.status).toBe('over');
      expect(row?.diff).toBe(3);
    });

    it('นับได้ขาด → status short, diff เป็นลบ', async () => {
      const s = await openWith(100);
      await count.submit(s.id, [line('A-001', 96, 1)], STAFF_A, DEV_A);
      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.status).toBe('short');
      expect(row?.diff).toBe(-4);
    });

    it('⭐ ยังไม่ได้นับ → not_counted และ diff เป็น null ไม่ใช่ 0', async () => {
      const s = await openWith(100);
      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.status).toBe('not_counted');
      expect(row?.countedQty).toBeNull();
      expect(row?.diff).toBeNull();
    });

    it('⭐ นับเจอของนอกรายการ → accepted + code OFF_LIST และ diff เป็น null', async () => {
      // "นอกรายการ" = สินค้ามีอยู่ในคลัง แต่ไม่ได้ถูก freeze เข้ารอบนี้
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'A-999', name: 'ของที่ไม่ได้อยู่ในรอบ', onHand: 8 },
      ]);
      const s = await count.openSession({ skus: ['A-001'] }, ADMIN);

      const key = randomUUID();
      const res = await count.submit(s.id, [line('A-999', 5, 1, key)], STAFF_A, DEV_A);

      expect(statusOf(res, key)?.status).toBe('accepted');
      expect(statusOf(res, key)?.code).toBe('OFF_LIST');

      const row = (await varianceBySku(s.id)).get('A-999');
      expect(row?.status).toBe('off_list');
      expect(row?.countedQty).toBe(5);
      expect(row?.diff).toBeNull();
      expect(row?.frozenOnHand).toBeNull();
    });

    it('SKU ที่ไม่มีอยู่ในคลังเลย → rejected SKU_NOT_FOUND (ต่างจาก off_list)', async () => {
      const s = await openWith(100);
      const key = randomUUID();
      const res = await count.submit(s.id, [line('ไม่มีในระบบเลย', 5, 1, key)], STAFF_A, DEV_A);
      expect(statusOf(res, key)).toMatchObject({
        status: 'rejected',
        code: 'SKU_NOT_FOUND',
      });
    });

    it('นับได้ 0 (ของหมดชั้น) ต้องบันทึกเป็น 0 จริง ไม่ใช่ "ยังไม่ได้นับ"', async () => {
      const s = await openWith(100);
      await count.submit(s.id, [line('A-001', 0, 1)], STAFF_A, DEV_A);
      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.countedQty).toBe(0);
      expect(row?.diff).toBe(-100);
      expect(row?.status).toBe('short');
    });

    it('ทศนิยม 3 ตำแหน่ง (สินค้าชั่งน้ำหนัก) ไม่ปัดทิ้ง', async () => {
      const s = await openWith(10);
      await count.submit(s.id, [line('A-001', 9.125, 1)], STAFF_A, DEV_A);
      expect((await varianceBySku(s.id)).get('A-001')?.countedQty).toBe(9.125);
    });

    it('batch ว่าง → คืน [] ไม่ throw', async () => {
      const s = await openWith();
      await expect(count.submit(s.id, [], STAFF_A, DEV_A)).resolves.toEqual([]);
    });

    it('รอบไม่มีอยู่จริง → SESSION_NOT_FOUND (ไม่ทำให้ทั้ง batch ระเบิด)', async () => {
      await openWith();
      const key = randomUUID();
      const res = await count.submit('รอบที่ไม่มี', [line('A-001', 1, 1, key)], STAFF_A, DEV_A);
      expect(statusOf(res, key)).toMatchObject({
        status: 'rejected',
        code: 'SESSION_NOT_FOUND',
      });
    });
  });

  // ── idempotency + ผลรายบรรทัด ────────────────────────────────────────

  describe('idempotency — คิวออฟไลน์ retry ได้ไม่จำกัด', () => {
    async function openWith() {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      return count.openSession({}, ADMIN);
    }

    it('⭐ ส่งซ้ำด้วย UUID เดิม → duplicate และตัวเลขไม่นับซ้ำ', async () => {
      const s = await openWith();
      const key = randomUUID();
      const payload = [line('A-001', 97, 1, key)];

      expect(statusOf(await count.submit(s.id, payload, STAFF_A, DEV_A), key)?.status).toBe(
        'accepted',
      );
      expect(statusOf(await count.submit(s.id, payload, STAFF_A, DEV_A), key)?.status).toBe(
        'duplicate',
      );
      expect(statusOf(await count.submit(s.id, payload, STAFF_A, DEV_A), key)?.status).toBe(
        'duplicate',
      );

      const n = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM count_submissions WHERE idempotency_key = $1`,
        [key],
      );
      expect(n?.n).toBe(1);
      expect((await varianceBySku(s.id)).get('A-001')?.countedQty).toBe(97);
    });

    it('⭐ 10 บรรทัด เสีย 1 → อีก 9 ยังผ่าน (ผลรายบรรทัด ไม่ทั้งหมดหรือไม่เอาเลย)', async () => {
      await seedItems(
        Array.from({ length: 10 }, (_, i) => ({
          sku: `B-${String(i).padStart(3, '0')}`,
          name: `สินค้า ${i}`,
          onHand: 10,
        })),
      );
      const s = await count.openSession({}, ADMIN);

      const good = Array.from({ length: 9 }, (_, i) =>
        line(`B-${String(i).padStart(3, '0')}`, 10, i + 1),
      );
      const badKey = randomUUID();
      const bad = { ...line('B-009', -5, 10, badKey) };

      const res = await count.submit(s.id, [...good, bad], STAFF_A, DEV_A);

      expect(res.filter((r) => r.status === 'accepted')).toHaveLength(9);
      expect(statusOf(res, badKey)?.status).toBe('rejected');
    });

    it('บรรทัดที่ payload ผิดรูป → rejected เฉพาะบรรทัดนั้น', async () => {
      const s = await openWith();
      const okKey = randomUUID();
      const res = await count.submit(
        s.id,
        [line('A-001', 10, 1, okKey), { ไม่ใช่: 'บรรทัดผลนับ' }],
        STAFF_A,
        DEV_A,
      );
      expect(statusOf(res, okKey)?.status).toBe('accepted');
      expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('เกิน 500 บรรทัดต่อ batch → ปฏิเสธทั้งซอง พร้อมบอกเหตุผล', async () => {
      const s = await openWith();
      const many = Array.from({ length: 501 }, (_, i) => line('A-001', 1, i + 1));
      await expect(count.submit(s.id, many, STAFF_A, DEV_A)).rejects.toBeDefined();
    });

    it('⭐ ผลนับ append-only — DB ปฏิเสธ UPDATE/DELETE ที่ระดับ engine', async () => {
      const s = await openWith();
      await count.submit(s.id, [line('A-001', 10, 1)], STAFF_A, DEV_A);
      await expect(db.query(`UPDATE count_submissions SET counted_qty = 1`)).rejects.toBeDefined();
      await expect(db.query(`DELETE FROM count_submissions`)).rejects.toBeDefined();
    });

    it('เครื่องเดิมส่ง deviceSeq สูงกว่า → ค่าล่าสุดของเครื่องนั้นชนะ (แก้ตัวเลขก่อนส่ง)', async () => {
      const s = await openWith();
      await count.submit(s.id, [line('A-001', 90, 1)], STAFF_A, DEV_A);
      await count.submit(s.id, [line('A-001', 95, 2)], STAFF_A, DEV_A);

      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.countedQty).toBe(95);
      expect(row?.isConflict).toBe(false);
    });
  });

  // ── conflict ─────────────────────────────────────────────────────────

  describe('conflict — 2 เครื่องนับ SKU เดียวกัน', () => {
    async function twoDevicesDisagree() {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_A, DEV_A);
      await count.submit(s.id, [line('A-001', 95, 1)], STAFF_B, DEV_B);
      return s;
    }

    it('⭐ ไม่ auto-resolve — ขึ้นสถานะ conflict รอ admin ตัดสิน', async () => {
      const s = await twoDevicesDisagree();
      const row = (await varianceBySku(s.id)).get('A-001');

      expect(row?.status).toBe('conflict');
      expect(row?.isConflict).toBe(true);
      expect(row?.deviceCount).toBe(2);
      expect(row?.submissionCount).toBe(2);
    });

    it('รายการ conflict แสดงทุกตัวเลือกให้ admin ตัดสิน', async () => {
      const s = await twoDevicesDisagree();
      const rows = await count.conflicts(s.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].sku).toBe('A-001');
      expect(rows[0].submissions.map((x) => x.countedQty).sort()).toEqual([95, 98]);
    });

    it('2 เครื่องนับได้เท่ากันก็ยังต้องให้ admin ตัดสิน (กติกาคือ device_count > 1)', async () => {
      // จงใจไม่ auto-resolve แม้ตัวเลขตรงกัน — สองคนนับ SKU เดียวกันแปลว่า
      // การแบ่งโซนผิดพลาด ซึ่ง admin ควรได้เห็น ไม่ใช่ให้ระบบกลบให้
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_A, DEV_A);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_B, DEV_B);

      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.isConflict).toBe(true);
      expect(row?.deviceCount).toBe(2);
    });

    it('⭐ admin ตัดสินแล้ว → บันทึกผู้ตัดสินและ submission ที่เลือกไว้', async () => {
      const s = await twoDevicesDisagree();
      const conflict = (await count.conflicts(s.id))[0];
      const chosen = conflict.submissions.find((x) => x.countedQty === 98)!;

      await count.resolveConflict(s.id, 'A-001', chosen.idempotencyKey, ADMIN);

      const row = (await varianceBySku(s.id)).get('A-001');
      // สถานะยังเป็น conflict โดยตั้งใจ — เก็บร่องรอยว่ารายการนี้เคยขัดแย้งและใครตัดสิน
      expect(row?.status).toBe('conflict');
      expect(row?.resolvedBy).toBe(ADMIN);
      expect(row?.chosenSubmission).toBe(chosen.idempotencyKey);
    });

    it('conflict ที่ตัดสินแล้วยังอยู่ในรายการ แต่ติดธง resolved (ให้ admin ตรวจย้อนได้)', async () => {
      const s = await twoDevicesDisagree();
      const chosen = (await count.conflicts(s.id))[0].submissions[0];
      await count.resolveConflict(s.id, 'A-001', chosen.idempotencyKey, ADMIN);

      const after = await count.conflicts(s.id);
      expect(after).toHaveLength(1);
      expect(after[0].resolved).toBe(true);
      expect(after[0].resolvedBy).toBe(ADMIN);
    });

    it('⭐ ค่าที่ admin เลือกต้องมีผลกับตัวเลขที่รายงาน ไม่ใช่แค่บันทึกไว้เฉย ๆ', async () => {
      // เลือก "ตัวที่ไม่ใช่ล่าสุด" โดยตั้งใจ — ถ้าระบบยังรายงานตัวล่าสุดอยู่
      // แปลว่าการตัดสินของ admin ไม่มีผลจนกว่าจะปิดรอบ
      const s = await twoDevicesDisagree(); // A ส่ง 98 ก่อน, B ส่ง 95 ทีหลัง (95 = ล่าสุด)
      const chosen = (await count.conflicts(s.id))[0].submissions.find(
        (x) => x.countedQty === 98,
      )!;
      await count.resolveConflict(s.id, 'A-001', chosen.idempotencyKey, ADMIN);

      const row = (await varianceBySku(s.id)).get('A-001');
      expect(row?.countedQty).toBe(98);
      expect(row?.diff).toBe(-2);
    });

    it('เลือก submission ที่ไม่ได้อยู่ใน conflict นั้น → ปฏิเสธ', async () => {
      const s = await twoDevicesDisagree();
      await expect(
        count.resolveConflict(s.id, 'A-001', randomUUID(), ADMIN),
      ).rejects.toBeDefined();
    });

    it('การตัดสินถูกบันทึกลง audit_log', async () => {
      const s = await twoDevicesDisagree();
      const chosen = (await count.conflicts(s.id))[0].submissions[0];
      await count.resolveConflict(s.id, 'A-001', chosen.idempotencyKey, ADMIN);

      const row = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE actor = $1 AND action LIKE '%conflict%'`,
        [ADMIN],
      );
      expect(row?.n).toBeGreaterThanOrEqual(1);
    });
  });

  // ── ปิดรอบ ───────────────────────────────────────────────────────────

  describe('ปิดรอบ', () => {
    it('⭐ ยังมี conflict ค้าง → ปฏิเสธการปิด (ข้อมูลต้องไม่หายเงียบ)', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_A, DEV_A);
      await count.submit(s.id, [line('A-001', 95, 1)], STAFF_B, DEV_B);

      await expect(count.closeSession(s.id, ADMIN)).rejects.toBeDefined();
      expect((await count.session(s.id))?.status).toBe('open');
    });

    it('ไม่มี conflict → ปิดได้ และ materialize ตัวเลขลง closed_variance', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'A-002', name: 'สกรู', onHand: 50 },
      ]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_A, DEV_A);

      const result = await count.closeSession(s.id, ADMIN);
      expect(result.conflicts).toBe(0);
      expect(result.materialized).toBeGreaterThanOrEqual(2);
      expect((await count.session(s.id))?.status).toBe('closed');
    });

    it('⭐ ตัวเลขหลังปิดไม่เปลี่ยนย้อนหลัง แม้ items_cache จะถูก sync ทับ', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 98, 1)], STAFF_A, DEV_A);
      await count.closeSession(s.id, ADMIN);

      const before = (await varianceBySku(s.id)).get('A-001');
      await db.query(`UPDATE items_cache SET on_hand = 5 WHERE sku = 'A-001'`);
      const after = (await varianceBySku(s.id)).get('A-001');

      expect(after?.frozenOnHand).toBe(before?.frozenOnHand);
      expect(after?.countedQty).toBe(before?.countedQty);
      expect(after?.diff).toBe(before?.diff);
      expect(after?.source).toBe('closed');
    });

    it('รอบที่ปิดแล้วอ่านจาก closed_variance ไม่ใช่ view สด', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 100, 1)], STAFF_A, DEV_A);

      expect((await varianceBySku(s.id)).get('A-001')?.source).toBe('live');
      await count.closeSession(s.id, ADMIN);
      expect((await varianceBySku(s.id)).get('A-001')?.source).toBe('closed');
    });

    it('⭐ submission มาช้าหลังปิดรอบ → SESSION_CLOSED (เข้าจอ pending-review ไม่หายเงียบ)', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 100 }]);
      const s = await count.openSession({}, ADMIN);
      await count.closeSession(s.id, ADMIN);

      const key = randomUUID();
      const res = await count.submit(s.id, [line('A-001', 98, 1, key)], STAFF_A, DEV_A);
      expect(statusOf(res, key)).toMatchObject({
        status: 'rejected',
        code: 'SESSION_CLOSED',
      });
    });

    it('ปิดรอบซ้ำ → ปฏิเสธ', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 10 }]);
      const s = await count.openSession({}, ADMIN);
      await count.closeSession(s.id, ADMIN);
      await expect(count.closeSession(s.id, ADMIN)).rejects.toBeDefined();
    });

    it('ปิดรอบที่ไม่มีอยู่ → ปฏิเสธ', async () => {
      await expect(count.closeSession('รอบที่ไม่มี', ADMIN)).rejects.toBeDefined();
    });

    it('ปิดรอบแล้วเปิดรอบใหม่ในคลังเดิมได้', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 10 }]);
      const first = await count.openSession({}, ADMIN);
      await count.closeSession(first.id, ADMIN);
      const second = await count.openSession({}, ADMIN);
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('open');
    });

    it('การปิดรอบถูกบันทึกผู้ปิดไว้', async () => {
      await seedItems([{ sku: 'A-001', name: 'น็อต', onHand: 10 }]);
      const s = await count.openSession({}, ADMIN);
      await count.closeSession(s.id, ADMIN);
      const row = await db.one<{ closed_by: string; closed_at: Date }>(
        `SELECT closed_by, closed_at FROM count_sessions WHERE id = $1`,
        [s.id],
      );
      expect(row?.closed_by).toBe(ADMIN);
      expect(row?.closed_at).not.toBeNull();
    });
  });

  // ── race: ส่งผลนับชนกับการปิดรอบ ─────────────────────────────────────

  describe('⭐ TOCTOU: ส่งผลนับพร้อมกับที่ admin ปิดรอบ', () => {
    async function openWith() {
      await seedItems([
        { sku: 'A-001', name: 'น็อต', onHand: 100 },
        { sku: 'A-002', name: 'สกรู', onHand: 50 },
      ]);
      return count.openSession({}, ADMIN);
    }

    it('🔴 ผลนับที่ชนกับการปิดรอบต้องไม่ "accepted" แล้วหายจากรายงาน', async () => {
      const s = await openWith();

      // ยิงพร้อมกัน: ปิดรอบ + ส่งผลนับ 20 บรรทัด
      const keys = Array.from({ length: 20 }, () => randomUUID());
      const [closeResult, submitResult] = await Promise.allSettled([
        count.closeSession(s.id, ADMIN),
        Promise.all(
          keys.map((k, i) =>
            count.submit(s.id, [line('A-001', 90 + i, i + 1, k)], STAFF_A, DEV_A),
          ),
        ),
      ]);

      if (closeResult.status !== 'fulfilled') return; // ปิดไม่สำเร็จ = ไม่มี race ให้ตรวจ

      const results = submitResult.status === 'fulfilled' ? submitResult.value.flat() : [];
      const accepted = results.filter((r) => r.status === 'accepted');

      // ⭐ กติกา: ทุกบรรทัดที่ตอบ accepted ต้องอยู่ใน closed_variance จริง
      //    (เครื่องลบออกจากคิวไปแล้วตามผลลัพธ์นี้ — หายไม่ได้)
      const frozen = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM closed_variance WHERE session_id = $1 AND sku = 'A-001'`,
        [s.id],
      );

      if (accepted.length > 0) {
        expect(frozen?.n).toBe(1);
        const row = (await varianceBySku(s.id)).get('A-001');
        expect(row?.countedQty).not.toBeNull();
      }

      // และบรรทัดที่ถูกปฏิเสธต้องบอกเหตุผลชัด ไม่ใช่ 'duplicate' ที่ทำให้เครื่องลบทิ้ง
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect(r.code).toBe('SESSION_CLOSED');
      }
      expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(0);
    });

    it('ปิดรอบเสร็จแล้วส่งต่อ → SESSION_CLOSED ทุกบรรทัด (ไม่ใช่ duplicate)', async () => {
      const s = await openWith();
      await count.closeSession(s.id, ADMIN);

      const res = await count.submit(
        s.id,
        [line('A-001', 98, 1), line('A-002', 50, 2)],
        STAFF_A,
        DEV_A,
      );
      expect(res.every((r) => r.status === 'rejected' && r.code === 'SESSION_CLOSED')).toBe(true);

      const n = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM count_submissions WHERE session_id = $1`,
        [s.id],
      );
      expect(n?.n).toBe(0);
    });
  });

  // ── CSV จากข้อมูลจริง ────────────────────────────────────────────────

  describe('export CSV จากรอบจริง', () => {
    it('มีทุก SKU ในรอบ พร้อมสถานะไทย และ BOM', async () => {
      await seedItems([
        { sku: 'A-001', name: 'น็อต, 3 นิ้ว', onHand: 100 },
        { sku: 'A-002', name: 'สกรู', onHand: 50 },
      ]);
      const s = await count.openSession({}, ADMIN);
      await count.submit(s.id, [line('A-001', 97, 1)], STAFF_A, DEV_A);

      const csv = await count.varianceCsv(s.id);
      expect(csv.startsWith('﻿')).toBe(true);
      expect(csv).toContain('"น็อต, 3 นิ้ว"');
      expect(csv).toContain('ขาด');
      expect(csv).toContain('ยังไม่ได้นับ');
      expect(csv.trimEnd().split('\r\n')).toHaveLength(3);
    });
  });
});
