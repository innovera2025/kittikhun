import type { ErpAdapter, ErpHealth } from '../erp-adapter';

/**
 * Mock driver — fixture canonical จาก design ต้นแบบ (`Stock Scan Mobile.dc.html`)
 *
 * ใช้เมื่อ `ERP_DRIVER=mock` สำหรับ: พัฒนา UI แบบตรง design ก่อนต่อ ERP จริง · demo · CI · golden tests
 * ข้อมูลตรงกับ `app/lib/data/fixtures.dart` แบบ 1:1 (สินค้า 5 รายการ + รอบนับ CC-2408)
 *
 * ไม่ต่อ network/DB ใด ๆ — ไม่มี dependency, สร้างด้วย `new MockDriver()` ได้เลย
 *
 * 🚫 กฎเหล็ก: ไม่มี method เขียนกลับ ERP (ชั้นที่ 4 ของกฎเหล็ก 5 ชั้น — docs/erp-integration.md)
 */

// ── type ของข้อมูลถูกดึงออกจาก interface โดยตรง ───────────────────────────────
// อ้างโครงสร้าง ไม่อ้างชื่อ type ใน erp-adapter.ts → เปลี่ยนชื่อ type ต้นทางแล้วไฟล์นี้ยังคอมไพล์ผ่าน
type ItemBatch =
  ReturnType<ErpAdapter['fetchItems']> extends AsyncIterable<infer TBatch> ? TBatch : never;
type CanonicalItem = ItemBatch[number];
type ErpCapabilities = ReturnType<ErpAdapter['capabilities']>;

/**
 * mock ยึดรหัสคลังตาม design (`WH-BKK-02`)
 * ⚠️ คลังจริงใน db_TCL คือ WHRM / WHFG / WHWIP / WHNG — ค่านี้เป็นของ fixture เท่านั้น
 */
const WAREHOUSE_CODE = 'WH-BKK-02';

interface ItemSeed {
  readonly sku: string;
  /** EAN-13 เดิมจาก design (prefix 885… = ไทย) */
  readonly ean13: string;
  readonly name: string;
  readonly nameEn: string;
  readonly loc: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly rop: number;
  readonly unit: string;
  readonly vendor: string;
  /** '—' = design ใช้ขีดแทน "ไม่มีล็อต" (ตรงกับ fixtures.dart) */
  readonly lot: string;
  /** เวลาอัปเดตแบบสัมพัทธ์กับวันนี้ — ป้ายในดีไซน์ ("วันนี้ 09:42" / "เมื่อวาน 17:20") จึงตรงทุกวันที่รัน */
  readonly updatedDayOffset: number;
  readonly updatedHour: number;
  readonly updatedMinute: number;
  /** วันที่นับล่าสุดตาม design เก็บเป็น พ.ศ. [ปี, เดือน, วัน] เพื่อเทียบกับดีไซน์ได้ตรงตา */
  readonly lastCountBe: readonly [number, number, number];
}

