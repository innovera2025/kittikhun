# นับสต็อกแบบไม่มีรอบ → ส่งเอกสารกลับ ERP — แผนลงมือ

> สร้าง 27 ส.ค. 2569 · ออกแบบจาก 4 มุม (แอป · API · โครงข้อมูล · ความเสี่ยง) แล้วสังเคราะห์เป็นแผนเดียว

> สถานะ: **รออนุมัติก่อนลงมือ**


## สรุปแนวทางที่เลือก

ทางที่เลือก (ต่างจากผลออกแบบ 2 ใน 4 ฉบับโดยตั้งใจ): **ไม่ย้าย PK ของ erp_writeback และไม่สร้างตารางผลนับใหม่เลย** — "เอกสารนับแบบไม่มีรอบ" 1 ใบ = 1 แถวใน count_sessions ที่ kind='adhoc' และเกิดมาปิดแล้ว (status='closed', opened_at=closed_at=now()) แล้วเขียนบรรทัดลง count_submissions (append-only เดิม) + closed_variance (เดิม) ตรง ๆ. ผลคือ buildLines() ที่ erp-writeback.service.ts:428-447 อ่าน closed_variance JOIN count_sessions อยู่แล้ว จึงใช้ได้ **โดยไม่แก้ไฟล์ฝั่ง ERP writer แม้แต่บรรทัดเดียว** และกลไกกันเอกสารซ้ำทั้ง 3 ชั้น (PK erp_writeback = session_id · advisory lock key = sessionId · มาร์กเกอร์ TCL#<id># ใน Remark) ทำงานเหมือนเดิมเป๊ะ ๆ เพราะ documentId คือ session id. เหตุผลที่ปฏิเสธทาง ref_id/count_tickets และทาง count_entries: ระบบไม่มี migration runner จริง (npm run migrate = psql replay ทั้ง schema.sql) การ DROP CONSTRAINT/ADD PRIMARY KEY บนตารางที่เป็นด่านกันซ้ำชั้นเดียวคือความเสี่ยงสูงสุดของงานนี้ และไม่ได้อะไรที่ kind='adhoc' ไม่ให้.

จุดตัดสินอื่นที่ผลออกแบบเห็นไม่ตรงกัน:
1) MainQty มาจากไหน → **server อ่าน items_cache.on_hand ตอนรับคำขอ ห้ามเชื่อค่าจาก client** (กฎเดิมที่ schema.sql:281 และ count.service.ts:25) แต่แอปต้องแนบ systemQtyShown มาด้วย ถ้าไม่ตรง → 409 SYSTEM_QTY_DRIFT พร้อมยอดใหม่รายบรรทัด ให้ผู้ใช้ยืนยันอีกรอบด้วย documentId เดิม. ได้ทั้ง "ค่าที่เขียนพิสูจน์ที่มาได้" และ "ไม่มีทางเขียนตัวเลขที่ไม่มีมนุษย์เคยเห็นเข้า ERP". เพราะบล็อก drift ไว้แล้ว จึง **ไม่ต้องเพิ่มคอลัมน์ client_system_qty** ที่ไหนเลย
2) ทิศเครื่องหมาย → แอปไม่คำนวณ/ไม่ส่ง diff เด็ดขาด ส่งแต่ systemQtyShown + countedQty. จอทุกจอใช้ Variance.from (counted − system, models.dart:214-223) ที่ตรงกับที่เจ้าของสั่งอยู่แล้ว. จุดกลับด้านมีจุดเดียวคือ erpDifQty() ที่ mssql-count-writer.ts:69-71 ห้ามแตะ
3) ส่งเข้า ERP จริง → เฟสนี้ปุ่มของพนักงานจบที่ "สร้างเอกสาร + เข้าคิว" (staff กดได้) ส่วนการยิงเข้า ERP ยังใช้ POST /count-sessions/:id/erp-writeback เดิม (admin) ที่ทำงานกับ adhoc doc ได้ทันที ไม่ต้องเขียนโค้ด writeback ใหม่เลย
4) แท็บ "นับสต็อก" ไม่ลบ (ทางเข้าจอผู้ดูแลมีทางเดียวคือปุ่มในจอนั้น) เปลี่ยนเนื้อเป็น "รอส่ง"
5) พบบั๊ก 2 ตัวที่ต้องแก้ก่อนเปิดช่องกรอก: setCount ตัดทศนิยมทิ้งเงียบ ๆ ('20.5'→'205' ทั้งที่ปลายทางเป็น numeric(18,3) และหน่วยจริงมี กส./ถัง) และ decCount เขียน '0' ลงช่องว่าง (= แจ้ง ERP ว่าของหายทั้งก้อน)


## ความเสี่ยงสูงสุด

เอกสารซ้ำใน ERP ที่แก้ไม่ได้และลบไม่ได้ — ปลายทางไม่มี unique บน VoucherNo/TransactionNo และไม่มีเส้นทางลบ ขณะที่โมเดลใหม่เปลี่ยนจาก 'admin กดส่งนาน ๆ ครั้ง' เป็น 'พนักงานกดส่งวันละหลายสิบครั้ง' → โอกาสเจอเคสสายขาด/กดซ้ำ/สองเครื่องพร้อมกัน เพิ่มตามจำนวนครั้งโดยตรง.

นี่คือเหตุผลหลักที่เลือกทาง kind='adhoc' แทนการย้าย PK ของ erp_writeback เป็น ref_id หรือสร้างตาราง/เอ็นด์พอยต์เขียนกลับชุดใหม่: documentId = count_sessions.id ทำให้ **ด่านกันซ้ำทั้ง 4 ชั้นทำงานเหมือนเดิมโดยไม่ต้องแก้โค้ดเลย** — (1) PK ของ erp_writeback (2) advisory lock key = sessionId (erp-writeback.service.ts:126-129) (3) reconcile ด้วยมาร์กเกอร์ TCL#<id># ใน Remark (mssql-count-writer.ts:425) (4) ux_count_sessions_erp_txn (schema.sql:552-553) — และไม่มีช่วงเวลาไหนเลยที่ต้อง DROP CONSTRAINT บนด่านกันซ้ำชั้นเดียวของระบบ บนฐานที่ไม่มี migration runner จริง (npm run migrate = psql replay ทั้ง schema.sql).

ด่านเสริมฝั่งแอปที่ต้องไม่พลาด: documentId = UUIDv7 สร้าง **ตอนกดยืนยัน ครั้งเดียว** แล้ว persist ลง outbox ทันที ห้ามสร้างใหม่ตอน retry (ถ้าสร้างใหม่ reconcile จะหาเอกสารเดิมไม่เจอแล้วเขียนใบที่สองทันทีโดยไม่มีอะไรฟ้อง) · ลบ count_drafts กับ insert outbox ต้องอยู่ในทรานแซกชันเดียว · state.busy กันกดสองที.

จุดเสี่ยงอันดับสองที่มักถูกมองข้าม: setCount ตัดทศนิยมทิ้งเงียบ ๆ ('20.5' → '205') บนช่องเดียวที่เจ้าของสั่งให้เพิ่ม ทั้งที่ปลายทางเป็น numeric(18,3) และหน่วยจริงใน ERP มี 'กส.' ที่ชั่งน้ำหนัก — ส่ง CountQty ผิด 10 เท่าเข้าเอกสารที่ลบไม่ได้ โดยไม่มี error ไม่มี toast. จึงจัดไว้เป็นขั้นที่ 1 ก่อนแตะ UI ใด ๆ.

ขนาดงานรวม: ~17 ไฟล์ (แอป 9: scan_screen · count_screen · common.dart · models.dart · app_state.dart · local_db.dart · sync_engine.dart · stock_repository.dart · sync_status_bar.dart + ไฟล์ใหม่ pending_counts_screen.dart, app_shell.dart, fixtures.dart · server 4: schema.sql · count.module.ts · count.service.ts · erp-writeback.service.ts (ขั้น 13 เท่านั้น) · docs 1) + เทสต์ใหม่ ~6 ไฟล์. **ไม่มีตาราง Postgres ใหม่ ไม่มีการย้าย PK ไม่ต้อง rename สัญญา ErpCountWriter** — ขั้น 1-12 ทำได้เลยทั้งหมด ขั้น 13-14 รอ ERP.


