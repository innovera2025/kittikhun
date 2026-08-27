# คู่มือติดตั้งบน VPS (หลายโปรเจคในเครื่องเดียว)

> เขียนสำหรับ VPS จริงของโปรเจคนี้: **Ubuntu · รันเป็น root · โปรเจคอยู่ใต้ `/opt/`**
> ของเดิมในเครื่อง: `api-pueanphet` · `orderstock`
> (`containerd` เป็นของ Docker ไม่ใช่โปรเจค — ห้ามแตะ)
>
> ตรวจแล้วกับ image ที่ build จริง (`tcl/stock-api:4.0.0`)

---

## 0. ก่อนเริ่ม — เช็ค 3 อย่างบน VPS

รันชุดนี้ทีเดียวแล้วเก็บผลไว้ — **ผลของข้อ 1 เป็นตัวกำหนดว่าจะใช้แบบ A หรือ B ในหัวข้อ 4**

```bash
echo '── 1) พอร์ตที่ถูกจองแล้ว (สำคัญสุด) ──'
ss -tlnp | grep -E ':(80|443|5432|8080|18080)\s' || echo '  ว่างทั้งหมด'

echo '── 2) docker ──'
docker --version; docker compose version

echo '── 3) ของเดิมที่รันอยู่ ──'
docker ps --format 'table {{.Names}}\t{{.Ports}}'

echo '── 4) ชื่อที่ถูกใช้แล้ว (ต้องไม่มีคำว่า tcl) ──'
docker network ls --format '{{.Name}}'
docker volume ls --format '{{.Name}}' | head -20

echo '── 5) ทรัพยากรพอไหม (ต้องการดิสก์ว่าง ~3GB, RAM 1GB+) ──'
df -h /opt | tail -1; free -h | head -2
```

---

## 1. โครงโฟลเดอร์ที่ต้องสร้าง

โปรเจคนี้ใช้ `build:` จาก source จึงต้องมีทั้ง repo ไม่ใช่แค่ compose file

```
/opt/
├── api-pueanphet/              ← ของเดิม ห้ามแตะ
├── orderstock/                 ← ของเดิม ห้ามแตะ
├── containerd/                 ← ของ Docker ห้ามแตะ
└── tcl/                  ★ สร้างใหม่
    └── server/                 ← ทำงานทุกคำสั่งจากในนี้
        ├── docker-compose.yml  (มากับ repo)
        ├── Dockerfile          (มากับ repo)
        ├── Caddyfile           (มากับ repo)
        ├── src/  db/  sql/     (มากับ repo)
        ├── (ไฟล์ตั้งค่า)        ⚠️ สร้างเอง — ไม่มีใน repo
        ├── config/             ⚠️ สร้างเอง — ว่างไว้ก็ได้
        ├── public/             ⚠️ สร้างเอง — ไฟล์แจก (APK, root CA)
        └── secrets/ssh/        (สร้างเมื่อจะส่ง backup ออกนอกเครื่อง)
```

`config/` `public/` `secrets/` ไม่มีใน git โดยตั้งใจ (กันไฟล์ความลับหลุด)
**ถ้าไม่สร้างไว้ก่อน Docker จะสร้างให้เองเป็นของ root แล้วเขียนไม่ได้ทีหลัง**

### คำสั่ง

```bash
mkdir -p /opt/tcl
cd /opt/tcl

git clone https://github.com/innovera2025/tcl.git .
cd server

mkdir -p config public secrets/ssh
chmod 700 secrets secrets/ssh
```

> รันเป็น root อยู่แล้วจึงไม่ต้อง `sudo` / `chown`
> แต่ `chmod 700 secrets` ยังจำเป็น — กันคีย์ backup ถูกอ่านจาก process อื่นในเครื่อง

---

## 2. ทำไมไม่ชนกับโปรเจคอื่น

