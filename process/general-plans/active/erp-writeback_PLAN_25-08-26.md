# แผน: ส่งผลการนับกลับเข้า ERP (write-back) — ฉบับที่ 2

**สถานะ:** ร่างแผน — ยังไม่เริ่มทำ
**วันที่:** 25 สิงหาคม 2569
**แทนที่:** `erp-writeback_PLAN_24-08-26.md` (ฉบับแรก เขียนตอนยังไม่มีสเปกจากฝ่าย ERP)

---

## 0. สิ่งที่เปลี่ยนจากฉบับแรก

ฉบับแรกเดาไม่ออกว่า ERP ให้เขียนอย่างไร จึงแนะนำให้ **ส่งออกไฟล์** และเลี่ยงการเขียนตรง

ตอนนี้ฝ่าย ERP ให้คำสั่ง `INSERT` จริง พร้อมกลไกออกเลขเอกสารมาแล้ว สถานการณ์เปลี่ยนไปคนละเรื่อง

| ประเด็น | ฉบับแรก | ฉบับนี้ |
|---|---|---|
| วิธีที่แนะนำ | ส่งออกไฟล์ให้คนนำเข้า | **เขียนตรงตามสเปกที่ฝ่าย ERP ให้มา** |
| เหตุผล | ไม่รู้ตรรกะภายในของ ERP จึงเลียนแบบไม่ได้ | ฝ่าย ERP ให้ตรรกะมาครบ ไม่ต้องเดาแล้ว |
| ความเสี่ยงหลัก | เขียนผิดจนข้อมูล ERP เสีย | **การชนกันของเลขที่เอกสาร** (§4) |

---

## 1. ข้อค้นพบสำคัญที่ลดความเสี่ยงลงมาก

**การเขียนเอกสารนับสต็อกไม่กระทบยอดคงเหลือ**

ยอดคงเหลือใน ERP คำนวณจาก `InventoryFlowHdr` / `InventoryFlowDtl` ตามสูตรที่ฝ่าย ERP ให้ไว้ ส่วน `tbl_CountHdr` / `tbl_CountDtl` เป็นเอกสาร **บันทึกผลนับ** คนละเส้นทางกัน

แปลว่างานนี้คือ "บันทึกว่านับได้เท่าไร" ไม่ใช่ "ปรับสต็อก" — ถ้าเขียนพลาด ยอดขายและยอดผลิตไม่กระทบทันที มีเวลาแก้ การปรับยอดจริงยังเป็นขั้นตอนที่คนทำใน ERP เหมือนเดิม

**ยังต้องยืนยัน 1 ข้อ:** มี trigger บน `tbl_CountDtl` ที่ไปเขียน `InventoryFlow*` ต่อหรือไม่ ถ้ามี ข้อสรุปข้างบนใช้ไม่ได้ทันที (§7 ข้อ 1)

---

## 2. สัญญาการเขียนที่ได้รับจากฝ่าย ERP

### 2.1 หัวเอกสาร

```sql
INSERT INTO tbl_CountHdr(
  TransactionNo, VoucherNo, VoucherDate, Emp_ID, Emp_Name,
  CountDate, CountNo, CountYear, CountNumber, Remark, EntryBy, EntryDate)
VALUES(?xTransNum, ?cRun, ?cDate, ?cEmpCode, ?cEmpName,
  ?dCountDate, ?cCountNo, ?cCountYear, ?cCountNumber, ?cRemark, ?cUserName, GETDATE())
```

### 2.2 รายการ

```sql
INSERT INTO tbl_CountDtl(
  TransactionNo, Number, ItemCode, Description, Warehouse,
  MainQty, MainUnits, CountQty, DifQty, RemarkDtl)
VALUES(?xTransNum, ?xSLNo, ?xItemCode, ?xDescription, ?xWH,
  ?xMainQty, ?xMainUnits, ?xCountQty, ?xDifQty, ?xRemark)
```

### 2.3 การออกเลข

ตาราง `RunningNumber(Name, Number)` มี 2 แถวที่เกี่ยวข้อง

| Name | ใช้ทำอะไร |
|---|---|
| `CNTTr` | เลข `TransactionNo` ซึ่งเป็นคีย์เชื่อมหัวกับรายการ |
| `CNT` + YYMM เช่น `CNT2608` | ลำดับของเดือน ใช้ประกอบเป็น `VoucherNo` |

