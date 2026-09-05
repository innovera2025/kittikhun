# TCL — Mobile Stock Check System

ระบบนับสต็อก / ตรวจเช็คสต็อกคลังสินค้าบนมือถือ เชื่อมต่อกับ ERP ภายในองค์กร (SQL Server) แบบ**อ่านอย่างเดียว** — ดึงยอดระบบมาเทียบ กรอกค่าที่นับได้จริง แล้วดูส่วนต่าง
UI อ้างอิง design ต้นแบบใน `Mobile Stock Check System/Stock Scan Mobile.dc.html` (v4.0, ธีมดาร์กเนวี) **อย่างเคร่งครัด**

## 🚫 กฎเหล็ก: ห้ามเขียนข้อมูลกลับ ERP โดยเด็ดขาด

ERP (`db_TCL` / SQL Server 2019) เป็นแหล่ง **อ่านอย่างเดียว** ไม่มีข้อยกเว้น — บังคับ 5 ชั้น:

| ชั้น | กลไก | สถานะ |
|---|---|---|
| 1 | สิทธิ์ระดับ DB — login ต้องเป็น `db_datareader` | ⏳ รอฝ่าย ERP จัดเตรียม login |
| 2 | Boot probe — ถามสิทธิ์จาก metadata ถ้าเขียนได้ = ปฏิเสธ start | ✅ `MssqlDriver.verifyReadOnly()` · **ไม่เขียนอะไรลง ERP เลย** |
| 3 | Statement guard — รับเฉพาะ `SELECT`/`WITH` | ✅ `assertReadOnlySql()` · **เทสต์ 24 เคสผ่าน** |
| 4 | Interface ไม่มี method เขียน + compile-time guard | ✅ เพิ่ม method เขียน = **build พังทันที** (ทดสอบแล้ว) |
| 5 | Read-only connection option (`readOnlyIntent`) | ✅ ใส่จริงแล้ว (มีผลเมื่อ ERP อยู่หลัง AG listener) |

ผลการนับและส่วนต่างเก็บใน PostgreSQL ของระบบนี้เท่านั้น

**ขอบเขตข้อมูลที่ดึงจาก ERP** (ยืนยัน 22 ส.ค. 2569): ดึง **item master + จำนวนคงเหลือ** เท่านั้น
บวก **บัญชีผู้ใช้จาก `menuuser`** (ตกลงเพิ่ม 4 ก.ย. 2569) · **ไม่** mirror รอบนับของ ERP — รอบนับทุกรอบเปิดจากแอปเราเอง

## สถานะโปรเจค

| ส่วน | สถานะ |
|---|---|
| ออกแบบสถาปัตยกรรม | ✅ เสร็จ ผ่านการตรวจเชิงปฏิปักษ์ 3 มุมมอง |
| ทดสอบเชื่อมต่อ ERP จริง | ✅ เชื่อมได้ สำรวจข้อมูลครบ (อ่านอย่างเดียว) |
| **UI (Flutter) — 8 หน้าจอ** | ✅ `flutter analyze` สะอาด · `flutter test` **59/59 ผ่าน** |
| **Backend (NestJS) — โครงครบ** | ✅ `tsc` สะอาด · boot ได้จริง · เทสต์ **259/259 ผ่าน** · CI รันทุก push |
| **ระบบผู้ใช้/login (บัญชีจาก ERP · hash เก็บที่เรา)** | ✅ **ใช้งานได้จริง** — `test/auth-integration.spec.ts` **36/36 ผ่าน** กับ Postgres จริง |
| ต่อ UI เข้ากับ backend (auth + members) | ✅ ตั้ง `API_BASE_URL` = ใช้ backend · ไม่ตั้ง = fixture สำหรับดู UI |
| **โมดูล Catalog / Count / Sync** | ✅ **ใช้งานได้จริง** — `test/count-cycle.spec.ts` **41/41 ผ่าน** กับ Postgres จริง |
| ล็อกอินด้วยบัญชี ERP (`menuuser`) แทน PIN 6 หลัก | ✅ ทั้ง sync ผู้ใช้ · จอล็อกอินใหม่ · ด่านกันเครื่องยิงบาร์โค้ด |
| **Offline-first layer (drift + outbox + SyncEngine)** | ✅ **ใช้งานได้จริง** — เทสต์ **19/19 ผ่าน** |
| ต่อหน้าจอ scan/search/count เข้า replica ในเครื่อง | ✅ สแกน/ค้นหา/นับ ทำงานได้แม้ออฟไลน์ |
| จอ pending-review + แถบสถานะซิงค์ | ✅ |
| **จอผู้ดูแล: เปิด/ปิดรอบ · ตัดสิน conflict · รายงานส่วนต่าง** | ✅ **ใช้งานได้จริง** — ทดสอบกับ backend ที่รันจริงครบวงจร |