## ขั้นตอน


| # | ขั้น | ทำได้เลย |
|---|---|---|
| 1 | แก้บั๊กช่องกรอกจำนวน (ทศนิยม + ปุ่มลบบนช่องว่าง) — ทำก่อนทุกอย่าง | ✅ |
| 2 | ยก _StepperButton / _CountField ขึ้นเป็น widget สาธารณะ (refactor ล้วน ไม่เปลี่ยนพฤติกรรม) | ✅ |
| 3 | SQLite: ตาราง count_drafts + schemaVersion 1→2 + onUpgrade (ยังไม่มี UI เรียก) | ✅ |
| 4 | การ์ดผลสแกน: ตัด 3 ช่อง + ใส่ 'ยอดคงเหลือ / ผลต่าง' + แถว stepper (write-through ลง count_drafts) | ✅ |
| 5 | แถบเตือน 'คีย์แล้วยังไม่ส่ง' + hydrate ตอน sign-in + กันปุ่มล้าง/นำออกทำลายงานที่คีย์ | ✅ |
| 6 | Postgres: เพิ่ม count_sessions.kind + CHECK 2 ตัว + index (ไม่มีตารางใหม่ ไม่แตะ erp_writeback) | ✅ |
| 7 | server: POST /count-documents — สร้างเอกสาร adhoc ใน TX เดียว (ยังไม่ยิง ERP) | ✅ |
| 8 | server: จอผู้ดูแลต้องแยก kind + GET /count-documents (รายการเอกสารที่ยังไม่เข้า ERP) | ✅ |
| 9 | app: outbox type ใหม่ 'count_doc' (1 แถว = 1 เอกสาร) + สายส่งใน SyncEngine | ✅ |
| 10 | app: ปุ่ม 'ส่งเข้า ERP' + Confirm popup + sendDraftsToErp() | ✅ |
| 11 | app: แท็บ 'นับสต็อก' → 'รอส่ง' (PendingCountsScreen) + จัดการ 409 SYSTEM_QTY_DRIFT | ✅ |
| 12 | เอกสาร: อัปเดต docs/erp-data-mapping.md ให้ตรงกับเส้นทางใหม่ + รวมคำถามค้างส่งฝ่าย ERP | ✅ |
| 13 | [รอ ERP] เปิดการยิงเอกสาร adhoc เข้า ERP จริง | ⛔ รอ ERP |
| 14 | [รอ ERP] ทดสอบ end-to-end กับ ERP จริง 1 ใบ แล้วค่อยเปิดใช้จริง | ⛔ รอ ERP |


### 1. แก้บั๊กช่องกรอกจำนวน (ทศนิยม + ปุ่มลบบนช่องว่าง) — ทำก่อนทุกอย่าง  ✅ ทำได้เลย

**ไฟล์:** `app/lib/state/app_state.dart` · `app/lib/data/models.dart` · `app/test/widget_test.dart`

app_state.dart:504-507 setCount: เปลี่ยน regex จาก [^0-9] เป็นตัวกรองที่ยอมจุดเดียวและทศนิยมไม่เกิน 3 ตำแหน่ง (ให้ตรงกับ numeric(18,3) ที่ schema.sql:322 และ count_submissions). app_state.dart:514-517 decCount: ถ้าช่องว่างอยู่ให้ no-op ห้ามเขียน '0' (0 = 'นับแล้วได้ศูนย์' → DifQty = MainQty ทั้งก้อน). models.dart: เพิ่ม getter `String get signed` ใน Variance (ยังไม่กรอก '—' · 0 → '0' · บวก → '+n' · ลบ → 'n') ห้ามแตะ Variance.from เพราะทิศ counted − systemQty ตรงกับที่เจ้าของสั่งแล้ว. ขั้นนี้ไม่แตะ UI ใหม่เลย → build/test เดิมผ่านทันที

**เทสต์:**

- setCount: '20.5' → เก็บ '20.5' ไม่ใช่ '205'
- setCount: '20.5555' → ตัดเหลือ 3 ตำแหน่ง
- setCount: '1.2.3' → ยอมจุดเดียว
- decCount บนช่องที่ยังว่าง → ช่องยังว่าง ไม่กลายเป็น '0'
- decCount บนค่า 1 → '0' (0 ที่ตั้งใจ ยังต้องได้)
- Variance.signed: 19 จากระบบ 20 → '-1' · 21 → '+1' · 20 → '0' · ว่าง → '—'


### 2. ยก _StepperButton / _CountField ขึ้นเป็น widget สาธารณะ (refactor ล้วน ไม่เปลี่ยนพฤติกรรม)  ✅ ทำได้เลย

**ไฟล์:** `app/lib/core/widgets/common.dart` · `app/lib/features/count/count_screen.dart`

คัดลอก count_screen.dart:341-376 (_StepperButton) และ :379-421 (_CountField) ไปต่อท้าย common.dart หลัง FieldBox เปลี่ยนชื่อเป็น StepperButton/CountField โดยไม่แก้เนื้อในสักบรรทัด (token เดิมทั้งหมด: hStepper 44 · rCountInput · hint 'นับได้' · Semantics 'เพิ่ม/ลดจำนวน'). แก้ผู้เรียกที่ count_screen.dart:306,308-313,315 แล้วลบคลาสเดิม. เพิ่มพารามิเตอร์ `Color? valueColor` ให้ _StatTile (scan_screen.dart:728-749) ส่งลง statValue() ที่บรรทัด 745 — ยังไม่มีใครใช้ในขั้นนี้ ค่า default คงเดิม

**เทสต์:**

- golden/widget: จอนับเดิมยังเรนเดอร์เหมือนเดิม (ปุ่ม +/− และช่องกรอกอยู่ตำแหน่งเดิม)
- _StatTile ที่ไม่ส่ง valueColor ยังใช้สี tBody เดิม


### 3. SQLite: ตาราง count_drafts + schemaVersion 1→2 + onUpgrade (ยังไม่มี UI เรียก)  ✅ ทำได้เลย

**ไฟล์:** `app/lib/local/local_db.dart` · `app/test/local_db_test.dart`

เพิ่ม `@DataClassName('CountDraftRow') class CountDrafts extends Table` PK = {sku} (1 SKU : 1 บรรทัดในเอกสาร = สแกนซ้ำแก้แถวเดิม ไม่เกิดบรรทัดซ้ำ). คอลัมน์: sku · name · unit? · loc? · warehouseCode · systemQtyShown (real NOT NULL — สแนปช็อตยอดที่จอโชว์ ณ เวลาคีย์) · systemQtyAsOf? · countedQty (real) · enteredAt · enteredBy. เพิ่มชื่อในลิสต์ @DriftDatabase (local_db.dart:240-250) · schemaVersion → 2 (local_db.dart:273) · เพิ่ม onUpgrade ใน MigrationStrategy ที่ปัจจุบันมีแค่ beforeOpen (local_db.dart:276-281): `if (from < 2) await m.createTable(countDrafts);` **ห้ามมี drop/recreate ใด ๆ** เพราะ outbox อาจมีงานค้างส่งอยู่. DAO: upsertDraft · deleteDraft(sku) · allDrafts() (เรียง enteredAt) · watchDraftCount() (รูปแบบเดียวกับ watchQueueDepth local_db.dart:696) · clearDrafts(List<String>)

**เทสต์:**

- migration v1→v2: DB v1 ที่มีแถว outbox ค้าง อัปเกรดแล้วแถว outbox ครบเท่าเดิม และ count_drafts ว่าง
- upsertDraft สอง sku เดิม → มีแถวเดียว ค่าล่าสุดชนะ
- deleteDraft แล้ว watchDraftCount ลดลง
- allDrafts เรียงตาม enteredAt


### 4. การ์ดผลสแกน: ตัด 3 ช่อง + ใส่ 'ยอดคงเหลือ / ผลต่าง' + แถว stepper (write-through ลง count_drafts)  ✅ ทำได้เลย

**ไฟล์:** `app/lib/features/scan/scan_screen.dart` · `app/lib/state/app_state.dart`