| สิ่งที่มักชนกัน | โปรเจคนี้ | ชนไหม |
|---|---|---|
| ชื่อ compose project | `tcl` (ตั้งไว้ในไฟล์แล้ว) | ✅ ไม่ชน |
| ชื่อ volume | `tcl_pgdata`, `tcl_caddy_data`, … | ✅ ไม่ชน (มี prefix อัตโนมัติ) |
| ชื่อ network | `tcl_default` | ✅ ไม่ชน |
| ชื่อ container | `tcl-api-1`, `tcl-postgres-1`, … | ✅ ไม่ชน |
| **พอร์ต 80 / 443** | ปิด Caddy ของเราด้วย override | ✅ ไม่ชน (ใช้ caddy-gen-proxy แทน) |
| พอร์ต Postgres | ไม่ publish ออก host | ✅ ไม่ชน |
| พอร์ต API | `expose` เท่านั้น ไม่ publish | ✅ ไม่ชน |

→ เรื่องเดียวที่ต้องตัดสินใจคือพอร์ต 80/443 (หัวข้อ 4)

---

## 3. สร้างไฟล์ `.env`

```bash
cd /opt/tcl/server
cp ../.env.example .env    # ถ้าไม่มีให้เขียนใหม่ตามด้านล่าง
chmod 600 .env
```

### สร้าง secret 3 ตัว — ห้ามใช้ค่าจากที่อื่น

```bash
echo "JWT_ACCESS_SECRET=$(openssl rand -hex 32)"
echo "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
echo "PIN_PEPPER=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')"
```

> 🔴 **`PIN_PEPPER` เปลี่ยนทีหลังไม่ได้** — PIN ของพนักงานทุกคนจะใช้ไม่ได้ทันที
> ต้องตั้งให้ถูกตั้งแต่ครั้งแรก และเก็บสำรองไว้ที่ปลอดภัย

### ค่าที่ต้องมีอย่างน้อย

```bash
# ── แอป ──
NODE_ENV=production
APP_PORT=8080
TZ=Asia/Bangkok
WAREHOUSE_CODE=WHFG            # คลังที่ ledger มีข้อมูลจริง (ไม่ใช่ WH-BKK-02)
APP_MIN_VERSION=4.0.0

# ── Postgres (ต้องตรงกันทั้ง 3 บรรทัดกับ DATABASE_URL) ──
POSTGRES_USER=stock
POSTGRES_DB=tcl
POSTGRES_PASSWORD=<ที่สร้างไว้>
DATABASE_URL=postgres://stock:<รหัสเดียวกัน>@tcl-db:5432/tcl   # ⚠️ ชื่อ alias ไม่ใช่ postgres

# ── ความลับ ──
JWT_ACCESS_SECRET=<hex 32>
JWT_REFRESH_SECRET=<hex 32>
PIN_PEPPER=<hex 32>

# ── โดเมน ──
CADDY_SITE=stock.example.com   # ต้องชี้ A record มาที่ IP ของ VPS แล้ว
CORS_ORIGINS=https://stock.example.com

# ── ERP ──
ERP_DRIVER=mock                # ⚠️ ดูหัวข้อ 5 ก่อนเปลี่ยนเป็น sql
```

> ⚠️ `DATABASE_URL` ใช้ host ว่า **`tcl-db`** (alias ที่ override ตั้งไว้) ไม่ใช่ `postgres` และไม่ใช่ `localhost`

---

## 4. รับ traffic ผ่าน caddy-gen-proxy ที่มีอยู่แล้ว

**ผลสำรวจของ VPS เครื่องนี้ (23 ส.ค. 2569):**

| พอร์ต | ใครจอง |
|---|---|
| 80 / 443 | `caddy-gen-proxy` |
| 8080 | `qtso-backend-app-php-restserver-1` |
| 3000 · 8081 · 9000 · 14339 | qtso-app · code-server · portainer · mssql |

→ **ห้ามใช้ Caddy ของโปรเจคนี้** และ **ห้าม publish พอร์ตใด ๆ ออก host**

