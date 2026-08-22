import { CatalogService, TombstoneGuardrailError } from '../src/catalog/catalog.service';
import type { PostgresService } from '../src/db/postgres.service';
import type { CanonicalItem } from '../src/erp/erp-adapter';
import {
  applySchema,
  describeWithDb,
  makeDb,
  testConfigService,
  truncateAll,
} from './support/test-db';

/**
 * `items_cache` — ทางเข้าเดียวของข้อมูลสินค้าจาก ERP เข้าสู่ระบบ
 *
 * ส่วนนี้ไม่เคยมีเทสต์เลยทั้งที่เป็นจุดที่ **พังแล้วสินค้าหายทั้งคลังโดยไม่มีอะไรฟ้อง**:
 *   - tombstone guardrail 5% — ถ้าไม่ทำงาน ดึง ERP ไม่ครบ = ลบสินค้าทิ้งยกคลัง
 *   - delta feed cursor — ถ้าแถวตกขอบ มือถือจะไม่เห็นสินค้าที่เปลี่ยน
 *   - บาร์โค้ด — สแกนไม่เจอ = นับไม่ได้
 *
 * ต้องใช้ Postgres จริงเพราะ cursor คือ `bigserial` และ tombstone เป็น partial index
 */

const WH = 'WH01';

describeWithDb('items_cache — ทางเข้าข้อมูลสินค้าจาก ERP', () => {
  let db: PostgresService;
  let catalog: CatalogService;

  beforeAll(async () => {
    db = makeDb();
    await applySchema(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  beforeEach(async () => {
    await truncateAll(db);
    catalog = new CatalogService(db, testConfigService());
  });

  const item = (sku: string, over: Partial<CanonicalItem> = {}): CanonicalItem => ({
    sku,
    name: `สินค้า ${sku}`,
    barcodes: [sku],
    unit: 'ชิ้น',
    warehouseCode: WH,
    ...over,
  });

  /** upsert ผ่าน transaction เหมือนที่ SyncService ทำจริง */
  const upsert = (items: CanonicalItem[]) =>
    db.transaction((client) => catalog.upsertItems(items, WH, client));

  const tombstone = (seen: string[]) =>
    db.transaction((client) => catalog.tombstoneMissing(seen, WH, client));

  const liveSkus = async (): Promise<string[]> => {
    const r = await db.query<{ sku: string }>(
      `SELECT sku FROM items_cache WHERE warehouse_code = $1 AND deleted_at IS NULL ORDER BY sku`,
      [WH],
    );
    return r.rows.map((x) => x.sku);
  };

  const seedMany = async (n: number): Promise<string[]> => {
    const skus = Array.from({ length: n }, (_, i) => `SKU-${String(i).padStart(4, '0')}`);
    await upsert(skus.map((s) => item(s)));
    return skus;
  };

  // ── upsert ───────────────────────────────────────────────────────────

  describe('upsertItems', () => {
    it('เพิ่มสินค้าใหม่พร้อมชื่อไทยและหน่วย', async () => {
      const result = await upsert([item('A-001', { name: 'น็อต 3 นิ้ว', unit: 'ตัว' })]);
      expect(result.upserted).toBe(1);

      const row = await db.one<{ name: string; unit: string }>(
        `SELECT name, unit FROM items_cache WHERE sku = 'A-001'`,
      );
      expect(row?.name).toBe('น็อต 3 นิ้ว');
      expect(row?.unit).toBe('ตัว');
    });

    it('ส่งซ้ำ = อัปเดตแถวเดิม ไม่เกิดแถวซ้ำ', async () => {
      await upsert([item('A-001', { name: 'ชื่อเก่า' })]);
      await upsert([item('A-001', { name: 'ชื่อใหม่' })]);

      const n = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM items_cache WHERE sku = 'A-001'`,
      );
      expect(n?.n).toBe(1);
      const row = await db.one<{ name: string }>(`SELECT name FROM items_cache WHERE sku='A-001'`);
      expect(row?.name).toBe('ชื่อใหม่');
    });

    it('⭐ onHand เป็น undefined (ERP ไม่มียอด) → เก็บเป็น NULL ไม่ใช่ 0', async () => {
      await upsert([item('A-001', { onHand: undefined })]);
      const row = await db.one<{ on_hand: string | null }>(
        `SELECT on_hand FROM items_cache WHERE sku='A-001'`,
      );
      expect(row?.on_hand).toBeNull();
    });

    it('⭐ onHand เป็น 0 จริง → เก็บเป็น 0 ไม่ถูกกลืนเป็น NULL', async () => {
      await upsert([item('A-001', { onHand: 0 })]);
      const row = await db.one<{ on_hand: string }>(
        `SELECT on_hand FROM items_cache WHERE sku='A-001'`,
      );
      expect(Number(row?.on_hand)).toBe(0);
    });

    it('ทศนิยม 3 ตำแหน่งไม่ถูกปัด (สินค้าชั่งน้ำหนัก)', async () => {
      await upsert([item('A-001', { onHand: 12.345 })]);
      const row = await db.one<{ on_hand: string }>(
        `SELECT on_hand FROM items_cache WHERE sku='A-001'`,
      );
      expect(Number(row?.on_hand)).toBeCloseTo(12.345, 3);
    });

    it('ลิสต์ว่าง → ไม่ทำอะไร ไม่ throw', async () => {
      await expect(upsert([])).resolves.toMatchObject({ upserted: 0 });
    });

    it('บาร์โค้ดถูกบันทึกให้ค้นเจอ', async () => {
      await upsert([item('A-001', { barcodes: ['8850001234567', 'A-001'] })]);
      const found = await catalog.findByBarcode('8850001234567', WH);
      expect(found?.sku).toBe('A-001');
    });

    it('สินค้าที่เคยถูกลบ กลับมาใน ERP อีกครั้ง → ฟื้นคืน (deleted_at กลับเป็น NULL)', async () => {
      // seed ใหญ่พอให้การลบ 2 รายการอยู่ใต้เพดาน guardrail 5%
      const skus = await seedMany(100);
      const gone = skus.slice(98);
      await tombstone(skus.slice(0, 98));
      expect(await liveSkus()).toHaveLength(98);

      // ERP ส่งกลับมาครบอีกครั้ง
      await upsert(skus.map((sku) => item(sku)));
      expect(await liveSkus()).toHaveLength(100);
      const revived = await db.one<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM items_cache WHERE sku = $1`,
        [gone[0]],
      );
      expect(revived?.deleted_at).toBeNull();
    });
  });

  // ── tombstone guardrail (จุดเสี่ยงสูงสุด) ─────────────────────────────

  describe('⭐ tombstone guardrail — กันลบสินค้าทิ้งยกคลังตอนดึง ERP ไม่ครบ', () => {
    it('ลบน้อยกว่าเพดาน → ลบได้ปกติ', async () => {
      const skus = await seedMany(100);
      const removed = await tombstone(skus.slice(0, 97)); // หายไป 3 จาก 100 = 3%
      expect(removed).toBe(3);
      expect(await liveSkus()).toHaveLength(97);
    });

    it('🔴 ลบเกิน 5% → โยน TombstoneGuardrailError และ **ไม่ลบอะไรเลย**', async () => {
      const skus = await seedMany(100);
      await expect(tombstone(skus.slice(0, 90))).rejects.toBeInstanceOf(TombstoneGuardrailError);
      // สำคัญที่สุด: ต้องไม่มีอะไรถูกลบแม้แต่รายการเดียว
      expect(await liveSkus()).toHaveLength(100);
    });

    it('error บอกตัวเลขให้ผู้ดูแลตัดสินใจได้', async () => {
      const skus = await seedMany(100);
      try {
        await tombstone(skus.slice(0, 90));
        throw new Error('คาดว่าจะ throw');
      } catch (e) {
        const err = e as TombstoneGuardrailError;
        expect(err).toBeInstanceOf(TombstoneGuardrailError);
        expect(err.doomed).toBe(10);
        expect(err.liveTotal).toBe(100);
        expect(err.ratio).toBeCloseTo(0.1, 5);
        expect(err.message).toContain('partial');
      }
    });

    it('🔴 ดึง ERP ไม่ได้เลย (ลิสต์ว่าง) → ปฏิเสธทันที ไม่ตีความว่า "ERP ไม่มีสินค้าแล้ว"', async () => {
      await seedMany(50);
      await expect(tombstone([])).rejects.toBeInstanceOf(TombstoneGuardrailError);
      expect(await liveSkus()).toHaveLength(50);
    });

    it('ลิสต์ที่มีแต่ช่องว่าง/ค่าว่าง = เท่ากับลิสต์ว่าง → ปฏิเสธ', async () => {
      await seedMany(50);
      await expect(tombstone(['', '   '])).rejects.toBeInstanceOf(TombstoneGuardrailError);
      expect(await liveSkus()).toHaveLength(50);
    });

    it('ไม่มีอะไรหายไป → คืน 0 ไม่แตะข้อมูล', async () => {
      const skus = await seedMany(20);
      expect(await tombstone(skus)).toBe(0);
      expect(await liveSkus()).toHaveLength(20);
    });

    it('ERP ส่ง SKU ที่ระบบยังไม่มี → ไม่พังและไม่ลบของเดิม', async () => {
      const skus = await seedMany(20);
      expect(await tombstone([...skus, 'SKU-ใหม่-ยังไม่มีในระบบ'])).toBe(0);
      expect(await liveSkus()).toHaveLength(20);
    });

    it('SKU ซ้ำในลิสต์ไม่ทำให้สัดส่วนเพี้ยน', async () => {
      const skus = await seedMany(100);
      const withDupes = [...skus.slice(0, 98), ...skus.slice(0, 98)];
      expect(await tombstone(withDupes)).toBe(2);
    });

    it('tombstone เป็น soft-delete — แถวยังอยู่ ตรวจย้อนหลังได้', async () => {
      const skus = await seedMany(100);
      await tombstone(skus.slice(0, 98));
      const row = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM items_cache WHERE deleted_at IS NOT NULL`,
      );
      expect(row?.n).toBe(2);
    });

    it('ไม่ข้ามคลัง — tombstone คลังหนึ่งไม่แตะอีกคลัง', async () => {
      const skus = await seedMany(100);
      await db.transaction((c) =>
        catalog.upsertItems([item('B-001', { warehouseCode: 'WH02' })], 'WH02', c),
      );

      await tombstone(skus.slice(0, 98)); // ลบ 2 จาก 100 ในคลัง WH01

      const other = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM items_cache
          WHERE warehouse_code = 'WH02' AND deleted_at IS NULL`,
      );
      expect(other?.n).toBe(1);
    });
  });

  // ── delta feed ───────────────────────────────────────────────────────

  describe('delta feed — มือถือต้องเห็นทุกอย่างที่เปลี่ยน', () => {
    it('ดึงตั้งแต่ต้น → ได้ทุกรายการ', async () => {
      await seedMany(5);
      const page = await catalog.listSince(0, 100, WH);
      expect(page.items).toHaveLength(5);
    });

    it('⭐ ดึงต่อจาก cursor → ได้เฉพาะที่เปลี่ยนหลังจากนั้น', async () => {
      await upsert([item('A-001'), item('A-002')]);
      const first = await catalog.listSince(0, 100, WH);
      const cursor = first.nextCursor;

      await upsert([item('A-003')]);
      const second = await catalog.listSince(cursor, 100, WH);

      expect(second.items.map((i) => i.sku)).toEqual(['A-003']);
    });

    it('⭐ แก้ของเดิมก็ต้องหลุดออกมาใน delta ถัดไป (ไม่ตกขอบ)', async () => {
      await upsert([item('A-001'), item('A-002')]);
      const cursor = (await catalog.listSince(0, 100, WH)).nextCursor;

      await upsert([item('A-001', { name: 'ชื่อที่เพิ่งแก้' })]);
      const next = await catalog.listSince(cursor, 100, WH);

      expect(next.items.map((i) => i.sku)).toEqual(['A-001']);
      expect(next.items[0].name).toBe('ชื่อที่เพิ่งแก้');
    });

    it('⭐ สินค้าที่ถูกลบต้องส่ง tombstone ให้มือถือลบตาม ไม่ใช่หายเงียบ', async () => {
      const skus = await seedMany(100);
      const cursor = (await catalog.listSince(0, 200, WH)).nextCursor;

      await tombstone(skus.slice(0, 98));
      const next = await catalog.listSince(cursor, 200, WH);

      expect(next.tombstones.length).toBe(2);
      expect(next.tombstones).toEqual(expect.arrayContaining([skus[98], skus[99]]));
    });

    it('ไม่มีอะไรเปลี่ยน → ลิสต์ว่าง และ cursor ไม่ถอยหลัง', async () => {
      await seedMany(3);
      const first = await catalog.listSince(0, 100, WH);
      const second = await catalog.listSince(first.nextCursor, 100, WH);

      expect(second.items).toHaveLength(0);
      expect(BigInt(second.nextCursor)).toBeGreaterThanOrEqual(BigInt(first.nextCursor));
    });

    it('แบ่งหน้าแล้วไม่มีแถวตกหล่นหรือซ้ำ', async () => {
      const skus = await seedMany(25);
      const seen: string[] = [];
      let cursor: string | number = 0;
      for (let i = 0; i < 10; i++) {
        const page = await catalog.listSince(cursor, 10, WH);
        seen.push(...page.items.map((x) => x.sku));
        cursor = page.nextCursor;
        if (page.items.length === 0) break;
      }
      expect(seen.sort()).toEqual([...skus].sort());
      expect(new Set(seen).size).toBe(skus.length);
    });
  });

  // ── ค้นหา / บาร์โค้ด ─────────────────────────────────────────────────

  describe('ค้นหาและบาร์โค้ด (พนักงานใช้ทุกวัน)', () => {
    it('ค้นด้วยชื่อไทยได้', async () => {
      await upsert([item('A-001', { name: 'น็อตหัวหกเหลี่ยม' }), item('A-002')]);
      const r = await catalog.search('หัวหก', WH, 50);
      expect(r.items.map((i) => i.sku)).toContain('A-001');
    });

    it('ค้นด้วยรหัสสินค้าได้', async () => {
      await upsert([item('A-001'), item('B-002')]);
      const r = await catalog.search('B-002', WH, 50);
      expect(r.items.map((i) => i.sku)).toEqual(['B-002']);
    });

    it('สินค้าที่ถูกลบไม่โผล่ในผลค้นหา', async () => {
      const skus = await seedMany(100);
      await tombstone(skus.slice(0, 98));
      const r = await catalog.search('SKU-', WH, 500);
      expect(r.items.map((i) => i.sku)).not.toContain(skus[99]);
    });

    it('บาร์โค้ดที่ไม่มีในระบบ → คืน null ไม่ throw', async () => {
      await upsert([item('A-001')]);
      await expect(catalog.findByBarcode('ไม่มีบาร์โค้ดนี้', WH)).resolves.toBeNull();
    });

    it('สินค้าที่ถูกลบแล้ว สแกนบาร์โค้ดต้องไม่เจอ', async () => {
      const skus = await seedMany(100);
      await tombstone(skus.slice(0, 98));
      await expect(catalog.findByBarcode(skus[99], WH)).resolves.toBeNull();
    });
  });
});