ลบ Row scan_screen.dart:676-690 ทั้งบล็อก (จอง = PendingQTY ว่าง 100% · พร้อมขาย = onHand−reserved จึง null เสมอ · จุดสั่งซื้อ). **ตัดแถบสี/ProgressBar ที่คำนวณจาก rop ออกด้วย** (scan_screen.dart:546-553, 647-651) เพราะถ้าเหลือแถบส้ม/แดงไว้โดยไม่มีตัวเลขอธิบาย ผู้ใช้อ่านไม่ออก → ให้แถบสีอ้างสถานะการนับแทน (ยังไม่นับ = tMuted · ตรง = ok · ต่าง = warn สูตรเดียวกับ _varianceTone count_screen.dart:249-254). แทรกแทนที่: แถว A = Expanded(_StatTile 'ยอดคงเหลือ') + gap + Expanded(_StatTile 'ผลต่าง', valueColor) ใช้ Variance.from(entered, systemQty: onHand!). แถว B = StepperButton('−') + CountField + StepperButton('+') + Expanded(หน่วย) (กว้างรวม 196px จากพื้นที่ 292px ที่จอ 360 → ไม่ล้น). app_state.dart เพิ่ม setScanCount(Item, String) ที่กรองเลขแบบเดียวกับขั้น 1 แล้ว **เขียนทะลุลง SQLite ทันทีทุก keystroke** (upsertDraft พร้อม systemQtyShown = item.onHand!, systemQtyAsOf = item.onHandAsOf, enteredBy = me.empId) · ค่าว่าง = deleteDraft. เพิ่ม incScanCount/decScanCount ห่อ setScanCount. **แยกจาก setCount เดิมเด็ดขาด** (เส้น session เก่ายังต้องไม่แตะ SQLite). กรณี onHand == null: ห้ามกรอก แสดง 'ไม่มียอดระบบ · นับรายการนี้ไม่ได้' แทนแถว B. กรณี viewer: แสดง 'ดูอย่างเดียว · viewer' แทนแถว B (ปิดตั้งแต่ช่องกรอก ไม่ใช่มาบอกตอนกดส่ง) และกั้นซ้ำที่ setScanCount

**เทสต์:**

- สแกนของที่ onHand=20 คีย์ 19 → การ์ดขึ้น '-1' สีเตือน และมีแถวใน count_drafts
- คีย์ 21 → '+1' · คีย์ 20 → '0' สีเขียว
- ล้างช่องกรอก → แถว draft ถูกลบ
- onHand == null → ไม่มีช่องกรอก แสดงข้อความห้ามนับ
- viewer → ไม่มีช่องกรอกในการ์ด และ setScanCount ไม่เขียน draft
- ปิดแอปจำลอง (สร้าง LocalDb ใหม่) → draft ยังอยู่


### 5. แถบเตือน 'คีย์แล้วยังไม่ส่ง' + hydrate ตอน sign-in + กันปุ่มล้าง/นำออกทำลายงานที่คีย์  ✅ ทำได้เลย

**ไฟล์:** `app/lib/features/shell/sync_status_bar.dart` · `app/lib/state/app_state.dart`

app_state: เพิ่มฟิลด์ drafts (Map<String,CountDraftRow>) + copyWith · เพิ่ม loadDrafts() ที่อ่าน allDrafts() เข้า state.drafts และเติม state.counts ให้ช่องกรอกโชว์ค่าเดิม เรียกต่อจาก loadSession() ใน signIn (app_state.dart:267). sync_status_bar.dart:115-117 แก้เงื่อนไขซ่อนแถบให้รวม drafts == 0 · เพิ่มข้อความในลิสต์ :127-131 ว่า 'คีย์แล้วยังไม่ส่ง N รายการ' และ **ต้องอยู่ก่อน 'รอซิงค์ N รายการ' เสมอ** พร้อมสีจุดต่างกัน (draft = warn เพราะยังไม่มีใครส่งให้ · queue = accent เพราะระบบส่งเองอยู่). วางที่ SyncStatusBar เพราะอยู่นอก Expanded ของแท็บ (app_shell.dart:101-118) → สลับแท็บก็ยังเห็น. แก้ removeScan (app_state.dart:431-434) และ clearScans (:436-437) ให้ **แตะได้แค่ state.scans ห้ามแตะ count_drafts** ถ้า sku นั้นมี draft ให้ flash 'ยอดที่คีย์ไว้ยังอยู่ในรายการรอส่ง'

**เทสต์:**

- มี draft 3 แถว → แถบขึ้น 'คีย์แล้วยังไม่ส่ง 3 รายการ' สี warn
- มีทั้ง draft และคิวซิงค์ → บรรทัด draft มาก่อน
- sign-in ใหม่หลังปิดแอป → แถบขึ้นเองจากข้อมูลใน SQLite และช่องกรอกในการ์ดโชว์ค่าเดิม
- คีย์ยอด → กดปุ่ม 'ล้าง' ในจอสแกน → แถบยังขึ้นเลขเดิม
- removeScan บน sku ที่มี draft → flash เตือน และ draft ยังอยู่


### 6. Postgres: เพิ่ม count_sessions.kind + CHECK 2 ตัว + index (ไม่มีตารางใหม่ ไม่แตะ erp_writeback)  ✅ ทำได้เลย

**ไฟล์:** `server/db/schema.sql` · `server/test/schema-replay.spec.ts`

ALTER TABLE count_sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'session' (PG11+ ไม่ rewrite ตาราง). CHECK ห่อ DO $do$ ... EXCEPTION WHEN duplicate_object THEN NULL (ADD CONSTRAINT ไม่มี IF NOT EXISTS ใน PG16): (a) count_sessions_kind_ok CHECK (kind IN ('session','adhoc')) (b) **count_sessions_adhoc_born_closed CHECK (kind <> 'adhoc' OR status = 'closed')** — ด่านสำคัญ เพราะ ux_count_sessions_open (schema.sql:548-549) เป็น UNIQUE partial WHERE status='open' ต่อคลัง ถ้า adhoc เผลอเป็น open ใบเดียวจะบล็อกการเปิดรอบของทั้งคลัง และสองเครื่องสร้าง adhoc พร้อมกันไม่ได้ · **ห้ามแก้ ux_count_sessions_open** (c) count_sessions_id_no_hash CHECK (id NOT LIKE '%#%') — เงื่อนไขความถูกต้องของมาร์กเกอร์ TCL#<id># ที่ mssql-count-writer.ts:425 ใช้ค้นเอกสารกลับด้วย LIKE ถ้า id มี '#' reconcile จะจับข้ามเอกสาร = คืนเลขเอกสารผิดใบ. ห่อ EXCEPTION WHEN check_violation แล้ว RAISE ข้อความที่บอกคำสั่งตรวจ (fail fast โดยตั้งใจ). เพิ่ม CREATE INDEX IF NOT EXISTS idx_count_sessions_adhoc ON count_sessions (warehouse_code, created_at DESC) WHERE kind='adhoc'. แก้ COMMENT ที่ schema.sql:263 (count_sessions) และ :386,:419 (erp_writeback) ให้พูดว่า 'เอกสารนับ (รอบ หรือ ชุดนับไม่มีรอบ)'. แก้กฎเหล็กหัวไฟล์ schema.sql:10-12 ให้ครอบเส้นทาง adhoc. **ไม่ DROP อะไรเลยในแพตช์นี้**

**เทสต์:**

- replay schema.sql 3 รอบติดบนฐานที่มีข้อมูลจริง → ไม่ error และไม่เปลี่ยนข้อมูล
- replay บนฐานเปล่า 1 รอบ → ผ่าน
- แถว count_sessions เดิมทั้งหมดได้ kind='session' อัตโนมัติ
- INSERT adhoc ที่ status='open' → ถูก CHECK ปฏิเสธ
- INSERT session id ที่มี '#' → ถูก CHECK ปฏิเสธ
- adhoc ที่ปิดแล้ว 2 ใบในคลังเดียวกัน → INSERT ได้ทั้งคู่ (ไม่ชน ux_count_sessions_open)


### 7. server: POST /count-documents — สร้างเอกสาร adhoc ใน TX เดียว (ยังไม่ยิง ERP)  ✅ ทำได้เลย

**ไฟล์:** `server/src/count/count.module.ts` · `server/src/count/count.service.ts` · `server/test/count-document.spec.ts`

