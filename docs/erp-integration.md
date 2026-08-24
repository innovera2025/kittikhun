# สัญญา ERP Integration — Adapter Layer

> ERP เป็นระบบภายในองค์กร (on-premise) — **Microsoft SQL Server 2019, database `db_TCL`** — การเชื่อมต่อทั้งหมดคอนฟิกผ่าน `.env` เท่านั้น (ผู้ดูแลกรอกเอง ไม่ต้องแก้โค้ด)
> ผลสำรวจ DB จริง: [`erp-tcl-findings.md`](erp-tcl-findings.md) · เทมเพลตคอนฟิก: `.env.example` (ทุก key ตรงกับ zod schema ที่ตรวจตอน boot แบบ 1:1)

---

## 🚫 กฎเหล็ก: ห้ามเขียนข้อมูลกลับ ERP โดยเด็ดขาด

**คำสั่งเจ้าของโปรเจค (ย้ำ 17 ส.ค. 2569): ไม่มีการเขียนกลับ ERP ทุกกรณี ไม่มีข้อยกเว้น ไม่ใช่การเลื่อนไปเฟสหลัง**

ระบบอ่านยอดจาก ERP มาเทียบ → พนักงานกรอกค่าที่นับได้ → ระบบแสดงส่วนต่าง → **ผลทั้งหมดเก็บในฐานข้อมูลของระบบเราเอง**

บังคับ **5 ชั้น** (ชั้นใดชั้นหนึ่งพลาด ชั้นอื่นยังกัน):

| ชั้น | กลไก | ป้องกันอะไร |
|---|---|---|
| **1. สิทธิ์ระดับ DB** | login ต้องเป็น `db_datareader` เท่านั้น (ห้ามใช้ `sa`) — SQL Server ปฏิเสธการเขียนที่ระดับ engine | โค้ดพลาด, คนพลาด, การโจมตี |
| **2. Boot probe** | ตอน start ยิง `INSERT` ทดสอบ — **ถ้าสำเร็จ = ปฏิเสธการ start ทันที** พร้อมข้อความบอกว่า login มีสิทธิ์เขียน | คอนฟิกผิดโดยไม่รู้ตัว (เช่นเผลอใส่ `sa`) |
| **3. Statement guard ใน driver** | ทุก SQL ที่จะส่งเข้า connection ของ ERP ผ่านตัวกรอง: ต้องเริ่มด้วย `SELECT` หรือ `WITH` เท่านั้น และปฏิเสธถ้าพบ `INSERT / UPDATE / DELETE / MERGE / TRUNCATE / DROP / ALTER / CREATE / GRANT / EXEC / sp_executesql` (รวม statement ที่ต่อด้วย `;`) → throw ก่อนส่งออก | script ที่ส่งมามีคำสั่งเขียนปนมา, SQL injection |
| **4. ไม่มี method เขียนใน interface** | `ErpAdapter` ไม่มี `pushAdjustment` หรือ method เขียนใด ๆ — เขียนไม่ได้แม้อยากเขียน | โค้ดในอนาคตเผลอเพิ่มฟีเจอร์ |
| **5. Connection option** | ตั้ง connection เป็น read-intent + `ApplicationIntent=ReadOnly` (ถ้ามี replica) และไม่เปิด transaction เขียนเลย | ปิดช่องที่เหลือ |

**เพิ่มเติม:** ห้ามเรียก stored procedure ของ ERP (`sp_CountStk`, `sp_BalanceSHELF` ฯลฯ) เว้นแต่ตรวจซอร์สแล้วยืนยันว่าอ่านล้วน — sp หลายตัวเขียน temp table หรืออัปเดตตารางจริง

**การทดสอบ/ดีบักก็อยู่ใต้กฎนี้:** ทุกครั้งที่ต่อ ERP เพื่อสำรวจ ใช้ได้แค่ `SELECT` และ `INFORMATION_SCHEMA` (การทดสอบเมื่อ 17 ส.ค. 2569 ทำตามกฎนี้แล้ว — ไม่มีการเขียนใด ๆ)

---

## 1. หลักการ

1. **Backend เท่านั้นที่คุยกับ ERP** — มือถือไม่เคยต่อ ERP ตรง ๆ; ทุกคำขอวิ่งผ่าน backend
   - **ข้อมูลสินค้า (ชื่อ/หน่วย/บาร์โค้ด/ตำแหน่ง)** มาจาก `items_cache` ตามรอบ sync
   - **ยอดคงเหลือบนหน้าค้นหาและหน้าสแกน** ยิงสดไป ERP ทุกครั้ง (`fetchItemsBySku`) — การตัดสินใจของเจ้าของโปรเจค 24 ส.ค. 2569
   - **delta feed (`GET /items`)** ยังเป็นสำเนาตามรอบเสมอ เพราะเป็นชุดข้อมูลที่มือถือเก็บไว้ใช้ตอน offline