`caddy-gen-proxy` เป็น caddy-gen: มันอ่าน **label ของ container** แล้วสร้าง Caddy config
พร้อมขอใบรับรอง Let's Encrypt ให้เองอัตโนมัติ ทางเข้าที่ถูกต้องคือเข้า network `proxy-network`
แล้วติด label — ไม่ต้องแก้อะไรที่ proxy เลย

### ก่อนใช้ — ตรวจรูปแบบ label ที่เครื่องนี้ใช้จริง

```bash
docker inspect qtso-app --format '{{json .Config.Labels}}' | python3 -m json.tool
```

ถ้าเห็น `virtual.host` / `virtual.port` / `virtual.tls-email` = ตรงกับไฟล์ที่เตรียมไว้
ถ้าเป็นคีย์อื่น ให้แก้ 3 บรรทัดใน `deploy/vps.override.yml` ให้ตรง

### ใช้งาน

`deploy/vps.override.yml` มีมากับ repo แล้ว — เพิ่ม 2 บรรทัดนี้ในไฟล์ตั้งค่า:

```bash
PUBLIC_HOST=stock.example.com     # โดเมนที่ชี้ A record มาที่ VPS แล้ว
TLS_EMAIL=you@example.com         # อีเมลสำหรับ Let's Encrypt
```

แล้วรันด้วย override เสมอ:

```bash
docker compose -f docker-compose.yml -f deploy/vps.override.yml up -d
```

> เช็คว่าถูกต้อง: `... config` แล้วต้องเห็น **ไม่มี service ไหน publish พอร์ตออก host เลย**
> และ `api` อยู่ทั้ง `default` (คุยกับ postgres) และ `proxy-network` (ให้ proxy เห็น)

### 🔴 ทุก service ต้องอยู่ network เดียว — ห้ามเพิ่ม

caddy-gen ปล่อย **ทุก IP** ของ container ที่มี label `virtual.host` เข้าไปใน
`reverse_proxy` แบบ `round_robin` ถ้า container อยู่ 2 network มันจะได้ 2 IP
แล้ว caddy สลับส่งไปทั้งคู่ — ตัวที่อยู่บน network ภายในของเรา caddy เข้าไม่ถึง

**อาการ: 502 สลับ 200 เป๊ะ 50%** (เจอจริง 24 ส.ค. 2569)

```
tcl.krs.co.th {
  reverse_proxy {
    lb_policy round_robin
    to 172.18.0.12:8080   ← proxy-network      เข้าถึงได้
    to 172.20.0.4:8080    ← tcl_default  เข้าไม่ถึง → 502
```

`deploy/vps.override.yml` จึงบังคับให้ทุก service อยู่ `proxy-network` เท่านั้น

**กับดักที่ตามมา:** `proxy-network` แชร์กับทุกโปรเจคในเครื่อง ชื่อ service `postgres`
เฉย ๆ อาจชนกับ postgres ของโปรเจคอื่น แล้วแอปต่อฐานข้อมูลผิดตัวโดยไม่มีอะไรฟ้อง
→ override ตั้ง alias `tcl-db` ไว้ **`DATABASE_URL` ต้องชี้มาที่ชื่อนี้**:

```bash
DATABASE_URL=postgres://stock:<รหัส>@tcl-db:5432/tcl
```

ตรวจก่อน `up` ทุกครั้งว่าไม่มี service ไหนอยู่หลาย network:

```bash
kk config | grep -A3 'networks:'
```

### ⚠️ `docker compose` ยังไม่มีในเครื่อง

`docker compose version` ตอบว่า `unknown command` — มีแต่ Docker engine ยังไม่มี compose v2

```bash
apt-get update
apt-get install -y docker-compose-v2     # Ubuntu 24.04
# ถ้าไม่มี package นี้ ให้ใช้: apt-get install -y docker-compose-plugin
docker compose version                   # ต้องขึ้น v2.x
```

