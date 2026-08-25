import { assertCountWriteSql, ErpWriteSqlViolationError } from '../src/erp/erp-count-writer';
import { erpDifQty, MssqlCountWriter, round2 } from '../src/erp/drivers/mssql-count-writer';

/**
 * เส้นทางเขียนกลับ ERP — เทสต์ที่ไม่ต้องต่อ SQL Server จริง
 *
 * ครอบสิ่งที่ **พลาดแล้วข้อมูลใน ERP เสียโดยไม่มีใครรู้**:
 *   - ทิศทาง DifQty กลับด้าน → รายงานส่วนต่างของ ERP ตรงข้ามความจริงทั้งฉบับ
 *   - guard ปล่อยคำสั่งที่แตะตารางอื่นของ ERP หลุดไปได้
 *   - เลขเดือนของ VoucherNo ผิด → เอกสารไปอยู่ผิดชุด
 */
describe('เส้นทางเขียนกลับ ERP', () => {
  describe('⭐ ทิศทาง DifQty (ยืนยันจากข้อมูลจริงใน tbl_CountDtl)', () => {
    // ค่าจริงที่อ่านมาจาก db_TCL เมื่อ 25 ส.ค. 2569
    it.each([
      { mainQty: 204, countQty: 212, expected: -8 },
      { mainQty: 320, countQty: 327, expected: -7 },
      { mainQty: 24, countQty: 23, expected: 1 },
      { mainQty: 214, countQty: 265, expected: -51 },
      { mainQty: 13, countQty: 12, expected: 1 },
      { mainQty: 70, countQty: 70, expected: 0 },
    ])('MainQty=$mainQty CountQty=$countQty → DifQty=$expected', ({ mainQty, countQty, expected }) => {
      expect(erpDifQty(mainQty, countQty)).toBe(expected);
    });

    it('⭐ ของขาดเป็นบวก ของเกินเป็นลบ — ตรงข้ามกับ closed_variance.diff ของเรา', () => {
      // ระบบเราเก็บ diff = counted − system (เกิน = บวก) ERP กลับด้าน
      const systemQty = 100;
      const countedShort = 90;
      const countedOver = 110;

      expect(erpDifQty(systemQty, countedShort)).toBeGreaterThan(0); // ขาด → บวก
      expect(erpDifQty(systemQty, countedOver)).toBeLessThan(0); // เกิน → ลบ

      // ของเราจะเป็นทิศตรงข้ามเสมอ
      expect(countedShort - systemQty).toBeLessThan(0);
      expect(countedOver - systemQty).toBeGreaterThan(0);
    });
  });

  describe('ปัดทศนิยมให้พอดีกับ decimal(18,2) ของ ERP', () => {
    it('ระบบเราเก็บ numeric(18,3) — ตำแหน่งที่ 3 ต้องถูกปัด ไม่ใช่ถูกตัดเงียบ', () => {
      expect(round2(12.345)).toBe(12.35);
      expect(round2(12.344)).toBe(12.34);
      expect(round2(-8.005)).toBe(-8.01);
    });

    it('DifQty ปัดหลังลบ ไม่ใช่ปัดก่อน (กันคลาดสะสม)', () => {
      expect(erpDifQty(10.005, 0.004)).toBe(10);
    });
  });

  describe('เลขเดือนของ VoucherNo', () => {
    it.each([
      { date: new Date(2026, 7, 25), expected: '2608' },
      { date: new Date(2026, 0, 1), expected: '2601' },
      { date: new Date(2026, 11, 31), expected: '2612' },
      { date: new Date(2027, 8, 9), expected: '2709' },
    ])('$expected', ({ date, expected }) => {
      expect(MssqlCountWriter.monthKey(date)).toBe(expected);
    });
  });

  describe('⭐ statement guard ของฝั่งเขียน', () => {
    const reasonOf = (sql: string): string => {
      try {
        assertCountWriteSql(sql);
        return 'ALLOWED';
      } catch (err) {
        return err instanceof ErpWriteSqlViolationError ? err.reason : 'UNKNOWN';
      }
    };

    it('ยอมให้ INSERT ลง 3 ตารางที่อนุญาต', () => {
      expect(reasonOf('INSERT INTO tbl_CountHdr(TransactionNo) VALUES(@tx)')).toBe('ALLOWED');
      expect(reasonOf('INSERT INTO tbl_CountDtl(TransactionNo) VALUES(@tx)')).toBe('ALLOWED');
      expect(reasonOf('INSERT INTO RunningNumber(Name, Number) VALUES (@name, 1)')).toBe('ALLOWED');
    });

    it('ยอมให้ UPDATE RunningNumber พร้อม hint ล็อกแถว', () => {
      expect(
        reasonOf(
          'UPDATE RunningNumber WITH (UPDLOCK, HOLDLOCK) SET Number = ISNULL(Number,0)+1 OUTPUT INSERTED.Number AS next_number WHERE Name = @name',
        ),
      ).toBe('ALLOWED');
    });

    it('⭐ ปฏิเสธการแตะตารางอื่นของ ERP', () => {
      expect(reasonOf('INSERT INTO InventoryFlowHdr(x) VALUES(1)')).toBe('TABLE_NOT_ALLOWED');
      expect(reasonOf('UPDATE InventoryItem SET BalStock = 0')).toBe('TABLE_NOT_ALLOWED');
      expect(reasonOf('UPDATE dbo.InventoryFlowDtl SET MainQuantity = 0')).toBe('TABLE_NOT_ALLOWED');
    });

    it('⭐ ปฏิเสธ DELETE ทุกกรณี — เส้นทางนี้มีไว้เพิ่มเอกสาร ไม่ใช่ลบของ ERP', () => {
      expect(reasonOf('DELETE FROM tbl_CountDtl WHERE TransactionNo = 1')).toBe(
        'NOT_INSERT_OR_UPDATE',
      );
    });

    it('ปฏิเสธ DDL และ stored procedure', () => {
      expect(reasonOf('DROP TABLE tbl_CountDtl')).toBe('NOT_INSERT_OR_UPDATE');
      expect(reasonOf('INSERT INTO tbl_CountDtl(a) VALUES(1) DROP TABLE x')).toBe(
        'FORBIDDEN_KEYWORD',
      );
      expect(reasonOf('INSERT INTO tbl_CountHdr(a) EXEC sp_who')).toBe('FORBIDDEN_KEYWORD');
      expect(reasonOf('UPDATE RunningNumber SET Number = 1; TRUNCATE TABLE tbl_CountDtl')).toBe(
        'MULTIPLE_STATEMENTS',
      );
    });

    it('⭐ ซ่อนคำสั่งไว้ในคอมเมนต์แล้วปิดคอมเมนต์ ไม่ช่วยให้ผ่าน', () => {
      expect(reasonOf('/* ok */ DELETE FROM tbl_CountDtl')).toBe('NOT_INSERT_OR_UPDATE');
      expect(reasonOf('INSERT INTO tbl_CountDtl(a) VALUES(1) -- \n DROP TABLE x')).toBe(
        'FORBIDDEN_KEYWORD',
      );
    });

    it('ปฏิเสธคำสั่งว่างและคอมเมนต์ล้วน', () => {
      expect(reasonOf('   ')).toBe('EMPTY_STATEMENT');
      expect(reasonOf('-- แค่คอมเมนต์')).toBe('EMPTY_STATEMENT');
    });
  });
});
