# คู่มือติดตั้งบน VPS (หลายโปรเจคในเครื่องเดียว)

> เขียนสำหรับ VPS ที่**มีโปรเจคอื่นรันอยู่แล้ว** — ทุกอย่างในนี้ตั้งใจให้ไม่ชนกับของเดิม
> ตรวจแล้วกับ image ที่ build จริง (`kittikhun/stock-api:4.0.0`) เมื่อ 22 ส.ค. 2569

---

## 0. ก่อนเริ่ม — เช็ค 3 อย่างบน VPS

```bash
# 1) มีอะไรจอง 80/443 อยู่แล้วไหม  ← สำคัญที่สุด
sudo ss -tlnp | grep -E ':(80|443)\s'

# 2) docker + compose plugin
docker --version && docker compose version

# 3) ชื่อที่ถูกใช้ไปแล้ว (กันชน)
docker ps -a --format '{{.Names}}'
docker volume ls --format '{{.Name}}'
```

**ผลของข้อ 1 เป็นตัวกำหนดว่าจะใช้แบบ A หรือ B ในหัวข้อ 4**

---

## 1. โครงโฟลเดอร์ที่ต้องสร้าง

โปรเจคนี้ใช้ `build:` จาก source จึงต้องมีทั้ง repo ไม่ใช่แค่ compose file

```
/srv/kittikhun/                     ← โฟลเดอร์โปรเจค (ชื่ออะไรก็ได้)
└── server/                         ← ทำงานทุกคำสั่งจากในนี้
    ├── docker-compose.yml          (มากับ repo)
    ├── Dockerfile                  (มากับ repo)
    ├── Caddyfile                   (มากับ repo)
    ├── src/  db/  sql/             (มากับ repo)
    ├── .env                        ⚠️ สร้างเอง — ไม่มีใน repo
    ├── config/                     ⚠️ สร้างเอง — ว่างไว้ก็ได้
    ├── public/                     ⚠️ สร้างเอง — ไฟล์แจก (APK, root CA)
    └── secrets/ssh/                (สร้างเมื่อจะส่ง backup ออกนอกเครื่อง)
```

`config/` `public/` `secrets/` ไม่มีใน git โดยตั้งใจ (กันไฟล์ความลับหลุด)
**ถ้าไม่สร้างไว้ก่อน Docker จะสร้างให้เองเป็นของ root แล้วเขียนไม่ได้ทีหลัง**

### คำสั่ง

```bash
sudo mkdir -p /srv/kittikhun
sudo chown "$USER":"$USER" /srv/kittikhun
cd /srv/kittikhun

git clone https://github.com/innovera2025/kittikhun.git .
cd server

mkdir -p config public secrets/ssh
chmod 700 secrets secrets/ssh
```

---

## 2. ทำไมไม่ชนกับโปรเจคอื่น

| สิ่งที่มักชนกัน | โปรเจคนี้ | ชนไหม |
|---|---|---|
| ชื่อ compose project | `kittikhun` (ตั้งไว้ในไฟล์แล้ว) | ✅ ไม่ชน |
| ชื่อ volume | `kittikhun_pgdata`, `kittikhun_caddy_data`, … | ✅ ไม่ชน (มี prefix อัตโนมัติ) |
| ชื่อ network | `kittikhun_default` | ✅ ไม่ชน |
| ชื่อ container | `kittikhun-api-1`, `kittikhun-postgres-1`, … | ✅ ไม่ชน |
| **พอร์ต 80 / 443** | Caddy จองไว้ | 🔴 **ชนแน่ถ้ามี reverse proxy อื่นอยู่** |
| พอร์ต Postgres | ไม่ publish ออก host | ✅ ไม่ชน |
| พอร์ต API | `expose` เท่านั้น ไม่ publish | ✅ ไม่ชน |

→ เรื่องเดียวที่ต้องตัดสินใจคือพอร์ต 80/443 (หัวข้อ 4)

---

## 3. สร้างไฟล์ `.env`