## วงจรนับสต็อก (ทดสอบจริงแล้ว)

```
ERP (อ่านอย่างเดียว) → sync → items_cache → มือถือ (replica)
                                                  ↓
admin เปิดรอบนับ → freeze ยอดระบบ (count_snapshot)
                                                  ↓
พนักงานสแกน + กรอกจำนวนที่นับได้ → outbox → POST submissions (idempotent)
                                                  ↓
                        server คำนวณส่วนต่าง (v_variance)
                     ตรงกับระบบ / เกิน +n / ขาด -n / ยังไม่ได้นับ / นอกรายการ
                                                  ↓
admin ตัดสิน conflict → ปิดรอบ → closed_variance (เลขไม่เปลี่ยนย้อนหลัง)
                                                  ↓
                       รายงาน + export CSV (อ้างอิงภายใน)   ✗ ไม่กลับไป ERP
```

| กลไก | สถานะ |
|---|---|
| **Idempotency** — ส่งซ้ำด้วย UUIDv7 เดิม = `duplicate` ไม่นับซ้ำ | ✅ |
| **ผลรายบรรทัด** — batch 10 บรรทัดเสีย 1 บรรทัด อีก 9 ยังผ่าน (HTTP 200 เสมอ) | ✅ |
| **CONFLICT** — 2 เครื่องนับ SKU เดียวกัน → admin ตัดสิน **ไม่ auto-resolve** | ✅ |
| ปิดรอบขณะมี conflict ค้าง → **ปฏิเสธ** (ข้อมูลไม่หายเงียบ) | ✅ |
| **freeze จริง** — ยอดระบบใน snapshot ไม่เปลี่ยนแม้ item_cache อัปเดต | ✅ |
| ผลนับ **append-only** — DB ปฏิเสธ UPDATE/DELETE ที่ระดับ engine | ✅ |
| นับของนอกรายการ → `off_list` **diff เป็น null ไม่ใช่ 0** | ✅ |
| submission มาช้าหลังปิดรอบ → `SESSION_CLOSED` เข้าจอ pending-review | ✅ |
| สแกน **Code128 จาก ItemCode** ได้เท่ากับ EAN-13 | ✅ |
| tombstone guardrail — ลบเกิน 5%/รอบ = abort (กันดึง ERP ไม่ครบ) | ✅ |
| advisory lock กัน sync ซ้อนรอบ | ✅ |
| CSV header ไทย + BOM (Excel ไทยอ่านได้) | ✅ |

## Offline-first (คลังมีจุดอับสัญญาณ WiFi)

การสแกน ค้นหา และนับ **ทำงานได้ 100% โดยไม่มีเน็ต** — อ่านจาก replica ในเครื่อง เขียนเข้าคิวแล้วซิงค์ทีหลัง

