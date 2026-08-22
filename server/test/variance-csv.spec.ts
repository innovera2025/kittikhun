import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../src/config/env.config';
import { CountService, VARIANCE_STATUS_TH, type VarianceRow } from '../src/count/count.service';
import type { PostgresService } from '../src/db/postgres.service';

/**
 * CSV ส่วนต่าง — เอกสารอ้างอิงภายใน เปิดด้วย Excel ไทยบนเครื่องออฟฟิศ
 *
 * ⚠️ ไฟล์นี้ **ไม่ใช่** ไฟล์สำหรับคีย์กลับเข้า ERP (กฎเหล็ก: ห้ามเขียนกลับ ERP)
 *
 * สิ่งที่ต้องไม่พังเงียบ:
 *   - BOM UTF-8 หาย → Excel ไทยอ่านเป็นขยะ ผู้ใช้เข้าใจว่าข้อมูลเสีย
 *   - null กลายเป็น 0 → "ยังไม่ได้นับ" ถูกอ่านเป็น "นับได้ 0" = สินค้าหายทั้งชั้น
 *   - ชื่อสินค้าไทยมีลูกน้ำ → คอลัมน์เลื่อน ทั้งไฟล์อ่านผิด
 *   - ชื่อขึ้นต้นด้วย = → Excel รันเป็นสูตร (formula injection)
 */

function baseRow(over: Partial<VarianceRow> = {}): VarianceRow {
  return {
    sku: 'A-001',
    name: 'สินค้าทดสอบ',
    frozenOnHand: 10,
    countedQty: 10,
    diff: 0,
    status: 'match',
    unit: 'ชิ้น',
    zone: 'Z1',
    warehouseCode: 'WH01',
    countedBy: '52104',
    countedDeviceId: 'dev-1',
    deviceCount: 1,
    submissionCount: 1,
    supersededCount: 0,
    isConflict: false,
    countedAt: '2026-08-19T03:00:00.000Z',
    receivedAt: '2026-08-19T03:00:01.000Z',
    latestSubmission: null,
    chosenSubmission: null,
    resolvedBy: null,
    source: 'live',
    ...over,
  };
}

function makeService(rows: VarianceRow[]): CountService {
  const cfg = { get: () => 'WH01' } as unknown as ConfigService<AppConfig, true>;
  const svc = new CountService({} as PostgresService, cfg);
  jest.spyOn(svc, 'variance').mockResolvedValue(rows);
  return svc;
}

const csvOf = (rows: VarianceRow[]) => makeService(rows).varianceCsv('sess-1');