> ⚠️ `docker-compose` (v1, ขีดกลาง) ใช้ไม่ได้กับไฟล์นี้ — ไม่รองรับ `name:` และ `profiles:`

### ⚠️ RAM เหลือ 1.3 GB

stack นี้ใช้เพิ่มราว 400–500 MB (postgres + api + backup sidecar) — พอ แต่ไม่เหลือมาก
ถ้าตึงให้ปิด backup sidecar ชั่วคราวด้วย `--scale backup=0` แล้วค่อยเปิดเมื่อจัด backup จริง

---

## 5. ⚠️ ERP: ตอนนี้ยังต่อของจริงไม่ได้

`ERP_DRIVER=sql` จะทำให้ **API ไม่ start และ restart วนไปเรื่อย ๆ** เพราะ:

1. `env.config.ts` ปฏิเสธ `ERP_SQL_USER=sa` ตั้งแต่อ่านคอนฟิก
2. `verifyReadOnly()` ตรวจสิทธิ์แล้วเจอว่าเขียน ERP ได้ → ปฏิเสธ start

**ต้องได้ login `db_datareader` จากฝ่าย ERP ก่อนเท่านั้น**

### deploy ด้วย mock ไปก่อน แล้วสลับทีหลัง

ตั้ง `ERP_DRIVER=mock` ขึ้นระบบก่อน — ทดสอบได้ครบทุกอย่างยกเว้นยอดสินค้าจริง
พอได้ login แล้วสลับโดย **ไม่ต้อง build ใหม่**:

```bash
# แก้ .env
ERP_DRIVER=sql
ERP_SQL_HOST=<host ของ ERP>
ERP_SQL_PORT=1433
ERP_SQL_DATABASE=db_TCL
ERP_SQL_USER=<login db_datareader>
ERP_SQL_PASSWORD=<รหัส>
ERP_SQL_ENCRYPT=true
ERP_SQL_TRUST_SERVER_CERT=true
ERP_SQL_CHARSET=utf8
ERP_SQL_ITEMS_SQL_FILE=/app/sql/erp/inventory-items-with-balance.sql

docker compose up -d api      # แค่นี้
```

> `/app/sql/erp/...` เป็นพาธ**ในคอนเทนเนอร์** ไฟล์ถูก COPY เข้า image แล้ว
> ไม่ต้องวางไฟล์เองบนเครื่อง

### 🔴 ก่อนเปิด `ERP_DRIVER=sql` ต้องคุยกับฝ่ายไอที

VPS อยู่นอกองค์กร → ต้องให้ ERP ยอมรับการเชื่อมต่อจาก **IP ของ VPS**
ขอให้จำกัด firewall ให้เฉพาะ IP นี้ (ไม่ใช่เปิดทั้งอินเทอร์เน็ต) และเปิด TLS ที่ SQL Server

---

## 6. คำสั่งขึ้นระบบ

```bash
cd /opt/tcl/server

# ตั้ง alias ให้พิมพ์สั้นลง (ต้องใช้ override ทุกครั้ง)
alias kk='docker compose -f docker-compose.yml -f deploy/vps.override.yml'

kk build            # ครั้งแรกเท่านั้น (~2 นาที)
kk up -d

kk ps               # ต้องเห็น api/postgres เป็น healthy
kk logs -f api      # ดูว่ามีอะไรผิดไหม
```

### สร้าง admin คนแรก

```bash
kk exec api node dist/cli/create-admin.js \
  --emp-id 52104 --name "ชื่อ ผู้ดูแล" --shift "กะเช้า · A"
# → พิมพ์ PIN เริ่มต้นครั้งเดียว · login แล้วระบบบังคับตั้ง PIN ใหม่
```

### ตรวจว่าขึ้นจริง