| กลไก | รายละเอียด |
|---|---|
| Replica ในเครื่อง | drift/SQLite เก็บ item master + บาร์โค้ด + รอบนับ + ยอดระบบที่ freeze |
| Delta feed | ดึงเฉพาะที่เปลี่ยนด้วย cursor `row_version` + **tombstone** (ลบสินค้าที่ ERP เอาออก) |
| Outbox | ทุกการนับเข้าคิวพร้อม **UUIDv7** — retry กี่ครั้งก็ไม่นับซ้ำ · แอปถูก kill งานยังอยู่ |
| แก้ตัวเลขก่อนส่ง | แทนที่แถวเดิมในคิว ไม่ส่งซ้ำหลายรอบ |
| ลำดับการนับ | ใช้ **deviceSeq** (counter ใน DB) ไม่ใช้นาฬิกาเครื่องที่เชื่อไม่ได้ |
| probe จริงก่อนส่ง | สถานะ WiFi ≠ server ถึง → ยิง `GET /sync/status` ก่อนทุกครั้ง |
| Backoff | 2s → เพดาน 5 นาที + jitter · drain ทันทีเมื่อแอปกลับ foreground |
| งานถูกปฏิเสธ | ค้างไว้ในจอ **pending-review** พร้อมเหตุผลไทย — **ห้ามหายเงียบ** |
| แถบสถานะ | 'ออฟไลน์ · บันทึกไว้ในเครื่อง' · 'รอซิงค์ n รายการ' · 'ข้อมูล ณ HH:MM' |
| sign-out | หยุดซิงค์แต่ **ไม่ลบคิว** — งานนับที่ยังไม่ส่งต้องอยู่รอด |

## ระบบผู้ใช้ (บัญชีมาจาก ERP · ตัวยืนยันตัวตนเป็นของระบบเรา)

บัญชีและรหัสผ่านมาจากตาราง `menuuser` ของ ERP ผ่านรอบ sync ผู้ใช้ แล้ว hash เก็บไว้ใน
`user_credentials` ของเราเอง — **login ยังทำงานได้แม้ ERP ล่ม** (ไม่ query สดตอนล็อกอิน)
และ **plaintext ของ ERP ไม่ถูกเก็บ/ไม่ลง log/ไม่โผล่ในข้อความ error** ที่ใดเลย

| ความสามารถ | รายละเอียด |
|---|---|
| รหัสผ่าน | argon2id + server pepper · ค่าที่ hash คือรหัสผ่านของ ERP ที่ sync ดึงมา (ระบบเราไม่ตั้ง/ไม่รีเซ็ตรหัสผ่านให้ใคร) |
| ที่มาของบัญชี | `source='erp'` (จาก sync) · `source='local'` (break-glass CLI ที่ sync ห้ามแตะ) · `source='legacy_pin'` (PIN เดิมระหว่างเปลี่ยนผ่าน) |
| กัน brute force | **หน่วงเวลาแบบทวีคูณต่อชื่อผู้ใช้** (1s→2s→4s…) ไม่ล็อคบัญชี — กันคนอื่นยิงรหัสผ่านผิดเพื่อล็อคเพื่อนร่วมงาน |
| Token | access 15 นาที + refresh 30 วัน rotate ทุกครั้ง · เก็บเฉพาะ sha256 · **ผูกกับเครื่อง** |
| WiFi คลังหลุด | **grace window 60 วิ** — retry ด้วย token เดิมไม่ทำให้ถูกเตะออกจากระบบ |
| สิทธิ์ | admin / staff / viewer มาจาก `menuuser.user_level` แบบ **allowlist ล้วน** (level ที่ไม่ได้ map = ไม่ได้บัญชีเลย) · endpoint สำคัญ**ตรวจ role กับ DB** (`role_version`) ไม่เชื่อ JWT |
| เพิ่ม/แก้สมาชิก | **ไม่มี endpoint สร้างผู้ใช้/รีเซ็ตรหัสผ่านแล้ว** — เพิ่มคนที่ ERP แล้วรอ sync รอบถัดไป · `PATCH /members/:empId/role` ปฏิเสธบัญชีของ ERP ด้วย `ERP_MANAGED` |
| กันล็อคตัวเอง | ลด admin คนสุดท้ายไม่ได้ ทั้งฝั่งแอป · `PATCH role` · และรอบ sync (ทั้งรายแถวและทั้ง sweep) |
| Audit | ทุกการกระทำลง `audit_log` แบบ append-only · **ตรวจแล้วว่าไม่มีรหัสผ่านรั่ว** |

