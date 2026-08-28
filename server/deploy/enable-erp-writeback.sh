#!/usr/bin/env bash
#
# เปิดเส้นทางส่งผลนับกลับ ERP โดยใช้ "บัญชี SQL Server ตัวเดียว" ทั้งอ่านและเขียน
#
#   รันจาก /opt/tcl/server เท่านั้น:   bash deploy/enable-erp-writeback.sh
#
# ── กรอก 2 ค่าด้านล่างก่อนรัน ────────────────────────────────────────────────
#
# ⚠️ ก่อนรัน บัญชีนี้ต้องได้สิทธิ์เขียนจากฝ่าย ERP แล้ว ไม่งั้น api จะไม่ยอม start
#    (ขึ้น ERP_WRITE_SCOPE_INSUFFICIENT พร้อมบอกว่าขาดสิทธิ์ตัวไหน)
#
#    ส่งให้ฝ่าย ERP รัน — แทน <บัญชี> ด้วยชื่อ login เดียวกับที่กรอกข้างล่าง:
#      GRANT INSERT                 ON dbo.tbl_CountHdr  TO <บัญชี>;
#      GRANT INSERT                 ON dbo.tbl_CountDtl  TO <บัญชี>;
#      GRANT SELECT, INSERT, UPDATE ON dbo.RunningNumber TO <บัญชี>;
#      GRANT SELECT                 ON dbo.tbl_CountHdr  TO <บัญชี>;
#      GRANT SELECT                 ON dbo.tbl_CountDtl  TO <บัญชี>;
#    ห้ามให้ db_owner / db_datawriter / sysadmin — จะโดนด่าน "สิทธิ์กว้างเกิน"
#
# สคริปต์นี้ไม่ลบข้อมูล ไม่แตะฐานข้อมูล แตะแค่ไฟล์ตั้งค่า และสำรองของเดิมไว้ให้ก่อนเสมอ
# ============================================================================

ERP_ACCOUNT=""           # ชื่อ login SQL Server เช่น tcl_reader
ERP_ACCOUNT_PASSWORD=""  # รหัสผ่านของบัญชีนั้น

# ============================================================================
set -euo pipefail

ENV_FILE=".env"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

say "0. ตรวจก่อนแตะอะไร"
[ -f docker-compose.yml ] && [ -d db ] || die "ต้องรันจาก /opt/tcl/server (ไม่เจอ docker-compose.yml หรือ db/)"
[ -f "$ENV_FILE" ] || die "ไม่เจอไฟล์ตั้งค่า $ENV_FILE ในโฟลเดอร์นี้"
[ -n "$ERP_ACCOUNT" ] || die "ยังไม่ได้กรอก ERP_ACCOUNT ที่หัวไฟล์นี้"
[ -n "$ERP_ACCOUNT_PASSWORD" ] || die "ยังไม่ได้กรอก ERP_ACCOUNT_PASSWORD ที่หัวไฟล์นี้"
case "$ERP_ACCOUNT_PASSWORD" in
  *$'\n'*) die "รหัสผ่านมีขึ้นบรรทัดใหม่ปนอยู่ — ตรวจตอนวางค่า" ;;
esac
ok "อยู่ที่ $(pwd) · บัญชีที่จะใช้: $ERP_ACCOUNT"

if [ ! -f env.testmode ]; then
  warn "ไม่เจอ env.testmode — ถ้าบัญชีนี้ทั้งอ่านและเขียนได้ api จะไม่ยอม start"
  warn "ต้อง git pull ให้ได้ commit ที่มีไฟล์นั้นก่อน"
fi

say "1. สำรองไฟล์ตั้งค่าเดิม"
cp -p "$ENV_FILE" "${ENV_FILE}.bak-${STAMP}"
chmod 600 "${ENV_FILE}.bak-${STAMP}"
ok "สำรองไว้ที่ ${ENV_FILE}.bak-${STAMP}"

say "2. เขียนค่าใหม่"
# ลบบรรทัดเดิมของคีย์นั้น (ถ้ามี) แล้วเติมค่าใหม่ต่อท้าย — ค่าซ้ำจึงไม่เหลือค้าง
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
KEYS="ERP_SQL_USER ERP_SQL_PASSWORD ERP_SQL_WRITE_USER ERP_SQL_WRITE_PASSWORD ERP_WRITEBACK_ENABLED ERP_WRITEBACK_DTL_VOUCHERNO"

cp "$ENV_FILE" "$TMP"
for key in $KEYS; do
  grep -v "^[[:space:]]*${key}[[:space:]]*=" "$TMP" > "${TMP}.new" || true
  mv "${TMP}.new" "$TMP"
done

{
  printf '\n'
  printf '# --- เปิดส่งผลนับกลับ ERP (ตั้งโดย deploy/enable-erp-writeback.sh เมื่อ %s) ---\n' "$STAMP"
  printf '# บัญชีเดียวทั้งอ่านและเขียน — ต้องมี env.testmode คู่กันเพื่อผ่านด่าน boot probe\n'
  printf 'ERP_SQL_USER=%s\n'           "$ERP_ACCOUNT"
  printf 'ERP_SQL_PASSWORD=%s\n'       "$ERP_ACCOUNT_PASSWORD"
  printf 'ERP_SQL_WRITE_USER=%s\n'     "$ERP_ACCOUNT"
  printf 'ERP_SQL_WRITE_PASSWORD=%s\n' "$ERP_ACCOUNT_PASSWORD"
  printf 'ERP_WRITEBACK_ENABLED=true\n'
  printf 'ERP_WRITEBACK_DTL_VOUCHERNO=false\n'
} >> "$TMP"

cat "$TMP" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "เขียนแล้ว (คีย์ซ้ำของเดิมถูกลบทิ้ง เหลือชุดใหม่ชุดเดียว)"

say "3. ตรวจผล (ไม่แสดงรหัสผ่าน)"
grep -E '^(ERP_SQL_USER|ERP_SQL_WRITE_USER|ERP_WRITEBACK_ENABLED|ERP_WRITEBACK_DTL_VOUCHERNO)=' "$ENV_FILE" | sed 's/^/     /'
printf '     ERP_SQL_PASSWORD=<%s ตัวอักษร>\n' "${#ERP_ACCOUNT_PASSWORD}"
printf '     ERP_SQL_WRITE_PASSWORD=<%s ตัวอักษร>\n' "${#ERP_ACCOUNT_PASSWORD}"

say "4. ขั้นต่อไป — ยกคอนเทนเนอร์ใหม่แล้วดู log"
cat <<'NEXT'
     docker compose -f docker-compose.yml -f deploy/vps.override.yml up -d api
     docker compose -f docker-compose.yml -f deploy/vps.override.yml logs --tail 40 api

   ต้องเห็นสองบรรทัดนี้ = สำเร็จ
     🚨 โหมดทดสอบ: login ERP_SQL_USER="..." **เขียน db_TCL ได้** ...
     เส้นทางเขียนกลับ ERP: เปิดอยู่ ...

   ถ้าขึ้น ERP_WRITE_SCOPE_INSUFFICIENT = ฝ่าย ERP ยัง GRANT ไม่ครบ
   error จะบอกตรง ๆ ว่าขาดสิทธิ์ตัวไหน

   ถอยกลับ:
     cp .env.bak-<เวลา> .env && docker compose -f docker-compose.yml -f deploy/vps.override.yml up -d api
NEXT

printf '\n'
