import {
  assertCountReadSql,
  assertCountWriteSql,
  ErpWriteSqlViolationError,
} from '../src/erp/erp-count-writer';
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

    it('⭐ เขียนลงตารางที่อนุญาตแต่ "อ่าน" ตารางอื่นของ ERP ต้องไม่ผ่าน', () => {
      // เคยหลุด: guard ตรวจแค่ว่ามีตารางที่อนุญาตอย่างน้อยหนึ่งตัว
      expect(
        reasonOf('INSERT INTO tbl_CountDtl(ItemCode) SELECT ItemCode FROM InventoryItem'),
      ).toBe('TABLE_NOT_ALLOWED');
      expect(
        reasonOf('UPDATE tbl_CountHdr SET Remark = (SELECT TOP 1 ItemName FROM dbo.InventoryItem)'),
      ).toBe('TABLE_NOT_ALLOWED');
      expect(reasonOf('INSERT INTO tbl_CountDtl(a) SELECT a FROM tbl_CountHdr')).toBe('ALLOWED');
    });
  });

  describe('⭐ statement guard ของการค้นเอกสารเดิม (ฝั่งอ่านของเส้นทางเขียน)', () => {
    const reasonOf = (sql: string): string => {
      try {
        assertCountReadSql(sql);
        return 'ALLOWED';
      } catch (err) {
        return err instanceof ErpWriteSqlViolationError ? err.reason : 'UNKNOWN';
      }
    };

    it('ยอมให้ SELECT จากตารางรอบนับเท่านั้น', () => {
      expect(
        reasonOf(
          `SELECT TOP (1) h.TransactionNo, h.VoucherNo,
             (SELECT COUNT(*) FROM tbl_CountDtl AS d WHERE d.TransactionNo = h.TransactionNo) AS n
             FROM tbl_CountHdr AS h WHERE h.Remark LIKE @pattern ORDER BY h.Roworder DESC`,
        ),
      ).toBe('ALLOWED');
    });

    it('⭐ ปฏิเสธการอ่านตารางอื่นของ ERP ผ่าน pool ของบัญชีเขียน', () => {
      expect(reasonOf('SELECT ItemCode FROM dbo.InventoryItem')).toBe('TABLE_NOT_ALLOWED');
      expect(reasonOf('SELECT * FROM tbl_CountHdr h JOIN InventoryItem i ON 1=1')).toBe(
        'TABLE_NOT_ALLOWED',
      );
    });

    it('⭐ ปฏิเสธคำสั่งเขียนทุกชนิดในเส้นทางนี้', () => {
      expect(reasonOf('INSERT INTO tbl_CountHdr(a) VALUES(1)')).toBe('NOT_SELECT');
      expect(reasonOf('SELECT 1 FROM tbl_CountHdr WHERE 1=(SELECT 1) UPDATE tbl_CountHdr SET a=1')).toBe(
        'FORBIDDEN_KEYWORD',
      );
      expect(reasonOf('SELECT 1 FROM tbl_CountHdr; DROP TABLE tbl_CountHdr')).toBe(
        'MULTIPLE_STATEMENTS',
      );
    });
  });

  describe('⭐ ช่องโหว่ที่รีวิวจับได้ — ต้องปิดถาวร', () => {
    const writeReason = (sql: string): string => {
      try {
        assertCountWriteSql(sql);
        return 'ALLOWED';
      } catch (err) {
        return err instanceof ErpWriteSqlViolationError ? err.reason : 'UNKNOWN';
      }
    };
    const readReason = (sql: string): string => {
      try {
        assertCountReadSql(sql);
        return 'ALLOWED';
      } catch (err) {
        return err instanceof ErpWriteSqlViolationError ? err.reason : 'UNKNOWN';
      }
    };

    it('⭐ ซ่อน `--` ไว้ใน string literal เพื่อให้ guard ตรวจคนละสตริงกับที่ SQL Server ได้รับ', () => {
      // guard เดิมตัดตั้งแต่ `--` ในข้อมูล ทำให้มองไม่เห็น `; DROP TABLE` ที่ตามมา
      expect(writeReason(`UPDATE tbl_CountHdr SET Remark = '--' ; DROP TABLE tbl_CountDtl`)).toBe(
        'MULTIPLE_STATEMENTS',
      );
      expect(
        readReason(`SELECT VoucherNo FROM tbl_CountHdr WHERE Remark = '--' ; DELETE FROM tbl_CountDtl`),
      ).toBe('MULTIPLE_STATEMENTS');
      expect(
        writeReason(`INSERT INTO RunningNumber(Name,Number) VALUES('--',1) ; EXEC xp_cmdshell 'dir'`),
      ).toBe('MULTIPLE_STATEMENTS');
      expect(
        writeReason(`UPDATE RunningNumber SET Number = 1 WHERE Name = '/*' AND 1=1 ; DROP TABLE x`),
      ).toBe('MULTIPLE_STATEMENTS');
    });

    it('คำในข้อมูลต้องไม่ไปชนกฎ (literal ถูกกลบก่อนตรวจ)', () => {
      expect(
        writeReason(`INSERT INTO tbl_CountDtl(RemarkDtl) VALUES('ยอดจาก InventoryItem ตอน update')`),
      ).toBe('ALLOWED');
    });

    it('⭐ SELECT … INTO และ OUTPUT … INTO สร้าง/เขียนตารางนอกขอบเขตได้', () => {
      expect(readReason('SELECT * INTO ErpBackdoor FROM tbl_CountHdr')).toBe('FORBIDDEN_KEYWORD');
      expect(readReason('SELECT * INTO dbo.ErpBackdoor FROM tbl_CountHdr')).toBe(
        'FORBIDDEN_KEYWORD',
      );
      expect(
        writeReason(
          'INSERT INTO tbl_CountHdr(TransactionNo) OUTPUT INSERTED.TransactionNo INTO AuditLeak VALUES(1)',
        ),
      ).toBe('FORBIDDEN_KEYWORD');
    });

    it('⭐ comma-join และ CROSS/OUTER APPLY อ่านตารางอื่นของ ERP ได้', () => {
      expect(readReason('SELECT * FROM tbl_CountHdr AS h, InventoryItem AS i WHERE 1=1')).toBe(
        'COMMA_JOIN',
      );
      expect(
        writeReason('INSERT INTO tbl_CountDtl(ItemCode) SELECT i.ItemCode FROM tbl_CountHdr h, InventoryItem i'),
      ).toBe('COMMA_JOIN');
      expect(readReason('SELECT h.VoucherNo FROM tbl_CountHdr AS h CROSS APPLY InventoryItem AS i')).toBe(
        'TABLE_NOT_ALLOWED',
      );
    });

    it('⭐ ชื่อตารางในวงเล็บเหลี่ยม / unicode / เครื่องหมายคำพูดคู่ ต้องถูกตรวจด้วย', () => {
      expect(readReason('SELECT * FROM tbl_CountHdr AS h JOIN [2Secret] AS s ON 1=1')).toBe(
        'TABLE_NOT_ALLOWED',
      );
      expect(readReason('SELECT * FROM tbl_CountHdr AS h JOIN Ínventory AS i ON 1=1')).toBe(
        'TABLE_NOT_ALLOWED',
      );
      expect(readReason('SELECT * FROM tbl_CountHdr AS h JOIN "InventoryItem" AS i ON 1=1')).toBe(
        'TABLE_NOT_ALLOWED',
      );
    });

    it('subquery ในวงเล็บยังใช้ได้ตามปกติ', () => {
      expect(
        readReason('SELECT * FROM (SELECT TransactionNo FROM tbl_CountHdr) AS x WHERE 1=1'),
      ).toBe('ALLOWED');
    });
  });

  describe('มาร์กเกอร์รอบนับใน Remark', () => {
    it('รูปแบบไม่มีอักขระพิเศษของ LIKE (ห้ามใช้วงเล็บเหลี่ยม)', () => {
      const marker = MssqlCountWriter.sessionMarker('CS-2608-0001');
      expect(marker).toBe('TCL#CS-2608-0001#');
      expect(marker).not.toMatch(/[[\]%_]/);
    });

    it('ต่อท้ายข้อความเดิม และไม่ประทับซ้ำ', () => {
      const once = MssqlCountWriter.stampSession('จากระบบ TCL Mobile', 'CS-1');
      expect(once).toBe('จากระบบ TCL Mobile TCL#CS-1#');
      expect(MssqlCountWriter.stampSession(once, 'CS-1')).toBe(once);
      expect(MssqlCountWriter.stampSession(null, 'CS-1')).toBe('TCL#CS-1#');
    });

    it("⭐ รหัสรอบที่มี '#' ต้องถูกปฏิเสธ — ไม่งั้นมาร์กเกอร์ของคนละรอบเป็น substring กัน", () => {
      // id `A#B` → `TCL#A#B#` ซึ่ง LIKE '%TCL#A#%' ของรอบ `A` จับได้
      expect(() => MssqlCountWriter.sessionMarker('A#B')).toThrow();
      expect(() => MssqlCountWriter.stampSession(null, 'A#B')).toThrow();
    });
  });
});