Controller ใหม่ @Controller('count-documents') ในไฟล์เดิม (ไม่แตะ @Controller('count-sessions')) · @Roles('staff','admin') · @RequireFreshRole() · @HttpCode(200) (ไม่ใช่ 201 — retry ด้วย documentId เดิมต้องได้ 200 พร้อมเอกสารใบเดิม). body: { documentId: SessionIdSchema (UUIDv7 จาก client = idempotency key ทั้งใบ · ผ่าน CHECK ห้าม '#' โดยอัตโนมัติ), deviceId, acceptSystemQtyDrift?: boolean, lines: [{ sku, countedQty (number finite >=0, ทศนิยม 3 ตำแหน่ง), systemQtyShown (number finite), countedAt (ISO offset), entryKey (uuid) }] min 1 max MAX_BATCH_LINES }. **ไม่รับ unit และไม่รับ diff จาก client เด็ดขาด**. ลำดับ: (1) ปฏิเสธ sku ซ้ำในใบเดียว → 400 DOCUMENT_DUPLICATE_SKU (2) อ่าน items_cache รายบรรทัด (sku, name, unit, warehouse_code, on_hand, deleted_at) ใช้ตรรกะเดียวกับ assertSkusCountable() count.service.ts:1281-1308 → ไม่พบ / tombstone / คลังไม่ตรง WAREHOUSE_CODE / on_hand IS NULL → 400 ITEM_NO_SYSTEM_QTY (ห้ามเดาเป็น 0) (3) เทียบ round2(systemQtyShown) กับ round2(on_hand) ถ้าต่างและไม่ acceptSystemQtyDrift → **409 SYSTEM_QTY_DRIFT + { lines: [{sku, shown, current}] } และต้องยังไม่มีอะไรถูกเขียนลง DB** (4) TX เดียว: INSERT count_sessions (id=documentId, kind='adhoc', status='closed', opened_at=closed_at=now(), closed_by=empId, warehouse_code, erp_data_as_of = max(sync_runs.stock_as_of WHERE kind='items'), opened_on_stale_cache ตามเกณฑ์เดิม) ON CONFLICT (id) DO NOTHING → ถ้าชนแปลว่าเคยสร้างแล้ว: เทียบ payload_hash ของ count_submissions เดิม ต่างกัน → 409 DOCUMENT_PAYLOAD_MISMATCH เหมือนกัน → คืนผลใบเดิม (idempotent) · INSERT count_submissions 1 แถว/บรรทัด (idempotency_key = entryKey, session_id = documentId, device_seq, payload_hash แบบ count.service.ts:1344-1353 คือ countedQty.toFixed(3) + ISO UTC เพื่อกัน 5 กับ 5.000 mismatch ปลอม) · INSERT closed_variance 1 แถว/sku (frozen_on_hand = on_hand จาก server, final_counted_qty, unit, counted_by, device_count=1, chosen_submission=entryKey, status = match/over/short) COMMIT (5) audit_log 1 แถว. **ไม่เรียก ErpWritebackService ในขั้นนี้** — Postgres ต้อง commit ก่อนเสมอ เพราะ ERP ยังปิดอยู่และล่มได้ ถ้าผูกใน TX เดียวงานที่พนักงานเดินเก็บมาทั้งวันจะหาย. response: { documentId, lineCount, erpDataAsOf, erpStatus: null, lines: [{sku, name, unit, systemQty, countedQty, diff /* counted − system */}] } — **ห้ามมีฟิลด์ชื่อ difQty/DifQty**

**เทสต์:**

- ส่งใบใหม่ 3 บรรทัด → 200 · มี count_sessions kind='adhoc' status='closed' 1 แถว · count_submissions 3 · closed_variance 3
- ส่งซ้ำด้วย documentId เดิม payload เดิม → 200 คืนใบเดิม ไม่เกิดแถวซ้ำ
- documentId เดิม payload ต่าง → 409 DOCUMENT_PAYLOAD_MISMATCH
- systemQtyShown ไม่ตรง items_cache → 409 SYSTEM_QTY_DRIFT และ **ไม่มีแถวใดถูก INSERT**
- ยิงซ้ำด้วย acceptSystemQtyDrift + documentId เดิม → สำเร็จ และ frozen_on_hand = ค่าจาก server ไม่ใช่ค่าจาก client
- on_hand IS NULL → 400 ITEM_NO_SYSTEM_QTY ไม่ส่ง 0
- sku ซ้ำในใบเดียว → 400 ปฏิเสธทั้งใบ
- สินค้าคลังอื่น / tombstone → ปฏิเสธ
- countedQty=19 systemQty=20 → response.lines[0].diff = -1
- viewer → 403
- สองคำขอพร้อมกันด้วย documentId เดียวกัน → เอกสารใบเดียว


### 8. server: จอผู้ดูแลต้องแยก kind + GET /count-documents (รายการเอกสารที่ยังไม่เข้า ERP)  ✅ ทำได้เลย

**ไฟล์:** `server/src/count/count.service.ts` · `server/src/count/count.module.ts`

ไล่ทุก query ที่อ้าง count_sessions ในโค้ดแล้วใส่ตัวกรอง kind ให้ครบ **ในแพตช์เดียวกัน ห้ามทิ้งไว้ทำทีหลัง** ไม่งั้นรายการ adhoc จะไหลปนกับรอบปกติจนจอผู้ดูแลอ่านไม่รู้เรื่อง และตัวเลข 'จำนวนรอบนับเดือนนี้' จะพุ่งเป็นร้อย. เพิ่ม GET /count-documents?status=pending (admin) → เอกสาร kind='adhoc' ที่ LEFT JOIN erp_writeback แล้ว w.session_id IS NULL OR w.status <> 'sent' = 'เอกสารที่ยังไม่เข้า ERP' (จำเป็นมากในช่วงที่ ERP_WRITEBACK_ENABLED=false เพราะทุกใบจะค้างสถานะนี้). เพิ่ม GET /count-documents/:id (staff+admin) คืนสถานะเอกสาร + สถานะ writeback แต่ **ตัด lastError ทิ้งเมื่อ role เป็น staff** (ข้อความ error ดิบของ SQL Server มีชื่อ host/database ปน — เหตุผลเดียวกับที่ count.module.ts:333-335 จำกัด admin). GET /count-sessions/:id/variance และ CSV export ใช้ได้ทันทีโดยไม่แก้ เพราะ adhoc เกิดมาปิดแล้วจึงอ่าน closed_variance อยู่แล้ว (count.service.ts:515-516,564)

**เทสต์:**

- รายการรอบนับของ admin ไม่แสดงเอกสาร adhoc
- GET /count-documents?status=pending คืนเฉพาะใบที่ยังไม่ sent
- staff เรียก GET /count-documents/:id → ไม่มี lastError ใน response
- GET /count-sessions/:id/variance บน adhoc doc → คืนบรรทัดจาก closed_variance ได้ทันที
- CSV export ของ adhoc doc มีคอลัมน์ครบเหมือนรอบปกติ


### 9. app: outbox type ใหม่ 'count_doc' (1 แถว = 1 เอกสาร) + สายส่งใน SyncEngine  ✅ ทำได้เลย

**ไฟล์:** `app/lib/local/local_db.dart` · `app/lib/local/sync_engine.dart` · `app/lib/data/stock_repository.dart`

