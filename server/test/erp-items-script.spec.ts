import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../src/config/env.config';
import { MssqlDriver } from '../src/erp/drivers/mssql.driver';
import { assertReadOnlySql } from '../src/erp/erp-adapter';

/**
 * script ดึง item master + ยอดคงเหลือ ที่ **ฝ่าย ERP ส่งมอบ** (22 ส.ค. 2569)
 *
 * ไฟล์นี้คือ "สัญญา" กับ ERP — ถ้ามีใครแก้เงื่อนไขในสูตรโดยไม่ได้คุยกับฝ่าย ERP
 * ยอดระบบทั้งคลังจะผิดโดยไม่มีอะไรฟ้อง เทสต์ชุดนี้จึงล็อกเงื่อนไขไว้ทีละข้อ
 *
 * สูตรต้นฉบับ (query ต่อ 1 รหัสสินค้า, placeholder แบบ ODBC):
 *   SUM(InventoryFlowDtl.InOut * InventoryFlowDtl.MainQuantity)
 *   FROM InventoryFlowHdr LEFT OUTER JOIN InventoryFlowDtl
 *     ON Hdr.TranSactionno = Dtl.Transactionno AND Hdr.VoucherNo = Dtl.VoucherNo
 *   WHERE Dtl.ItemCode = ? AND Hdr.InOutDate <= ? AND Hdr.Approved = 1
 *     AND Hdr.IsClosed <> 1 AND Dtl.Warehouse = ?
 */

const SCRIPT_PATH = join(__dirname, '..', 'sql', 'erp', 'inventory-items-with-balance.sql');
const script = readFileSync(SCRIPT_PATH, 'utf8');