กติกา: `SELECT` เจอ → `UPDATE Number = Number + 1` · ไม่เจอ (เอกสารแรกของเดือน) → `INSERT`

```sql
UPDATE RunningNumber SET Number = ?cRunno WHERE Name = ?xRun
INSERT INTO RunningNumber(Name, Number) VALUES (?xRun, ?cRunno)
```

รูปแบบ `VoucherNo` จากหน้าจอจริง: **`CNT-2608-0004`** = `CNT` + `-` + YYMM + `-` + ลำดับ 4 หลัก

---

## 3. การแมปข้อมูลจากระบบเราไปยัง ERP

ตรวจแล้วว่าฝั่งเรามีครบทุกคอลัมน์ ไม่ต้องเพิ่มตารางใหม่

### 3.1 รายการ (`tbl_CountDtl`)

| คอลัมน์ ERP | มาจากระบบเรา | หมายเหตุ |
|---|---|---|
| `TransactionNo` | เลขจาก `RunningNumber.CNTTr` | เหมือนกันทุกแถวในเอกสารเดียว |
| `Number` | ลำดับ 1..N ในเอกสาร | เรียงตาม `sku` ให้ผลซ้ำได้ |
| `ItemCode` | `count_snapshot.sku` | ตรงกับ item master ของ ERP 100% |
| `Description` | `items_cache.name` | ชื่อไทย |
| `Warehouse` | `count_snapshot.warehouse_code` | เช่น `WHFG` |
| `MainQty` | `count_snapshot.frozen_on_hand` | **ยอดระบบที่ตรึงตอนเปิดรอบ** ไม่ใช่ยอดสด |
| `MainUnits` | `count_snapshot.unit` | |
| `CountQty` | ค่าที่นับได้จาก `v_variance` | ผ่านการตัดสินข้อขัดแย้งแล้ว |
| `DifQty` | `MainQty − CountQty` | ดู §3.2 |
| `RemarkDtl` | ว่าง หรือเหตุผลตอนตัดสินข้อขัดแย้ง | ต้องยืนยันความยาวสูงสุด |

### 3.2 ทิศทางของ `DifQty`

อ่านจากหน้าจอ ERP จริงที่ส่งมา ตรวจสอบ 3 แถวที่อ่านเลขได้ชัด

| ยอดคงเหลือ | ยอดนับ | ผลต่างที่ ERP แสดง | `MainQty − CountQty` |
|---|---|---|---|
| 916 | 606 | 310 | 310 ✅ |
| 401 | 212 | 189 | 189 ✅ |
| 246 | 286 | −40 | −40 ✅ |

→ **`DifQty = MainQty − CountQty`** (ของขาด = บวก · ของเกิน = ลบ)

ขอให้ฝ่าย ERP ยืนยันบรรทัดเดียวว่าถูกต้อง เพราะถ้ากลับด้าน รายงานส่วนต่างของ ERP จะตรงข้ามกับความจริงทั้งฉบับ

### 3.3 หัวเอกสาร (`tbl_CountHdr`)

| คอลัมน์ ERP | มาจากไหน | ความชัดเจน |
|---|---|---|
| `TransactionNo` | `RunningNumber.CNTTr` | ✅ |
| `VoucherNo` | `CNT-YYMM-NNNN` | ✅ |
| `VoucherDate` | วันที่ปิดรอบในระบบเรา | ✅ |
| `CountDate` | **วันที่นับจริง** | ✅ หน้าจอ ERP แยกช่องนี้จาก `VoucherDate` ชัดเจน (19/08 กับ 17/08) |
| `Emp_ID` / `Emp_Name` | ผู้ตรวจนับ | ⚠️ รอบเราอาจมีผู้นับหลายคน — ต้องตัดสินว่าใส่ใคร (§7 ข้อ 3) |
| `EntryBy` | ผู้บันทึก = admin ที่กดส่ง | ✅ |
| `EntryDate` | `GETDATE()` | ✅ |
| `CountNo` | จากหน้าจอคือ "ครั้งที่ 1 / 2026" → `1` | ⚠️ ต้องยืนยัน |
| `CountYear` | `2026` (ค.ศ.) | ⚠️ ต้องยืนยันว่าเป็น ค.ศ. ไม่ใช่ พ.ศ. |
| `CountNumber` | จากหน้าจอคือ "ครั้งที่ 4" | ⚠️ ไม่ชัดว่าต่างจาก `CountNo` อย่างไร |
| `Remark` | หมายเหตุของรอบ | ✅ |