local_db.dart:38-44 เพิ่ม `static const String countDoc = 'count_doc';` ใน OutboxType. เพิ่ม enqueueCountDoc({warehouseCode, empId, deviceId}) ที่ทำใน **transaction เดียว**: อ่าน count_drafts ทั้งหมด → documentId = newUuidV7() (stock_repository.dart:40-42) → INSERT outbox 1 แถว (type=countDoc, id=documentId, sessionId=null, deviceSeq=_nextDeviceSeq()) → **ลบ count_drafts ทุกแถวที่เข้า batch ในทรานแซกชันเดียวกัน** → คืน documentId. payload = { documentId, deviceId, warehouseCode, empId, createdAt, acceptSystemQtyDrift:false, lines:[{entryKey, sku, systemQtyShown, countedQty, countedAt}] }. **ห้ามใส่ฟิลด์ diff**. ⚠️ ห้ามใช้เส้น dedupe เดิมของ enqueueCountLine (local_db.dart:499-506) ที่ where ด้วย sessionId.equals(sessionId) — sessionId เป็น null จะแปลเป็น `session_id = NULL` ซึ่งเป็นเท็จเสมอ ลบไม่โดน แถวเก่าค้าง ส่งซ้ำ. sync_engine.dart:139-140 เพิ่ม typeCountDoc และสาขาใหม่ในโซ่ dispatch (:339/:393): แกะ payload ไม่ได้ → markRejectedAll(codeMalformedPayload) · markInflight → POST /count-documents · 200 = markAcked · 409 DOCUMENT_PAYLOAD_MISMATCH / 400 = markRejected (ไปโผล่จอ pending-review ห้ามลบ) · 409 SYSTEM_QTY_DRIFT = markRejected พร้อมเก็บ payload ตอบกลับไว้ให้จอ (ขั้น 11) · error ชั่วคราว = markRetryAll ทั้งแถว. **ห้ามแตกส่งเป็นหลาย request** (ต่างจาก scanEventsPerRequest sync_engine.dart:167) ไม่งั้นสายขาดกลางทางได้เอกสารครึ่งใบ. เพิ่ม CountRepository.submitDocument() ใน stock_repository.dart

**เทสต์:**

- enqueueCountDoc: draft 5 แถว → outbox 1 แถว และ count_drafts ว่าง (ทรานแซกชันเดียว)
- จำลอง crash ระหว่าง enqueue → ทั้ง outbox และ drafts ต้องกลับไปสถานะก่อนหน้า ไม่มีสภาพ 'ส่งแล้วและยังคีย์ค้าง' พร้อมกัน
- payload ไม่มีคีย์ชื่อ diff/DifQty
- retry 3 ครั้งหลังเน็ตหลุด → ใช้ documentId เดิมทุกครั้ง
- เอกสาร 200 บรรทัดถูกส่งเป็น request เดียว ไม่ถูกตัดชุด
- server ตอบ 409 PAYLOAD_MISMATCH → แถวเป็น rejected ไม่ถูกลบ


### 10. app: ปุ่ม 'ส่งเข้า ERP' + Confirm popup + sendDraftsToErp()  ✅ ทำได้เลย

**ไฟล์:** `app/lib/features/scan/scan_screen.dart` · `app/lib/state/app_state.dart`

scan_screen.dart:260-267 แทรกลูกตัวสุดท้ายของ Column: `if (state.drafts.isNotEmpty) _SubmitErpBar(...)` รูปทรงลอกจากปุ่มส่งของจอนับเดิม (count_screen.dart:114-132) label 'ส่งผลนับ · N รายการ' · viewer ห่อ Opacity(0.45). _ConfirmSendDialog ต่อจาก _ManualCodeDialog (scan_screen.dart:843-939) ใช้เปลือกเดียวกันเป๊ะ เนื้อใน: (1) หัวข้อ 'ยืนยันส่งผลนับ' (2) บล็อกสรุปด้วย _SpecRow (:751-787): จำนวนรายการ · ขาด k รายการ รวม −X · เกิน m รายการ รวม +Y · ตรง z รายการ · รวมสุทธิ (ทิศ counted − system เหมือนบนการ์ด) (3) **บล็อกแยกสำหรับรายการที่นับได้ 0** พร้อมข้อความว่าจะแจ้ง ERP ว่าของหายทั้งก้อน — ต้องติ๊กยืนยันอีกชั้นถ้ามี (4) ListView maxHeight 240 แสดงทุกบรรทัด 'sku · ระบบ X → นับได้ Y · ±Z' (5) กล่องเตือน bad: 'เอกสารที่ส่งแล้วลบใน ERP ไม่ได้ ถ้าตัวเลขผิดต้องให้ฝ่ายบัญชีแก้ให้' (6) ปุ่มยกเลิก/ยืนยันลอกจาก :910-931. app_state.sendDraftsToErp(): (a) `if (!me.role.canWrite) { flash('สิทธิ์ viewer ส่งผลนับไม่ได้'); return; }` — ด่านแข็ง fail-closed (b) `if (state.busy) return;` → busy=true (กันกดสองที) (c) drafts ว่าง → flash แล้วออก (d) await db.enqueueCountDoc(...) (e) state.copyWith(drafts:{}, counts:{}, busy:false) (f) syncEngine.syncAll() (g) flash('ส่ง N รายการเข้าคิวแล้ว'). เปลี่ยน PrimaryButton 'นับสต็อกรายการนี้' (scan_screen.dart:696-708) เป็น SecondaryButton 'ล้างค่าที่นับ' → setScanCount(item,'') เพราะกรอกได้ในการ์ดแล้ว ปุ่มกระโดดข้ามแท็บไม่มีเหตุผล · goCount (app_state.dart:519-526) ไม่มีใครเรียกแล้ว ให้ชี้ไปแท็บ 'รอส่ง'

**เทสต์:**

- ไม่มี draft → ไม่มีแถบปุ่มส่ง (ลิสต์ผลสแกนได้ความสูงเต็ม)
- popup แสดงจำนวน ขาด/เกิน/ตรง และผลรวมสุทธิถูกต้อง
- มีรายการนับได้ 0 → ต้องติ๊กยืนยันก่อนกดส่งได้
- กดยืนยันสองครั้งรัว ๆ → enqueueCountDoc ถูกเรียกครั้งเดียว (busy)
- viewer กดปุ่มส่ง → ถูกปฏิเสธ ไม่มีแถว outbox
- ออฟไลน์กดส่ง → เข้าคิวสำเร็จ + toast + แถบเปลี่ยนจาก 'คีย์แล้วยังไม่ส่ง' เป็น 'รอซิงค์'


### 11. app: แท็บ 'นับสต็อก' → 'รอส่ง' (PendingCountsScreen) + จัดการ 409 SYSTEM_QTY_DRIFT  ✅ ทำได้เลย

**ไฟล์:** `app/lib/features/count/pending_counts_screen.dart` · `app/lib/features/shell/app_shell.dart` · `app/lib/data/fixtures.dart`

**ห้ามลบแท็บ** เพราะแถบล่างเป็นกริด 4 ช่องตาม design (app_shell.dart:32,351-365) และ **ทางเข้าจอผู้ดูแลมีทางเดียวคือปุ่ม 'จัดการรอบนับ' ในการ์ดรอบนับ** (count_screen.dart:74-80 → showAdminProvider) ลบแท็บ = admin เข้าจอตัวเองไม่ได้อีกเลย. สร้าง PendingCountsScreen: รายการ draft ทุกแถว (sku · ชื่อ · ระบบ · นับได้ · ผลต่างมีเครื่องหมาย · ปุ่มลบรายแถว — ลบได้เพราะ draft อยู่ในเครื่อง ยังไม่ใช่หลักฐานฝั่ง server จึงไม่ขัด append-only) + ปุ่มส่งตัวเดียวกับจอสแกน + **ยกปุ่มเข้าจอผู้ดูแล (count_screen.dart:207-215) มาไว้ที่นี่** เปลี่ยนป้ายเป็น 'จอผู้ดูแล' แสดงเฉพาะ isAdmin. แก้ app_shell.dart:192 → PendingCountsScreen() · fixtures.dart:125 ป้ายแท็บ 'รอส่ง' · fixtures.dart:116 หัวเรื่อง ('รายการที่คีย์ไว้','รอส่งเข้า ERP') · ลบสาขา session ใน _headFor (app_shell.dart:58-70). **count_screen.dart คงไฟล์ไว้ทั้งไฟล์แต่ไม่มีใครเรียก** จนกว่าจะตัดสินปลดระวางเส้น session. เพิ่มการจัดการ 409 SYSTEM_QTY_DRIFT: เขียน draft กลับคืนพร้อมยอดใหม่จาก server แล้วขึ้นบรรทัดเตือนต่อรายการ 'ยอดระบบเปลี่ยนหลังคีย์ (20 → 25)' ให้ผู้ใช้ดูผลต่างใหม่แล้วกดยืนยันอีกรอบด้วย documentId เดิม (acceptSystemQtyDrift=true) — **ห้ามแอบเปลี่ยนตัวเลขให้เงียบ ๆ**

