#!/usr/bin/env bash
#
# อัปเดต TCL Stock API บน VPS — รันจาก /opt/tcl/server เท่านั้น
#
#   bash deploy/update.sh
#
# ลำดับ: ตรวจก่อน → backup → git pull → migrate → build → up → ตรวจผล
# ทุกขั้นที่ล้มจะหยุดทันทีและไม่ทำขั้นถัดไป (set -e) — ไม่มีขั้นไหนลบข้อมูล
#
# ⚠️ รอบนี้ schema เปลี่ยน (คอลัมน์ erp_writeback.claimed_at + UNIQUE index
#    กันเปิดรอบซ้อนต่อคลัง) การ migrate จะ **ล้มโดยตั้งใจ** ถ้าตอนนี้มีรอบเปิด
#    ซ้อนกันอยู่ สคริปต์จึงตรวจให้ก่อนตั้งแต่ต้น จะได้ไม่ค้างกลางทาง
#
set -euo pipefail

COMPOSE="docker compose -f docker-compose.yml -f deploy/vps.override.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="./backups-local"

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

# psql ในคอนเทนเนอร์ — อ่าน SQL จาก stdin (ชื่อ user/db มาจาก env ของคอนเทนเนอร์เอง)
psql_run()   { $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'; }
psql_value() { $COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA'; }

# ── 0. อยู่ถูกที่ไหม ────────────────────────────────────────────────────────
say "0. ตรวจสภาพก่อนแตะอะไร"
[ -f docker-compose.yml ] && [ -d db ] || die "ต้องรันจาก /opt/tcl/server (ไม่เจอ docker-compose.yml หรือ db/)"
[ -f .env ] || die "ไม่มีไฟล์ตั้งค่า .env ในโฟลเดอร์นี้"
[ -f deploy/vps.override.yml ] || die "ไม่มี deploy/vps.override.yml"
ok "อยู่ที่ $(pwd)"

if ! $COMPOSE ps --status running --format '{{.Service}}' | grep -qx postgres; then
  die "คอนเทนเนอร์ postgres ไม่ได้รันอยู่ — เปิดก่อนด้วย: $COMPOSE up -d postgres"
fi
ok "postgres รันอยู่"

# ── 1. รอบเปิดซ้อน (ตัวเดียวที่ทำให้ migrate ล้มกลางทางได้) ─────────────────
say "1. ตรวจรอบนับที่เปิดซ้อนกันในคลังเดียว"
DUP="$(psql_value <<'SQL'
SELECT warehouse_code || ' → เปิดค้างอยู่ ' || count(*) || ' รอบ'
  FROM count_sessions
 WHERE status = 'open'
 GROUP BY warehouse_code
HAVING count(*) > 1;
SQL
)"
if [ -n "$DUP" ]; then
  printf '%s\n' "$DUP" | sed 's/^/     /'
  die "มีรอบเปิดซ้อนกันอยู่ — ปิดให้เหลือคลังละ 1 รอบก่อน แล้วรันสคริปต์นี้ใหม่
     (ดูรายชื่อรอบ: SELECT id, warehouse_code, opened_at FROM count_sessions WHERE status='open' ORDER BY warehouse_code, opened_at;)"
fi
ok "ไม่มีรอบซ้อน — migrate ผ่านแน่"

# ── 2. backup ก่อนแตะ schema ────────────────────────────────────────────────
say "2. สำรองฐานข้อมูลก่อน migrate"
mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/pre-update-$STAMP.sql.gz"
$COMPOSE exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$DUMP"
[ -s "$DUMP" ] || die "pg_dump ได้ไฟล์ว่าง — หยุดไว้ก่อน"
ok "$DUMP ($(du -h "$DUMP" | cut -f1))"

# ── 3. ดึงโค้ดใหม่ ──────────────────────────────────────────────────────────
say "3. ดึงโค้ดใหม่จาก origin/main"
OLD_REV="$(git -C .. rev-parse --short HEAD)"
git -C .. pull --ff-only
NEW_REV="$(git -C .. rev-parse --short HEAD)"
if [ "$OLD_REV" = "$NEW_REV" ]; then
  warn "ไม่มีอะไรใหม่ (ยังอยู่ที่ $NEW_REV) — ทำต่อเพื่อ migrate/rebuild ให้ครบ"
else
  ok "$OLD_REV → $NEW_REV"
  git -C .. log --oneline "$OLD_REV..$NEW_REV" | sed 's/^/     /'
fi

# ── 4. migrate ──────────────────────────────────────────────────────────────
say "4. อัปเดต schema (idempotent — รันซ้ำได้)"
psql_run < db/schema.sql
ok "schema ตรงกับ db/schema.sql แล้ว"

psql_value <<'SQL' | sed 's/^/     /'
SELECT 'erp_writeback.claimed_at  : ' ||
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='erp_writeback' AND column_name='claimed_at')
            THEN 'มีแล้ว' ELSE 'ยังไม่มี ⚠️' END