const ITEM_SEEDS: readonly ItemSeed[] = [
  {
    sku: 'SKU-40128',
    ean13: '8851234567890',
    name: 'สลักเกลียวหัวหกเหลี่ยม M12',
    nameEn: 'Hex bolt M12 × 60 mm, zinc',
    loc: 'A-04-12',
    onHand: 1240,
    reserved: 180,
    rop: 400,
    unit: 'ชิ้น',
    vendor: 'Siam Fastener Co.',
    lot: 'LOT-24C-118',
    updatedDayOffset: 0,
    updatedHour: 9,
    updatedMinute: 42,
    lastCountBe: [2569, 8, 12],
  },
  {
    sku: 'SKU-77340',
    ean13: '8859900112233',
    name: 'เทปพันสายไฟ PVC 19 มม.',
    nameEn: 'PVC insulation tape 19 mm',
    loc: 'C-01-08',
    onHand: 86,
    reserved: 60,
    rop: 120,
    unit: 'ม้วน',
    vendor: 'Thai Poly Tape',
    lot: 'LOT-24A-902',
    updatedDayOffset: 0,
    updatedHour: 8,
    updatedMinute: 15,
    lastCountBe: [2569, 8, 2],
  },
  {
    sku: 'SKU-11902',
    ean13: '8850001456712',
    name: 'ถุงมือหนังนิรภัย เบอร์ 9',
    nameEn: 'Leather safety gloves, size 9',
    loc: 'B-07-03',
    onHand: 0,
    reserved: 0,
    rop: 50,
    unit: 'คู่',
    vendor: 'Protex Industrial',
    lot: '—',
    updatedDayOffset: -1,
    updatedHour: 17,
    updatedMinute: 20,
    lastCountBe: [2569, 7, 28],
  },
  {
    sku: 'SKU-63015',
    ean13: '8851777090412',
    name: 'น้ำมันหล่อลื่นเกียร์ 20 ลิตร',
    nameEn: 'Gear oil, 20 L drum',
    loc: 'D-02-01',
    onHand: 34,
    reserved: 6,
    rop: 10,
    unit: 'ถัง',
    vendor: 'PTT Lubricants',
    lot: 'LOT-24B-441',
    updatedDayOffset: 0,
    updatedHour: 7,
    updatedMinute: 55,
    lastCountBe: [2569, 8, 9],
  },
  {
    sku: 'SKU-20887',
    ean13: '8853344556677',
    name: 'แผ่นตัดเหล็ก 4 นิ้ว',
    nameEn: 'Steel cutting disc 4"',
    loc: 'A-09-05',
    onHand: 512,
    reserved: 24,
    rop: 150,
    unit: 'แผ่น',
    vendor: 'Nippon Abrasive',
    lot: 'LOT-24C-077',
    updatedDayOffset: 0,
    updatedHour: 9,
    updatedMinute: 10,
    lastCountBe: [2569, 8, 5],
  },
];

/** วันที่/เวลาสัมพัทธ์กับ "วันนี้" ตามเวลาเครื่อง */
function relativeDate(dayOffset: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** พ.ศ. → ค.ศ. (ลบ 543) — เก็บเป็น Date, การแสดงผลเป็น พ.ศ. เป็นหน้าที่ของชั้น UI */
function fromBuddhistDate(be: readonly [number, number, number]): Date {
  const [year, month, day] = be;
  return new Date(year - 543, month - 1, day);
}

function toCanonicalItem(seed: ItemSeed): CanonicalItem {
  return {
    sku: seed.sku,
    // สแกนได้ทั้ง EAN-13 เดิม และ Code128 ของ ItemCode (ตัดสินใจแล้ว: erp-tcl-findings §6.1)
    barcodes: [seed.ean13, seed.sku],
    name: seed.name,
    nameEn: seed.nameEn,
    loc: seed.loc,
    onHand: seed.onHand,
    reserved: seed.reserved,
    rop: seed.rop,
    unit: seed.unit,
    vendor: seed.vendor,
    lot: seed.lot,
    lastCountDate: fromBuddhistDate(seed.lastCountBe),
    updatedAt: relativeDate(seed.updatedDayOffset, seed.updatedHour, seed.updatedMinute),
    warehouseCode: WAREHOUSE_CODE,
  };
}

export class MockDriver implements ErpAdapter {
  /** fixture ไม่มี updated-at ที่เชื่อถือได้ → server ใช้ full snapshot + diff */
  capabilities(): ErpCapabilities {
    return { delta: false };
  }

  /** ชุดเล็ก 5 รายการ → ส่งเป็น batch เดียว (ไม่มี pagination ให้จำลอง) */
  /** ยอดสดของ mock = ข้อมูล fixture ชุดเดียวกัน กรองตามรหัสที่ขอ */
  async fetchItemsBySku(skus: readonly string[]): Promise<CanonicalItem[]> {
    const wanted = new Set(skus.map((s) => s.trim()).filter((s) => s.length > 0));
    if (wanted.size === 0) return [];
    return ITEM_SEEDS.map(toCanonicalItem).filter((item) => wanted.has(item.sku));
  }

  async *fetchItems(): AsyncGenerator<CanonicalItem[]> {
    yield ITEM_SEEDS.map(toCanonicalItem);
  }

  /** mock ไม่ต้องต่ออะไร — แต่ต้องมีตาม contract เพื่อให้ ErpModule เรียกได้เหมือนกันทุก driver */
  init(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** mock พร้อมใช้เสมอ — ไม่มีอะไรให้ล่ม */
  healthCheck(): Promise<ErpHealth> {
    return Promise.resolve({ ok: true, driver: 'mock' });
  }
}