**เทสต์:**

- แท็บที่ 3 แสดงรายการ draft ครบทุกแถว
- admin เห็นปุ่ม 'จอผู้ดูแล' และกดเข้าจอผู้ดูแลได้ (ทางเข้าไม่หาย)
- staff ไม่เห็นปุ่มนั้น
- ลบ draft รายแถว → หายจากลิสต์และจากแถบเตือน
- 409 SYSTEM_QTY_DRIFT → draft กลับมาพร้อมป้าย 'ยอดระบบเปลี่ยน (20 → 25)' และผลต่างใหม่
- ยืนยันหลัง drift → ส่งด้วย documentId เดิม ไม่ใช่ id ใหม่


### 12. เอกสาร: อัปเดต docs/erp-data-mapping.md ให้ตรงกับเส้นทางใหม่ + รวมคำถามค้างส่งฝ่าย ERP  ✅ ทำได้เลย

**ไฟล์:** `docs/erp-data-mapping.md`

เพิ่มหัวข้อ 'เส้นทางที่สอง: เอกสารนับแบบไม่มีรอบ (kind=adhoc)' อธิบายว่า documentId = count_sessions.id จึงใช้กลไกกันซ้ำชุดเดิมทั้ง 3 ชั้นได้เหมือนเดิม · ระบุชัดว่าจอแสดง counted − system แต่ ERP ได้ MainQty − CountQty และจุดกลับด้านมีจุดเดียวที่ erpDifQty() ห้ามแตะ · รวมคำถามที่ต้องส่งฝ่าย ERP เป็นลิสต์เดียวพร้อมลำดับความสำคัญ (ดู open_decisions)

**เทสต์:**

- ไม่มีเทสต์อัตโนมัติ — ตรวจด้วยการอ่าน: ทุกเลขบรรทัดที่อ้างในเอกสารยังตรงกับโค้ดจริง


### 13. [รอ ERP] เปิดการยิงเอกสาร adhoc เข้า ERP จริง  ⛔ รอ ERP

**ไฟล์:** `server/src/count/count.module.ts` · `server/src/count/erp-writeback.service.ts` · `server/test/erp-writeback-db.spec.ts`

**โค้ด writeback ไม่ต้องเขียนใหม่เลย** — POST /count-sessions/:id/erp-writeback (count.module.ts:315-322, admin + RequireFreshRole) ทำงานกับ adhoc doc ได้ทันที เพราะ documentId คือ session id, buildLines() อ่าน closed_variance ที่เรา materialize ไว้แล้ว, assertOwnWarehouse() อ่าน warehouse_code จากแถว count_sessions ได้ตามปกติ, และเงื่อนไข 'ส่งได้เฉพาะรอบที่ปิดแล้ว' ผ่านเพราะ adhoc เกิดมาปิดแล้ว. สิ่งที่ต้องทำจริงมีแค่: (1) เพิ่มปุ่ม/รายการในจอผู้ดูแลให้กดส่งเอกสาร adhoc ทีละใบจาก GET /count-documents?status=pending (2) ตัดสินใจว่าจะให้ staff กดส่งเองได้ไหม (open decision สูง) (3) ถ้าให้ staff กดได้ ให้ลด MAX_BATCH_LINES ของเส้นทางนี้จาก 200 เหลือ ~50 และบังคับ RequireFreshRole. **ห้ามเปิด ERP_WRITEBACK_ENABLED บน production จนกว่า tcl_writer พร้อม + verifyWriteScope() (erp.module.ts:138-159) ผ่าน + ส่งเอกสารทดสอบ 1 ใบบนฐานทดสอบแล้วเทียบทีละคอลัมน์**

**เทสต์:**

- ทำซ้ำ 3 เคสดาวของ erp-writeback-db.spec.ts บน adhoc doc: สองคำขอพร้อมกัน → เอกสารเดียว · ERP commit แล้วสายขาด → reconcile เจอใบเดิม · ถาม ERP ไม่ได้ → หยุด ไม่เดา
- retry ข้ามสิ้นเดือน → VoucherNo เดือนเดียวกับ count_date ที่ตรึงตอน claim
- adhoc doc ที่ส่งแล้ว ส่งซ้ำ → 409 ERP_WRITEBACK_ALREADY_SENT
- countedQty=19 systemQty=20 → ค่าที่เข้า sql.Decimal (mssql-count-writer.ts:406) = +1 แต่ response.diff = -1


### 14. [รอ ERP] ทดสอบ end-to-end กับ ERP จริง 1 ใบ แล้วค่อยเปิดใช้จริง  ⛔ รอ ERP

**ไฟล์:** `server/src/erp/drivers/mssql-count-writer.ts` · `docs/erp-data-mapping.md`

ต้องมี tcl_writer + ฐานทดสอบของฝ่าย ERP ก่อน. ตรวจ: TZ=Asia/Bangkok ใน Dockerfile/compose (useUTC:false ที่ mssql-count-writer.ts:466-470 ถ้า container ไม่ตั้ง TZ เวลาจะเพี้ยน 7 ชม. และกระทบ monthKey ของ VoucherNo) · ERP_WRITEBACK_DTL_VOUCHERNO (mssql-count-writer.ts:33-42) ให้ฝ่าย ERP เปิดรายงานยืนยันว่าเห็นรายการที่เราส่ง · findDocumentBySession() (:151-176) ใช้ SELECT TOP(1) ... ORDER BY Roworder DESC ซึ่งจะรายงาน 'reconciled สำเร็จ' เงียบ ๆ แม้มีเอกสารซ้ำสองใบ → เมื่อจำนวนเอกสารเพิ่มหลายเท่าจากเส้นทางใหม่ ควรเปลี่ยนเป็นนับจำนวนที่ match แล้ว throw/alarm เมื่อ > 1 · วัดผลกระทบของ nextNumber() (:325-344) ที่ถือ UPDLOCK/HOLDLOCK ตลอดธุรกรรม เมื่อเอกสารเพิ่มจากไม่กี่ใบ/เดือนเป็นหลายสิบใบ/วัน

**เทสต์:**

- ส่งเอกสารจริง 1 ใบบนฐานทดสอบ → เทียบ tbl_CountHdr/tbl_CountDtl ทีละคอลัมน์กับที่คาดไว้
- DifQty ในแถวจริง = MainQty − CountQty ตามที่อนุมานไว้
- เขียนเอกสารตอน 23:50 ของวันสิ้นเดือน → VoucherNo เดือนถูกต้อง
- reconcile: จงใจสร้างเอกสารซ้ำสองใบด้วยมาร์กเกอร์เดียวกัน → ระบบต้อง alarm ไม่ใช่รายงานว่าสำเร็จ


## เรื่องที่ต้องตัดสิน


### [สูง] ERP รับเอกสารนับหลายใบต่อวันต่อคลังได้ไหม และถ้า ItemCode เดียวกันโผล่ในสองเอกสารที่ CountDate เดียวกัน โมดูลนับของ ERP ใช้ใบไหนเป็นคำตอบ (ใบล่าสุด / รวมกัน / นับซ้ำ)

ถามฝ่าย ERP เป็นลายลักษณ์อักษรก่อนเปิดใช้จริง — นี่คือคำถามที่ตัดสินว่าโมเดล 'ไม่มีรอบ' ใช้ได้หรือไม่ตั้งแต่ต้น เพราะปลายทางไม่มี unique บน VoucherNo/TransactionNo และไม่มีเส้นทางลบ ถ้าคำตอบคือ 'รวมกัน' ยอดปรับสต็อกจะผิดเป็นเท่าตัวโดยไม่มีอะไรฟ้องทั้งสองฝั่ง. ระหว่างรอ ให้กันฝั่งเราด้วย: เตือนตอนสแกนถ้า sku นั้นถูกส่งไปแล้วในเอกสารของวันเดียวกัน (query จาก closed_variance JOIN count_sessions WHERE kind='adhoc'). โครงที่เลือกรองรับทั้งสองแบบอยู่แล้ว เพราะ 'เอกสาร' เป็นแค่แถวหนึ่งใน count_sessions — ถ้า ERP อยากได้ใบใหญ่ใบเดียวต่อวัน เปลี่ยนเป็นสะสมแล้วปิดตอนสิ้นวันได้โดยไม่ต้องย้ายคีย์อะไรเลย