2. **ERP ล่ม ≠ ระบบหยุด** — scheduler ล้มเหลว = log + ใช้ cache เดิมต่อ; การนับไม่สะดุด
   การยิงสดที่ล้มเหลวหรือช้าเกิน 4 วินาที ก็ตกกลับไปใช้ยอดจากรอบ sync ล่าสุดเช่นกัน
   แล้วบอกผู้ใช้ผ่าน `onHandSource` / `onHandAsOf` (มือถือแสดง "สด" กับ "ณ HH:mm") — **ห้ามเงียบ**
3. **อ่านอย่างเดียวโดยสมบูรณ์** — ระบบอ่าน item/stock ตามรอบเท่านั้น **ไม่มีการเขียนอะไรกลับ ERP เลย** (การตัดสินใจของเจ้าของโปรเจค 17 ส.ค. 2569): ค่าที่นับได้และส่วนต่างเก็บอยู่ในระบบนี้ ดู §6
4. **Fail fast เรื่องคอนฟิก, fail soft เรื่องเน็ตเวิร์ก** — `.env` ผิดโครงสร้าง → ไม่ start พร้อมบอกชื่อตัวแปรที่ขาด; ERP ต่อไม่ได้ → start ตามปกติ สถานะ degraded ใน `sync_runs`

---

## 2. Canonical interface

```typescript
// Adapter เป็น READ-ONLY โดยสัญญา — ไม่มี method เขียนกลับ ERP (ดู §6)
interface ErpAdapter {
  capabilities(): { delta: boolean }

  // อ่าน item master — stream เป็น batch (ห้ามโหลดทั้งก้อนเข้า memory)
  fetchItems(since?: Cursor): AsyncIterable<CanonicalItem[]>

  // อ่าน on-hand/reserved เฉพาะคลังที่กำหนด (warehouse scope บังคับ — ดู §5)
  fetchStockSnapshot(warehouseCode: string): AsyncIterable<StockLine[]>

  healthCheck(): Promise<ErpHealth>
}

// CanonicalItem: sku, barcodes[], name, nameEn, loc, onHand, reserved, rop,
//                unit, vendor, lot, lastCountDate, updatedAt, warehouseCode
```

**กติกาที่ตายตัว:**
- `delta` เป็น capability ต่อ driver — ERP ที่ไม่มี updated-at ที่เชื่อถือได้ใช้ **full snapshot + diff ฝั่ง server** (default); เมื่อรองรับ delta ให้ดึงแบบมี overlap window (`since = cursor − ERP_SYNC_OVERLAP_S`) กันแถวตกขอบ
- ทุก response ผ่าน **zod validation** ก่อนเข้า domain + ตรวจ row-count anomaly ระหว่างรอบ (ตัวจับ schema drift เงียบ ๆ ที่ถูกที่สุด)

---

## 3. Drivers (เลือกด้วย `ERP_DRIVER` — ค่า: `rest` | `sql` | `mock`)

### 3.1 `rest` — Generic REST driver

สำหรับ ERP ที่มี HTTP API: ทุกอย่าง config ได้หมด — base URL, โหมด auth (`header`/`basic`/`none`), path ของ items/stock, รูปแบบ pagination (`page`/`offset`/`cursor`/`none`) พร้อม**ชื่อ param และ path ของ envelope** (array อยู่ที่ root/`data`/`items` — ระบุใน `ERP_REST_DATA_PATH`), ชื่อ+ฟอร์แมตของ `since` param (ISO / epoch / **วันที่ พ.ศ.** — ERP ไทยบางเจ้าใช้จริง), warehouse param
**Field map** (`ERP_REST_FIELD_MAP` → ไฟล์ JSON ใน `/config`): แปลงชื่อฟิลด์ vendor → canonical โดยแต่ละ entry เป็น `{path, type, format, dateEra (ce|be), uomFactor}` — ไม่ใช่แค่ชื่อ เพราะปัญหาจริงคือ **ความหมาย** (reserved = allocated? committed? / stock มาเป็นลิตรแต่แสดงเป็นถัง / วันที่ พ.ศ. ปนมา)

### 3.2 `sql` — Direct-DB read-only driver ✅ **เส้นทางที่ยืนยันแล้ว (17 ส.ค. 2569)**

> **ยืนยันจากเจ้าของโปรเจค:** ERP DB เป็น **Microsoft SQL Server** (`ERP_SQL_DIALECT=mssql`, client lib: `mssql`/tedious, พอร์ตปกติ 1433) และเจ้าของโปรเจคจะ**ส่งมอบ script ดึงข้อมูล Inventory** มาให้ — script นั้นจะกลายเป็น "สัญญา" ของ driver แทนการให้ vendor สร้าง view