**⚠️ ต้องรักษากฎ `null ≠ 0`** — สินค้าที่อยู่ในรอบแต่ **ไม่มีใครนับ** ต้องไม่ถูกส่งเป็น `CountQty = 0` เพราะ ERP จะเข้าใจว่านับแล้วได้ศูนย์ = ของหายทั้งที่ยังอยู่บนชั้น ต้องตัดแถวนั้นออกหรือมีวิธีที่ฝ่าย ERP กำหนด (§7 ข้อ 2)

---

## 3.4 แผนที่ข้อมูลสองทิศทาง (ตารางเทียบ)

สรุปว่า **อ่านอะไรจากตารางไหนของ ERP** และ **เขียนอะไรกลับไปที่ตารางไหน**

### ก. ขาไป — ERP → ระบบเรา (อ่านอย่างเดียว)

ผ่าน script `sql/erp/inventory-items-with-balance.sql`

| ตารางต้นทางใน ERP | คอลัมน์ที่ดึง | เข้ามาเป็นอะไรในระบบเรา | หมายเหตุ |
|---|---|---|---|
| `dbo.InventoryItem` | `ItemCode` | `items_cache.sku` | คีย์เชื่อมทุกอย่าง · ครบ 100% |
| `dbo.InventoryItem` | `ItemName` | `items_cache.name` | ชื่อไทย · ครบ 100% |
| `dbo.InventoryItem` | `ItemNameEng` | `items_cache.name_en` | ว่าง 100% ในข้อมูลจริง |
| `dbo.InventoryItem` | `MainUnits` | `items_cache.unit` | ครบ 100% |
| `dbo.InventoryItem` | `MinStock` | `items_cache.rop` | มี ~29% · ค่า 0 ถือว่าไม่ได้ตั้ง |
| `dbo.InventoryItem` | `Shelf` | `items_cache.loc` | ว่าง 100% |
| `dbo.InventoryItem` | `LotNumber` | (ไม่ใช้ต่อ) | ว่าง 100% |
| `dbo.InventoryItem` | `BarCodeUnits` · `BarCodePack` | `item_barcodes.barcode` | มีจริง ~2% |
| `dbo.InventoryItem` | `Roworder` | ใช้ตัดแถวซ้ำเท่านั้น | `ItemCode` ซ้ำได้ → เอา `Roworder` สูงสุด |
| `dbo.InventoryItem` | `IsActive` · `IsStock` | เงื่อนไขกรอง | เอาเฉพาะ `= 1` |
| `dbo.InventoryFlowHdr` | `InOutDate` · `Approved` · `IsClosed` | เงื่อนไขกรอง ledger | สูตรของฝ่าย ERP |
| `dbo.InventoryFlowHdr` | `TranSactionno` · `VoucherNo` | คีย์ join ไป `Dtl` | |
| `dbo.InventoryFlowDtl` | `ItemCode` · `Warehouse` | เงื่อนไขกรอง | กรองตาม `WAREHOUSE_CODE` |
| `dbo.InventoryFlowDtl` | `SUM(InOut × MainQuantity)` | `items_cache.on_hand` | **ยอดคงเหลือ** · ไม่มี movement = `NULL` ไม่ใช่ 0 |

**ไม่ได้ดึงอะไรอีกเลย** — ไม่เอาข้อมูลพนักงาน ราคา ผู้ขาย หรือรอบนับของ ERP
ตามขอบเขตที่เจ้าของโปรเจคยืนยันไว้เมื่อ 22 ส.ค. 2569

**เส้นทางที่ข้อมูลวิ่งต่อ**

```
ERP → items_cache → count_snapshot (ตรึงตอนเปิดรอบ) → มือถือ
                 └→ ยิงสดรายครั้งตอนค้นหา/สแกน (ไม่ผ่าน cache)
```

### ข. ขากลับ — ระบบเรา → ERP (เขียน)