describe('export CSV ส่วนต่าง', () => {
  describe('Excel ไทยต้องอ่านออก', () => {
    it('ขึ้นต้นด้วย BOM UTF-8', async () => {
      expect(await csvOf([baseRow()])).toMatch(/^\uFEFF/);
    });

    it('ขึ้นบรรทัดใหม่ด้วย CRLF และปิดท้ายไฟล์ด้วย CRLF', async () => {
      const csv = await csvOf([baseRow()]);
      expect(csv.endsWith('\r\n')).toBe(true);
      expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('หัวคอลัมน์เป็นภาษาไทยครบ 10 คอลัมน์ตามลำดับที่ตกลงไว้', async () => {
      const csv = await csvOf([baseRow()]);
      const header = csv.slice(1).split('\r\n')[0];
      expect(header).toBe(
        'รหัสสินค้า,ชื่อสินค้า,คลัง,โซน,ยอดระบบ,นับได้,ส่วนต่าง,สถานะ,ผู้นับ,หน่วย',
      );
    });

    it('ไฟล์ว่าง (ยังไม่มีรายการ) ยังมีหัวคอลัมน์ ไม่ใช่ไฟล์เปล่า', async () => {
      const csv = await csvOf([]);
      expect(csv.slice(1)).toBe(
        'รหัสสินค้า,ชื่อสินค้า,คลัง,โซน,ยอดระบบ,นับได้,ส่วนต่าง,สถานะ,ผู้นับ,หน่วย\r\n',
      );
    });
  });

  describe('null ต้องเป็นเซลล์ว่าง ห้ามเป็น 0', () => {
    it('ยังไม่ได้นับ — นับได้/ส่วนต่าง ว่าง ไม่ใช่ 0', async () => {
      const csv = await csvOf([
        baseRow({ status: 'not_counted', countedQty: null, diff: null, countedBy: null }),
      ]);
      const cells = csv.slice(1).split('\r\n')[1].split(',');
      expect(cells[4]).toBe('10');
      expect(cells[5]).toBe('');
      expect(cells[6]).toBe('');
      expect(cells[7]).toBe('ยังไม่ได้นับ');
    });

    it('นอกรายการ — ยอดระบบ/ส่วนต่าง ว่าง แต่ "นับได้" มีค่าจริง', async () => {
      const csv = await csvOf([
        baseRow({ status: 'off_list', frozenOnHand: null, countedQty: 3, diff: null }),
      ]);
      const cells = csv.slice(1).split('\r\n')[1].split(',');
      expect(cells[4]).toBe('');
      expect(cells[5]).toBe('3');
      expect(cells[6]).toBe('');
      expect(cells[7]).toBe('นอกรายการ');
    });

    it('ส่วนต่าง 0 จริง (ตรงกับระบบ) ต้องเป็น "0" ไม่ใช่ช่องว่าง', async () => {
      const csv = await csvOf([baseRow({ diff: 0 })]);
      expect(csv.slice(1).split('\r\n')[1].split(',')[6]).toBe('0');
    });
  });

  describe('ตัวเลข', () => {
    it.each([
      [10, '10'],
      [0, '0'],
      [-4, '-4'],
      [2.5, '2.5'],
      [1000, '1000'],
      [20, '20'],
      [0.125, '0.125'],
    ])('%p → %p (ตัดศูนย์ท้ายแต่ไม่กินหลักจริง)', async (value, expected) => {
      const csv = await csvOf([baseRow({ countedQty: value })]);
      expect(csv.slice(1).split('\r\n')[1].split(',')[5]).toBe(expected);
    });

    it('ส่วนต่างติดลบแสดงเครื่องหมายลบ (ของขาด)', async () => {
      const csv = await csvOf([baseRow({ status: 'short', countedQty: 7, diff: -3 })]);
      const cells = csv.slice(1).split('\r\n')[1].split(',');
      expect(cells[6]).toBe('-3');
      expect(cells[7]).toBe('ขาด');
    });
  });

  describe('escape — ข้อมูลไทยจริงต้องไม่ทำคอลัมน์เลื่อน', () => {
    it('ชื่อมีลูกน้ำ → ครอบด้วยอัญประกาศ', async () => {
      const csv = await csvOf([baseRow({ name: 'น็อต, สกรู 3 นิ้ว' })]);
      expect(csv).toContain('"น็อต, สกรู 3 นิ้ว"');
      expect(csv.slice(1).split('\r\n')[1].split('","').length).toBeGreaterThan(0);
    });

    it('ชื่อมีอัญประกาศ → escape เป็น "" ตาม RFC4180', async () => {
      const csv = await csvOf([baseRow({ name: 'ท่อ 2" PVC' })]);
      expect(csv).toContain('"ท่อ 2"" PVC"');
    });

    it('ชื่อมีขึ้นบรรทัดใหม่ → ครอบด้วยอัญประกาศ ไม่ทำให้แถวขาด', async () => {
      const csv = await csvOf([baseRow({ name: 'บรรทัด1\nบรรทัด2' })]);
      expect(csv).toContain('"บรรทัด1\nบรรทัด2"');
    });
  });

  describe('กัน formula injection ของ Excel', () => {
    it.each(['=cmd|calc', '+1+1', '-2+3', '@SUM(A1)'])(
      'ชื่อขึ้นต้นด้วยอักขระสูตร (%s) ถูกเติม อัญประกาศเดี่ยว นำหน้า',
      async (name) => {
        const csv = await csvOf([baseRow({ name })]);
        expect(csv).toContain(`'${name}`);
      },
    );

    it('SKU ก็ถูกกันเหมือนกัน ไม่ใช่แค่ชื่อสินค้า', async () => {
      const csv = await csvOf([baseRow({ sku: '=1+1' })]);
      expect(csv.slice(1).split('\r\n')[1].startsWith("'=1+1")).toBe(true);
    });
  });

  describe('สถานะภาษาไทย', () => {
    it('แปลครบทุกสถานะ ไม่มีคำอังกฤษหลุดเข้าไฟล์', async () => {
      const statuses = Object.keys(VARIANCE_STATUS_TH) as (keyof typeof VARIANCE_STATUS_TH)[];
      const csv = await csvOf(
        statuses.map((status, i) => baseRow({ sku: `S-${i}`, status })),
      );
      for (const status of statuses) {
        expect(csv).toContain(VARIANCE_STATUS_TH[status]);
        expect(csv).not.toContain(`,${status},`);
      }
    });

    it('ขัดแย้ง (หลายเครื่องนับ SKU เดียวกัน) ระบุชัดในไฟล์', async () => {
      const csv = await csvOf([
        baseRow({ status: 'conflict', isConflict: true, deviceCount: 2, countedQty: null, diff: null }),
      ]);
      expect(csv).toContain('ขัดแย้ง(หลายเครื่อง)');
    });
  });

  it('หนึ่งแถวข้อมูลต่อหนึ่ง SKU — ไม่มีแถวหายไปเงียบ ๆ', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => baseRow({ sku: `SKU-${i}` }));
    const csv = await csvOf(rows);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(26);
  });
});