**สร้าง admin คนแรก** (แก้ปัญหาไก่กับไข่ — ยังไม่มี admin จึงสร้างผ่านแอปไม่ได้
และรอบ sync ผู้ใช้ **ปฏิเสธการรันทั้งรอบ** ถ้าไม่มี admin `source='local'` เหลืออยู่):

```bash
cd server
npm run db:schema                                    # สร้างตาราง
npm run build                                        # create-admin รันจาก dist/
npm run create-admin -- --emp-id 52901 --name "ชื่อ ผู้ดูแล" --shift "กะเช้า · A"
# → พิมพ์รหัสผ่านเริ่มต้นออกมาครั้งเดียว · ชื่อผู้ใช้คือรหัสพนักงานตัวพิมพ์เล็ก
```

⚠️ รหัสพนักงานของ admin break-glass ต้อง**ไม่ซ้ำกับแถวใดใน `menuuser`** มิฉะนั้นรอบ sync
จะเขียนสิทธิ์ตาม `user_level` ทับ (credential ไม่ถูกแตะ แต่ role ถูกลด) — ตัวอย่างใช้ `52901`
เพราะ fixture ของ `ERP_DRIVER=mock` จองช่วง `52101–52105` ไว้แล้ว

## สแต็กเทคโนโลยี

| ชั้น | เทคโนโลยี |
|---|---|
| Mobile App | **Flutter 3.44 / Dart 3.12** · Riverpod 3 · drift (SQLite) · mobile_scanner 7 |
| Backend API | **NestJS 11** (Fastify) · Node 22 · TypeScript 5.9 · zod |
| Database | **PostgreSQL 16** (system of record) · SQLite (offline-first บนเครื่อง) |
| ERP Integration | driver `sql` → **Microsoft SQL Server** (read-only) · `mock` สำหรับ dev/demo |
| Deployment | **Docker Compose**: api + postgres + caddy + backup sidecar |

## โครงสร้างโปรเจค