### [สูง] ใครมีสิทธิ์ทำให้เอกสารเข้า ERP จริง — staff หน้างาน หรือ admin เท่านั้น

เฟสนี้: **staff สร้างเอกสารได้ (POST /count-documents) แต่การยิงเข้า ERP ยังเป็น admin** ตามเส้นทางเดิม. เจ้าของสั่งว่า 'กดส่งเข้า ERP' ได้เลย แต่ ERP ไม่มีเส้นทางลบเอกสาร การเปิดให้ทุกคนหน้างานเขียนเอกสารถาวรเข้าระบบการเงินคือการขยาย blast radius ที่ใหญ่ที่สุดของงานนี้ — และตอนนี้ ERP_WRITEBACK_ENABLED=false อยู่แล้วจึงไม่มีต้นทุนที่จะรอ. ให้จอแยกคำสองคำชัด ๆ: 'ส่งผลนับ' (พนักงานกด สำเร็จเสมอถ้า Postgres รับ) กับ 'เข้า ERP แล้ว' (สถานะแยก). ขอคำยืนยันเป็นลายลักษณ์อักษรจากเจ้าของก่อนผ่อนให้ staff กดยิงเอง และถ้าผ่อนต้องแลกด้วย MAX_BATCH_LINES 50, RequireFreshRole, audit ครบทุกใบ


### [สูง] เอกสารที่ส่งผิดเข้าไปแล้ว (นับผิด/สแกนผิดตัว) แก้หรือยกเลิกอย่างไรในระบบ ERP

เดิมความเสี่ยงถูกจำกัดด้วย 'หนึ่งรอบส่งได้ครั้งเดียว' และมี admin ดูรายงาน variance ทั้งรอบก่อนกด. เส้นทางใหม่ตัดสองด่านนี้ทิ้งและเพิ่มจำนวนโอกาสพลาดหลายเท่าต่อวัน คำถามนี้จึงกลายเป็นตัวบล็อก ไม่ใช่ nice-to-have. ต้องได้คำตอบ (เอกสารกลับรายการ? แก้ในหน้าจอ ERP?) ก่อนเปิด ERP_WRITEBACK_ENABLED=true และขอ UNIQUE constraint บน tbl_CountHdr.VoucherNo/TransactionNo ไปพร้อมกัน. ถ้าไม่มีวิธีแก้เลย ให้ Confirm popup เป็นด่านสุดท้ายจริง ๆ และต้องเขียนบน popup ว่า 'เอกสารนี้ลบไม่ได้'


### [สูง] ยืนยันเป็นลายลักษณ์อักษรว่า DifQty = MainQty − CountQty (ตอนนี้อนุมานจากข้อมูลจริงแค่ 8 แถว)

ขอคำยืนยันพร้อมคำถามข้ออื่น. ระหว่างนี้กันด้วยโครงสร้าง: แอปไม่คำนวณและไม่ส่ง diff ขึ้น server เลย ส่งแต่ค่าดิบสองตัว → **จำนวนจุดกลับด้านในระบบ = 1 จุด** อยู่ที่ erpDifQty() (mssql-count-writer.ts:69-71) ถ้าอนุมานผิด แก้จุดเดียวจบ. ห้าม server คืนฟิลด์ชื่อ difQty/DifQty ใน response ให้ชื่อ diff แล้วระบุใน doc comment ว่าเป็น counted − system


### [สูง] บัญชี tcl_writer จะพร้อมเมื่อไหร่ และมีฐานทดสอบของฝ่าย ERP ให้ลองส่งเอกสารจริง 1 ใบไหม

งานฝั่งแอป+Postgres (ขั้น 1-12) เดินได้ครบโดยไม่ต้องรอ — พนักงานใช้งานได้จริง งานไม่หาย เอกสารถูกบันทึกครบ. แต่ห้ามเปิดสวิตช์ ERP จนกว่าจะรัน verifyWriteScope() (erp.module.ts:138-159) ผ่านและเทียบเอกสารจริงทีละคอลัมน์


### [กลาง] เมื่อยอดระบบขยับระหว่างคีย์กับกดส่ง ควรหยุดให้ยืนยันใหม่ (409) หรือมี tolerance

ตัดสินแล้วว่าหยุด (409 SYSTEM_QTY_DRIFT) เพราะ DifQty ในเอกสารต้องเป็นตัวเลขที่มนุษย์อนุมัติแล้ว. ที่ยังต้องรู้คือความถี่จริง: items_cache ถูก cron ทับทุก 30 นาที (ERP_SYNC_CRON) ถ้า SKU หมุนเร็วผู้ใช้จะเจอ 409 บ่อยจนน่ารำคาญ. เก็บสถิติจำนวน 409 ใน 2 สัปดาห์แรก แล้วถ้าเกินเกณฑ์ค่อยพิจารณา tolerance แบบ 'drift แล้วทิศส่วนต่างไม่เปลี่ยน (ขาดยังขาด) ให้ผ่าน' — อย่าใส่ tolerance ตั้งแต่แรกโดยไม่มีข้อมูล


### [กลาง] CountNo (NVarChar(2)) และ CountNumber (Numeric(18,0)) หมายถึงอะไร เมื่อมีเอกสารหลายใบต่อวันต้องเดินเลขต่อใบ/ต่อวัน/ต่อปี หรือคงเป็น 1 ได้

วันนี้ส่ง '1' และ 1 ตายตัวทุกใบ (erp-writeback.service.ts:209-212) ซึ่งเสี่ยงต่ำตอนวันละใบ แต่ถ้าสองช่องนี้แปลว่า 'ครั้งที่นับ' รายงาน ERP จะเห็นเอกสารหลายสิบใบที่อ้างว่าเป็นการนับครั้งที่ 1 ทั้งหมดแล้วอาจทับกัน. ขอ sp_columns tbl_CountHdr เต็ม พร้อมตัวอย่างข้อมูลที่มีหลายรอบในปีเดียวกัน อย่าเดาจาก 8 แถวเดิม


### [กลาง] CountDate ควรเป็นเที่ยงคืน (00:00:00 แบบข้อมูลจริงใน ERP) หรือมีเวลาติดไปด้วย

ข้อมูลจริงใน ERP เป็น 00:00:00 เสมอ แต่เราส่งเวลาติดไปด้วย และที่สำคัญกว่าคือฝั่งอ่านของเราเองใช้ CountDate เป็นจุดตัดเวลาของสูตรยอดคงเหลือ → เขียนเอกสารวันละหลายใบที่มีเวลาต่างกันอาจย้อนมาทำให้สูตรยอดของเราเองเพี้ยน. ถ้าคำตอบคือ 'ต้องเป็นเที่ยงคืน' ให้ตัดเวลาทิ้งที่ writer จุดเดียว (mssql-count-writer.ts:367) ไม่ใช่ที่ผู้เรียก


### [กลาง] สินค้าที่ ERP ไม่มียอดคงเหลือ (on_hand IS NULL) — ห้ามนับ หรือให้นับแล้วส่ง MainQty = 0

ห้ามนับในเฟสนี้ (แสดง 'ไม่มียอดระบบ · นับรายการนี้ไม่ได้') เพราะส่ง MainQty ปลอมเข้าเอกสารที่ลบไม่ได้อันตรายกว่ามาก และกฎ null ≠ 0 เป็นกฎเดิมของระบบ (models.dart:47-48, local_db.dart:10-11). ⚠️ ต้องรู้ด้วยว่า on_hand ใช้ได้จริงเฉพาะคลัง WHFG — WHRM/WHWIP/WHNG คำนวณจาก ledger ไม่ได้ → **เฟสนี้เปิดใช้เฉพาะ WHFG** ไม่งั้นพนักงานจะนับทั้งวันแล้วส่งไม่ได้เลยโดยไม่รู้ว่าทำไม


### [กลาง] รายการที่ 'นับได้ 0' จริง ๆ (ของหมดชั้น) ต้องยืนยันชั้นสองก่อนส่งไหม