```bash
# จากในเครื่อง (ผ่าน network ภายใน)
docker compose -f docker-compose.yml -f deploy/vps.override.yml exec api \
  node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)"

# จากภายนอก (ผ่าน caddy-gen-proxy)
curl -s https://stock.example.com/healthz
```

---

## 7. Backup — ต้องตั้ง ไม่งั้นไม่ถือว่ามี backup

`pg_dump` ที่ยังอยู่ในเครื่องเดียวกับฐานข้อมูล **ไม่ใช่ backup**
ต้องตั้งอย่างน้อยหนึ่งอย่างใน `.env`:

```bash
BACKUP_REMOTE_TARGET=backup@nas.example.com:/volume1/tcl/
BACKUP_SSH_KEY=/keys/id_ed25519
# แล้ว mount: ./secrets/ssh:/keys:ro
```

ผลนับและส่วนต่างเป็นข้อมูลที่**สร้างใหม่ไม่ได้** — หายแล้วหายเลย

---

## 8. ชี้แอปมือถือมาที่ VPS

```bash
cd app
flutter build apk --release \
  --dart-define=API_BASE_URL=https://stock.example.com
```

> 🔴 **ลืมใส่ `--dart-define=API_BASE_URL` แล้วแอปจะไม่พังแบบเห็นชัด — มันจะเงียบ**
> `ApiConfig.baseUrl` มี `defaultValue: ''` (`app/lib/data/api_client.dart:39-42`) ค่าว่าง =
> `isConfigured` เป็น false = แอปเข้าโหมด fixture ทั้งเครื่อง: ขึ้นคลัง `WH-BKK-02`
> ผู้ใช้ `Tcl S./ADMIN` สแกนอะไรก็ "ไม่พบ" (ค้นใน fixture 5 ตัว ไม่ยิงเน็ตเลย) และ
> **login ไม่ตรวจ PIN** — ห้ามแจก build แบบนี้ให้ใครเด็ดขาด
>
> **ห้ามต่อ `/api` ท้าย URL** — API เสิร์ฟที่ root (ตรวจแล้วกับเครื่องจริง 27 ส.ค. 2569:
> `/healthz` → 200 · `/api/healthz` → 404) และแอปต่อ path เช่น `/auth/login` ท้าย baseUrl ตรง ๆ
>
> **ตรวจว่า build ถูกต้องก่อนแจก** — เปิดหน้า login: ถ้ายังมีชิป `WH-BKK-02` ข้าง `v4.0`
> แปลว่าเป็น fixture build (ชิปนี้เรนเดอร์เฉพาะตอน `!isConfigured` — `login_screen.dart:399-402`)
> หรือตรวจจากไฟล์ APK ตรง ๆ (ต้องได้มากกว่า 0):
> ```bash
> unzip -p build/app/outputs/flutter-apk/app-release.apk lib/arm64-v8a/libapp.so \
>   | grep -ao 'stock\.example\.com' | wc -l
> ```
> ⚠️ อย่าใช้ `| strings |` ในคำสั่งนี้ — `strings` บน macOS อ่าน stdin ไม่ได้ จะคืน 0 เสมอ
> ทำให้เข้าใจผิดว่า build พลาดทั้งที่ถูกต้องแล้ว ใช้ `grep -a` ตรง ๆ กับสตรีมไบนารี
>
> ⚠️ ต้องมี keystore สำหรับ release build (ยังไม่ได้ตั้ง — ดู "งานที่รออยู่" ข้อ 5 ใน README)
> ระหว่างทดสอบใช้ `flutter run --dart-define=...` กับมือถือที่เสียบสายได้เลย ไม่ต้องมี keystore

---

## 9. อัปเดตเวอร์ชันใหม่

```bash
cd /opt/tcl && git pull
cd server && kk build api && kk up -d api
```

ข้อมูลอยู่ใน volume ไม่หายไปกับการ rebuild
`docker compose down` ปลอดภัย · **`docker compose down -v` ลบข้อมูลทั้งหมด — ห้ามใช้**