UNION ALL
SELECT 'ux_count_sessions_open    : ' ||
       COALESCE((SELECT CASE WHEN indexdef LIKE '%UNIQUE%' THEN 'UNIQUE ✓' ELSE 'ไม่ unique ⚠️' END
                   FROM pg_indexes WHERE indexname='ux_count_sessions_open'), 'ยังไม่มี ⚠️');
SQL

# ตัวยืนยันของแผนล็อกอินผ่าน ERP — "users ไม่มี credential" ต้องเป็น 0 เสมอก่อนคัตโอเวอร์
# (backfill ใน schema.sql การันตีให้อยู่แล้ว ตัวเลขนี้คือหลักฐานว่ามันทำงานจริงรอบนี้)
# หลังคัตโอเวอร์ Phase 3 ตัวเลขนี้ > 0 ได้ตามดีไซน์ = คนที่ถูก deactivate ไปแล้ว
psql_value <<'SQL' | sed 's/^/     /'
SELECT 'user_credentials ทั้งหมด : ' || count(*) FROM user_credentials;
SELECT 'users ไม่มี credential   : ' || count(*)
  FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.emp_id = u.emp_id);
SQL

# ── 5. build + ขึ้นระบบ ─────────────────────────────────────────────────────
say "5. build image แล้วสลับคอนเทนเนอร์ api"
$COMPOSE build api
$COMPOSE up -d api
ok "สลับแล้ว"

# ── 6. ตรวจว่าขึ้นจริง ──────────────────────────────────────────────────────
say "6. รอ api พร้อม (สูงสุด 90 วินาที)"
for i in $(seq 1 30); do
  if $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    ok "healthz ตอบ 200 (รอ ${i}0 วินาที... โดยประมาณ)"
    HEALTHY=1
    break
  fi
  sleep 3
done
[ "${HEALTHY:-0}" = 1 ] || die "api ไม่ตอบ healthz — ดู log: $COMPOSE logs --tail=100 api"

say "7. บรรทัดสำคัญใน log ตอน boot"
$COMPOSE logs --tail=200 api 2>/dev/null \
  | grep -E 'ERP driver|ตรวจ ERP ตอน boot|เส้นทางเขียนกลับ ERP|ERP_WRITE_|degraded' \
  | tail -10 | sed 's/^/     /' || warn "ไม่พบบรรทัดที่เกี่ยวกับ ERP ใน log"

cat <<INFO

────────────────────────────────────────────────────────────────────────
 เสร็จแล้ว — โค้ดที่รันอยู่คือ $NEW_REV

 ยังไม่ได้เปิดการส่งผลนับกลับ ERP โดยตั้งใจ
 เปิดเมื่อฝ่าย ERP สร้างบัญชี tcl_writer และ GRANT ให้แล้ว:

   1) เพิ่มในไฟล์ตั้งค่า:
        ERP_WRITEBACK_ENABLED=true
        ERP_SQL_WRITE_USER=tcl_writer
        ERP_SQL_WRITE_PASSWORD=********
        ERP_WRITEBACK_DTL_VOUCHERNO=false
   2) $COMPOSE up -d api
   3) ต้องเห็นใน log: "เส้นทางเขียนกลับ ERP: เปิดอยู่ และขอบเขตสิทธิ์ของบัญชีเขียนถูกต้อง"
      ถ้าไม่ขึ้น อ่าน error — มันบอกตรง ๆ ว่าสิทธิ์เกินหรือขาดตรงไหน

 ถอยกลับถ้ามีปัญหา:
   git -C .. checkout $OLD_REV && $COMPOSE build api && $COMPOSE up -d api
   ฐานข้อมูล: gunzip -c $DUMP | $COMPOSE exec -T postgres sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"'
   (schema ใหม่เข้ากันได้กับโค้ดเก่า — ปกติถอยแค่โค้ดพอ ไม่ต้อง restore)
────────────────────────────────────────────────────────────────────────
INFO