| ปลายทางใน ERP | คอลัมน์ | มาจากตารางไหนของเรา | คอลัมน์ของเรา |
|---|---|---|---|
| `RunningNumber` | `Number` | — | อ่านแล้ว `+1` ในคำสั่งเดียว (`CNTTr` และ `CNT`+YYMM) |
| `tbl_CountHdr` | `TransactionNo` | — | เลขที่ออกจาก `RunningNumber.CNTTr` |
| `tbl_CountHdr` | `VoucherNo` | — | ประกอบเป็น `CNT-YYMM-NNNN` |
| `tbl_CountHdr` | `VoucherDate` | — | เวลาที่กดส่ง |
| `tbl_CountHdr` | `CountDate` | `count_sessions` | `closed_at` (วันที่ปิดรอบ) |
| `tbl_CountHdr` | `Emp_ID` | `count_sessions` | `closed_by` |
| `tbl_CountHdr` | `Emp_Name` | `users` | `name` ของ `closed_by` |
| `tbl_CountHdr` | `CountNo` · `CountYear` · `CountNumber` | — | คงที่ `'1'` · ปีที่นับ · `1` |
| `tbl_CountHdr` | `Remark` | `count_sessions` | รหัสรอบของเรา |
| `tbl_CountHdr` | `EntryBy` | `users` | `emp_id` ของ admin ที่กดส่ง |
| `tbl_CountHdr` | `EntryDate` | — | `GETDATE()` ของ ERP |
| `tbl_CountDtl` | `TransactionNo` | — | เลขเดียวกับหัวเอกสาร |
| `tbl_CountDtl` | `Number` | — | ลำดับ 1..N เรียงตาม `sku` |
| `tbl_CountDtl` | `ItemCode` | `closed_variance` | `sku` |
| `tbl_CountDtl` | `Description` | `items_cache` | `name` |
| `tbl_CountDtl` | `Warehouse` | `count_sessions` | `warehouse_code` |
| `tbl_CountDtl` | `MainQty` | `closed_variance` | `frozen_on_hand` (ยอดที่ตรึงตอนเปิดรอบ) |
| `tbl_CountDtl` | `MainUnits` | `closed_variance` | `unit` |
| `tbl_CountDtl` | `CountQty` | `closed_variance` | `final_counted_qty` |
| `tbl_CountDtl` | `DifQty` | คำนวณ | `MainQty − CountQty` |
| `tbl_CountDtl` | `RemarkDtl` | `closed_variance` | หมายเหตุเมื่อ `status = 'conflict'` |

**ไม่เขียนตารางอื่นเลย** — บังคับด้วย `assertCountWriteSql()` ที่ยอมเฉพาะ 3 ตารางนี้

### ค. จุดที่สองทิศทางไม่ตรงกัน — ต้องแปลงเสมอ

| เรื่อง | ฝั่งเรา | ฝั่ง ERP | ต้องทำอะไร |
|---|---|---|---|
| ทิศทางส่วนต่าง | `diff = counted − system` (เกิน = บวก) | `DifQty = MainQty − CountQty` (ขาด = บวก) | **กลับเครื่องหมาย** |
| ความละเอียดตัวเลข | `numeric(18,3)` | `decimal(18,2)` | **ปัดเป็น 2 ตำแหน่ง** |
| ยังไม่ได้นับ | `final_counted_qty = NULL` | `CountQty` เป็น NULL ไม่ได้ | **ตัดแถวออกไม่ส่ง** |
| ของนอกรายการ | `status = 'off_list'` (ไม่มี `frozen_on_hand`) | ไม่มีที่รองรับ | **ตัดแถวออกไม่ส่ง** |
| คลังสินค้า | ผูกกับรอบนับ | อยู่ที่ระดับรายการ | ประทับ `warehouse_code` ของรอบลงทุกแถว |
| กันเอกสารซ้ำ | `erp_writeback.session_id` เป็น PK | **ไม่มี unique เลย** | ด่านทั้งหมดอยู่ฝั่งเรา |

---

## 4. ⭐ ความเสี่ยงอันดับหนึ่ง — เลขที่เอกสารชนกัน

สเปกที่ได้รับเป็น `SELECT` แล้วค่อย `UPDATE` แยกคำสั่ง **ซึ่งไม่ปลอดภัยเมื่อมีผู้ใช้พร้อมกัน**

