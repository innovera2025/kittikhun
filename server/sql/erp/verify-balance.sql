-- =============================================================================
-- ตรวจสุขภาพของสูตรยอดคงเหลือ ก่อนเชื่อตัวเลข — **อ่านอย่างเดียว**
--
-- รันด้วย sqlcmd/SSMS บน db_TCL หลังได้ login `db_datareader` แล้ว:
--   sqlcmd -S <host> -U <reader> -d db_TCL -v warehouse="WH01" -i verify-balance.sql
--
-- ทำไมต้องตรวจ: docs/erp-tcl-findings.md §5 บันทึกว่าสูตรคำนวณยอดจาก ledger
-- ที่ลองมาก่อนหน้า 7 แบบ ตรงกับความจริงดีที่สุดแค่ 52.1% — สูตรที่ฝ่าย ERP
-- ส่งมาเป็นสูตรที่ตัว ERP ใช้เอง แต่ **ยังไม่เคยเทียบกับหน้าจอ ERP จริง**
--
-- สิ่งที่ต้องดูจากผลลัพธ์:
--   rows_isclosed_null > 0  → ⚠️ เงื่อนไข `IsClosed <> 1` จะ **ตัดแถวเหล่านี้ทิ้ง**
--                              (พิสูจน์บน SQL Server 2019 จริงแล้ว: NULL <> 1 = UNKNOWN)
--                              ต้องถามฝ่าย ERP ว่าตั้งใจหรือไม่ ก่อนเชื่อยอด
--   rows_approved_null > 0  → เช่นเดียวกัน `Approved = 1` ตัดทิ้ง
--   items_with_movement     → เทียบกับจำนวนสินค้าทั้งหมด สินค้าที่เหลือจะได้ยอด NULL
--   min_balance < 0         → ยอดติดลบ = ledger ขาดยอดยกมา (ประเด็นเดิมใน findings §5)
-- =============================================================================

SELECT
  (SELECT COUNT(*) FROM dbo.InventoryFlowHdr WITH (NOLOCK)
    WHERE IsClosed IS NULL)                                   AS rows_isclosed_null,
  (SELECT COUNT(*) FROM dbo.InventoryFlowHdr WITH (NOLOCK)
    WHERE Approved IS NULL)                                   AS rows_approved_null,
  (SELECT COUNT(*) FROM dbo.InventoryItem WITH (NOLOCK)
    WHERE IsActive = 1 AND IsStock = 1)                       AS items_active,
  (SELECT COUNT(DISTINCT LTRIM(RTRIM(d.ItemCode)))
     FROM dbo.InventoryFlowHdr AS h WITH (NOLOCK)
     LEFT OUTER JOIN dbo.InventoryFlowDtl AS d WITH (NOLOCK)
       ON h.TranSactionno = d.Transactionno AND h.VoucherNo = d.VoucherNo
    WHERE h.Approved = 1 AND h.IsClosed <> 1
      AND d.Warehouse = '$(warehouse)')                       AS items_with_movement,
  (SELECT MIN(x.Balqty) FROM (
     SELECT SUM(d.InOut * d.MainQuantity) AS Balqty
       FROM dbo.InventoryFlowHdr AS h WITH (NOLOCK)
       LEFT OUTER JOIN dbo.InventoryFlowDtl AS d WITH (NOLOCK)
         ON h.TranSactionno = d.Transactionno AND h.VoucherNo = d.VoucherNo
      WHERE h.Approved = 1 AND h.IsClosed <> 1
        AND d.Warehouse = '$(warehouse)'
      GROUP BY LTRIM(RTRIM(d.ItemCode))
   ) AS x)                                                    AS min_balance