```
app/                      Flutter app
  lib/
    core/theme/tcl_tokens.dart    ⭐ design token ทั้งหมด (ห้ามฮาร์ดโค้ดสีที่อื่น)
    core/widgets/common.dart            widget ที่ใช้ร่วม
    data/models.dart · fixtures.dart    โมเดล + ข้อมูลตัวอย่างจาก design
    state/app_state.dart                Riverpod controller (พฤติกรรมทุกอย่างตาม design)
    features/login · shell · scan · search · count · team · pending
    features/admin/admin_screen.dart    ⭐ จอผู้ดูแล (design extension — ไม่มีใน design ต้นแบบ)
    local/local_db.dart                 ⭐ drift: replica + outbox (คิวผลนับออฟไลน์)
    local/sync_engine.dart              pull delta / drain outbox / probe server จริง
  test/widget_test.dart                 22 เทสต์ (ข้อความไทย, สิทธิ์, สแกน, ส่วนต่าง)
  test/offline_test.dart                19 เทสต์ (replica, outbox, รอบนับออฟไลน์)
  test/admin_test.dart                  18 เทสต์ (จอผู้ดูแล, null≠0, ตัวเลือก conflict)
  test/api_contract_test.dart           สัญญา HTTP ที่ Dio ส่งจริง (ต้องมี server)

server/                   NestJS backend
  sql/erp/inventory-items-with-balance.sql  ⭐ item master + ยอดคงเหลือ (สูตรจากฝ่าย ERP)
  sql/erp/verify-balance.sql            diagnostic ตรวจสูตรก่อนเชื่อตัวเลข (อ่านอย่างเดียว)
  scripts/verify-erp.ts                 `npm run verify:erp` ตรวจสิทธิ์ + ความแม่นของยอด
  scripts/simulate.ts                   `npm run simulate` จำลองวันนับสต็อกทั้งวันผ่าน HTTP จริง
                                        (ต้องตั้ง SIM_ADMIN_EMP/SIM_ADMIN_PIN · บัญชีพนักงานมาจาก `POST /sync/users`)
  src/config/env.config.ts              zod ตรวจ .env ตอน boot (fail fast บอกชื่อตัวแปร)
  src/erp/erp-adapter.ts                ⭐ สัญญา read-only + statement guard + compile guard
  src/erp/drivers/mssql.driver.ts       SQL Server driver + boot write-probe + charset ไทย
  src/erp/drivers/mock.driver.ts        fixture จาก design
  db/schema.sql                         Postgres schema 13 ตาราง + view v_variance
  docker-compose.yml · Dockerfile · Caddyfile
  src/sync/sync.module.ts               ⭐ รอบ sync items + ผู้ใช้ (allowlist · last-admin floor · grace)
  test/erp-read-only.spec.ts            24 เทสต์กฎเหล็ก read-only
  test/erp-items-script.spec.ts         25 เทสต์ล็อกเงื่อนไขสูตรยอดคงเหลือ
  test/catalog-sync.spec.ts             29 เทสต์ tombstone guardrail + delta feed (ต้องมี Postgres)
  test/users-sync.spec.ts               ⭐ เทสต์ sync ผู้ใช้: last-admin floor · allowlist · grace (ต้องมี Postgres)
  test/auth-crypto.spec.ts              23 เทสต์ argon2 + pepper + sha256 + TTL
  test/variance-csv.spec.ts             26 เทสต์ CSV ไทย (BOM, null≠0, formula injection)
  test/auth-integration.spec.ts         36 เทสต์ login/refresh/throttle/audit (ต้องมี Postgres)
  test/count-cycle.spec.ts              41 เทสต์วงจรนับเต็มวงจร (ต้องมี Postgres)

docs/                     เอกสารออกแบบ (อ่าน erp-tcl-findings.md ก่อน)
Mobile Stock Check System/  design ต้นแบบ (authoritative)
```

## เอกสาร

| เอกสาร | เนื้อหา |
|---|---|
| [`docs/erp-tcl-findings.md`](docs/erp-tcl-findings.md) | **⭐ อ่านก่อน** — ผลสำรวจ ERP จริง, ความครบของข้อมูล, ประเด็นความปลอดภัย, การตัดสินใจ |
| [`docs/architecture.md`](docs/architecture.md) | สถาปัตยกรรมเต็ม: data flow, DB schema, API, offline sync, auth, deployment |
| [`docs/design-fidelity.md`](docs/design-fidelity.md) | สัญญาความตรงกับ design: token ทุกตัว, ทุกจอ/สถานะ, ข้อความไทยทุกข้อความ |
| [`docs/erp-integration.md`](docs/erp-integration.md) | สัญญา ERP adapter + กฎเหล็ก 5 ชั้น + โหมดล้มเหลว |
| [`docs/deploy-vps.md`](docs/deploy-vps.md) | **ติดตั้งบน VPS** ที่มีหลายโปรเจค — โครงโฟลเดอร์, กันพอร์ตชน, secret, backup |

## เริ่มพัฒนา