ถ้าโปรแกรม ERP กับระบบเราออกเลขพร้อมกัน ทั้งคู่จะอ่านได้เลขเดียวกัน แล้วสร้างเอกสารเลขซ้ำ หรือแย่กว่านั้นคือ `TransactionNo` ซ้ำ ทำให้ **รายการนับของสองเอกสารปนกัน** โดยไม่มีอะไรฟ้อง

### วิธีแก้ที่ต้องใช้

ทำทั้งหมดใน transaction เดียว และล็อกแถวตั้งแต่ตอนอ่าน

```sql
BEGIN TRANSACTION;

DECLARE @next int;

UPDATE RunningNumber WITH (UPDLOCK, HOLDLOCK)
   SET Number = Number + 1, @next = Number + 1
 WHERE Name = @name;

IF @@ROWCOUNT = 0
BEGIN
  SET @next = 1;
  INSERT INTO RunningNumber(Name, Number) VALUES (@name, @next);
END

-- ใช้ @next แล้ว INSERT หัวและรายการในธุรกรรมเดียวกัน
COMMIT;
```

จุดสำคัญ
- `UPDLOCK, HOLDLOCK` กันไม่ให้อีกฝั่งอ่านเลขเดียวกันได้
- ทั้งการออกเลข การเขียนหัว และการเขียนรายการต้องอยู่ใน transaction เดียว — ล้มกลางทางต้อง rollback ทั้งหมด **ห้ามมีเอกสารหัวลอยที่ไม่มีรายการ**
- ต้องขอ `UNIQUE` constraint บน `tbl_CountHdr.TransactionNo` และ `VoucherNo` จากฝ่าย ERP ถ้ายังไม่มี — เป็นด่านสุดท้ายที่กันข้อมูลซ้ำเมื่อโค้ดพลาด

### คำถามที่ยังไม่ทราบ

`RunningNumber.Number` เก็บ **เลขล่าสุดที่ใช้ไปแล้ว** หรือ **เลขถัดไปที่จะใช้**

ภาพที่ส่งมาแสดง `CNT2608 = 1` แต่หน้าจอเอกสารเป็น `CNT-2608-0004` ซึ่งไม่สอดคล้องกัน (น่าจะคนละฐานข้อมูล เพราะหน้าจอระบุผู้ใช้ `TEST`) ตอบผิดข้อนี้ = เลขเอกสารเพี้ยนทั้งระบบ ต้องยืนยันก่อนเขียนบรรทัดแรก

---

## 5. สถาปัตยกรรมฝั่งเรา

### 5.1 แยกเส้นทางเขียนออกจากเส้นทางอ่านโดยเด็ดขาด

| | เส้นทางอ่าน (เดิม) | เส้นทางเขียน (ใหม่) |
|---|---|---|
| interface | `ErpAdapter` | `ErpCountWriter` แยกไฟล์ |
| login | `tcl_reader` (`db_datareader`) | `tcl_writer` สิทธิ์เฉพาะ 3 ตาราง |
| connection pool | `readOnlyIntent: true` คงไว้ | pool ใหม่ |
| statement guard | `assertReadOnlySql()` คงไว้ทั้งหมด | guard ของตัวเอง — อนุญาตเฉพาะรูปแบบที่ whitelist |

**กฎเหล็กเดิมไม่ถูกยกเลิก แต่ถูกจำกัดขอบเขต** — ทุกเส้นทางอ่านยังพิสูจน์ได้ว่าเขียนไม่ได้เหมือนเดิม สิ่งที่เปลี่ยนคือมีประตูบานใหม่ที่แคบมาก เปิดไปที่ 3 ตารางเท่านั้น

### 5.2 สิ่งที่ต้องแก้ในโค้ดเดิม

| ไฟล์ | สิ่งที่ต้องทำ |
|---|---|
| `erp-adapter.ts` | `WriteishMethodName` ยังบังคับกับ `ErpAdapter` เหมือนเดิม · เพิ่ม interface ใหม่ที่ไม่อยู่ใต้ guard นี้ · แก้คอมเมนต์ที่เขียนว่าห้ามเสนอเรื่องนี้ใหม่ |
| `mssql.driver.ts` | boot probe ปัจจุบัน **ปฏิเสธการบูตถ้าเขียนได้** — ต้องเปลี่ยนเป็นตรวจแยกสองบัญชี: บัญชีอ่านต้องเขียนไม่ได้ · บัญชีเขียนต้องมีสิทธิ์เฉพาะที่กำหนด ไม่มากกว่านั้น |
| `env.config.ts` | เพิ่ม `ERP_SQL_WRITE_USER` / `ERP_SQL_WRITE_PASSWORD` · ปฏิเสธถ้าซ้ำกับบัญชีอ่าน |
| `count.service.ts` | หลังปิดรอบ เข้าคิวส่งกลับ ERP |
| `db/schema.sql` | ตาราง `erp_writeback` เก็บสถานะการส่งต่อรอบ |