```bash
cd /srv/kittikhun/server
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
POSTGRES_DB=kittikhun
POSTGRES_PASSWORD=<ที่สร้างไว้>
DATABASE_URL=postgres://stock:<รหัสเดียวกัน>@postgres:5432/kittikhun

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

> ⚠️ `DATABASE_URL` ใช้ host ว่า `postgres` (ชื่อ service ใน compose) ไม่ใช่ `localhost`

---

## 4. เลือกวิธีรับ traffic — ตัดสินจากผลข้อ 0

### แบบ A — ยังไม่มีอะไรใช้ 80/443

ใช้ Caddy ของโปรเจคนี้ได้เลย ไม่ต้องแก้อะไร แค่แก้ `Caddyfile` บรรทัดแรกให้ใช้ TLS จริง:

```caddyfile
{$CADDY_SITE} {
	# ลบ `tls internal` ออก → Caddy ขอใบรับรอง Let's Encrypt อัตโนมัติ
	handle /api/* {
		uri strip_prefix /api
		reverse_proxy api:8080
	}
	...
}
```

> `tls internal` มีไว้สำหรับ LAN ที่ไม่มีโดเมนจริง — บน VPS ที่มีโดเมนต้องเอาออก
> ไม่งั้นมือถือจะไม่เชื่อใบรับรอง

### แบบ B — มี reverse proxy อื่นอยู่แล้ว (พบบ่อยที่สุด)

ให้ proxy เดิมเป็นทางเข้า แล้วปิด Caddy ของเรา — สร้างไฟล์ override:

```bash
cat > docker-compose.override.yml <<'EOF'
# VPS นี้มี reverse proxy อยู่แล้ว → ไม่ใช้ Caddy ของโปรเจคนี้
# และเปิด API ที่ 127.0.0.1 เท่านั้นให้ proxy เดิมต่อเข้ามา (ไม่โผล่ออกอินเทอร์เน็ต)
services:
  caddy:
    profiles: ["ไม่ใช้"]
  api:
    ports:
      - "127.0.0.1:18080:8080"
EOF
```

แล้วชี้ proxy เดิมมาที่ `http://127.0.0.1:18080`
(nginx: `proxy_pass http://127.0.0.1:18080;` · Caddy: `reverse_proxy 127.0.0.1:18080`)

> เลือกเลข 18080 ให้ไม่ชนของเดิม — เช็คด้วย `ss -tlnp | grep 18080`

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
cd /srv/kittikhun/server

docker compose build            # ครั้งแรกเท่านั้น (~2 นาที)
docker compose up -d

docker compose ps               # ต้องเห็น api/postgres เป็น healthy
docker compose logs -f api      # ดูว่ามีอะไรผิดไหม
```

### สร้าง admin คนแรก

```bash
docker compose exec api node dist/cli/create-admin.js \
  --emp-id 52104 --name "ชื่อ ผู้ดูแล" --shift "กะเช้า · A"
# → พิมพ์ PIN เริ่มต้นครั้งเดียว · login แล้วระบบบังคับตั้ง PIN ใหม่
```

### ตรวจว่าขึ้นจริง

```bash
curl -s http://127.0.0.1:18080/healthz          # แบบ B
curl -s https://stock.example.com/healthz       # แบบ A
```

---

## 7. Backup — ต้องตั้ง ไม่งั้นไม่ถือว่ามี backup

`pg_dump` ที่ยังอยู่ในเครื่องเดียวกับฐานข้อมูล **ไม่ใช่ backup**
ต้องตั้งอย่างน้อยหนึ่งอย่างใน `.env`:

```bash
BACKUP_REMOTE_TARGET=backup@nas.example.com:/volume1/kittikhun/
BACKUP_SSH_KEY=/keys/id_ed25519
# แล้ว mount: ./secrets/ssh:/keys:ro
```

ผลนับและส่วนต่างเป็นข้อมูลที่**สร้างใหม่ไม่ได้** — หายแล้วหายเลย

---

## 8. ชี้แอปมือถือมาที่ VPS

```bash
cd app
flutter build apk --release \
  --dart-define=API_BASE_URL=https://stock.example.com/api
```

> ⚠️ ต้องมี keystore สำหรับ release build (ยังไม่ได้ตั้ง — ดู "งานที่รออยู่" ข้อ 5 ใน README)
> ระหว่างทดสอบใช้ `flutter run --dart-define=...` กับมือถือที่เสียบสายได้เลย ไม่ต้องมี keystore

---

## 9. อัปเดตเวอร์ชันใหม่

```bash
cd /srv/kittikhun && git pull
cd server && docker compose build api && docker compose up -d api
```

ข้อมูลอยู่ใน volume ไม่หายไปกับการ rebuild
`docker compose down` ปลอดภัย · **`docker compose down -v` ลบข้อมูลทั้งหมด — ห้ามใช้**
