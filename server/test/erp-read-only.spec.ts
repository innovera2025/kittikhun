import { assertReadOnlySql, ReadOnlySqlViolationError } from '../src/erp/erp-adapter';

/**
 * เทสต์กฎเหล็ก ชั้นที่ 3: statement guard
 *
 * ทุก SQL ที่จะวิ่งเข้า connection ของ ERP ต้องผ่านตัวนี้ก่อน
 * ถ้าเทสต์ชุดนี้ fail = ระบบมีช่องเขียนข้อมูลกลับ ERP ได้ = ห้าม deploy
 */
describe('assertReadOnlySql — กฎเหล็ก ERP อ่านอย่างเดียว', () => {
  const reject = (sql: string) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlySqlViolationError);
  };
  const accept = (sql: string) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  };

  describe('ยอมรับ: query อ่านที่ถูกต้อง', () => {
    it('SELECT ธรรมดา', () => {
      accept('SELECT ItemCode, ItemName FROM dbo.InventoryItem');
    });

    it('WITH (CTE) — ใช้ dedupe ItemCode ซ้ำ', () => {
      accept(`
        WITH ranked AS (
          SELECT ItemCode, Roworder,
                 ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(ItemCode)) ORDER BY Roworder DESC) AS rn
          FROM dbo.InventoryItem
        )
        SELECT * FROM ranked WHERE rn = 1`);
    });

    it('มี ; ปิดท้ายได้', () => {
      accept('SELECT 1;');
    });

    it('คอมเมนต์นำหน้าได้', () => {
      accept('-- ดึงรายการนับ\nSELECT MainQty FROM dbo.tbl_CountDtl');
    });

    it('คำต้องห้ามที่อยู่ใน string literal ไม่ถือว่าละเมิด', () => {
      accept("SELECT ItemName FROM dbo.InventoryItem WHERE ItemName = 'DELETE ของเสีย'");
    });

    it('ชื่อคอลัมน์ที่มีคำต้องห้ามใน [] ไม่ถือว่าละเมิด', () => {
      accept('SELECT [Update Date] FROM dbo.InventoryItem');
    });
  });

  describe('ปฏิเสธ: ทุกรูปแบบการเขียน', () => {
    it.each([
      ['INSERT', "INSERT INTO dbo.tbl_CountDtl (ItemCode) VALUES ('X')"],
      ['UPDATE', "UPDATE dbo.InventoryItem SET BalStock = 0"],
      ['DELETE', 'DELETE FROM dbo.tbl_CountHdr'],
      ['MERGE', 'MERGE dbo.InventoryItem AS t USING src ON 1=1'],
      ['TRUNCATE', 'TRUNCATE TABLE dbo.tbl_CountDtl'],
      ['DROP', 'DROP TABLE dbo.InventoryItem'],
      ['ALTER', 'ALTER TABLE dbo.InventoryItem ADD x int'],
      ['CREATE', 'CREATE TABLE dbo.tmp (x int)'],
      ['GRANT', 'GRANT INSERT ON dbo.InventoryItem TO stockcheck_ro'],
      ['EXEC', 'EXEC sp_CountStk'],
      ['sp_executesql', "EXEC sp_executesql N'DELETE FROM x'"],
      ['BACKUP', 'BACKUP DATABASE db_TCL TO DISK = :path'],
    ])('ปฏิเสธ %s', (_label, sql) => reject(sql));

    it('ปฏิเสธ statement ซ้อนที่แอบต่อท้าย SELECT', () => {
      reject("SELECT 1; DELETE FROM dbo.tbl_CountDtl");
    });

    it('ปฏิเสธคำสั่งที่ซ่อนด้วยคอมเมนต์บล็อก', () => {
      reject('/* อ่านเฉย ๆ */ DELETE FROM dbo.InventoryItem');
    });

    it('ปฏิเสธ string ที่ปิดไม่ครบ (กันหลอก parser)', () => {
      reject("SELECT * FROM x WHERE name = 'unterminated");
    });

    it('ปฏิเสธ statement ว่าง', () => {
      reject('   ');
      reject('-- คอมเมนต์เท่านั้น');
    });
  });

  describe('บอกสาเหตุการปฏิเสธได้ชัดเจน (ผู้ดูแลต้องแก้ .sql ได้ถูกจุด)', () => {
    it('ไม่ใช่ SELECT/WITH', () => {
      try {
        assertReadOnlySql('DELETE FROM dbo.InventoryItem');
        fail('ต้อง throw');
      } catch (e) {
        const err = e as ReadOnlySqlViolationError;
        expect(['NOT_SELECT_OR_WITH', 'FORBIDDEN_KEYWORD']).toContain(err.violation);
        expect(err.message).toContain('read-only');
      }
    });

    it('statement ซ้อน', () => {
      try {
        assertReadOnlySql('SELECT 1; SELECT 2');
        fail('ต้อง throw');
      } catch (e) {
        expect((e as ReadOnlySqlViolationError).violation).toBe('MULTIPLE_STATEMENTS');
      }
    });
  });
});