/** ตัดคอมเมนต์ออกก่อนตรวจ — เงื่อนไขต้องอยู่ใน SQL จริง ไม่ใช่ในคอมเมนต์ */
const sqlOnly = script
  .replace(/--[^\n]*/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** ต้นฉบับที่ฝ่าย ERP ส่งมา — เก็บไว้เทียบว่าเงื่อนไขไม่หล่นหาย */
const ORIGINAL_FROM_ERP = `SELECT InventoryFlowDtl.ItemCode, SUM(InventoryFlowDtl.InOut * InventoryFlowDtl.MainQuantity) AS Balqty
   FROM InventoryFlowHdr WITH (NOLOCK) LEFT OUTER JOIN InventoryFlowDtl WITH (NOLOCK) ON  InventoryFlowHdr.TranSactionno = InventoryFlowDtl.Transactionno AND InventoryFlowHdr.VoucherNo = InventoryFlowDtl.VoucherNo
   WHERE (InventoryFlowDtl.ItemCode = ?cItemCode) AND (InventoryFlowHDR.InOutDate <= ?cTodate) AND (InventoryFlowHdr.Approved = 1) AND (InventoryFlowHdr.IsClosed <> 1)  AND (InventoryFlowDtl.Warehouse = ?cWH)
   GROUP BY InventoryFlowDtl.ItemCode
   ORDER BY InventoryFlowDtl.ItemCode`;

describe('script ยอดคงเหลือจากฝ่าย ERP', () => {
  describe('กฎเหล็ก: ต้องผ่าน statement guard', () => {
    it('ไฟล์ที่ส่งมอบผ่าน assertReadOnlySql', () => {
      expect(() => assertReadOnlySql(script)).not.toThrow();
    });

    it('ต้นฉบับจากฝ่าย ERP ก็ผ่าน guard (ไม่มีคำสั่งเขียนแฝง)', () => {
      expect(() => assertReadOnlySql(ORIGINAL_FROM_ERP)).not.toThrow();
    });

    it('ไม่มีตัวคั่นแบตช์ GO (driver ปฏิเสธไฟล์ที่มี GO)', () => {
      expect(/^\s*GO\s*$/im.test(script)).toBe(false);
    });

    it('ไม่มีคำสั่งเขียนแม้แต่ในคอมเมนต์ที่อาจถูกลอกไปใช้', () => {
      expect(/\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|EXEC)\s+(?!อ)/i.test(sqlOnly))
        .toBe(false);
    });
  });

  describe('เงื่อนไขของสูตรต้องครบทุกข้อ — หายไปข้อเดียวยอดผิดทั้งคลัง', () => {
    it('SUM(InOut × MainQuantity) — ทิศทางเข้า/ออกคูณจำนวน', () => {
      expect(sqlOnly).toMatch(/SUM\(\s*d\.InOut\s*\*\s*d\.MainQuantity\s*\)/i);
    });

    it('นับเฉพาะเอกสารที่อนุมัติแล้ว (Approved = 1)', () => {
      expect(sqlOnly).toMatch(/h\.Approved\s*=\s*1/i);
    });

    it('ตัดเอกสารที่ปิดแล้วออก (IsClosed <> 1)', () => {
      expect(sqlOnly).toMatch(/h\.IsClosed\s*<>\s*1/i);
    });

    it('จำกัดถึงเวลาที่กำหนด (InOutDate <= @asOf)', () => {
      expect(sqlOnly).toMatch(/h\.InOutDate\s*<=\s*@asOf/i);
    });

    it('จำกัดเฉพาะคลังของ deployment นี้ (Warehouse = @warehouse)', () => {
      expect(sqlOnly).toMatch(/d\.Warehouse\s*=\s*@warehouse/i);
    });

    it('join หัว/รายละเอียดด้วย **ทั้งสอง** คีย์ (TranSactionno + VoucherNo)', () => {
      expect(sqlOnly).toMatch(/h\.TranSactionno\s*=\s*d\.Transactionno/i);
      expect(sqlOnly).toMatch(/h\.VoucherNo\s*=\s*d\.VoucherNo/i);
    });

    it('อ่านอย่างเดียวด้วย NOLOCK เหมือนที่ ERP ใช้เอง', () => {
      expect((sqlOnly.match(/WITH\s*\(\s*NOLOCK\s*\)/gi) ?? []).length)
        .toBeGreaterThanOrEqual(2);
    });
  });

  describe('สัญญากับ driver', () => {
    it('ใช้พารามิเตอร์ที่ driver ผูกให้เท่านั้น (@warehouse, @asOf)', () => {
      const params = new Set(script.match(/@[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      expect(params).toEqual(new Set(['@warehouse', '@asOf']));
    });

    it('ไม่มี placeholder แบบ ODBC หลงเหลือ (?cItemCode ฯลฯ ใช้กับ mssql ไม่ได้)', () => {
      expect(sqlOnly).not.toMatch(/\?c[A-Za-z]/);
    });

    it('alias ยอดคงเหลือเป็น on_hand ตามที่ pickItemFields อ่าน', () => {
      expect(sqlOnly).toMatch(/AS\s+on_hand/i);
    });

    it('คืนคอลัมน์ครบตามที่ driver map เป็น CanonicalItem', () => {
      for (const col of [
        'ItemCode',
        'ItemName',
        'ItemNameEng',
        'MainUnits',
        'MinStock',
        'BarCodeUnits',
        'BarCodePack',
        'Shelf',
        'LotNumber',
        'Roworder',
        'Warehouse',
      ]) {
        expect(sqlOnly).toMatch(new RegExp(`AS\\s+${col}\\b`, 'i'));
      }
    });

    it('dedupe ItemCode ซ้ำด้วย Roworder สูงสุด — กติกาเดียวกับ itemsPageSql()', () => {
      expect(sqlOnly).toMatch(/ROW_NUMBER\(\)\s*OVER\s*\(\s*PARTITION BY\s+.*?ORDER BY\s+Roworder\s+DESC/i);
      expect(sqlOnly).toMatch(/WHERE\s+r\.rn\s*=\s*1/i);
    });

    it('LTRIM/RTRIM ทั้งสองฝั่งของ join ยอด (ERP pad ช่องว่างใน ItemCode)', () => {
      expect(sqlOnly).toMatch(/GROUP BY\s+LTRIM\(\s*RTRIM\(\s*d\.ItemCode\s*\)\s*\)/i);
    });
  });

  describe('⭐ ยอดที่ไม่มีในบัญชีเดินสะพัดต้องเป็น NULL ไม่ใช่ 0', () => {
    it('ใช้ LEFT OUTER JOIN ไม่ใช่ INNER — สินค้าที่ไม่มี movement ต้องยังอยู่ในลิสต์', () => {
      expect(sqlOnly).toMatch(/FROM\s+ranked\s+AS\s+r\s+LEFT\s+OUTER\s+JOIN\s+bal\s+AS\s+b/i);
    });

    it('ไม่ COALESCE ยอดเป็น 0 — "ไม่มีข้อมูล" กับ "ยอดศูนย์" ต้องแยกกัน', () => {
      expect(sqlOnly).not.toMatch(/COALESCE\s*\(\s*b\.Balqty/i);
      expect(sqlOnly).not.toMatch(/ISNULL\s*\(\s*b\.Balqty/i);
    });
  });

  describe('driver map ยอดเข้า CanonicalItem', () => {
    const driver = new MssqlDriver({
      get: (key: string) =>
        ({
          ERP_SQL_HOST: 'localhost',
          ERP_SQL_PORT: 1433,
          ERP_SQL_USER: 'reader',
          ERP_SQL_PASSWORD: 'x',
          ERP_SQL_DATABASE: 'db_TCL',
          ERP_SQL_ENCRYPT: false,
          ERP_SQL_TRUST_SERVER_CERT: true,
          ERP_TIMEOUT_MS: 15_000,
          ERP_SQL_POOL_MAX: 3,
          ERP_SQL_CHARSET: 'utf8',
          WAREHOUSE_CODE: 'WH01',
        })[key],
    } as unknown as ConfigService<AppConfig, true>);

    /** toCanonicalItem เป็น private และไม่แตะ connection — เรียกตรงเพื่อทดสอบการ map */
    const map = (row: Record<string, unknown>) =>
      (
        driver as unknown as {
          toCanonicalItem: (r: Record<string, unknown>) => {
            ok: boolean;
            item?: { onHand?: number; sku: string };
            reason?: string;
          };
        }
      ).toCanonicalItem(row);

    const baseRow = {
      ItemCode: 'SKU-1',
      ItemName: 'น็อต 3 นิ้ว',
      MainUnits: 'ชิ้น',
    };

    it('on_hand จาก script → CanonicalItem.onHand', () => {
      const r = map({ ...baseRow, on_hand: 1240 });
      expect(r.ok).toBe(true);
      expect(r.item?.onHand).toBe(1240);
    });

    it('รับชื่อคอลัมน์ Balqty ตามสูตรต้นฉบับด้วย', () => {
      expect(map({ ...baseRow, Balqty: 512 }).item?.onHand).toBe(512);
    });

    it('⭐ NULL (ไม่มี movement) → undefined ไม่ใช่ 0', () => {
      const r = map({ ...baseRow, on_hand: null });
      expect(r.ok).toBe(true);
      expect(r.item?.onHand).toBeUndefined();
    });

    it('⭐ ยอด 0 จริงจาก ledger ยังเป็น 0 (ไม่ถูกกลืนเป็น undefined)', () => {
      expect(map({ ...baseRow, on_hand: 0 }).item?.onHand).toBe(0);
    });

    it('ยอดติดลบ (ledger เพี้ยน/จ่ายเกิน) ไม่ถูกปัดทิ้งเงียบ ๆ', () => {
      expect(map({ ...baseRow, on_hand: -5 }).item?.onHand).toBe(-5);
    });

    it('ทศนิยมไม่ถูกปัด', () => {
      expect(map({ ...baseRow, on_hand: 12.5 }).item?.onHand).toBe(12.5);
    });
  });
});
