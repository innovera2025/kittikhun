-- =============================================================================
-- item master + ยอดคงเหลือ — script ที่ ERP_SQL_ITEMS_SQL_FILE ชี้มา
--
-- 🚫 อ่านอย่างเดียวเท่านั้น — ไฟล์นี้วิ่งบน connection ของ ERP (db_TCL)
--    ต้องผ่าน assertReadOnlySql() ก่อนเสมอ · ห้ามมี GO · ห้ามมีคำสั่งเขียนใด ๆ
--
-- สูตรยอดคงเหลือมาจาก **ฝ่าย ERP** (22 ส.ค. 2569) — คือสูตรที่ตัว ERP ใช้เอง
-- ต้นฉบับเป็น query ต่อ 1 รหัสสินค้า (`ItemCode = ?cItemCode`) พร้อม placeholder
-- แบบ ODBC/VFP · ที่นี่แปลงเป็น T-SQL แบบ set-based (ทุกรหัสในครั้งเดียว)
-- โดย **ไม่แตะเงื่อนไขใด ๆ**:
--     h.Approved = 1
--     h.IsClosed <> 1
--     h.InOutDate <= @asOf
--     d.Warehouse = @warehouse
--     join ทั้ง TranSactionno และ VoucherNo
--     SUM(d.InOut * d.MainQuantity)
--
-- พารามิเตอร์ที่ driver ผูกให้ (ดู MssqlDriver.readItemRowsFromScript):
--   @warehouse  NVARCHAR  = WAREHOUSE_CODE ของ deployment นี้
--   @asOf       DATETIME2 = เวลาที่เริ่มรอบ sync (ตรงกับ ?cTodate ในต้นฉบับ)
--   @skus       NVARCHAR  = รายการรหัสสินค้าคั่นด้วย ',' สำหรับการยิงสดรายครั้ง
--                           NULL = ดึงทั้งคลัง (รอบ sync ตามเวลา)
--                           driver ผูกค่านี้ให้ **เสมอ** แม้เป็น NULL
--
-- ⚠️ ยังต้องตรวจกับหน้าจอ ERP จริงก่อนเชื่อ — ดู docs/erp-tcl-findings.md §5
-- =============================================================================

WITH ranked AS (
  -- ItemCode ซ้ำได้ (PK = Roworder, ItemCode) → Roworder สูงสุด (รายการใหม่สุด) ชนะ
  -- กติกาเดียวกับ itemsPageSql() ใน mssql.driver.ts — เปลี่ยนที่เดียวต้องเปลี่ยนทั้งคู่
  SELECT
    LTRIM(RTRIM(ItemCode))     AS ItemCode,
    LTRIM(RTRIM(ItemName))     AS ItemName,
    LTRIM(RTRIM(ItemNameEng))  AS ItemNameEng,
    LTRIM(RTRIM(MainUnits))    AS MainUnits,
    MinStock                   AS MinStock,
    LTRIM(RTRIM(BarCodeUnits)) AS BarCodeUnits,
    LTRIM(RTRIM(BarCodePack))  AS BarCodePack,
    LTRIM(RTRIM(Shelf))        AS Shelf,
    LTRIM(RTRIM(LotNumber))    AS LotNumber,
    Roworder                   AS Roworder,
    ROW_NUMBER() OVER (
      PARTITION BY LTRIM(RTRIM(ItemCode)) ORDER BY Roworder DESC
    ) AS rn
  FROM dbo.InventoryItem WITH (NOLOCK)
  WHERE IsActive = 1 AND IsStock = 1
    -- @skus IS NULL → ทั้งคลัง · มีค่า → เฉพาะรหัสที่ขอ (การยิงสดจากมือถือ)
    AND (@skus IS NULL
         OR LTRIM(RTRIM(ItemCode)) IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@skus, ',')))
),
bal AS (
  -- ยอดคงเหลือจาก ledger ตามสูตรของฝ่าย ERP
  -- LTRIM/RTRIM ที่ ItemCode เพราะ ERP pad ช่องว่าง — ต้อง join กับ ranked ได้
  SELECT
    LTRIM(RTRIM(d.ItemCode)) AS ItemCode,
    SUM(d.InOut * d.MainQuantity) AS Balqty
  FROM dbo.InventoryFlowHdr AS h WITH (NOLOCK)
  LEFT OUTER JOIN dbo.InventoryFlowDtl AS d WITH (NOLOCK)
    ON  h.TranSactionno = d.Transactionno
    AND h.VoucherNo     = d.VoucherNo
  WHERE d.ItemCode IS NOT NULL
    AND h.InOutDate <= @asOf
    AND h.Approved  = 1
    AND h.IsClosed <> 1
    AND d.Warehouse = @warehouse
    AND (@skus IS NULL
         OR LTRIM(RTRIM(d.ItemCode)) IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@skus, ',')))
  GROUP BY LTRIM(RTRIM(d.ItemCode))
)
SELECT
  r.ItemCode     AS ItemCode,
  r.ItemName     AS ItemName,
  r.ItemNameEng  AS ItemNameEng,
  r.MainUnits    AS MainUnits,
  r.MinStock     AS MinStock,
  r.BarCodeUnits AS BarCodeUnits,
  r.BarCodePack  AS BarCodePack,
  r.Shelf        AS Shelf,
  r.LotNumber    AS LotNumber,
  r.Roworder     AS Roworder,
  -- ⚠️ ไม่มีแถวใน ledger → NULL **ไม่ใช่ 0** โดยตั้งใจ
  --    'ไม่มีข้อมูลยอด' กับ 'ยอดเป็นศูนย์' ต้องแยกกันตลอดทั้งระบบ
  --    (ถ้าฝ่าย ERP ยืนยันว่าไม่มี movement = ศูนย์จริง ค่อยเปลี่ยนเป็น COALESCE(b.Balqty, 0))
  b.Balqty       AS on_hand,
  @warehouse     AS Warehouse
FROM ranked AS r
LEFT OUTER JOIN bal AS b ON b.ItemCode = r.ItemCode
WHERE r.rn = 1
ORDER BY r.ItemCode