### 5.3 ตารางใหม่ฝั่งเรา

```
erp_writeback(
  session_id      -- รอบนับของเรา (PK)
  status          -- queued | sent | failed
  transaction_no  -- TransactionNo ที่ ERP ออกให้
  voucher_no      -- CNT-YYMM-NNNN
  row_count
  attempts
  last_error
  sent_at
)
```

`session_id` เป็น primary key คือกลไกกันส่งซ้ำที่แข็งแรงที่สุด — หนึ่งรอบนับส่งได้ครั้งเดียวตลอดกาล

### 5.4 เมื่อไรที่ส่ง

หลัง admin **ปิดรอบ** และ **ตัดสินข้อขัดแย้งครบแล้ว** เท่านั้น

ไม่ส่งระหว่างนับ เพราะผลยังเปลี่ยนได้ และ ERP ไม่มีกลไกแก้เอกสารที่เราทราบ

---

## 6. เฟสการทำงาน

### เฟส 0 — ปิดคำถามที่ค้าง (ไม่แตะโค้ด)

รันคำสั่ง `SELECT` ตรวจโครงสร้างจริง (คำสั่งอยู่ท้ายเอกสาร) และคุยกับฝ่าย ERP ให้ได้คำตอบใน §7

**ต้องได้ฐานข้อมูลสำเนาสำหรับทดสอบ — ห้ามพัฒนางานเขียนบนฐานจริง**

### เฟส 1 — เขียนได้บนฐานทดสอบ

1. เพิ่มตาราง `erp_writeback` และคอนฟิกบัญชีเขียน
2. `ErpCountWriter` พร้อมการออกเลขแบบล็อกตาม §4
3. แมปข้อมูลตาม §3 พร้อมเทสต์กฎ `null ≠ 0`
4. endpoint `POST /count/:id/writeback` — admin เท่านั้น รอบที่ปิดแล้วเท่านั้น

**เกณฑ์ผ่าน:** เอกสารที่เขียนขึ้นเปิดดูในหน้าจอ ERP ได้ ยอดตรงทุกแถว และรัน 2 เครื่องพร้อมกันแล้วเลขไม่ชน

### เฟส 2 — ให้เห็นและกู้คืนได้

1. จอ admin แสดงสถานะการส่งของแต่ละรอบ พร้อมเลขเอกสารที่ ERP ออกให้
2. ส่งไม่สำเร็จต้องเข้าคิวและลองใหม่ได้ ไม่หายเงียบ
3. ปุ่มส่งซ้ำสำหรับรอบที่ล้มเหลว โดยกันการเขียนซ้ำ

### เฟส 3 — เปิดใช้จริงแบบมีคนเฝ้า

1. รอบแรก คลัง WHFG อย่างเดียว โดยมีคนฝั่ง ERP เปิดหน้าจอดูพร้อมกัน
2. เทียบทุกแถวกับรายงานของเรา
3. 30 วันแรกเก็บสำเนา `tbl_CountHdr` / `tbl_CountDtl` ก่อนเขียนทุกครั้ง

---

## 7. คำถามที่ต้องได้คำตอบก่อนเริ่มเฟส 1

