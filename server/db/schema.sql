-- =============================================================================
-- TCL Mobile Stock Check — PostgreSQL 16 schema (system of record ของเรา)
-- =============================================================================
-- อ้างอิง: docs/architecture.md §4.1 · docs/erp-integration.md §5 · docs/erp-tcl-findings.md
--
-- 🚫 กฎเหล็ก: ระบบนี้ "ไม่เขียนกลับ ERP" โดยเด็ดขาด
--    ERP (SQL Server db_TCL) = อ่านอย่างเดียว → ยอดระบบไหลเข้า items_cache / count_snapshot
--    พนักงานกรอกค่าที่นับได้ → server คำนวณส่วนต่าง → เก็บผลถาวรที่ closed_variance
--    ห้ามมีตาราง erp_post_outbox หรืออะไรที่ทำหน้าที่คิวเขียนกลับ ERP (มี guard ท้ายไฟล์)
--
-- คุณสมบัติของไฟล์นี้:
--   • idempotent ทั้งไฟล์ (CREATE ... IF NOT EXISTS + DO block สำหรับ enum/trigger/index)
--   • รันซ้ำได้ปลอดภัย → ใช้เป็น migration แรก (รันใต้ pg advisory lock ใน entrypoint)
--   • เวลาทุกคอลัมน์เป็น timestamptz (server ตั้ง TZ=Asia/Bangkok, การเรียงลำดับใช้ UTC จริง)
--   • ยอด/จำนวนเป็น numeric(18,3) — ERP ใช้หน่วยเป็นทศนิยม (กส./ถัง/มัด)
--
-- หมายเหตุคลังสินค้า: รหัสคลังจริงจาก ERP = WHRM · WHFG · WHWIP · WHNG
--   (ไม่ใช่ WH-BKK-02 ที่ design สมมติไว้) และคอลัมน์ Warehouse ใน ERP เป็น nvarchar padded
--   → ทุกค่าที่เข้ามาต้อง LTRIM/RTRIM แล้ว บังคับด้วย CHECK (col = btrim(col))
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
-- pg_trgm ใช้ทำ substring search ของ GET /items?q= (ชื่อไทย + sku)
-- ถ้า role ที่รัน migration ไม่มีสิทธิ์สร้าง extension ให้ข้ามไปใช้ btree lower() แทน
DO $do$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'ไม่มีสิทธิ์สร้าง extension pg_trgm — จะ fallback เป็น btree lower(name) (ค้นหา substring จะช้ากว่า)';
END
$do$;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
DO $do$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'staff', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  CREATE TYPE count_session_status AS ENUM ('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  -- count_sessions = mirror ของรอบนับ ERP (tbl_CountHdr) จึงมี kind แยกจาก items/stock
  CREATE TYPE sync_kind AS ENUM ('items', 'stock', 'count_sessions');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  -- partial = ดึงได้ไม่ครบ → ห้ามขยับ cursor, ห้าม tombstone (erp-integration.md §5)
  CREATE TYPE sync_run_status AS ENUM ('running', 'success', 'partial', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  CREATE TYPE variance_status AS ENUM ('match', 'over', 'short', 'not_counted', 'off_list', 'conflict');
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- -----------------------------------------------------------------------------
-- 2. Shared trigger functions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

-- items_cache: bump row_version ทุกครั้งที่ "เนื้อข้อมูลเปลี่ยนจริง" (รวม soft-delete)
-- เทียบด้วย jsonb เพื่อไม่ให้ upsert ที่ค่าเหมือนเดิมไป bump cursor
-- (ถ้า bump มั่ว มือถือจะดาวน์โหลดซ้ำทั้ง catalog ทุกรอบ sync)
CREATE OR REPLACE FUNCTION items_cache_bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'row_version' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'row_version' - 'updated_at') THEN
    NEW.row_version := nextval(pg_get_serial_sequence('items_cache', 'row_version'));
    NEW.updated_at  := now();
  END IF;
  RETURN NEW;
END
$fn$;

-- ป้องกันตาราง append-only ที่ระดับ engine (ชั้นที่ role/permission พลาดแล้วยังกันได้)
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ตาราง % เป็น append-only: ห้าม % (แก้/ลบผลการนับหรือ audit trail ไม่ได้)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

-- =============================================================================
-- 3. Tables
-- =============================================================================

-- 3.1 users -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  emp_id          text        PRIMARY KEY,
  name            text        NOT NULL,
  pin_hash        text        NOT NULL,
  role            user_role   NOT NULL DEFAULT 'staff',
  shift           text,
  warehouse_code  text        NOT NULL,
  role_version    integer     NOT NULL DEFAULT 1,
  must_change_pin boolean     NOT NULL DEFAULT true,
  failed_attempts integer     NOT NULL DEFAULT 0,
  throttle_until  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_emp_id_fmt      CHECK (emp_id = btrim(emp_id) AND emp_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  CONSTRAINT users_name_notblank   CHECK (btrim(name) <> ''),
  -- argon2id เท่านั้น (PIN 6 หลักเอนโทรปีต่ำ ต้อง hash แบบช้า + server pepper)
  CONSTRAINT users_pin_hash_argon  CHECK (pin_hash LIKE '$argon2id$%'),
  CONSTRAINT users_wh_trimmed      CHECK (warehouse_code = btrim(warehouse_code) AND length(warehouse_code) BETWEEN 1 AND 32),
  CONSTRAINT users_role_version_ge CHECK (role_version >= 1),
  CONSTRAINT users_failed_ge       CHECK (failed_attempts >= 0)
);

COMMENT ON TABLE  users IS 'พนักงาน + credential PIN (argon2id + server pepper) — system of record ของสิทธิ์ ห้ามเชื่อ role จาก JWT อย่างเดียว';
COMMENT ON COLUMN users.role_version IS 'bump ทุกครั้งที่เปลี่ยน role — endpoint blast radius สูงต้องตรวจค่านี้กับ DB ทุกครั้ง';
COMMENT ON COLUMN users.throttle_until IS 'escalating delay ต่อ empId (1s/5s/30s/...) แทนการล็อคตายตัว — กันคนอื่นยิง PIN ผิดเพื่อล็อคพนักงาน';

-- 3.2 devices -----------------------------------------------------------------
-- เครื่องต้องมีแถวนี้ก่อน: ทุก path ที่รับ device_id (login / ingest / scan) ต้อง
-- upsert devices ก่อน (INSERT ... ON CONFLICT DO UPDATE) เพราะตารางอื่นอ้าง FK มาที่นี่
CREATE TABLE IF NOT EXISTS devices (
  device_id         text        PRIMARY KEY,
  model             text,
  app_version       text,
  last_seen_at      timestamptz,
  -- คนล่าสุดที่ login บนเครื่องนี้ (เครื่องคลังใช้ร่วมกันเป็น pool)
  -- ใช้ตามหาเครื่องที่หายพร้อมงานนับที่ยังไม่ซิงค์ — ไม่ใช้ FK เพราะเครื่องอยู่ได้แม้ลบ user
  last_emp_id       text,
  queue_depth       integer     NOT NULL DEFAULT 0,
  oldest_pending_age interval,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_id_fmt      CHECK (device_id = btrim(device_id) AND length(device_id) BETWEEN 1 AND 128),
  CONSTRAINT devices_queue_ge    CHECK (queue_depth >= 0),
  CONSTRAINT devices_age_ge_zero CHECK (oldest_pending_age IS NULL OR oldest_pending_age >= interval '0')
);

COMMENT ON TABLE  devices IS 'heartbeat จากทุกการ sync — ใช้ตรวจ "เครื่องหายพร้อมงานนับค้าง" และมอบโซนใหม่';
COMMENT ON COLUMN devices.oldest_pending_age IS 'อายุงานเก่าสุดใน outbox ของเครื่อง (รายงานโดยเครื่องเอง = คำใบ้ ไม่ใช่ความจริงสัมบูรณ์)';

-- 3.3 refresh_tokens ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash   text        PRIMARY KEY,
  emp_id       text        NOT NULL REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE CASCADE,
  device_id    text        NOT NULL REFERENCES devices(device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_from text        REFERENCES refresh_tokens(token_hash) ON UPDATE CASCADE ON DELETE SET NULL,
  revoked_at   timestamptz,
  CONSTRAINT refresh_tokens_hash_fmt CHECK (token_hash ~ '^[0-9a-f]{64}$'),   -- sha256 hex ของ token (ห้ามเก็บ token ดิบ)
  CONSTRAINT refresh_tokens_ttl      CHECK (expires_at > issued_at),
  CONSTRAINT refresh_tokens_no_self  CHECK (rotated_from IS NULL OR rotated_from <> token_hash)
);

COMMENT ON TABLE  refresh_tokens IS 'refresh token family ต่อ (emp_id, device_id) — rotate แบบมี grace window 60 วิ กัน WiFi หลุดแล้วโดน revoke ทั้ง family';
COMMENT ON COLUMN refresh_tokens.rotated_from IS 'สายการ rotate — ใช้ตรวจ replay/grace window; NULL = token แรกของ family';

-- 3.4 items_cache -------------------------------------------------------------
-- replica ฝั่ง server ของ item master จาก ERP (dbo.InventoryItem)
-- ⚠️ ERP: PK = (Roworder, ItemCode) → ItemCode ซ้ำได้ (85 รหัสซ้ำ ณ 17/08/2569)
--    กติกาที่ตัดสินแล้ว: Roworder สูงสุดชนะ → ที่นี่ sku เป็น PK แถวเดียวเท่านั้น
--    และเก็บ erp_roworder ไว้ให้ตรวจย้อนได้ว่าเลือกแถวไหนมา
CREATE TABLE IF NOT EXISTS items_cache (
  sku             text        PRIMARY KEY,
  name            text        NOT NULL,
  name_en         text,
  loc             text,
  on_hand         numeric(18,3),
  reserved        numeric(18,3),
  rop             numeric(18,3),
  unit            text,
  specs           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  warehouse_code  text        NOT NULL,
  erp_roworder    bigint,
  erp_updated_at  timestamptz,
  row_version     bigserial   NOT NULL,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_cache_sku_fmt     CHECK (sku = btrim(sku) AND length(sku) BETWEEN 1 AND 64),
  CONSTRAINT items_cache_name_ok     CHECK (btrim(name) <> ''),
  CONSTRAINT items_cache_wh_trimmed  CHECK (warehouse_code = btrim(warehouse_code) AND length(warehouse_code) BETWEEN 1 AND 32),
  CONSTRAINT items_cache_specs_obj   CHECK (jsonb_typeof(specs) = 'object'),
  CONSTRAINT items_cache_rop_ge      CHECK (rop IS NULL OR rop >= 0),
  CONSTRAINT items_cache_reserved_ge CHECK (reserved IS NULL OR reserved >= 0)
);

COMMENT ON TABLE  items_cache IS 'replica ของ item master จาก ERP (อ่านอย่างเดียว) — มือถือไม่เคยคุยกับ ERP ตรง';
COMMENT ON COLUMN items_cache.row_version IS 'cursor ภายในสำหรับ delta feed GET /items?since= — bump ทุก upsert/soft-delete ด้วย trigger; ⚠️ ห้าม cursor ด้วยเวลา ERP (ties/backfill/clock skew ทำแถวตกขอบ)';
COMMENT ON COLUMN items_cache.deleted_at IS 'tombstone: SKU หายจาก ERP — set ได้เฉพาะรอบ full-reconcile ที่ยืนยันดึงครบ (guardrail ห้ามลบเกิน 5%/รอบ)';
COMMENT ON COLUMN items_cache.erp_roworder IS 'Roworder จาก dbo.InventoryItem — ItemCode ซ้ำได้ กติกาคือ Roworder สูงสุดชนะ';
COMMENT ON COLUMN items_cache.erp_updated_at IS 'ใช้ทำ delta/tie-break จาก ERP เท่านั้น — ป้าย "ข้อมูล ณ HH:MM" อ่านจาก sync_runs.stock_as_of';
COMMENT ON COLUMN items_cache.on_hand IS 'ยอดระบบล่าสุดที่ดึงได้ (ERP ไม่มีตารางยอดสำเร็จ: แหล่งที่ใช้ได้จริงคือ tbl_CountDtl.MainQty หรือ query ที่เจ้าของโปรเจคส่งมอบ)';

DROP TRIGGER IF EXISTS trg_items_cache_row_version ON items_cache;
CREATE TRIGGER trg_items_cache_row_version
  BEFORE UPDATE ON items_cache
  FOR EACH ROW EXECUTE FUNCTION items_cache_bump_row_version();

-- 3.5 item_barcodes -----------------------------------------------------------
-- 1 SKU : N barcode · barcode ว่างได้ (= ไม่มีแถว) — ERP มี BarCodeUnits แค่ 1.9%
-- จึงพิมพ์ฉลาก Code128 จาก ItemCode เพิ่มเข้ามาเป็นอีกแถวของ SKU เดียวกัน
CREATE TABLE IF NOT EXISTS item_barcodes (
  barcode        text        PRIMARY KEY,
  sku            text        NOT NULL REFERENCES items_cache(sku) ON UPDATE CASCADE ON DELETE CASCADE,
  source         text        NOT NULL DEFAULT 'erp_unit',
  erp_updated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_barcodes_fmt    CHECK (barcode = btrim(barcode) AND length(barcode) BETWEEN 1 AND 64),
  CONSTRAINT item_barcodes_source CHECK (source IN ('erp_unit', 'erp_pack', 'item_code_label', 'manual'))
);

COMMENT ON TABLE  item_barcodes IS 'barcode → sku (exact match ตอนสแกน); ชนกัน = erp_updated_at ใหม่ชนะ + log anomaly ห้าม fail ทั้งรอบ';
COMMENT ON COLUMN item_barcodes.source IS 'erp_unit=BarCodeUnits · erp_pack=BarCodePack (ITF-14) · item_code_label=Code128 ที่เราพิมพ์จาก ItemCode · manual=กรอกมือ';

-- 3.6 count_sessions ----------------------------------------------------------
-- mirror ของรอบนับ ERP (dbo.tbl_CountHdr) — admin ไม่ได้สร้างยอดเอง
-- ⚠️ ERP: PK = (Roworder, TransactionNo) → ทั้ง VoucherNo และ TransactionNo ซ้ำได้
--    กติกา dedupe: Roworder สูงสุดชนะ → ที่นี่เหลือรอบละ 1 แถว
--    erp_voucher_no ห้าม unique เด็ดขาด (CNT-xxxx ซ้ำได้จริงในข้อมูล)
CREATE TABLE IF NOT EXISTS count_sessions (
  id                  text                 PRIMARY KEY,
  erp_transaction_no  text,
  erp_voucher_no      text,
  erp_roworder        bigint,
  zone                text,
  warehouse_code      text                 NOT NULL,
  status              count_session_status  NOT NULL DEFAULT 'open',
  opened_at           timestamptz          NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  closed_by           text                 REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE SET NULL,
  erp_data_as_of      timestamptz,
  erp_count_date      date,
  opened_on_stale_cache boolean            NOT NULL DEFAULT false,
  created_at          timestamptz          NOT NULL DEFAULT now(),
  updated_at          timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT count_sessions_id_fmt   CHECK (id = btrim(id) AND length(id) BETWEEN 1 AND 64),
  CONSTRAINT count_sessions_wh_trim  CHECK (warehouse_code = btrim(warehouse_code) AND length(warehouse_code) BETWEEN 1 AND 32),
  CONSTRAINT count_sessions_txn_trim CHECK (erp_transaction_no IS NULL OR erp_transaction_no = btrim(erp_transaction_no)),
  CONSTRAINT count_sessions_vch_trim CHECK (erp_voucher_no IS NULL OR erp_voucher_no = btrim(erp_voucher_no)),
  CONSTRAINT count_sessions_zone_trim CHECK (zone IS NULL OR zone = btrim(zone)),
  -- ปิดแล้วต้องมีเวลาปิด · เปิดอยู่ต้องไม่มีเวลาปิด (กันสถานะกำกวมตอนคำนวณ variance)
  CONSTRAINT count_sessions_close_consistent CHECK (
    (status = 'closed' AND closed_at IS NOT NULL AND closed_at >= opened_at)
    OR (status = 'open' AND closed_at IS NULL)
  )
);

COMMENT ON TABLE  count_sessions IS 'รอบนับ — เปิดจากระบบเราเอง; ผลการนับและส่วนต่างเก็บฝั่งเรา และส่งกลับ ERP ได้หลังปิดรอบผ่าน erp_writeback';
COMMENT ON COLUMN count_sessions.erp_transaction_no IS 'คีย์เชื่อม tbl_CountDtl; NULL ได้เมื่อเป็นรอบที่สร้างในระบบเราเอง (ไม่มีต้นทางใน ERP)';
COMMENT ON COLUMN count_sessions.erp_voucher_no IS 'VoucherNo เช่น CNT-2608-0003 — ⚠️ ซ้ำได้ ห้ามใส่ unique constraint';
COMMENT ON COLUMN count_sessions.erp_data_as_of IS 'อายุข้อมูล ERP ตอน freeze snapshot — แสดงในหน้านับและในรายงาน variance';
COMMENT ON COLUMN count_sessions.opened_on_stale_cache IS 'true = เปิดรอบขณะ ERP ล่ม โดย admin ยืนยันใช้ cache เก่า (ต้องเห็นในรายงาน)';

DROP TRIGGER IF EXISTS trg_count_sessions_touch ON count_sessions;
CREATE TRIGGER trg_count_sessions_touch
  BEFORE UPDATE ON count_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_users_touch ON users;
CREATE TRIGGER trg_users_touch
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 3.7 count_snapshot ----------------------------------------------------------
-- baseline ที่ freeze ตอนเปิดรอบ = ยอดระบบจาก tbl_CountDtl.MainQty (ไม่มี NULL ในข้อมูลจริง)
-- server คำนวณ variance เทียบตารางนี้เสมอ — ห้ามเชื่อ frozen qty ที่ client ส่งมา
CREATE TABLE IF NOT EXISTS count_snapshot (
  session_id        text          NOT NULL REFERENCES count_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  sku               text          NOT NULL REFERENCES items_cache(sku) ON UPDATE CASCADE ON DELETE RESTRICT,
  frozen_on_hand    numeric(18,3) NOT NULL,
  unit              text,
  warehouse_code    text          NOT NULL,
  zone              text,
  erp_ref_count_qty numeric(18,3),
  frozen_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sku),
  CONSTRAINT count_snapshot_wh_trim CHECK (warehouse_code = btrim(warehouse_code) AND length(warehouse_code) BETWEEN 1 AND 32)
);