- **แหล่ง query เลือกได้ 2 ทาง** (อย่างใดอย่างหนึ่งต่อชนิดข้อมูล):
  1. `ERP_SQL_ITEMS_VIEW` / `ERP_SQL_STOCK_VIEW` — ชื่อ view/ตารางที่พร้อม SELECT ได้ตรง ๆ
  2. `ERP_SQL_ITEMS_SQL_FILE` / `ERP_SQL_STOCK_SQL_FILE` — **ไฟล์ .sql จาก script ของเจ้าของโปรเจค** (bind-mount ใน `/config`) — driver รัน query นี้ตามรอบแล้ว map คอลัมน์ผลลัพธ์เข้า canonical fields
- คอลัมน์ที่ระบบต้องการจากผลลัพธ์: `sku, barcode, name, name_en, loc, on_hand, reserved, rop, unit, vendor, lot, last_count_date, updated_at, warehouse_code` — คอลัมน์ไหนไม่มีใน script จริง จะตัดสินการแสดงผลร่วมกัน (เช่น ไม่มี `reserved` → ซ่อน tile "พร้อมขาย")
- DB login ต้องมีสิทธิ์ SELECT เท่านั้น (`db_datareader` หรือ GRANT SELECT เฉพาะ object) **และ driver พิสูจน์เองตอน boot: ยิง INSERT ทดสอบ — ถ้าสำเร็จ = refuse to start** (read-only ต้องถูกพิสูจน์เชิงโครงสร้าง ไม่ใช่เชื่อ `.env`)
- **ภาษาไทยบน SQL Server:** คอลัมน์ `NVARCHAR` = Unicode ปลอดภัย; ถ้าเป็น `VARCHAR` + Thai collation (TIS-620/Windows-874) ให้ตั้ง `ERP_SQL_CHARSET=win874` — driver decode ให้ + smoke test ตอน boot/sync: ดึงแถวไทยที่รู้ค่า 1 แถว ถ้า decode แล้วมี U+FFFD หรือหลุด Thai block → fail รอบนั้นพร้อม log
- **TLS ต่อ SQL Server:** `ERP_SQL_ENCRYPT=true|false` + `ERP_SQL_TRUST_SERVER_CERT=true` สำหรับ SQL Server เก่าที่ใช้ self-signed cert ใน LAN
- `ERP_SQL_POOL_MAX` + timeout ต่อ query — scheduler ห้ามดูด connection ของ DB production ERP จนอิ่ม

dialect อื่น (`pg` / `mysql` / `oracle`) ยังรองรับใน design ของ driver แต่ไม่ใช่เส้นทางของโปรเจคนี้

### 3.3 `mock` — Fixture driver

ข้อมูลตัวอย่าง canonical จาก design (สินค้า 5 + สมาชิก 4 — ดู design-fidelity.md §4) สำหรับ: พัฒนา UI แบบ pixel-perfect ก่อนมี ERP จริง, demo, CI, golden tests — ปุ่มจำลองสแกน 1/2/3 ของ demo แสดงเฉพาะโหมดนี้

---

## 4. Boot sequence (คอนฟิกโดยคนไม่ใช่ dev — diagnostics คือฟีเจอร์)

1. **zod-parse `.env` เฉพาะ subset ของ driver ที่เลือก** → ขาด/ผิด → ไม่ start + ข้อความบอก**ชื่อตัวแปร**ที่ผิดตรง ๆ
2. `sql` driver: write-probe (INSERT ต้อง fail) + charset smoke test
3. Connectivity self-test (ดึง item 1 แถว) — **ไม่ block การ start**: ผลลง `sync_runs`, ERP ล่ม = สถานะ degraded, API เปิดให้มือถือ sync ได้ตามปกติจาก cache
4. `/healthz` = liveness ของ API เท่านั้น; สถานะ ERP อยู่ที่ `/healthz/erp` — **Docker healthcheck ห้ามผูกกับ ERP**

---

## 5. กติกาความถูกต้องของข้อมูล