| # | คำถาม | ถ้าตอบผิดจะเกิดอะไร |
|---|---|---|
| 1 | มี trigger บน `tbl_CountHdr` / `tbl_CountDtl` ที่ไปเขียนตารางอื่นไหม | ถ้ามีและไปแตะ `InventoryFlow*` การเขียนจะกระทบยอดสต็อกจริงทันที เปลี่ยนระดับความเสี่ยงทั้งแผน |
| 2 | สินค้าที่อยู่ในรอบแต่ไม่มีใครนับ ต้องส่งหรือไม่ส่ง | ส่งเป็น 0 = ERP เข้าใจว่าของหมด ทั้งที่แค่ยังไม่ได้นับ |
| 3 | `Emp_ID` ใส่ใครเมื่อรอบหนึ่งมีผู้นับหลายคน | ประวัติผู้รับผิดชอบผิดคน |
| 4 | `RunningNumber.Number` = เลขล่าสุดที่ใช้ไปแล้ว หรือเลขถัดไป | เลขเอกสารเพี้ยนหรือชนกับของที่ ERP ออกเอง |
| 5 | `CountNo` `CountYear` `CountNumber` แต่ละตัวหมายถึงอะไร และปีเป็น ค.ศ. หรือ พ.ศ. | เอกสารไปอยู่ผิดปีหรือผิดรอบ |
| 6 | `DifQty = MainQty − CountQty` ถูกต้องไหม | รายงานส่วนต่างของ ERP กลับด้านทั้งฉบับ |
| 7 | มี `UNIQUE` บน `TransactionNo` / `VoucherNo` แล้วหรือยัง | ไม่มีด่านสุดท้ายกันเอกสารซ้ำ |
| 8 | เอกสารที่เราเขียนต้องมีสถานะรออนุมัติไหม ใครกดอนุมัติ | เอกสารมีผลทันทีโดยไม่มีใครตรวจ |
| 9 | ถ้าส่งผิดแล้ว ลบหรือยกเลิกเอกสารอย่างไร | ไม่มีทางย้อนกลับ |

---

## 8. คำสั่งตรวจโครงสร้างจริง (อ่านอย่างเดียว รันได้ทันที)

รันบน VPS ผลลัพธ์จะปิดคำถามข้อ 1 · 4 · 7 ได้ทันที

```bash
cd /opt/tcl/server
PW=$(grep -m1 '^ERP_SQL_PASSWORD=' .env | sed -E 's/^[^=]+=//')
docker run --rm mcr.microsoft.com/mssql-tools:latest /opt/mssql-tools/bin/sqlcmd \
  -S 43.229.134.162,1433 -U tcl_reader -P "$PW" -d db_TCL -C -b -W -s'|' -Q "
SELECT '--COLUMNS--' AS section;
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME IN ('tbl_CountHdr','tbl_CountDtl','RunningNumber')
 ORDER BY TABLE_NAME, ORDINAL_POSITION;
SELECT '--TRIGGERS--' AS section;
SELECT t.name AS trigger_name, OBJECT_NAME(t.parent_id) AS on_table, t.is_disabled
  FROM sys.triggers t
 WHERE OBJECT_NAME(t.parent_id) IN ('tbl_CountHdr','tbl_CountDtl','RunningNumber');
SELECT '--INDEXES--' AS section;
SELECT OBJECT_NAME(i.object_id) AS tbl, i.name, i.is_unique, i.is_primary_key
  FROM sys.indexes i
 WHERE OBJECT_NAME(i.object_id) IN ('tbl_CountHdr','tbl_CountDtl','RunningNumber')
   AND i.type > 0;
SELECT '--RUNNINGNUMBER--' AS section;
SELECT Name, Number FROM RunningNumber WHERE Name LIKE 'CNT%';
SELECT '--LATEST_DOCS--' AS section;
SELECT TOP 5 TransactionNo, VoucherNo, VoucherDate, CountDate, CountNo, CountYear, CountNumber, EntryBy
  FROM tbl_CountHdr ORDER BY TransactionNo DESC;
"
```

---

## 9. สรุปสำหรับตัดสินใจ

**เปลี่ยนจากฉบับแรก:** เขียนตรงเป็นทางที่แนะนำแล้ว เพราะฝ่าย ERP ให้สัญญามาครบ

**ความเสี่ยงหลักเหลือข้อเดียว:** การออกเลขเอกสารชนกัน แก้ได้ด้วย `UPDLOCK, HOLDLOCK` ใน transaction เดียว (§4)

**ยังไม่ควรเริ่มเฟส 1 จนกว่าจะได้:** คำตอบข้อ 1 (trigger) · ข้อ 2 (`null ≠ 0`) · ข้อ 4 (ความหมายของ `Number`) และฐานข้อมูลสำเนาสำหรับทดสอบ

**ยังไม่มีการแก้โค้ดใด ๆ จากแผนนี้**