COMMENT ON TABLE  count_snapshot IS 'ยอดระบบที่ freeze ต่อ (รอบ, SKU) — baseline เดียวที่ใช้คำนวณส่วนต่าง';
COMMENT ON COLUMN count_snapshot.erp_ref_count_qty IS 'tbl_CountDtl.CountQty ที่ ERP เคยกรอก — ข้อมูลอ้างอิง/ประวัติเท่านั้น ไม่ใช้คำนวณ';
COMMENT ON COLUMN count_snapshot.frozen_on_hand IS 'จาก tbl_CountDtl.MainQty ณ เวลาที่ดึง; ติดลบได้ (ERP อาจให้ยอดติดลบ) จึงไม่มี CHECK >= 0';

-- 3.8 count_zone_assign -------------------------------------------------------
CREATE TABLE IF NOT EXISTS count_zone_assign (
  session_id  text        NOT NULL REFERENCES count_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  zone        text        NOT NULL,
  emp_id      text        NOT NULL REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by text        REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE SET NULL,
  PRIMARY KEY (session_id, zone, emp_id),
  CONSTRAINT count_zone_assign_zone_trim CHECK (zone = btrim(zone) AND btrim(zone) <> '')
);

COMMENT ON TABLE count_zone_assign IS 'มอบโซนต่อคนนับ — server reject submission ของโซนที่ไม่ได้รับมอบ; PK ยอมให้ 1 โซนมีหลายคนเชิงโครงสร้าง แต่นั่นคือต้นเหตุ CONFLICT ให้ admin ระวัง';