```bash
# ── Mobile ──
cd app
flutter pub get
flutter run                # ใช้ข้อมูลตัวอย่างจาก design ได้ทันที ไม่ต้องมี backend
flutter test               # 59 เทสต์ (UI + offline + จอผู้ดูแล)
flutter analyze

# ── Backend ──
cd server
npm install
cp ../.env.example .env    # กรอกค่าจริง (ไฟล์ .env ไม่ถูก commit)
npm run db:schema          # สร้างตารางใน Postgres
npm run build              # ต้อง build ก่อน — create-admin รันจาก dist/ (ไม่ใช่ ts-node)
npm run create-admin -- --emp-id 52901 --name "ชื่อ ผู้ดูแล"
npm run start:dev          # ERP_DRIVER=mock ใช้ได้เลยไม่ต้องต่อ ERP
npm run test:unit          # 104 เทสต์ ไม่ต้องมี DB
npx jest                   # ทั้งหมด — ข้าม integration อัตโนมัติถ้าไม่มี DB

# ── เทสต์ที่ต้องใช้ Postgres จริง (trigger append-only, advisory lock, v_variance) ──
docker run -d --name tcl-test-pg \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_USER=tcl \
  -e POSTGRES_DB=tcl_test -p 55432:5432 postgres:16-alpine
export TEST_DATABASE_URL='postgres://tcl:testpw@localhost:55432/tcl_test'
npx jest                   # 181 เทสต์ครบทุกชุด

# ── แอปต่อ backend จริง ──
cd app
flutter run --dart-define=API_BASE_URL=http://192.168.1.10:8080

# ── ทั้งระบบบนเซิร์ฟเวอร์ LAN ──
docker compose up -d
```

ตรวจสุขภาพ: `GET /healthz` (liveness) · `GET /healthz/erp` (สถานะ ERP แยก — ERP ล่มไม่ทำให้ container unhealthy)

## งานที่รออยู่

**รอจากฝ่าย ERP**
1. **login สิทธิ์ `db_datareader`** สำหรับต่อ ERP — จำเป็นก่อนใช้งานจริง
   (boot probe ปฏิเสธการ start ถ้า login เขียน ERP ได้)
2. ~~script/query ยอดคงเหลือ~~ ✅ **เสร็จและตรวจกับข้อมูลจริงแล้ว 22 ส.ค. 2569**
   `server/sql/erp/inventory-items-with-balance.sql` (ชี้ด้วย `ERP_SQL_ITEMS_SQL_FILE`)
   เทียบกับ `tbl_CountDtl.MainQty` ของ ERP: **100% ตรง** 2 รอบนับ (93/93 และ 96/96)
   ปริศนา "52.1%" เดิมคือจุดตัดวันที่ ไม่ใช่สูตรผิด (ดู `docs/erp-tcl-findings.md` §6.6)
   🔴 ใช้ได้เฉพาะคลัง **WHFG** — `WHRM` ไม่มีข้อมูลใน ledger ต้องถามฝ่าย ERP
3. จำกัดการเข้าถึงพอร์ต ERP ให้เฉพาะเซิร์ฟเวอร์แอป (firewall/VPN) + ตั้ง `ERP_SQL_ENCRYPT=true`

**ฝั่งพัฒนา**
4. ตัดสินกติกา **ItemCode ซ้ำ 85 รหัส** (ตอนนี้ driver ใช้ "Roworder สูงสุดชนะ")
5. ฟีเจอร์พิมพ์ฉลาก **Code128 จาก ItemCode** (บาร์โค้ดเดิมมีแค่ 1.9%)
6. ~~หน้าจอ admin~~ ✅ เสร็จแล้ว — เข้าผ่านปุ่ม **จัดการรอบนับ** ในจอนับ (เห็นเฉพาะผู้ดูแล)
   ⚠️ จอนี้ไม่มีใน design ต้นแบบ สร้างจาก token/pattern เดิมทั้งหมด — ถ้ามี design ทีหลังให้ปรับตาม
7. ทดสอบบนเครื่องจริง: กล้อง/สแกน/ฟอนต์ไทย + acceptance gate ≥95% first-pass EAN-13
8. TLS บน LAN: bundle root CA ของ Caddy เข้าแอป + pin (ดู architecture.md §8.2)