ต้อง — 0 ทำให้ DifQty = MainQty ทั้งก้อน คือ mutation ที่แรงที่สุดที่ระบบทำได้. ให้ Confirm popup แสดงรายการที่นับได้ 0 เป็นบล็อกแยกพร้อมยอดผลต่างที่จะเกิดจริง และต้องติ๊กยืนยันอีกชั้น (อยู่ในขั้น 10 แล้ว). คู่กับการแก้ decCount ในขั้น 1 ที่ปิดช่องการเผลอสร้าง 0


### [กลาง] draft ที่คีย์ค้างผูกกับเครื่องหรือกับคน — คนที่ 1 คีย์ค้าง 20 รายการแล้ว sign out คนที่ 2 login เจอของค้าง

เครื่องคลังใช้ร่วมกันหลายกะ (local_db.dart:15). เก็บ draft ไว้ ห้ามลบตอน sign out (งานพนักงานต้องไม่หายเงียบ ๆ) แต่บันทึก enteredBy ต่อแถว และให้ Confirm popup ขึ้นบรรทัด 'มี N รายการที่คีย์โดยรหัส XXXXX' เมื่อคนกดส่งไม่ใช่คนที่คีย์. เอกสาร ERP มีช่องผู้ตรวจนับช่องเดียว จึงจะบันทึกเป็นชื่อคนกดส่ง — ให้เจ้าของโปรเจคตัดสินว่าจะห้ามส่งข้ามคนไปเลยหรือไม่


### [กลาง] เพดานบรรทัดต่อเอกสาร — 200 (MAX_BATCH_LINES เดิม) หรือ 50

เอกสารเป็น outbox แถวเดียวและห้ามแตกส่ง ถ้าใหญ่เกิน timeout จะ retry ทั้งก้อนวนไปเรื่อย ๆ. เริ่มที่ 200 ให้ตรงกับของเดิม แต่ถ้าตัดสินให้ staff ยิงเข้า ERP เองได้ ให้ลดเหลือ 50 เพื่อจำกัดวงของการกดผิดหนึ่งครั้ง. เกินเพดานให้ปุ่มบอกตรง ๆ ว่าจะแยกเป็น N เอกสาร และให้ยืนยันใน popup (แต่ละใบมี documentId ของตัวเอง)


### [กลาง] กดส่งตอน ERP_WRITEBACK_ENABLED=false ควรได้เห็นอะไรบนจอ

แยกคำสองคำให้ขาด: 'บันทึกผลนับแล้ว' (สำเร็จเสมอถ้า Postgres รับ) กับ 'เข้า ERP แล้ว' (สถานะแยก) · Confirm popup บอกตรง ๆ ว่ารายการจะถูกบันทึกเป็นเอกสารและเข้าคิวรอส่ง ERP · จอผู้ดูแลมีป้ายถาวร (ไม่ใช่ toast) แสดงจำนวนเอกสารที่ยังไม่เข้า ERP · **ห้ามซ่อนความจริงว่า ERP ยังปิดอยู่**


### [ต่ำ] ต้องมีรายงาน 'คลังถูกนับครบกี่เปอร์เซ็นต์' ไหม เมื่อไม่มี count_snapshot เป็นทะเบียนว่ารอบนี้ต้องนับอะไรบ้าง

เส้นทางใหม่ไม่มีทะเบียนนี้ → ไม่มีใครตอบได้ว่านับครบแค่ไหน ซึ่งฝ่ายบัญชีมักต้องการตอนปิดงวด. ถ้าเจ้าของยอมรับว่าไม่ต้องมี ก็จบ ไม่ต้องทำอะไร (YAGNI). ถ้าต้องการ ให้ทำเป็นรายงานฝั่งเราล้วน: นับ distinct sku ที่มีใน closed_variance ของเอกสาร adhoc ในช่วงวันที่ เทียบกับจำนวน sku ใน items_cache — ไม่ต้องส่งอะไรเพิ่มเข้า ERP


### [ต่ำ] ลบ draft รายแถวก่อนส่งได้ไหม (ขัดกับ append-only หรือเปล่า)

ได้ และไม่ขัด — draft อยู่ใน SQLite ของเครื่องเท่านั้น ยังไม่ใช่หลักฐานผลการนับฝั่ง server. ความเป็น append-only เริ่มบังคับที่ count_submissions ตอน POST /count-documents ซึ่งเป็นจังหวะที่ผู้ใช้กดยืนยันแล้ว. จึงไม่ต้องสร้างตาราง void ใด ๆ (ตัดข้อเสนอนั้นทิ้งตาม YAGNI)


### [ต่ำ] เส้นทาง count_sessions เดิม (เปิด/ปิดรอบ · count_snapshot · zone · conflict) จะปลดระวางเมื่อไหร่

ไม่ปลดในเฟสนี้ เก็บทั้งเส้นแต่ **ตัดทางเข้าจาก UI** (ไม่มีใครเรียก CountScreen แล้ว). เหตุผลที่เก็บ: เส้นทางรอบเป็นทางเดียวที่ผลิตรายงานส่วนต่างของทั้งคลัง และเทสต์ 22 เคสใน erp-writeback-db.spec.ts คือ regression net ของกลไกกันเอกสารซ้ำที่แพงเกินจะทิ้ง. ที่สำคัญ: **ไม่มีปัญหาสองเส้นทางกันเองไม่ได้** เพราะทั้งคู่ผ่าน erp_writeback ที่มี PK = session_id ตัวเดียวกัน — นี่คือผลตอบแทนหลักของการเลือกทาง kind='adhoc'. ดูการใช้งานจริง 1-2 เดือนว่ามีใครเปิดรอบอีกไหม ค่อยตัด


### [ต่ำ] เก็บ client_system_qty (ยอดที่จอโชว์) ไว้ฝั่ง server ไหม

ไม่ต้อง — ตัดสินแล้วว่าบล็อก drift ด้วย 409 จึงไม่มีเคสที่ค่าจอ ≠ ค่า server ผ่านเข้ามาได้ ยกเว้นเมื่อผู้ใช้กด acceptSystemQtyDrift ซึ่งให้บันทึกลง audit_log แทน (มีตารางอยู่แล้ว). ประหยัดคอลัมน์ใหม่ทั้งชุดและไม่ต้องแตะ count_submissions


## ติดอยู่กับฝ่าย ERP

- เปิด ERP_WRITEBACK_ENABLED=true บน production — ต้องมีบัญชี tcl_writer และ verifyWriteScope() (server/src/erp/erp.module.ts:138-159) ผ่านก่อน
- ยิงเอกสาร adhoc เข้า ERP จริง (ขั้น 13) — ต้องมีฐานทดสอบของฝ่าย ERP ให้ส่ง 1 ใบแล้วเทียบ tbl_CountHdr/tbl_CountDtl ทีละคอลัมน์
- ยืนยันทิศ DifQty = MainQty − CountQty เป็นลายลักษณ์อักษร (ตอนนี้อนุมานจากข้อมูลจริง 8 แถว)
- คำตอบว่า ERP รับเอกสารนับหลายใบต่อวันต่อคลังได้ไหม และตีความ ItemCode ซ้ำข้ามเอกสารวันเดียวกันอย่างไร
- ความหมายจริงของ CountNo / CountNumber เมื่อมีเอกสารหลายใบต่อวัน (ตอนนี้ส่ง '1'/1 ตายตัวทุกใบ)
- CountDate ต้องเป็นเที่ยงคืนหรือมีเวลาได้
- ขั้นตอนยกเลิก/แก้ไขเอกสารนับที่ส่งผิดในระบบ ERP + ขอ UNIQUE บน tbl_CountHdr.VoucherNo/TransactionNo
- ERP_WRITEBACK_DTL_VOUCHERNO ควรเปิดหรือไม่ — ให้ฝ่าย ERP เปิดรายงานยืนยันว่าเห็นรายการที่เราส่ง
- ให้ staff กดยิงเอกสารเข้า ERP เองได้หรือไม่ (ต้องได้คำยืนยันจากเจ้าของโปรเจคเป็นลายลักษณ์อักษร)
- ขยายการใช้งานไปคลังอื่นนอก WHFG — ต้องรู้ก่อนว่ารายการที่ ERP ไม่มียอด (on_hand NULL) ฝ่าย ERP อยากได้ในเอกสารไหม