-- 3.9 count_submissions (APPEND-ONLY) -----------------------------------------
-- event ผลการนับจากมือถือ: เพิ่มได้อย่างเดียว ห้าม UPDATE/DELETE
-- idempotency_key = UUIDv7 จาก client → retry กี่ครั้งก็ไม่นับซ้ำ (PK จับ duplicate ให้ฟรี)
CREATE TABLE IF NOT EXISTS count_submissions (
  idempotency_key uuid          PRIMARY KEY,
  session_id      text          NOT NULL REFERENCES count_sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sku             text          NOT NULL REFERENCES items_cache(sku) ON UPDATE CASCADE ON DELETE RESTRICT,
  counted_qty     numeric(18,3) NOT NULL,
  emp_id          text          NOT NULL REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  device_id       text          NOT NULL REFERENCES devices(device_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  device_seq      bigint        NOT NULL,
  counted_at      timestamptz   NOT NULL,
  received_at     timestamptz   NOT NULL DEFAULT now(),
  payload_hash    text          NOT NULL,
  CONSTRAINT count_submissions_qty_ge   CHECK (counted_qty >= 0),
  CONSTRAINT count_submissions_seq_ge   CHECK (device_seq > 0),
  CONSTRAINT count_submissions_hash_fmt CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE  count_submissions IS 'APPEND-ONLY: ผลการนับที่พนักงานกรอก — ห้าม UPDATE/DELETE (บังคับด้วย trigger deny_mutation + revoke สิทธิ์ role แอป)';
COMMENT ON COLUMN count_submissions.device_seq IS 'ลำดับ monotonic ต่อเครื่อง — "ล่าสุดชนะ" ใช้ค่านี้ได้เฉพาะภายในเครื่องเดียวกัน; ไม่ unique เพราะเครื่องลงแอปใหม่แล้ว seq เริ่มใหม่ = anomaly ที่ต้อง log ไม่ใช่ให้ insert พัง';
COMMENT ON COLUMN count_submissions.counted_at IS 'เวลาที่เครื่องบอก — ใช้แสดงผลเท่านั้น (นาฬิกาเครื่องเพี้ยนได้) การจัดลำดับใช้ device_seq/received_at';
COMMENT ON COLUMN count_submissions.payload_hash IS 'sha256 ของ payload — duplicate ที่ hash ต่างจากเดิม = ความผิดปกติ ต้อง log ไม่ทับของเดิม';
COMMENT ON COLUMN count_submissions.sku IS 'ไม่บังคับ FK ไป count_snapshot: การนับเจอของนอกรายการเกิดขึ้นจริง (off_list) — จะถูกตัดสินที่ชั้น app';

DROP TRIGGER IF EXISTS trg_count_submissions_append_only ON count_submissions;
CREATE TRIGGER trg_count_submissions_append_only
  BEFORE UPDATE OR DELETE ON count_submissions
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- 3.10 closed_variance -------------------------------------------------------
-- materialize ตอนปิดรอบ = คำตอบถาวรของคำถาม "ต่างกันเท่าไหร่"
-- ผลนี้อยู่ในระบบเรา (+ export CSV) และเป็นแหล่งข้อมูลของการส่งกลับ ERP
-- ⚠️ ส่งกลับได้เฉพาะแถวที่มีคนนับจริง — `not_counted` ถูกตัดออกเสมอ เพราะ ERP
--    เก็บ CountQty เป็น NULL ไม่ได้ ส่ง 0 ไปจะแปลว่า "นับแล้วได้ศูนย์" (ของหาย)
CREATE TABLE IF NOT EXISTS closed_variance (
  session_id        text            NOT NULL REFERENCES count_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  sku               text            NOT NULL,
  frozen_on_hand    numeric(18,3),
  final_counted_qty numeric(18,3),
  diff              numeric(18,3)   GENERATED ALWAYS AS (final_counted_qty - frozen_on_hand) STORED,
  status            variance_status NOT NULL,
  unit              text,
  counted_by        text            REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE SET NULL,
  device_count      integer         NOT NULL DEFAULT 0,
  chosen_submission uuid            REFERENCES count_submissions(idempotency_key) ON UPDATE CASCADE ON DELETE SET NULL,
  resolved_by       text            REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE SET NULL,
  materialized_at   timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sku),
  CONSTRAINT closed_variance_device_count_ge CHECK (device_count >= 0),
  -- นับแล้วต้องมียอด · ไม่ได้นับต้องไม่มียอด (กันรายงานที่อ่านไม่ออก)
  CONSTRAINT closed_variance_counted_consistent CHECK (
    (status = 'not_counted' AND final_counted_qty IS NULL)
    OR (status <> 'not_counted' AND final_counted_qty IS NOT NULL)
  ),
  -- off_list = ของที่นับเจอแต่ไม่อยู่ใน snapshot ของรอบ
  CONSTRAINT closed_variance_offlist_consistent CHECK (
    (status = 'off_list' AND frozen_on_hand IS NULL)
    OR (status <> 'off_list' AND frozen_on_hand IS NOT NULL)
  ),
  -- ห้าม auto-resolve: แถว conflict จะ materialize ได้ต่อเมื่อ admin ตัดสินแล้ว
  CONSTRAINT closed_variance_conflict_resolved CHECK (
    status <> 'conflict' OR resolved_by IS NOT NULL
  )
);

COMMENT ON TABLE  closed_variance IS 'ผลส่วนต่างถาวร ณ จุดปิดรอบ (materialized) — รายงานสุดท้ายของระบบ; ไม่ส่งกลับ ERP ตามกฎเหล็ก';
COMMENT ON COLUMN closed_variance.diff IS 'final_counted_qty − frozen_on_hand (generated) : + = เกิน, − = ขาด, 0 = ตรง';
COMMENT ON COLUMN closed_variance.status IS 'conflict = admin ตัดสินจากหลายเครื่อง (chosen_submission บอกว่าเลือกแถวไหน) — ห้าม auto-resolve';
COMMENT ON COLUMN closed_variance.sku IS 'ไม่ผูก FK ไป items_cache โดยเจตนา: รายงานส่วนต่างต้องอยู่ถาวรแม้อนาคตจะ purge สินค้าที่ tombstone แล้ว';

-- 3.11 erp_writeback ---------------------------------------------------------
-- สถานะการส่งผลนับกลับเข้า ERP (tbl_CountHdr / tbl_CountDtl)
--
-- ⚠️ session_id เป็น PRIMARY KEY โดยเจตนา = หนึ่งรอบนับส่งได้ครั้งเดียวตลอดกาล
--    ฝั่ง ERP ไม่มี unique บน VoucherNo/TransactionNo (คีย์หลักคือ Roworder+TransactionNo
--    ซึ่ง Roworder เป็น IDENTITY) → ไม่มีด่านสุดท้ายกันเอกสารซ้ำที่ฐานข้อมูลปลายทาง
--    ตารางนี้จึงเป็นด่านเดียวที่กันได้ ห้ามผ่อนคีย์นี้เด็ดขาด
CREATE TABLE IF NOT EXISTS erp_writeback (
  session_id      text        PRIMARY KEY REFERENCES count_sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status          text        NOT NULL DEFAULT 'queued',
  transaction_no  integer,
  voucher_no      text,
  row_count       integer,
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  requested_by    text        REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT erp_writeback_status_ok  CHECK (status IN ('queued','sent','failed')),
  CONSTRAINT erp_writeback_attempts_ge CHECK (attempts >= 0),
  CONSTRAINT erp_writeback_row_count_ge CHECK (row_count IS NULL OR row_count >= 0),
  -- ส่งสำเร็จต้องมีเลขเอกสารครบ ไม่งั้นตามรอยใน ERP ไม่ได้
  CONSTRAINT erp_writeback_sent_complete CHECK (
    status <> 'sent'
    OR (transaction_no IS NOT NULL AND voucher_no IS NOT NULL AND sent_at IS NOT NULL)
  )
);

COMMENT ON TABLE  erp_writeback IS 'สถานะการส่งผลนับกลับ ERP — หนึ่งรอบต่อหนึ่งแถว (PK) คือกลไกกันส่งซ้ำเพียงชั้นเดียวที่มี';
COMMENT ON COLUMN erp_writeback.transaction_no IS 'tbl_CountHdr.TransactionNo ที่เราออกให้จาก RunningNumber.CNTTr';
COMMENT ON COLUMN erp_writeback.voucher_no IS 'tbl_CountHdr.VoucherNo รูปแบบ CNT-YYMM-NNNN';
COMMENT ON COLUMN erp_writeback.row_count IS 'จำนวนแถวใน tbl_CountDtl ที่ส่งจริง — นับเฉพาะรายการที่มีคนนับ (not_counted ถูกตัดออก)';

-- 3.12 audit_log (APPEND-ONLY) -----------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial   PRIMARY KEY,
  actor      text        NOT NULL,
  action     text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_ok   CHECK (btrim(actor) <> ''),
  CONSTRAINT audit_log_action_ok  CHECK (btrim(action) <> ''),
  CONSTRAINT audit_log_payload_ok CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE  audit_log IS 'APPEND-ONLY: การกระทำที่ต้องตรวจย้อนได้ (เปลี่ยน role, เปิด/ปิดรอบ, unlock PIN, ตัดสิน conflict, reject submission)';
COMMENT ON COLUMN audit_log.actor IS 'emp_id หรือ ''system''/''scheduler'' — ไม่ผูก FK เพื่อให้ actor ที่ถูกลบยัง audit ได้';

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- 3.12 scan_events -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_events (
  id          bigserial   PRIMARY KEY,
  emp_id      text        NOT NULL REFERENCES users(emp_id) ON UPDATE CASCADE ON DELETE CASCADE,
  device_id   text        NOT NULL REFERENCES devices(device_id) ON UPDATE CASCADE ON DELETE CASCADE,
  barcode     text        NOT NULL,
  sku         text,
  scanned_at  timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_events_barcode_ok CHECK (barcode = btrim(barcode) AND btrim(barcode) <> '')
);

COMMENT ON TABLE  scan_events IS 'ประวัติการสแกน (telemetry) — sku NULL = สแกนแล้วไม่พบในคลัง (สัญญาณว่าฉลาก/ข้อมูลไม่ตรง); ไม่ผูก FK sku เพื่อเก็บบาร์โค้ดที่ไม่รู้จักไว้วิเคราะห์';

-- 3.13 sync_runs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_runs (
  id              bigserial       PRIMARY KEY,
  driver          text            NOT NULL,
  kind            sync_kind       NOT NULL,
  warehouse_code  text,
  started_at      timestamptz     NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  rows_read       integer         NOT NULL DEFAULT 0,
  rows_upserted   integer         NOT NULL DEFAULT 0,
  rows_tombstoned integer         NOT NULL DEFAULT 0,
  status          sync_run_status NOT NULL DEFAULT 'running',
  error           text,
  anomalies       jsonb           NOT NULL DEFAULT '[]'::jsonb,
  stock_as_of     timestamptz,
  cursor_after    bigint,
  triggered_by    text,
  CONSTRAINT sync_runs_driver_ok    CHECK (driver IN ('rest', 'sql', 'mock')),
  CONSTRAINT sync_runs_wh_trim      CHECK (warehouse_code IS NULL OR warehouse_code = btrim(warehouse_code)),
  CONSTRAINT sync_runs_finish_order CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT sync_runs_rows_ge      CHECK (rows_read >= 0 AND rows_upserted >= 0 AND rows_tombstoned >= 0),
  CONSTRAINT sync_runs_anomalies_arr CHECK (jsonb_typeof(anomalies) = 'array'),
  -- ล้มเหลวต้องบอกเหตุ (จุดแรกที่ผู้ดูแลเปิดดูเมื่อ "ทำไมสต็อกไม่อัปเดต")
  CONSTRAINT sync_runs_error_when_failed CHECK (status <> 'failed' OR error IS NOT NULL),
  -- ป้าย "ข้อมูล ณ HH:MM" ต้องมาจากรอบที่สำเร็จจริงเท่านั้น
  CONSTRAINT sync_runs_stock_as_of_success CHECK (stock_as_of IS NULL OR status = 'success')
);

COMMENT ON TABLE  sync_runs IS 'บันทึกทุกรอบดึงข้อมูลจาก ERP — จุดแรกที่ผู้ดูแลดูเมื่อสต็อกไม่อัปเดต (ERP ล่มห้ามทำให้ container unhealthy)';
COMMENT ON COLUMN sync_runs.stock_as_of IS 'เวลาที่ดึง ERP สำเร็จ — ป้าย "ข้อมูล ณ HH:MM" อ่านจากค่านี้ (ไม่ใช่ max ของ erp_updated_at ซึ่งจะโกหกเมื่อ ERP ไม่มีอะไรเปลี่ยน)';
COMMENT ON COLUMN sync_runs.status IS 'partial = ดึงไม่ครบ → ห้ามขยับ cursor และห้าม tombstone';
COMMENT ON COLUMN sync_runs.anomalies IS 'array ของความผิดปกติ: row-count drift, barcode ชนกัน, ItemCode ซ้ำ, decode ภาษาไทยพัง, คลังไม่ตรงที่คาด';

-- =============================================================================
-- 4. Indexes (ตาม query จริงของ API surface)
-- =============================================================================

-- delta feed: WHERE row_version > $since ORDER BY row_version (รวม tombstone)
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_cache_row_version
  ON items_cache (row_version);
CREATE INDEX IF NOT EXISTS idx_items_cache_wh_row_version
  ON items_cache (warehouse_code, row_version);
-- รายการที่ยังมีชีวิต (หน้าค้นหา/นับ)
CREATE INDEX IF NOT EXISTS idx_items_cache_active
  ON items_cache (warehouse_code) WHERE deleted_at IS NULL;

-- barcode lookup: GET /items/by-barcode/:code (exact match) + reverse ต่อ sku
CREATE INDEX IF NOT EXISTS idx_item_barcodes_sku ON item_barcodes (sku);

-- ค้นหา substring ชื่อไทย/sku — GIN trigram ถ้ามี pg_trgm, ไม่มีก็ btree lower()
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_items_cache_name_trgm ON items_cache USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_items_cache_sku_trgm  ON items_cache USING gin (sku gin_trgm_ops)';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_items_cache_name_lower ON items_cache (lower(name))';
  END IF;
END
$do$;

-- auth
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_emp ON refresh_tokens (emp_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_emp_device_active
  ON refresh_tokens (emp_id, device_id, issued_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- devices heartbeat / ops view
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_devices_queue ON devices (queue_depth DESC) WHERE queue_depth > 0;

-- รอบนับ
CREATE INDEX IF NOT EXISTS idx_count_sessions_open
  ON count_sessions (warehouse_code, opened_at DESC) WHERE status = 'open';
-- 1 รอบ ERP : 1 แถวของเรา (dedupe แล้วด้วย Roworder สูงสุด) — voucher_no ไม่มี unique โดยเจตนา
CREATE UNIQUE INDEX IF NOT EXISTS ux_count_sessions_erp_txn
  ON count_sessions (erp_transaction_no) WHERE erp_transaction_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_count_sessions_voucher ON count_sessions (erp_voucher_no);

CREATE INDEX IF NOT EXISTS idx_count_snapshot_sku ON count_snapshot (sku);
CREATE INDEX IF NOT EXISTS idx_count_snapshot_zone ON count_snapshot (session_id, zone);
CREATE INDEX IF NOT EXISTS idx_count_zone_assign_emp ON count_zone_assign (emp_id, session_id);

-- ingest + variance
CREATE INDEX IF NOT EXISTS idx_count_submissions_session_sku
  ON count_submissions (session_id, sku, device_seq DESC, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_count_submissions_session_device
  ON count_submissions (session_id, sku, device_id);
CREATE INDEX IF NOT EXISTS idx_count_submissions_device_seq
  ON count_submissions (device_id, device_seq DESC);
CREATE INDEX IF NOT EXISTS idx_count_submissions_emp
  ON count_submissions (emp_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_closed_variance_diff
  ON closed_variance (session_id, status) WHERE diff IS DISTINCT FROM 0;

-- observability
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_scanned ON scan_events (scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_barcode ON scan_events (barcode, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_events_emp ON scan_events (emp_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_kind_started ON sync_runs (kind, started_at DESC);
-- อ่าน stock_as_of ล่าสุดของรอบที่สำเร็จ (ป้าย "ข้อมูล ณ HH:MM")
CREATE INDEX IF NOT EXISTS idx_sync_runs_stock_as_of
  ON sync_runs (kind, stock_as_of DESC) WHERE stock_as_of IS NOT NULL;

-- =============================================================================
-- 5. View v_variance — ส่วนต่างสด (ระหว่างรอบ)
-- =============================================================================
-- กติกา "ล่าสุดชนะ" มีขอบเขต:
--   • ภายในเครื่องเดียว → เรียงตาม device_seq (แล้ว received_at, idempotency_key กัน tie)
--   • ข้ามเครื่อง (2+ device_id นับ SKU เดียวกันในรอบเดียวกัน) → CONFLICT ห้าม auto-resolve
--     เพราะ received_at คือลำดับการซิงค์ ไม่ใช่ลำดับการนับจริง
CREATE OR REPLACE VIEW v_variance AS
WITH keys AS (
  SELECT session_id, sku FROM count_snapshot
  UNION
  SELECT session_id, sku FROM count_submissions
),
agg AS (
  SELECT
    session_id,
    sku,
    count(*)                        AS submission_count,
    count(DISTINCT device_id)       AS device_count,
    array_agg(DISTINCT device_id)   AS device_ids,
    max(received_at)                AS last_received_at
  FROM count_submissions
  GROUP BY session_id, sku
),
latest AS (
  SELECT DISTINCT ON (session_id, sku)
    session_id,
    sku,
    idempotency_key,
    counted_qty,
    emp_id,
    device_id,
    device_seq,
    counted_at,
    received_at
  FROM count_submissions
  ORDER BY session_id, sku, device_seq DESC, received_at DESC, idempotency_key DESC
)
SELECT
  k.session_id,
  k.sku,
  sn.frozen_on_hand,
  l.counted_qty,
  l.counted_qty - sn.frozen_on_hand                     AS diff,
  l.emp_id                                              AS counted_by,
  l.device_id                                           AS counted_device_id,
  l.device_seq,
  l.counted_at,
  l.received_at,
  l.idempotency_key                                     AS latest_submission,
  COALESCE(a.submission_count, 0)                       AS submission_count,
  COALESCE(a.device_count, 0)                           AS device_count,
  a.device_ids,
  GREATEST(COALESCE(a.submission_count, 0) - 1, 0)      AS superseded_count,
  COALESCE(a.device_count, 0) > 1                        AS is_conflict,
  CASE
    WHEN COALESCE(a.device_count, 0) > 1              THEN 'conflict'::variance_status
    WHEN sn.session_id IS NULL                        THEN 'off_list'::variance_status
    WHEN l.idempotency_key IS NULL                    THEN 'not_counted'::variance_status
    WHEN l.counted_qty > sn.frozen_on_hand            THEN 'over'::variance_status
    WHEN l.counted_qty < sn.frozen_on_hand            THEN 'short'::variance_status
    ELSE 'match'::variance_status
  END                                                    AS status,
  sn.unit,
  sn.warehouse_code,
  sn.zone
FROM keys k
LEFT JOIN count_snapshot sn ON sn.session_id = k.session_id AND sn.sku = k.sku
LEFT JOIN latest         l  ON l.session_id  = k.session_id AND l.sku  = k.sku
LEFT JOIN agg            a  ON a.session_id  = k.session_id AND a.sku  = k.sku;

COMMENT ON VIEW v_variance IS 'ส่วนต่างสดต่อ (session_id, sku): submission ล่าสุดตาม device_seq/received_at เทียบ count_snapshot; device_count > 1 = CONFLICT ให้ admin ตัดสิน (ห้าม auto-resolve). หลังปิดรอบให้อ่านจาก closed_variance. diff เป็น NULL ได้ 2 กรณี: not_counted (ยังไม่นับ) และ off_list (นับเจอของนอกรายการ = ไม่มียอดระบบในรอบนี้ให้เทียบ) — ฝั่ง API ต้องแยกแสดง ห้าม coalesce เป็น 0';

-- =============================================================================
-- 6. Append-only enforcement เพิ่มเติมที่ระดับสิทธิ์
-- =============================================================================
-- trigger deny_mutation กันไว้แล้วทุก role; ชั้นนี้เพิ่มการถอนสิทธิ์ให้ role ของแอป
-- ถ้าติดตั้งแบบมี role แยก (แนะนำ: role แอปไม่ใช่ owner ของ schema)
DO $do$
DECLARE
  app_role text;
BEGIN
  FOREACH app_role IN ARRAY ARRAY['stock_app', 'tcl_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON count_submissions, audit_log FROM %I', app_role);
      EXECUTE format('GRANT SELECT, INSERT ON count_submissions, audit_log TO %I', app_role);
      RAISE NOTICE 'ถอนสิทธิ์ UPDATE/DELETE บน count_submissions, audit_log จาก role %', app_role;
    END IF;
  END LOOP;
END
$do$;

-- =============================================================================
-- 7. Structural guard — กฎเหล็ก "ไม่เขียนกลับ ERP"
-- =============================================================================
-- ถ้ามีใครเพิ่มคิวเขียนกลับ ERP เข้ามา migration ต้องล้มทันที (fail fast)
DO $do$
DECLARE
  banned text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO banned
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND (c.relname = 'erp_post_outbox' OR c.relname LIKE 'erp_push%' OR c.relname LIKE 'erp_adjust%');

  IF banned IS NOT NULL THEN
    RAISE EXCEPTION 'ละเมิดกฎเหล็ก: พบ object สำหรับเขียนกลับ ERP (%) — ระบบนี้อ่าน ERP อย่างเดียว ห้ามมีคิว/ตารางเขียนกลับ', banned;
  END IF;
END
$do$;

-- ────────────────────────────────────────────────────────────────────────────
-- migration แบบ idempotent สำหรับ DB ที่สร้างไว้ก่อนหน้า
-- (CREATE TABLE IF NOT EXISTS ไม่เพิ่มคอลัมน์ให้ตารางที่มีอยู่แล้ว)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_emp_id text;
COMMENT ON COLUMN devices.last_emp_id IS 'คนล่าสุดที่ login บนเครื่องนี้ — ใช้ตามหาเครื่องที่หายพร้อมงานนับค้าง';