| เรื่อง | กติกา |
|---|---|
| **Warehouse scope** | ทุก driver ต้อง filter คลังชัดเจน (`ERP_REST_WAREHOUSE_PARAM` / คอลัมน์ `warehouse_code` ใน view) + assertion ตอน sync: sample แถวต้องมีรหัสคลังที่คาด — กันเคสร้ายแรงสุด "เลขทั้งบริษัทที่ดูเหมือนเลขคลังเรา" |
| **Cursor** | cursor ของ device feed คือ `row_version` (bigserial ภายใน bump ทุก upsert/soft-delete) — **ห้าม** ใช้เวลา ERP (ties/backfill/clock skew ตกแถว) |
| **Tombstone** | soft-delete SKU ที่หายไป **เฉพาะ**จากรอบ full-reconcile ที่ยืนยันว่าดึงครบ (row count ตรง/ทุกหน้า confirmed) — ห้าม tombstone จาก delta; guardrail: ลบเกิน 5% ของ catalog ในรอบเดียว → abort + alert; cursor ไม่ขยับเมื่อรอบไม่สมบูรณ์ |
| **Barcode** | 1 SKU : N barcodes (`item_barcodes`), barcode ว่างได้; ชนกัน → นโยบาย deterministic (erp_updated_at ใหม่ชนะ) + เข้า anomalies ให้ผู้ดูแลตรวจ — ห้าม fail ทั้งรอบ |
| **Freshness** | `stock_as_of` = เวลาดึง ERP สำเร็จครั้งล่าสุด (ต่อรอบ ใน `sync_runs`) — ป้าย "ข้อมูล ณ HH:MM" และ "อัปเดต …" อ่านจากค่านี้; `erp_updated_at` ใช้ทำ delta เท่านั้น |
| **รอบ sync** | ที่ทำจริงตอนนี้: item master + ยอด ตาม `ERP_SYNC_CRON` (ค่าใช้งานจริง = ทุก 30 นาที) และ `POST /sync/items` ให้ admin สั่งเอง · ยอดบนหน้าค้นหา/สแกนไม่รอรอบ เพราะยิงสด · **ยังไม่ได้ทำ:** รอบ stock แยก (`ERP_SYNC_STOCK_CRON`) และ sync อัตโนมัติตอนเปิดรอบนับ · ทุก run กัน overlap ด้วย pg advisory lock + deadline |
| **เปิดรอบนับตอน ERP ล่ม** | ทำได้เฉพาะ admin ยืนยันโดยเห็นอายุ cache ("ข้อมูลสต็อกอายุ 3 ชม.") — `count_snapshot` ประทับ `erp_data_as_of` และแสดงในหน้านับ + ในรายงาน variance |
| **นับครั้งล่าสุด** | เมื่อระบบเรารันเองแล้วมี 2 แหล่ง (ERP `lastCountDate` vs `count_submissions` ของเรา) — **กติกา: ค่าที่ใหม่กว่าชนะ** และแสดงเป็น พ.ศ. ฟอร์แมตเดียวกับ design |
| **Go-live gate ต่อ ERP** | รายงาน reconcile บังคับ: เทียบ 20 รายการที่ map แล้วกับหน้าจอ ERP/ของจริงบนชั้น (ตรวจความหมาย reserved, UoM, วันที่) ก่อนเชื่อ driver |

---

## 6. ไม่มีการเขียนกลับ ERP — ปิดถาวร

ดู **กฎเหล็ก 5 ชั้น** ด้านบนสุดของเอกสารนี้ สรุปเส้นทางข้อมูล:

```
ERP (SELECT เท่านั้น) ──► items_cache ──► มือถือ ──► พนักงานกรอกค่าที่นับได้
                                                          │
                                       ส่วนต่าง (เกิน/ขาด/ตรง) ◄┘
                                                          │
                              ระบบเราเก็บผล: count_submissions → closed_variance
                                                          │
                                     รายงาน / export CSV อ้างอิงภายใน   ✗ ไม่กลับไป ERP
```

- ผลส่วนต่างดูได้ที่ `GET /count-sessions/:id/variance` (+ `?format=csv` สำหรับ export ไว้อ้างอิงภายใน — **ไม่ใช่**ไฟล์สำหรับคีย์เข้า ERP)
- ไม่มี `pushAdjustment`, ไม่มี `erp_post_outbox`, ไม่มี CSV สำหรับ import กลับ ERP
- **ห้ามเสนอฟีเจอร์นี้ใหม่** — ตัดออกจาก scope ถาวรตามคำสั่งเจ้าของโปรเจค

---

## 7. โหมดล้มเหลว → พฤติกรรม (สรุปตาราง)

| เหตุการณ์ | พฤติกรรมระบบ |
|---|---|
| ERP ล่มตอน boot | start ปกติ, degraded ใน `sync_runs`, มือถือใช้ cache |
| ERP ล่มระหว่างวัน | รอบ sync fail + log; ข้อมูลบนมือถือค้างที่ `stock_as_of` เดิม (ป้ายบอกตามจริง) |
| ERP ช้า | timeout ต่อ request/query (`ERP_TIMEOUT_MS`) + advisory lock กันรอบซ้อน + pool cap |
| ดึงได้บางส่วน | cursor ไม่ขยับ, ห้าม tombstone, รอบถูก mark ไม่สมบูรณ์ |
| ERP ตอบ item ผิด schema | zod reject + anomaly log — ข้อมูลเสียไม่ไหลถึงชั้นวาง |

(ไม่มีโหมดล้มเหลวฝั่งเขียน — ระบบไม่เขียนอะไรกลับ ERP เลย ดู §6)
