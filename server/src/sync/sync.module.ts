import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { z } from 'zod';

import { CurrentUser, RequireFreshRole, Roles } from '../auth/auth.guards';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { ROLE_RANK, type AuthenticatedUser, type Role } from '../auth/auth.types';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService, TombstoneGuardrailError } from '../catalog/catalog.service';
import { parseUserLevelRoleMap, type AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import {
  ERP_ADAPTER,
  type ErpAdapter,
  type ErpUserRow,
} from '../erp/erp-adapter';

/**
 * Sync — ดึงข้อมูลจาก ERP ตามรอบเข้า Postgres ของเราเอง
 *
 * 🚫 กฎเหล็ก: ERP (`db_TCL`) **อ่านอย่างเดียว** — ไฟล์นี้เรียกได้เฉพาะ `ErpAdapter`
 *    (interface ไม่มี method เขียน) และเขียนลง Postgres ของระบบเราเท่านั้น
 *
 * หลักการที่ต้องรักษา (docs/erp-integration.md §5):
 *  1. รอบซ้อนกันไม่ได้ → pg advisory lock (ดึง 50k แถวอาจนานกว่าคาบ cron)
 *  2. ดึงไม่ครบ = 'partial' → **ห้าม tombstone และห้ามขยับ cursor** (ไม่ set stock_as_of)
 *  3. ERP ล่ม = 'failed' + log แต่ **ห้าม throw ออกจาก scheduler** (ระบบต้องเดินด้วย cache เดิม)
 *  4. ป้าย "ข้อมูล ณ HH:MM" ในแอปอ่านจาก `sync_runs.stock_as_of` (เวลาที่ดึง ERP สำเร็จ)
 *     ไม่ใช่ `items_cache.erp_updated_at` ซึ่งจะโกหกเมื่อ ERP ไม่มีอะไรเปลี่ยน
 */

// ---------------------------------------------------------------------------
// ชนิดข้อมูลที่ export ให้โมดูลอื่นใช้
// ---------------------------------------------------------------------------

export interface SyncRunResult {
  runId: number;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  rowsRead: number;
  rowsUpserted: number;
  rowsTombstoned: number;
  error?: string;
  anomalies: unknown[];
  /** ตัวนับสรุปของรอบ (ดู `sync_runs.metrics`) — รอบ items ไม่มี */
  metrics?: Record<string, number>;
}

/**
 * ตัวนับของรอบผู้ใช้ที่ต้องเห็นได้จาก `sync_runs.metrics` โดยไม่ต้องเปิดโค้ด
 *
 * ⚠️ `unmapped` กับ `absent` เป็นคนละเรื่องกันโดยสิ้นเชิง และนี่คือจุดที่เคยพลาด:
 *   `unmapped` = ปรากฏใน ERP แต่ `user_level` ไม่อยู่ใน allowlist → **ปัญหา config**
 *                (map ตกไปค่าหนึ่ง / ERP เปลี่ยน level ให้คน) ห้ามลบ credential เด็ดขาด
 *   `absent`   = ไม่ปรากฏในผล ERP เลย → **ปัญหาคน** (ลาออก/ถูกปิดบัญชี) เท่านั้นที่เข้า sweep ได้
 */
interface UserSyncMetrics extends Record<string, number> {
  /** map เป็น role ได้ → เขียน users + credential */
  mapped: number;
  /** ปรากฏใน ERP แต่ level ไม่อยู่ใน allowlist — ไม่แตะแถวเดิมเลย */
  unmapped: number;
  /** ในจำนวน unmapped มีกี่คนที่ยังถือ credential อยู่ (ตัวเลขที่ฟ้องว่า map ตกค่าไหนไป) */
  unmappedKeptCredential: number;
  /**
   * แถวที่รูปแบบใช้ไม่ได้ (emp_id/login/ชื่อ/รหัสผ่าน decode เพี้ยน) หรือ login_name ซ้ำ —
   * ทั้งซ้ำกันเองในรอบเดียว (`duplicate_login`) และซ้ำกับแถวที่ persist ไว้แล้วของ emp_id
   * อื่น (`login_name_conflict`) ทั้งสองแบบข้ามเป็นรายแถว ห้ามล้มทั้งรอบ
   */
  rejected: number;
  /** credential (erp/legacy_pin) ที่ไม่ปรากฏในผล ERP รอบนี้ — กำลังนับเวลา grace */
  absent: number;
  /** ในจำนวน absent ที่ค้างนานพ้น grace แล้ว = เข้าเกณฑ์ลบได้ */
  graceElapsed: number;
  /** ลบจริงในรอบนี้ */
  deactivated: number;
  /**
   * ในจำนวน `deactivated` มีกี่คนที่เป็น admin — ตัวเลขที่ต้องดูก่อนตัวอื่นทั้งหมด
   *
   * ⚠️ เพดาน last-admin ยอมให้ผ่านตราบใดที่เหลือ admin ที่ล็อกอินได้ **อย่างน้อย 1 คน**
   *    ซึ่งอาจเป็น break-glass (`source='local'`) เพียงคนเดียว = คลังไม่เหลือ admin ตัวจริงเลย
   *    ทั้งที่รอบนั้นรายงานว่า 'success' → ตัวนับนี้กับ anomaly `admin_credentials_deactivated`
   *    คือสิ่งเดียวที่ทำให้ผู้ดูแลรู้ตัว
   */
  adminsDeactivated: number;
  /**
   * **พ้น grace แล้ว** แต่การ์ดปฏิเสธ (เพดาน %, เพดานแถวขั้นต่ำ, last-admin floor)
   *
   * ⚠️ ทุกเส้นทางต้องแปลตัวเลขนี้เหมือนกันเป๊ะ = `graceElapsed - deactivated` เสมอ
   *    เคยมีเส้นทางเดียว (เพดานแถวขั้นต่ำ) ที่ใส่ "จำนวน absent ทั้งหมด" ลงช่องนี้แล้วปล่อย
   *    `graceElapsed` เป็น 0 → เลขเดียวกันสองรอบหมายถึงคนละเรื่อง อ่านเทียบกันไม่ได้
   */
  refused: number;
  /**
   * เลื่อนสิทธิ์ขึ้นจริงในรอบนี้ (rank สูงกว่าเดิม) — คนที่เพิ่งได้บัญชีรอบนี้ไม่นับ
   * เพราะไม่มีสิทธิ์เดิมให้เทียบ
   */
  elevated: number;
  /** ตั้งใจเลื่อนสิทธิ์แต่เกินเพดาน `ERP_USER_ELEVATE_MAX_PCT` → คงสิทธิ์เดิมไว้ทุกคน */
  elevationsRefused: number;
}

/** ตรงกับ enum `sync_kind` ใน Postgres */
/**
 * ชนิดของรอบ sync
 * ⚠️ 'stock' และ 'count_sessions' ถูกตัดออก 22 ส.ค. 2569 (ยอดคงเหลือมาพร้อม item master แล้ว ·
 *    ไม่ mirror รอบนับของ ERP อีกต่อไป) ค่าเดิมยังมีในคอลัมน์ sync_runs.kind ของข้อมูลเก่า
 *    จึงไม่ลบออกจาก enum ใน DB
 * 'users' = รอบดึงผู้ใช้จาก `menuuser` (เพิ่มเข้า enum ด้วย ALTER TYPE ... ADD VALUE ใน schema.sql)
 */
export type SyncKind = 'items' | 'users';

/** อายุข้อมูลล่าสุดต่อ kind — CountService ใช้ตัดสิน `opened_on_stale_cache` */
export interface SyncFreshness {
  stockAsOf: Date | null;
  finishedAt: Date | null;
}

/** 1 รอบใน `GET /sync/runs` — จุดแรกที่ผู้ดูแลดูเมื่อ "ทำไมสต็อกไม่อัปเดต" */
export interface SyncRunDto {
  id: number;
  driver: string;
  kind: SyncKind;
  warehouseCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  rowsUpserted: number;
  rowsTombstoned: number;
  status: SyncRunResult['status'] | 'running';
  error: string | null;
  anomalies: unknown[];
  /** ตัวนับสรุปของรอบ — `{}` สำหรับรอบที่ไม่ได้บันทึกอะไร (เช่นรอบ items) */
  metrics: Record<string, unknown>;
  stockAsOf: string | null;
  triggeredBy: string | null;
}

export interface SyncStatusDto {
  itemsStockAsOf: string | null;
  erpOk: boolean;
}

// ---------------------------------------------------------------------------
// ค่าคงที่ + ตัวช่วย (pure)
// ---------------------------------------------------------------------------

/**
 * key ของ advisory lock — คงที่ตลอดอายุระบบ (คนละ key ต่อ kind เพื่อให้
 * รอบต่าง kind ไม่บล็อกกันเอง)
 */
const LOCK_KEY: Readonly<Record<SyncKind, number>> = {
  items: 872_001,
  users: 872_002, // คนละ key จาก items — รอบ users ไม่บล็อกรอบ items และกลับกัน
};

/** กันไม่ให้ jsonb ของ 1 รอบบวมจนอ่านไม่ได้ */
const MAX_ANOMALIES = 200;
const MAX_ERROR_LEN = 1000;

/**
 * จำนวน emp_id สูงสุดที่ยอมให้ติดไปใน anomaly ก้อนเดียว
 * (การ์ดที่ปฏิเสธ "ทั้งคลัง" ได้ ต้องบอกว่าใครบ้างพอให้ตามต่อ แต่ห้ามยัดทั้งคลังลง jsonb)
 */
const MAX_ANOMALY_IDS = 20;

/**
 * ⚠️ สำเนาของ statement เดียวกับ `MembersService` โดยตั้งใจ — ทั้งสองไฟล์เขียน `users`/
 * `refresh_tokens` ด้วยกติกาเดียวกันเป๊ะ (ลดสิทธิ์ = ตัด refresh token ทุกเครื่อง)
 * ไม่ import ข้ามโมดูลเพราะ MembersModule ไม่ได้ export ค่าเหล่านี้ และ SyncModule
 * ไม่ควรต้อง import ทั้ง MembersModule เพื่อเอาสตริงสองบรรทัด
 */
const AUDIT_SQL = `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`;

const REVOKE_ALL_SQL = `UPDATE refresh_tokens SET revoked_at = now()
                         WHERE emp_id = $1 AND revoked_at IS NULL`;

/** กะเริ่มต้นของผู้ใช้ที่ sync มาจาก ERP — `menuuser` ไม่มีคอลัมน์กะ (สตริงเดียวกับ MembersService) */
const DEFAULT_SHIFT = 'ยังไม่กำหนดกะ';

/** `menuuser.emp_id` ต้องผ่านรูปแบบเดียวกับ CHECK `users_emp_id_fmt` ไม่งั้น INSERT ล้มทั้ง run */
const EMP_CODE_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** ความยาวสูงสุดของ login_name ตาม CHECK `user_credentials_login_fmt` */
const MAX_LOGIN_NAME_LEN = 64;

/** U+FFFD ในรหัสผ่าน = decode charset ผิด — hash ค่าที่เพี้ยนไว้จะทำให้คนนั้นล็อกอินไม่ได้ตลอดไป */
const REPLACEMENT_CHAR = '\uFFFD';

/**
 * \u0E15\u0E49\u0E2D\u0E07 "\u0E2B\u0E32\u0E22\u0E08\u0E32\u0E01\u0E1C\u0E25 ERP" \u0E15\u0E48\u0E2D\u0E40\u0E19\u0E37\u0E48\u0E2D\u0E07\u0E19\u0E32\u0E19\u0E40\u0E17\u0E48\u0E32\u0E19\u0E35\u0E49\u0E01\u0E48\u0E2D\u0E19\u0E16\u0E39\u0E01\u0E1B\u0E34\u0E14\u0E25\u0E47\u0E2D\u0E01\u0E2D\u0E34\u0E19 (cron \u0E23\u0E32\u0E22\u0E0A\u0E31\u0E48\u0E27\u0E42\u0E21\u0E07 \u2248 24 \u0E23\u0E2D\u0E1A\u0E15\u0E34\u0E14)
 *
 * \u0E40\u0E1B\u0E47\u0E19\u0E01\u0E32\u0E23\u0E4C\u0E14\u0E04\u0E19\u0E25\u0E30\u0E0A\u0E31\u0E49\u0E19\u0E01\u0E31\u0E1A\u0E40\u0E1E\u0E14\u0E32\u0E19 % \u0E41\u0E25\u0E30\u0E40\u0E1E\u0E14\u0E32\u0E19\u0E41\u0E16\u0E27\u0E02\u0E31\u0E49\u0E19\u0E15\u0E48\u0E33: \u0E2A\u0E2D\u0E07\u0E15\u0E31\u0E27\u0E19\u0E31\u0E49\u0E19\u0E04\u0E38\u0E21 "\u0E23\u0E2D\u0E1A\u0E19\u0E35\u0E49\u0E25\u0E1A\u0E40\u0E22\u0E2D\u0E30\u0E44\u0E1B\u0E44\u0E2B\u0E21"
 * \u0E2A\u0E48\u0E27\u0E19\u0E15\u0E31\u0E27\u0E19\u0E35\u0E49\u0E04\u0E38\u0E21 "\u0E25\u0E1A\u0E08\u0E32\u0E01\u0E2B\u0E25\u0E31\u0E01\u0E10\u0E32\u0E19\u0E23\u0E2D\u0E1A\u0E40\u0E14\u0E35\u0E22\u0E27\u0E44\u0E2B\u0E21" \u2014 ERP \u0E15\u0E2D\u0E1A\u0E40\u0E1E\u0E35\u0E49\u0E22\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E23\u0E2D\u0E1A (query \u0E16\u0E39\u0E01\u0E15\u0E31\u0E14\u0E17\u0E2D\u0E19 /
 * \u0E15\u0E32\u0E23\u0E32\u0E07\u0E16\u0E39\u0E01\u0E25\u0E47\u0E2D\u0E01 / deploy \u0E01\u0E25\u0E32\u0E07\u0E04\u0E31\u0E19) \u0E15\u0E49\u0E2D\u0E07\u0E44\u0E21\u0E48\u0E17\u0E33\u0E43\u0E2B\u0E49\u0E43\u0E04\u0E23\u0E25\u0E47\u0E2D\u0E01\u0E2D\u0E34\u0E19\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49 \u0E19\u0E32\u0E2C\u0E34\u0E01\u0E32\u0E16\u0E39\u0E01\u0E25\u0E49\u0E32\u0E07\u0E17\u0E31\u0E19\u0E17\u0E35\u0E17\u0E35\u0E48\u0E01\u0E25\u0E31\u0E1A\u0E21\u0E32\u0E1E\u0E1A
 */
const ABSENCE_GRACE_HOURS = 24;

/** ค่าเดียวกันในรูป interval ของ Postgres — ทั้ง sweep และด่าน last-admin ต่อแถวต้องใช้ตัวนี้ตัวเดียว */
const ABSENCE_GRACE_INTERVAL = `${ABSENCE_GRACE_HOURS} hours`;

/** โค้ดของ Postgres ตอน unique/PK ชน — ดูจาก `code` เท่านั้น ข้อความเปลี่ยนตาม locale ได้ */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * จำนวนการเลื่อนสิทธิ์ที่ยอมให้ผ่านเสมอ ไม่ว่าจะคิดเป็นกี่ % ของคนทั้งคลัง
 *
 * เพดาน % ล้วน ๆ ใช้กับคลังเล็กไม่ได้: คลังที่มีบัญชีจาก ERP อยู่ 2 คน การเลื่อนสิทธิ์ที่ถูกต้อง
 * ของคนเดียว = 50% ซึ่งเกินเพดานทุกค่าที่ตั้งจริงได้ → การ์ดจะปฏิเสธการเลื่อนสิทธิ์ **ทุกครั้ง
 * ตลอดไป** แบบเงียบ ๆ ซึ่งเป็นความเสียหายคนละแบบแต่ถาวรพอกัน
 * การ์ดนี้มีไว้กัน "role map พิมพ์ผิดแล้วคนทั้งคลังกลายเป็น admin ในรอบเดียว"
 * ไม่ได้มีไว้กันการเลื่อนสิทธิ์ทีละคนที่ผู้ดูแลตั้งใจให้เกิด
 */
const ELEVATE_ALWAYS_ALLOWED = 3;

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_ERROR_LEN ? `${raw.slice(0, MAX_ERROR_LEN)}…` : raw;
}

/** `login_name` ที่คนอื่นถือไว้อยู่แล้ว = แถวเสียรายตัว ไม่ใช่เหตุให้ล้มทั้งรอบ */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

function toCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** จำกัดจำนวน anomaly ที่เก็บลง sync_runs (jsonb) ไม่ให้บวมจนอ่านไม่ได้ */
function pushAnomaly(into: unknown[], anomaly: unknown): void {
  if (into.length < MAX_ANOMALIES) into.push(anomaly);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * แถวจาก ERP หลังผ่าน "ด่านรูปแบบ" ของรอบผู้ใช้
 *
 * `ok: false` = แถวที่ลูปหลักจะปฏิเสธแน่นอน และ `reason` ตรงกับชนิด anomaly ที่บันทึกลง
 * `sync_runs.anomalies` แบบหนึ่งต่อหนึ่ง
 */
type ScreenedRow = { row: ErpUserRow; empCode: string; login: string } & (
  | { ok: true; nameThai: string }
  | { ok: false; reason: 'rejected_row' | 'duplicate_login' }
);

/**
 * ด่านรูปแบบ **ชุดเดียว** ของรอบผู้ใช้ — ลูปที่เขียนจริงกับ `planElevations()` ที่นับ
 * ล่วงหน้าเทียบเพดาน ต้องเห็นแถวชุดเดียวกันเป๊ะ
 *
 * ⚠️ เคยแยกกันมาก่อนแล้วเพี้ยน: `planElevations()` กรองแค่ emp_id + map เป็น role ได้
 *    ส่วนลูปหลักปฏิเสธ login ซ้ำกันเองในรอบเดียว / รหัสผ่าน decode เพี้ยน / ชื่อกับ login
 *    ว่างเพิ่มอีกชั้น → จำนวนที่เอาไปเทียบเพดานสูงกว่าจำนวนที่จะเลื่อนสิทธิ์ได้จริง
 *    การ์ดจึงบล็อกการเลื่อนสิทธิ์ที่ถูกต้องด้วยตัวเลขที่ไม่มีวันเกิดขึ้น
 *
 * 🚫 `password.expose()` ใช้เพื่อตรวจ U+FFFD ตรงนี้เท่านั้น ห้ามเก็บ/log/คืนค่าออกไป
 */
function screenUserRows(rows: readonly ErpUserRow[]): ScreenedRow[] {
  const seenLoginNames = new Set<string>(); // กันชนกันเองภายในรอบเดียว
  return rows.map((row): ScreenedRow => {
    const empCode = row.empCode.trim();
    const login = row.loginName.trim().toLowerCase();
    const nameThai = row.nameThai.trim();
    // emp_id อ่านไม่ออก = จับคู่กับแถวใน user_credentials ไม่ได้อยู่แล้ว (CHECK เดียวกัน)
    if (
      !EMP_CODE_RE.test(empCode) ||
      login.length === 0 ||
      login.length > MAX_LOGIN_NAME_LEN ||
      nameThai.length === 0 ||
      row.password.expose().includes(REPLACEMENT_CHAR)
    ) {
      return { ok: false, row, empCode, login, reason: 'rejected_row' };
    }
    if (seenLoginNames.has(login)) {
      return { ok: false, row, empCode, login, reason: 'duplicate_login' };
    }
    seenLoginNames.add(login);
    return { ok: true, row, empCode, login, nameThai };
  });
}

// ---------------------------------------------------------------------------

interface SyncRunRow {
  id: string;
  driver: string;
  kind: SyncKind;
  warehouse_code: string | null;
  started_at: Date;
  finished_at: Date | null;
  rows_read: number;
  rows_upserted: number;
  rows_tombstoned: number;
  status: SyncRunDto['status'];
  error: string | null;
  anomalies: unknown;
  metrics: unknown;
  stock_as_of: Date | null;
  triggered_by: string | null;
}

/** แถว `users` ที่ถูกล็อกไว้ระหว่างตัดสิน role (รูปเดียวกับ MembersService.changeRole) */
interface LockedUserRow {
  emp_id: string;
  role: Role;
  /**
   * ยังมีแถวใน `user_credentials` อยู่ไหม — **`users.role = 'admin'` ไม่ได้แปลว่าล็อกอินได้**
   *
   * sweep ลบเฉพาะแถว credential และไม่แตะแถว `users` เลยโดยตั้งใจ (FK 9 ตาราง +
   * count_submissions เป็น ON DELETE RESTRICT) คนที่ออกจาก ERP ไปแล้วจึงค้างเป็น
   * admin ใน `users` ตลอดกาลทั้งที่ล็อกอินไม่ได้ นับ "admin ผี" พวกนี้เป็นตาข่ายเมื่อไร
   * ด่าน last-admin จะยอมลดสิทธิ์ admin ตัวจริงคนสุดท้ายทันที
   */
  has_credential: boolean;
}

/** ⚠️ `secret_hash` เป็น argon2id เท่านั้น ห้ามหลุดออกจากขอบเขตของ verify/hash */
interface CredentialRow {
  source: string;
  secret_hash: string;
}

interface DoomedCredentialRow {
  login_name: string;
  emp_id: string;
  /** role ปัจจุบันของเจ้าของแถว — ใช้นับว่าลบแล้วยังเหลือ admin ที่ล็อกอินได้ไหม */
  role: Role;
}

/** ตัวนับที่ deactivation sweep ผลิต — ต้องลง `sync_runs.metrics` ทุกทางออกของ sweep */
interface SweepCounts {
  absent: number;
  graceElapsed: number;
  deactivated: number;
  adminsDeactivated: number;
  refused: number;
}

/**
 * sweep รอบนี้จะทำให้ไม่เหลือ credential ของ admin เลย → ห้าม commit
 *
 * โยนจาก**ในทรานแซกชัน**ของ sweep โดยตั้งใจ เพื่อให้การลบทั้งก้อน rollback พร้อมกัน
 * (ลบไปครึ่งทางแล้วค่อยรู้ตัว = ยังล็อกคนออกอยู่ดี) รอบถูกบันทึกเป็น 'failed'
 */
class AdminCredentialFloorError extends Error {
  constructor(
    readonly adminCredentials: number,
    readonly doomedAdmins: number,
    /**
     * ตัวนับ ณ วินาทีที่ปฏิเสธ — **เดินทางออกมากับ error เอง**
     *
     * บรรทัดที่ copy ผลของ sweep ลง `metrics` อยู่หลังจุดเรียก จึงไม่มีวันได้รันเมื่อ sweep โยน
     * → รอบที่ผู้ดูแลต้องอ่านมากที่สุด (ระบบเกือบไม่เหลือ admin) กลับเป็นรอบเดียวที่ทุกตัวนับ
     *   เป็น 0 ทั้งแถว ดูเหมือนรอบที่ไม่ได้ทำอะไรเลย
     */
    readonly counts: SweepCounts,
  ) {
    super(
      `ยกเลิกการปิดล็อกอิน ${doomedAdmins} บัญชี: จะไม่เหลือ admin ที่ล็อกอินได้เลย ` +
        `(admin ที่มี credential ทั้งหมด ${adminCredentials} คน) — ตรวจ ERP_USER_LEVEL_ROLE_MAP ก่อน`,
    );
    this.name = 'AdminCredentialFloorError';
  }
}

const SELECT_RUNS_SQL = `SELECT id, driver, kind, warehouse_code, started_at, finished_at,
                                rows_read, rows_upserted, rows_tombstoned, status, error,
                                anomalies, metrics, stock_as_of, triggered_by
                           FROM sync_runs
                          ORDER BY started_at DESC, id DESC
                          LIMIT $1`;

/** stock_as_of ถูก CHECK ให้มีได้เฉพาะรอบ success อยู่แล้ว — query นี้จึงเป็นแหล่งอายุข้อมูลเดียว */
const LAST_SUCCESS_SQL = `SELECT stock_as_of, finished_at
                            FROM sync_runs
                           WHERE kind = $1 AND status = 'success'
                           ORDER BY finished_at DESC NULLS LAST, id DESC
                           LIMIT 1`;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);
  private readonly driver: 'sql' | 'rest' | 'mock';
  private readonly warehouseCode: string;

  constructor(
    private readonly db: PostgresService,
    @Inject(ERP_ADAPTER) private readonly erp: ErpAdapter,
    private readonly catalog: CatalogService,
    private readonly registry: SchedulerRegistry,
    private readonly cfg: ConfigService<AppConfig, true>,
    /** ใช้ hashPin/verifyPin ตัวเดียวกับ login — pepper เดียวกันเท่านั้น (ห้ามมี pepper แยกของ sync) */
    private readonly auth: AuthService,
  ) {
    this.driver = cfg.get('ERP_DRIVER', { infer: true });
    this.warehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true });
  }

  // ── 1. scheduler ────────────────────────────────────────────────────────
  //
  // ⚠️ @Cron('...') รับ expression ตอน decorate (compile-time) จึงอ่านค่าจาก .env
  //    ไม่ได้ → สร้าง CronJob เองใน onModuleInit แล้วฝากไว้กับ SchedulerRegistry
  //    (ScheduleModule.forRoot() ถูกลงทะเบียนแบบ global ที่ app.module.ts แล้ว
  //     Nest จะหยุด job ที่อยู่ใน registry ให้ตอน shutdown)

  onModuleInit(): void {
    const timeZone = this.cfg.get('TZ', { infer: true });

    this.registerJob('kk:sync:items', this.cfg.get('ERP_SYNC_CRON', { infer: true }), timeZone, () =>
      this.tick('items'),
    );

    // ⚠️ ต่างจาก items ที่ลงทะเบียนเสมอ — รอบผู้ใช้ลงทะเบียน **เฉพาะเมื่อเปิดสวิตช์คัตโอเวอร์**
    //    (ERP_USER_SYNC_ENABLED ไม่มี default เป็น true — ต้องมีคนกดเปิดเองเท่านั้น)
    if (this.cfg.get('ERP_USER_SYNC_ENABLED', { infer: true })) {
      this.registerJob(
        'kk:sync:users',
        this.cfg.get('ERP_USER_SYNC_CRON', { infer: true }),
        timeZone,
        () => this.tick('users'),
      );
    } else {
      this.logger.log('ERP_USER_SYNC_ENABLED=false — ไม่ตั้งรอบ sync ผู้ใช้ (ล็อกอินใช้ข้อมูลเดิม)');
    }

    if (this.driver === 'mock') {
      this.logger.warn('ERP_DRIVER=mock — scheduler ทำงานกับข้อมูล fixture ไม่ใช่ ERP จริง');
    }
  }

  private registerJob(
    name: string,
    cronTime: string,
    timeZone: string,
    run: () => Promise<void>,
  ): void {
    try {
      const job = new CronJob(cronTime, () => void run(), null, false, timeZone);
      this.registry.addCronJob(name, job);
      job.start();
      this.logger.log(`ตั้งรอบ ${name} = "${cronTime}" (${timeZone})`);
    } catch (err) {
      // cron ผิดรูป/ชื่อซ้ำ ห้ามทำให้แอป start ไม่ขึ้น — ยัง trigger มือผ่าน POST /sync/* ได้
      this.logger.error(
        `ตั้งรอบ ${name} ไม่สำเร็จ: ${errorMessage(err)} — ใช้ POST /sync/* trigger เองได้`,
      );
    }
  }

  /** tick ของ cron — ห้าม throw ออกไปนอกนี้เด็ดขาด */
  private async tick(kind: SyncKind): Promise<void> {
    try {
      const result =
        kind === 'users' ? await this.syncUsers('scheduler') : await this.syncItems('scheduler');
      this.logger.log(
        `รอบ ${kind} #${result.runId}: ${result.status} · อ่าน ${result.rowsRead} · เขียน ${result.rowsUpserted} · tombstone ${result.rowsTombstoned}`,
      );
    } catch (err) {
      this.logger.error(`รอบ ${kind} ล้มแบบไม่คาดคิด: ${errorMessage(err)}`);
    }
  }

  // ── 2. syncItems ────────────────────────────────────────────────────────

  /** ดึง item master จาก ERP เข้า items_cache — ไม่ throw เมื่อ ERP ล่ม (คืน status 'failed') */
  async syncItems(triggeredBy: string): Promise<SyncRunResult> {
    return this.withLock('items', triggeredBy, (by) => this.runItems(by));
  }

  private async runItems(triggeredBy: string): Promise<SyncRunResult> {
    const anomalies: unknown[] = [];
    const runId = await this.startRun('items', triggeredBy);
    const seen = new Set<string>();
    let rowsRead = 0;
    let rowsUpserted = 0;
    let rowsTombstoned = 0;
    let streamError: string | undefined;

    // delta pull ได้เฉพาะ driver ที่มี updated-at ที่เชื่อถือได้ · ที่เหลือ = full snapshot
    const since = this.erp.capabilities().delta ? await this.computeSince('items') : undefined;

    try {
      for await (const batch of this.erp.fetchItems(since)) {
        if (batch.length === 0) continue;
        rowsRead += batch.length;
        for (const item of batch) seen.add(item.sku);
        // 1 batch = 1 transaction ย่อย (items + barcodes ต้องลงพร้อมกัน และ
        // 50k แถวห้ามค้างใน transaction เดียว — bounded memory/lock)
        const upserted = await this.db.transaction((client) =>
          this.catalog.upsertItems(batch, this.warehouseCode, client),
        );
        rowsUpserted += toCount(upserted.upserted);
        for (const anomaly of upserted.anomalies) pushAnomaly(anomalies, anomaly);
      }
    } catch (err) {
      streamError = errorMessage(err);
    }

    let status: SyncRunResult['status'];
    let error = streamError;

    if (streamError !== undefined) {
      // ดึงไม่ครบ → ห้าม tombstone และห้าม set stock_as_of (cursor ต้องไม่ขยับ)
      status = rowsRead > 0 ? 'partial' : 'failed';
      pushAnomaly(anomalies, {
        type: 'erp_stream_failed',
        kind: 'items',
        rowsRead,
        message: streamError,
      });
      this.logger.error(`ดึง items จาก ERP ไม่ครบ (อ่านได้ ${rowsRead} แถว): ${streamError}`);
    } else if (since !== undefined) {
      // delta pull: seen มีแค่ของที่เปลี่ยน → reconcile ไม่ได้ ห้าม tombstone
      status = 'success';
    } else {
      try {
        const removed = await this.db.transaction((client) =>
          this.catalog.tombstoneMissing([...seen], this.warehouseCode, client),
        );
        rowsTombstoned = toCount(removed);
        status = 'success';
      } catch (err) {
        // guardrail (ลบเกิน 5%/รอบ) กันไว้ — ของที่ upsert ไปแล้วยังใช้ได้ จึงไม่ล้มทั้งรอบ
        status = 'partial';
        error = errorMessage(err);
        pushAnomaly(
          anomalies,
          err instanceof TombstoneGuardrailError
            ? {
                type: 'tombstone_guardrail_blocked',
                seenSkus: seen.size,
                doomed: err.doomed,
                liveTotal: err.liveTotal,
                ratio: err.ratio,
                message: error,
              }
            : { type: 'tombstone_failed', seenSkus: seen.size, message: error },
        );
        this.logger.warn(`ข้าม tombstone: ${error}`);
      }
    }

    return this.finishRun(runId, { status, rowsRead, rowsUpserted, rowsTombstoned, error, anomalies });
  }

  // ── 2b. syncUsers ───────────────────────────────────────────────────────

  /** ดึงผู้ใช้จาก `menuuser` เข้า users/user_credentials — ไม่ throw เมื่อ ERP ล่ม */
  async syncUsers(triggeredBy: string): Promise<SyncRunResult> {
    return this.withLock('users', triggeredBy, (by) => this.runUsers(by));
  }

  /**
   * รอบผู้ใช้ — เขียน `users` (ตัวตน/สิทธิ์) + `user_credentials` (ตัวยืนยันตัวตน)
   *
   * 🚫 plaintext ของ ERP: `.expose()` ถูกเรียกแล้วส่งเข้า argon2 **ในบรรทัดเดียวกัน** ทุกจุด
   *    ไม่มีการ assign ผลลัพธ์เก็บไว้เป็นตัวแปร ไม่มี anomaly/audit/log บรรทัดไหนรับค่านี้
   *
   * ⚠️ "level ไม่ได้ map" กับ "หายไปจาก ERP" คือคนละเรื่อง และห้ามเดินเส้นทางเดียวกัน:
   *    level ที่ไม่ได้ map = **ปัญหา config ของเราเอง** (ตกไปค่าหนึ่ง / ERP เปลี่ยน level ให้คน)
   *    → คนนั้นไม่ได้บัญชีใหม่ แต่ credential เดิม **ห้ามถูกแตะแม้แถวเดียว**
   *    มีแต่ "ไม่ปรากฏในผล ERP เลย" เท่านั้นที่ป้อนเข้า deactivation sweep ได้
   *
   * ด่านที่ต้องมีครบ (ถอดออกข้อใดข้อหนึ่ง = ล็อกคนทั้งคลังออกได้ในรอบเดียว):
   *  0. ต้องมี break-glass admin (`source='local'`) อยู่ก่อน มิฉะนั้นปฏิเสธทั้ง run —
   *     และบัญชี `source='local'` ต้องรอดจากรอบนี้ทั้ง **credential และ `users.role`**
   *  1. allowlist ล้วน — `user_level` ที่ไม่ได้ map = ไม่ได้บัญชีเลย (ไม่ fallback viewer)
   *  2. last-admin floor ต่อแถว ด้วย `SELECT ... FOR UPDATE` แบบเดียวกับ MembersService.changeRole
   *     นับเฉพาะ admin ที่ **ยังมีแถวใน `user_credentials`** (role อย่างเดียว = ผี ล็อกอินไม่ได้)
   *  3. deactivation sweep ผ่านครบทั้งสี่ชั้น: เพดานแถวขั้นต่ำ · grace หลายรอบ · เพดาน % ·
   *     last-admin floor ของทั้ง sweep (ไม่ผ่านชั้นสุดท้าย = rollback ทั้งก้อน + รอบล้มเหลว)
   *  4. เพดาน % ของการ **เลื่อน** สิทธิ์ทั้งรอบ (`ERP_USER_ELEVATE_MAX_PCT`) — คู่ตรงข้าม
   *     ของข้อ 3 ซึ่งกันแต่การถอนสิทธิ์ ส่วนข้อนี้กัน role map ที่พิมพ์ผิดค่าเดียวไม่ให้
   *     แจก admin ทั้งคลังในรอบเดียว (ตัดสินก่อนเข้าลูปเพราะแต่ละแถว commit แยกกัน)
   */
  private async runUsers(triggeredBy: string): Promise<SyncRunResult> {
    const runId = await this.startRun('users', triggeredBy);
    const anomalies: unknown[] = [];
    const metrics: UserSyncMetrics = {
      mapped: 0,
      unmapped: 0,
      unmappedKeptCredential: 0,
      rejected: 0,
      absent: 0,
      graceElapsed: 0,
      deactivated: 0,
      adminsDeactivated: 0,
      refused: 0,
      elevated: 0,
      elevationsRefused: 0,
    };
    let rowsRead = 0;

    try {
      // ── ด่าน 0: ต้องมี break-glass admin อยู่แล้วก่อนแตะอะไรเลย ──────────────
      // create-admin เขียน source='local' ซึ่ง sync ห้ามแตะ → ถ้าไม่มีเลยแปลว่าไม่มี
      // ทางกลับเข้าระบบถ้ารอบนี้ตีความ role ผิด จึงไม่ยอมเขียนอะไรทั้งสิ้น
      const localAdmin = await this.db.query(
        `SELECT 1 FROM user_credentials c JOIN users u ON u.emp_id = c.emp_id
          WHERE c.source = 'local' AND u.role = 'admin' LIMIT 1`,
      );
      if (localAdmin.rows.length === 0) {
        return this.finishRun(runId, {
          status: 'failed',
          error: 'ไม่มีบัญชี local admin (break-glass) เลย — รัน npm run create-admin ก่อน sync ผู้ใช้',
          rowsRead: 0,
          rowsUpserted: 0,
          rowsTombstoned: 0,
          anomalies,
          metrics,
        });
      }

      const roleMap = this.userLevelRoleMap();
      const rows = await this.erp.fetchUsers();
      rowsRead = rows.length;
      const minExpected = this.cfg.get('ERP_USER_MIN_EXPECTED_ROWS', { infer: true });
      // ⚠️ ไม่ได้ตั้งค่า = ไม่รู้ว่า "ครบ" คือกี่แถว → ถือว่าไม่ผ่านเพดานเสมอ ห้าม deactivate ใคร
      //    (ด่าน boot บังคับตั้งค่านี้เมื่อ ERP_USER_SYNC_ENABLED=true แต่ POST /sync/users
      //     ยิงด้วยมือได้แม้สวิตช์ปิดอยู่ — ตรงนั้นต้องไม่กลายเป็นทางลัดที่ไม่มีเพดาน)
      const rowCountOk = minExpected !== undefined && rows.length >= minExpected;

      // ⚠️ ชุดนี้คือ "ยังอยู่ใน ERP" ไม่ใช่ "ได้บัญชีรอบนี้" — เก็บทุกแถวที่ ERP ส่งมาและ
      //    emp_id อ่านออก ไม่ว่าจะ map ไม่ได้ / login ซ้ำ / ชื่อว่าง ก็ตาม เพราะ sweep
      //    ตอบคำถามเดียวคือ "คนนี้หายไปจาก ERP แล้วหรือยัง" ปนคำถามอื่นเข้าไปเมื่อไร
      //    ค่า map ที่ตกไปค่าเดียวจะกลายเป็นการล้าง credential ทั้งคลังทันที
      //
      //    ประกอบให้ครบ **ก่อน** เข้าลูป (ไม่ใช่เติมทีละแถวระหว่างลูปแบบเดิม) เพราะด่าน
      //    last-admin ต่อแถวต้องรู้ตั้งแต่แถวแรกว่า admin คนไหนกำลังจะถูก sweep ลบท้ายรอบ
      //    เงื่อนไขคัดเข้าเหมือนเดิมเป๊ะ: emp_id ที่ผ่าน EMP_CODE_RE เท่านั้น
      const presentEmpIds = new Set<string>(
        rows.map((r) => r.empCode.trim()).filter((code) => EMP_CODE_RE.test(code)),
      );

      // ── admin ที่ "ยังเป็น admin อยู่ตอนนี้ แต่ credential จะถูกลบท้ายรอบนี้แน่ ๆ" ──────
      // ห้ามนับคนกลุ่มนี้เป็นตาข่ายของด่าน last-admin ต่อแถว มิฉะนั้นลูปจะยอมลดสิทธิ์ admin
      // คนสุดท้ายที่ล็อกอินได้จริง (โดยอ้างคนที่กำลังจะหายไป) แล้วรอบนั้นก็จบด้วยการที่
      // sweep ต้อง rollback ทั้งก้อน — คลังเสียทั้งสิทธิ์และรอบ sync ไปพร้อมกัน
      // นับเฉพาะรอบที่ sweep จะได้ทำงานจริง (rowCountOk) ไม่งั้นจะกันสิทธิ์คนโดยไม่มีเหตุ
      const doomedAdminEmpIds = rowCountOk
        ? await this.doomedAdminEmpIds(presentEmpIds)
        : new Set<string>();

      // ด่านรูปแบบเดินครั้งเดียวตรงนี้ แล้วส่งผลชุดเดียวกันให้ทั้งด่านเพดานและลูปที่เขียนจริง
      const screened = screenUserRows(rows);

      // ── เพดานการ "ให้" สิทธิ์ — คู่ตรงข้ามของ ERP_USER_DEACTIVATE_MAX_PCT ──────────
      // ต้องรู้ผลรวมทั้งรอบ **ก่อน** แถวแรกจะ commit เพราะแต่ละแถวอยู่คนละทรานแซกชัน
      // (รู้ตัวตอนแถวที่ 300 = 299 คนแรกเลื่อนสิทธิ์ไปแล้วและเรียกคืนไม่ได้)
      const elevation = await this.planElevations(screened, roleMap, anomalies);

      const unmappedLevelsSeen = new Set<string>();
      const unmappedEmpIds = new Set<string>(); // ใช้ตรวจว่ามีคนถือ credential ค้างอยู่กี่คน
      let upserted = 0;

      for (const entry of screened) {
        if (!entry.ok) {
          // 🚫 anomaly เก็บได้แค่ตัวระบุ — ห้ามมี password/hash ใด ๆ (sync_runs.anomalies อ่านได้ทีหลัง)
          pushAnomaly(
            anomalies,
            entry.reason === 'duplicate_login'
              ? { type: 'duplicate_login', login: entry.login }
              : { type: 'rejected_row', empCode: entry.empCode, login: entry.login },
          );
          metrics.rejected += 1;
          continue;
        }
        // ⚠️ แถวนี้ถูก "นับว่ายังอยู่ใน ERP" ไปแล้วตั้งแต่ตอนประกอบ presentEmpIds ข้างบน —
        //    ก่อนด่านอื่นทุกด่านโดยตั้งใจ (ตกด่านไหนหลังจากนี้ก็ยังไม่ใช่คนที่หายจาก ERP)
        const { row, empCode, login, nameThai } = entry;

        const mappedRole = roleMap.get(row.userLevel);
        if (mappedRole === undefined) {
          // ── allowlist ล้วน — level ที่ไม่ได้ map ไว้ "ไม่ได้บัญชีใหม่" ─────────
          // แต่ **ห้ามลบของเดิม**: นี่คือปัญหา config ไม่ใช่หลักฐานว่าคนนี้ออกจาก ERP
          // audit หนึ่งรายการต่อค่า level ที่ต่างกัน (ไม่ใช่ต่อแถว) ไม่งั้นบัญชีทั้ง ERP
          // ที่ไม่เกี่ยวกับคลังจะท่วม audit_log ซึ่งเป็น append-only ลบไม่ได้
          metrics.unmapped += 1;
          unmappedEmpIds.add(empCode);
          if (!unmappedLevelsSeen.has(row.userLevel)) {
            unmappedLevelsSeen.add(row.userLevel);
            await this.audit('scheduler', 'users.erp_level_unmapped', {
              userLevel: row.userLevel,
            });
            pushAnomaly(anomalies, { type: 'erp_level_unmapped', userLevel: row.userLevel });
          }
          continue;
        }

        // ผลของแถวนี้ที่ต้องนับ — ขยับตัวนับจริง **หลัง** ทรานแซกชันผ่านแล้วเท่านั้น
        // (rollback = ไม่ได้เกิดขึ้นจริง ห้ามนับ) เก็บเป็นอ็อบเจ็กต์เดียวเพราะค่าถูกเขียน
        // จากในคอลแบ็กซึ่งอยู่คนละขอบเขตฟังก์ชัน
        const rowOutcome = { elevated: false, elevationRefused: false };

        try {
          await this.db.transaction(async (client) => {
            // ── ล็อกเป้าหมาย + admin ทุกคนพร้อมกัน เรียงตาม emp_id (ลำดับเดียวกันทุก tx =
            //    ไม่มี deadlock) แล้ว **อ่าน role เก่าไว้ในโค้ดก่อน UPDATE**
            //    ⚠️ ห้ามกลับไปใช้ `UPDATE ... RETURNING role` เพื่อเทียบ role เก่า/ใหม่:
            //    RETURNING คืนค่า **ใหม่** เสมอ การเทียบกับตัวเองไม่มีทางเป็นจริง →
            //    การเพิกถอน refresh token ตอนลดสิทธิ์จะไม่เคยทำงานแบบเงียบสนิท
            //
            //    LEFT JOIN user_credentials = ความสัมพันธ์เดียวกับด่าน last-admin ของ sweep
            //    (`user_credentials c JOIN users u ON u.emp_id = c.emp_id`) — ต่างกันแค่ต้อง
            //    เก็บแถวเป้าหมายไว้ด้วยแม้เขายังไม่มี credential จึงเป็น LEFT
            //    ⚠️ `FOR UPDATE OF u` — ล็อกเฉพาะแถว `users` เหมือนเดิมเป๊ะ (ลำดับล็อก
            //    users → user_credentials ห้ามสลับ ไม่งั้น deadlock กับ MembersService.changeRole)
            const locked = await client.query<LockedUserRow>(
              `SELECT u.emp_id, u.role, c.emp_id IS NOT NULL AS has_credential
                 FROM users u
                 LEFT JOIN user_credentials c ON c.emp_id = u.emp_id
                WHERE u.emp_id = $1 OR u.role = 'admin'
                ORDER BY u.emp_id FOR UPDATE OF u`,
              [empCode],
            );
            const lockedRows: LockedUserRow[] = locked.rows;
            const current = lockedRows.find((r) => r.emp_id === empCode);
            const fromRole = current?.role ?? null;
            // ⚠️ ตัดคนที่ credential พ้น grace แล้วและ sweep จะลบท้ายรอบนี้ออกจากการนับ —
            //    "ยังเป็น admin อยู่ ณ วินาทีนี้" ไม่ได้แปลว่าจะยังล็อกอินได้ตอนรอบจบ
            //    และตัด "admin ผี" (ไม่มี credential แล้ว) ออกด้วยเหตุผลเดียวกัน
            const adminCountExcluding = lockedRows.filter(
              (r) =>
                r.role === 'admin' &&
                r.has_credential &&
                r.emp_id !== empCode &&
                !doomedAdminEmpIds.has(r.emp_id),
            ).length;

            // ── credential เดิม — ต้องอ่าน **ก่อน** ตัดสิน role ────────────────
            // source='local' คือ break-glass: ห้าม ERP แตะทั้งแถว credential และ `users.role`
            // (เดิมกันแค่แถว credential แล้วปล่อยให้ลูปลดสิทธิ์เขาได้ = ปิดทางกลับเข้าระบบ
            //  ทางเดียวที่เหลือ และการลดสิทธิ์นั้น commit ไปแล้วคนละทรานแซกชัน กู้คืนไม่ได้)
            const cred = await client.query<CredentialRow>(
              `SELECT source, secret_hash FROM user_credentials WHERE emp_id = $1 FOR UPDATE`,
              [empCode],
            );
            // ⚠️ `.at(0)` ไม่ใช่ `[0]`: โปรเจคนี้ไม่ได้เปิด `noUncheckedIndexedAccess` →
            //    `rows[0]` มีชนิดเป็น `CredentialRow` เฉย ๆ ทั้งที่ผลลัพธ์ว่างได้จริง
            //    (คนที่ยังไม่มี credential) แล้ว TS ก็ narrow ตัวแปรตามชนิดของค่าที่ assign
            //    จน `existing?.source` กับ `existing === undefined` ข้างล่างกลายเป็นเงื่อนไข
            //    ที่ lint บอกว่า "ตายแล้ว" ทั้งที่ทั้งสองอันจำเป็นจริงตอนรัน — `.at()` คืน
            //    `CredentialRow | undefined` ตามความจริง ชนิดกับโค้ดจึงตรงกันโดยไม่ต้อง disable
            const existing = cred.rows.at(0);

            if (existing?.source === 'local') {
              // ERP สั่งเป็น role อื่น = ต้องเห็นใน audit ว่าเราจงใจไม่ทำตาม (ไม่ใช่เงียบหาย)
              if (fromRole !== null && mappedRole !== fromRole) {
                await client.query(AUDIT_SQL, [
                  'scheduler',
                  'users.erp_local_role_ignored',
                  JSON.stringify({ empId: empCode, attemptedRole: mappedRole, keptRole: fromRole }),
                ]);
              }
              return;
            }

            // ── ด่านเพดานการเลื่อนสิทธิ์: รอบนี้เลื่อนคนมากเกินเพดาน → คงสิทธิ์เดิมทุกคน ──
            // fail-safe คือ "สิทธิ์เดิมซึ่งต่ำกว่า" เสมอ — คนที่ควรได้เลื่อนจริงจะช้าไปหนึ่งรอบ
            // แต่ map ที่พิมพ์ผิดจะไม่แจก admin ทั้งคลังโดยไม่มีมนุษย์คนไหนกด
            let effectiveRole = mappedRole;
            let blockedByFloor = false;
            if (fromRole !== null && elevation.blocked && elevation.empIds.has(empCode)) {
              effectiveRole = fromRole;
              rowOutcome.elevationRefused = true;
            }

            // ── ด่าน last-admin ต่อแถว: ห้ามลดสิทธิ์ admin คนสุดท้ายไม่ว่า ERP จะบอกว่าอะไร ──
            if (fromRole === 'admin' && effectiveRole !== 'admin' && adminCountExcluding === 0) {
              effectiveRole = 'admin';
              blockedByFloor = true;
            }

            // นับหลังผ่านด่านครบทุกด่านแล้ว = สิทธิ์ที่ "เขียนลงแถวจริง" ไม่ใช่สิ่งที่ ERP ขอมา
            rowOutcome.elevated =
              fromRole !== null && ROLE_RANK[effectiveRole] > ROLE_RANK[fromRole];

            if (!current) {
              // ⚠️ ไม่เขียน pin_hash เลย (คอลัมน์ผ่อนเป็น nullable แล้ว) — credential อยู่คนละตาราง
              await client.query(
                `INSERT INTO users (emp_id, name, role, shift, warehouse_code, must_change_pin)
                 VALUES ($1, $2, $3::user_role, $4, $5, false)`,
                [empCode, nameThai, effectiveRole, DEFAULT_SHIFT, this.warehouseCode],
              );
            } else {
              // WHERE ... IS DISTINCT FROM: ไม่มีอะไรเปลี่ยน = ไม่แตะแถวเลย (updated_at ไม่ขยับ)
              // role_version bump เฉพาะตอน role เปลี่ยนจริง (`role` ใน SET อ้างค่าเก่าเสมอ)
              await client.query(
                `UPDATE users SET name = $2, role = $3::user_role,
                        role_version = role_version + CASE WHEN role <> $3::user_role THEN 1 ELSE 0 END,
                        updated_at = now()
                  WHERE emp_id = $1
                    AND (name IS DISTINCT FROM $2 OR role IS DISTINCT FROM $3::user_role)`,
                [empCode, nameThai, effectiveRole],
              );
            }

            if (blockedByFloor) {
              await client.query(AUDIT_SQL, [
                'scheduler',
                'users.erp_last_admin_floor_blocked',
                JSON.stringify({ empId: empCode, attemptedRole: mappedRole }),
              ]);
            } else if (fromRole !== null && fromRole !== effectiveRole) {
              if (ROLE_RANK[effectiveRole] < ROLE_RANK[fromRole]) {
                // ลดสิทธิ์ → ตัด refresh token ทุกเครื่อง ไม่ให้ทำงานต่อด้วยสิทธิ์เก่า
                await client.query(REVOKE_ALL_SQL, [empCode]);
              }
              await client.query(AUDIT_SQL, [
                'scheduler',
                'users.erp_role_changed',
                JSON.stringify({ empId: empCode, from: fromRole, to: effectiveRole }),
              ]);
            }

            // ── credential upsert — แถว source='local' ออกจากรอบไปตั้งแต่ต้นแล้ว ──────
            if (existing === undefined) {
              await client.query(
                `INSERT INTO user_credentials
                   (login_name, emp_id, secret_hash, source, erp_user_level, erp_last_seen_at)
                 VALUES ($1, $2, $3, 'erp', $4, now())`,
                [login, empCode, await this.auth.hashPin(row.password.expose()), row.userLevel],
              );
              await client.query(AUDIT_SQL, [
                'scheduler',
                'users.erp_created',
                JSON.stringify({ empId: empCode, loginName: login, userLevel: row.userLevel }),
              ]);
              return;
            }

            // argon2 hash มี salt → เทียบ hash ตรง ๆ ไม่ได้ `verify` คือวิธีเดียวที่บอกได้ว่า
            // รหัสผ่านเปลี่ยนไหม และช่วยไม่ให้ revoke token ทุกเครื่องทุกชั่วโมงโดยไม่จำเป็น
            if (await this.auth.verifyPin(existing.secret_hash, row.password.expose())) {
              await client.query(
                `UPDATE user_credentials
                    SET login_name = $1, erp_user_level = $2, erp_last_seen_at = now(),
                        source = 'erp', updated_at = now()
                  WHERE emp_id = $3`,
                [login, row.userLevel, empCode],
              );
              return;
            }

            // รหัสผ่านเปลี่ยนที่ ERP (หรือแถวเดิมเป็น legacy_pin ที่กำลังถูกเปลี่ยนสัญชาติ)
            await client.query(
              `UPDATE user_credentials
                  SET login_name = $1, secret_hash = $2, secret_rotated_at = now(),
                      erp_user_level = $3, erp_last_seen_at = now(), source = 'erp', updated_at = now()
                WHERE emp_id = $4`,
              [login, await this.auth.hashPin(row.password.expose()), row.userLevel, empCode],
            );
            await client.query(REVOKE_ALL_SQL, [empCode]); // ตัดเซสชันเก่าทั้งหมด
            await client.query(AUDIT_SQL, [
              'scheduler',
              'users.erp_secret_rotated',
              JSON.stringify({ empId: empCode }),
            ]);
          });
        } catch (err) {
          // ── login_name ชนกับ emp_id อื่นที่ persist ไว้แล้ว ──────────────────
          // `seenLoginNames` เห็นแค่ภายในรอบเดียว คนใหม่ที่ชื่อล็อกอินไปตรงกับแถวเก่า
          // ของคนอื่นจึงชน PK ที่ INSERT ตรง ๆ ถ้าปล่อยให้หลุดออกไปถึง catch ของทั้งรอบ:
          // แถวที่เหลือทั้งหมดถูกข้าม **และ sweep ไม่ได้ทำงานเลย** แล้วรอบถัด ๆ ไปก็ล้ม
          // ซ้ำแบบเดิมตลอดไป (ข้อมูล ERP ไม่ซ่อมตัวเอง) = ทั้งการเปิดและการปิดบัญชีตายยาว
          // 🚫 anomaly เก็บได้แค่ตัวระบุ — ห้ามมี password/hash (sync_runs อ่านได้ทีหลัง)
          if (!isUniqueViolation(err)) throw err;
          pushAnomaly(anomalies, { type: 'login_name_conflict', empCode, login });
          metrics.rejected += 1;
          this.logger.warn(
            `ข้ามผู้ใช้ ${empCode}: login_name "${login}" เป็นของ emp_id อื่นอยู่แล้ว — แก้ที่ ERP`,
          );
          continue;
        }
        upserted += 1;
        metrics.mapped += 1;
        if (rowOutcome.elevated) metrics.elevated += 1;
        if (rowOutcome.elevationRefused) metrics.elevationsRefused += 1;
      }

      // ── คนที่ level ไม่ได้ map แต่ยังถือ credential อยู่ = สัญญาณว่า map ตกค่าไหนไป ────
      // ไม่ทำอะไรกับแถวเขาเลยโดยตั้งใจ — แค่ทำให้ผู้ดูแลเห็นตัวเลขนี้จาก sync_runs ตรง ๆ
      if (unmappedEmpIds.size > 0) {
        const kept = await this.db.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM user_credentials WHERE emp_id = ANY($1::text[])`,
          [[...unmappedEmpIds]],
        );
        metrics.unmappedKeptCredential = kept?.n ?? 0;
        if (metrics.unmappedKeptCredential > 0) {
          pushAnomaly(anomalies, {
            type: 'erp_level_unmapped_kept_credential',
            credentials: metrics.unmappedKeptCredential,
            levels: [...unmappedLevelsSeen],
          });
          this.logger.warn(
            `ผู้ใช้ ${metrics.unmappedKeptCredential} คนมี user_level ที่ไม่อยู่ใน ` +
              `ERP_USER_LEVEL_ROLE_MAP (${[...unmappedLevelsSeen].join(', ')}) — ` +
              'คงบัญชีเดิมไว้ทุกแถว (ปัญหา config ไม่ใช่การลาออก)',
          );
        }
      }

      // ── นาฬิกา grace ของคนที่ "กลับมาพบใน ERP แล้ว" ต้องถูกล้างทุกรอบ ──────────────
      // เดิมคำสั่งนี้อยู่ข้างใน sweep ซึ่งไม่ได้ทำงานเลยเมื่อ ERP ส่งแถวมาน้อยผิดปกติ →
      // นาฬิกาของคนที่ยังอยู่จริงเดินต่อทั้งที่เขาปรากฏในผลรอบนี้ พอรอบหน้าดึงมาครบ
      // เขาก็ถูกลบทันทีทั้งที่ไม่เคยหายไปไหน (การล้าง = ให้ grace เต็มใหม่ ไม่ทำร้ายใครได้)
      await this.clearAbsentMarks(presentEmpIds);

      // ── deactivation + legacy-pin retirement = sweep เดียวที่มีการ์ดครบสี่ชั้น ────
      let tombstoned = 0;
      if (rowCountOk) {
        const swept = await this.sweepAbsentCredentials(presentEmpIds, anomalies);
        Object.assign(metrics, swept);
        tombstoned = swept.deactivated;
      } else {
        // ดึงมาน้อยกว่าที่ควรเป็น = สงสัยว่า query/ERP ผิด → ห้ามเริ่มจับเวลา grace ให้ใคร
        // และห้าม deactivate ใครทั้งสิ้น (นับไว้ให้เห็นว่าปฏิเสธไปกี่คน)
        //
        // ⚠️ ตัวนับต้องแปลเหมือนเส้นทาง sweep เป๊ะ ๆ: `absent` = ยังไม่พบใน ERP ·
        //    `graceElapsed` = ในจำนวนนั้นพ้น grace แล้วกี่คน · `refused` = **พ้น grace แล้ว
        //    แต่ไม่ได้ถูกลบ** ที่นี่คือทั้งหมดของ graceElapsed (การ์ดเพดานแถวขั้นต่ำปฏิเสธไว้)
        //    คนที่นาฬิกายังไม่พ้น grace ไม่ใช่ "คนที่ถูกปฏิเสธ" — รอบปกติก็ยังไม่ลบเขาอยู่ดี
        const absent = await this.db.one<{ n: number; grace_elapsed: number }>(
          `SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE absent_since <= now() - $2::interval)::int AS grace_elapsed
             FROM user_credentials
            WHERE source IN ('erp', 'legacy_pin') AND emp_id <> ALL($1::text[])`,
          [[...presentEmpIds], ABSENCE_GRACE_INTERVAL],
        );
        metrics.absent = absent?.n ?? 0;
        metrics.graceElapsed = absent?.grace_elapsed ?? 0;
        metrics.refused = metrics.graceElapsed;
        pushAnomaly(anomalies, {
          type: 'row_count_below_floor',
          rowsRead: rows.length,
          minExpected: minExpected ?? null,
          absent: metrics.absent,
          graceElapsed: metrics.graceElapsed,
        });
        this.logger.warn(
          `ERP ส่งผู้ใช้มา ${rows.length} แถว ไม่ถึง ERP_USER_MIN_EXPECTED_ROWS=` +
            `${minExpected ?? 'ไม่ได้ตั้งค่า'} — ข้ามการ deactivate ทั้งหมดในรอบนี้`,
        );
      }

      return this.finishRun(
        runId,
        {
          status: rowCountOk ? 'success' : 'partial',
          rowsRead: rows.length,
          rowsUpserted: upserted,
          rowsTombstoned: tombstoned,
          anomalies,
          metrics,
        },
        // รอบผู้ใช้ไม่แตะป้าย "ข้อมูล ณ HH:MM" ของสต็อก มิฉะนั้นป้ายจะโกหกว่าสต็อกเพิ่งอัปเดต
        { setStockAsOf: false },
      );
    } catch (err) {
      const error = errorMessage(err);
      this.logger.error(`รอบผู้ใช้ล้มเหลว: ${error}`);
      // ตัวนับที่เดินมาได้ก่อนล้มยังต้องเห็นใน sync_runs — ไม่งั้นรอบที่ล้มกลางทาง
      // (เช่น last-admin floor ตัด sweep ทิ้ง) จะดูเหมือนรอบที่ไม่ได้ทำอะไรเลย
      //
      // ⚠️ ตัวนับของ sweep เดินทางมากับ error เอง: การ throw ข้ามบรรทัดที่ copy ผลลง
      //    `metrics` ไปทั้งหมด → รอบที่ผู้ดูแลต้องอ่านมากที่สุดคือรอบเดียวที่เคยเป็น 0 ทั้งแถว
      if (err instanceof AdminCredentialFloorError) Object.assign(metrics, err.counts);
      return this.finishRun(
        runId,
        {
          status: 'failed',
          error,
          rowsRead,
          rowsUpserted: metrics.mapped,
          rowsTombstoned: metrics.deactivated,
          anomalies,
          metrics,
        },
        { setStockAsOf: false },
      );
    }
  }

  /**
   * ปิดล็อกอินของคนที่ **หายไปจากผล ERP** — และเฉพาะคนกลุ่มนั้นเท่านั้น
   *
   * `presentEmpIds` คือ emp_id ทุกตัวที่ ERP ส่งมาในรอบนี้ (รวมคนที่ level ไม่ได้ map และ
   * แถวที่ถูกปฏิเสธด้วยเหตุอื่น) — คนที่ยังอยู่ใน ERP ห้ามเข้ามาถึงบรรทัดนี้เด็ดขาด
   *
   * การ์ดสามชั้นในเมธอดนี้ (ชั้นที่สี่คือเพดานแถวขั้นต่ำ ผู้เรียกตรวจให้แล้ว):
   *  1. **grace** — ต้องหายต่อเนื่องเกิน ABSENCE_GRACE_HOURS ชม. ไม่ใช่เห็นหายรอบเดียวแล้วลบ
   *  2. **เพดาน %** — `ERP_USER_DEACTIVATE_MAX_PCT` ของ credential ที่ยังมีชีวิต
   *  3. **last-admin floor ของทั้ง sweep** — ลบแล้วต้องเหลือ admin ที่ล็อกอินได้อย่างน้อย 1 คน
   *     ไม่ผ่าน = โยนออกจากทรานแซกชัน → ไม่มีการลบไหน commit และรอบถูกบันทึกเป็น 'failed'
   *
   * ทั้งหมดอยู่ในทรานแซกชันเดียว (จำนวนแถวถูกเพดาน % คุมไว้แล้วจึงเล็กเสมอ)
   */
  private async sweepAbsentCredentials(
    presentEmpIds: ReadonlySet<string>,
    anomalies: unknown[],
  ): Promise<SweepCounts> {
    const present = [...presentEmpIds];
    const grace = ABSENCE_GRACE_INTERVAL;
    const maxPct = this.cfg.get('ERP_USER_DEACTIVATE_MAX_PCT', { infer: true });

    return this.db.transaction(async (client) => {
      // ── ล็อกแถว `users` ของ admin ทุกคน **ก่อนแตะ `user_credentials` แถวแรก** ───────
      // ด่าน last-admin ของทั้ง sweep (ล่างสุด) เคยนับด้วย `SELECT count(*)` เปล่า ๆ →
      // ระหว่าง "นับ" กับ "ลบ" ทรานแซกชันอื่น (MembersService.changeRole หรือรอบ sync
      // อีกรอบ) ลดสิทธิ์ admin คนสุดท้ายลงได้ แล้ว sweep ก็ลบ credential ต่อโดยอ้างตัวเลข
      // ที่ไม่จริงอีกแล้ว = ไม่เหลือใครล็อกอินเข้ามาซ่อม
      //
      // ⚠️ ต้องอยู่ **บนสุดของทรานแซกชัน** ไม่ใช่ตรงจุดที่ใช้ค่า: ลำดับล็อกของทั้งระบบคือ
      //    `users` → `user_credentials` (เหมือนลูปต่อแถวใน `runUsers()` และ
      //    `MembersService.changeRole` เป๊ะ) ส่วนคำสั่ง UPDATE absent_since ข้างล่างนี้
      //    ล็อกแถว `user_credentials` ไปแล้ว — ย้ายบล็อกนี้ลงไปทีหลังเมื่อไรก็กลายเป็น
      //    `user_credentials` → `users` ซึ่งวนเป็น deadlock กับสองเส้นทางนั้นได้ทันที
      //    ภายในคำสั่งเดียวก็เรียง emp_id จากน้อยไปมากเหมือนกันทุกเส้นทาง
      await client.query(
        `SELECT emp_id FROM users WHERE role = 'admin' ORDER BY emp_id FOR UPDATE`,
      );

      // ⚠️ การหยุดนาฬิกาของคนที่กลับมาพบใน ERP ย้ายออกไปอยู่ที่ `clearAbsentMarks()`
      //    ของผู้เรียกแล้ว — มันต้องเกิดทุกรอบ ไม่ใช่เฉพาะรอบที่ sweep ได้ทำงาน
      // ไม่พบใน ERP → เริ่มจับเวลา **ครั้งแรกครั้งเดียว** (รอบถัด ๆ ไปห้ามรีเซ็ตให้นาฬิกาถอยหลัง)
      await client.query(
        `UPDATE user_credentials SET absent_since = now()
          WHERE source IN ('erp', 'legacy_pin') AND absent_since IS NULL
            AND emp_id <> ALL($1::text[])`,
        [present],
      );

      const scope = await client.query<{ absent: number; grace_elapsed: number }>(
        `SELECT count(*)::int AS absent,
                count(*) FILTER (WHERE absent_since <= now() - $2::interval)::int AS grace_elapsed
           FROM user_credentials
          WHERE source IN ('erp', 'legacy_pin') AND emp_id <> ALL($1::text[])`,
        [present, grace],
      );
      const absent = scope.rows[0]?.absent ?? 0;
      const graceElapsed = scope.rows[0]?.grace_elapsed ?? 0;
      if (graceElapsed === 0) {
        return { absent, graceElapsed, deactivated: 0, adminsDeactivated: 0, refused: 0 };
      }

      // ล็อกเฉพาะแถว credential ที่จะลบ (FOR UPDATE OF c) — ไม่ล็อก users ทั้งตาราง
      const doomed = await client.query<DoomedCredentialRow>(
        `SELECT c.login_name, c.emp_id, u.role
           FROM user_credentials c
           JOIN users u ON u.emp_id = c.emp_id
          WHERE c.source IN ('erp', 'legacy_pin')
            AND c.emp_id <> ALL($1::text[])
            AND c.absent_since <= now() - $2::interval
          ORDER BY c.emp_id
            FOR UPDATE OF c`,
        [present, grace],
      );
      const doomedRows: DoomedCredentialRow[] = doomed.rows;
      const live = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_credentials WHERE source IN ('erp', 'legacy_pin')`,
      );
      const liveTotal = live.rows[0]?.n ?? 0;
      const ratio = liveTotal > 0 ? doomedRows.length / liveTotal : 0;

      if (doomedRows.length === 0) {
        return { absent, graceElapsed, deactivated: 0, adminsDeactivated: 0, refused: 0 };
      }
      if (ratio > maxPct / 100) {
        pushAnomaly(anomalies, {
          type: 'deactivate_guardrail_blocked',
          doomed: doomedRows.length,
          live: liveTotal,
          ratio,
        });
        this.logger.warn(
          `ข้าม deactivate ผู้ใช้: จะลบ ${doomedRows.length} จาก ${liveTotal} แถว ` +
            `(${Math.round(ratio * 100)}% เกินเพดาน ${maxPct}%)`,
        );
        return {
          absent,
          graceElapsed,
          deactivated: 0,
          adminsDeactivated: 0,
          refused: doomedRows.length,
        };
      }

      // ── last-admin floor ของทั้ง sweep ────────────────────────────────────
      // ด่าน 0 ตอนต้นรอบเช็คไว้ก่อนลูป แต่ลูปเองลด role ของคนได้ (รวมเจ้าของ credential
      // ที่เป็น source='local' ซึ่ง sync ไม่แตะแถว credential แต่แตะ users.role ได้)
      // จึงต้องนับใหม่ ณ ที่นี่ ไม่ใช่เชื่อผลตอนต้นรอบ
      //
      // แถว `users` ของ admin ทุกคนถูกล็อกไว้ตั้งแต่ต้นทรานแซกชันแล้ว (ไม่มีใครขยับ role ได้
      // ระหว่างนี้) เหลือแค่ต้องล็อกแถว `user_credentials` ของพวกเขาด้วย — ลำดับที่สองพอดี
      // ⚠️ นับจากจำนวนแถวที่ได้มา ไม่ใช่ `count(*)`: Postgres ห้ามใช้ FOR UPDATE คู่กับ
      //    aggregate ("FOR UPDATE is not allowed with aggregate functions")
      const admins = await client.query<{ emp_id: string }>(
        `SELECT c.emp_id
           FROM user_credentials c
           JOIN users u ON u.emp_id = c.emp_id
          WHERE u.role = 'admin'
          ORDER BY c.emp_id
            FOR UPDATE OF c`,
      );
      const adminCredentials = admins.rows.length;
      const doomedAdmins = doomedRows.filter((d) => d.role === 'admin').length;
      if (adminCredentials - doomedAdmins <= 0) {
        // anomaly ถูก push ไว้ในหน่วยความจำก่อนโยน — rollback ไม่ได้ลบมันทิ้ง
        // ผู้เรียกจึงยังบันทึกลง sync_runs ได้ในเส้นทาง 'failed'
        pushAnomaly(anomalies, {
          type: 'admin_credential_floor_blocked',
          adminCredentials,
          doomedAdmins,
          doomed: doomedRows.length,
        });
        throw new AdminCredentialFloorError(adminCredentials, doomedAdmins, {
          absent,
          graceElapsed,
          // ทั้งก้อน rollback → ไม่มีใครถูกลบจริง และทุกคนที่พ้น grace แล้วนับเป็น "ถูกปฏิเสธ"
          deactivated: 0,
          adminsDeactivated: 0,
          refused: doomedRows.length,
        });
      }

      // ── ผ่านเพดานแล้ว ≠ ไม่มีอะไรต้องบอก ────────────────────────────────
      // เพดานข้างบนต้องการแค่ "เหลือ admin ที่ล็อกอินได้ ≥ 1 คน" ซึ่งถูกแล้ว (break-glass
      // ต้องรอดเสมอ) แต่รอบที่ลบ admin ของ ERP ทิ้งจนเหลือแต่ break-glass จะรายงาน
      // 'success' เงียบ ๆ ถ้าไม่มี anomaly ตัวนี้ — ผู้ดูแลจะรู้ตัวก็ตอนไม่มีใครเปิดรอบนับได้
      if (doomedAdmins > 0) {
        const survivors = await client.query<{ local_admins: number; other_admins: number }>(
          `SELECT count(*) FILTER (WHERE c.source = 'local')::int  AS local_admins,
                  count(*) FILTER (WHERE c.source <> 'local')::int AS other_admins
             FROM user_credentials c
             JOIN users u ON u.emp_id = c.emp_id
            WHERE u.role = 'admin' AND c.login_name <> ALL($1::text[])`,
          [doomedRows.map((d) => d.login_name)],
        );
        const localAdminsLeft = survivors.rows[0]?.local_admins ?? 0;
        const otherAdminsLeft = survivors.rows[0]?.other_admins ?? 0;
        pushAnomaly(anomalies, {
          type: 'admin_credentials_deactivated',
          deactivated: doomedAdmins,
          // 🚫 ตัวระบุอย่างเดียว — ห้ามมี hash/รหัสผ่านใน anomaly (sync_runs อ่านได้ทีหลัง)
          empIds: doomedRows.filter((d) => d.role === 'admin').map((d) => d.emp_id),
          localAdminsLeft,
          otherAdminsLeft,
        });
        this.logger.warn(
          `ปิดล็อกอิน admin ${doomedAdmins} บัญชีที่หายจาก ERP — เหลือ admin ที่ล็อกอินได้ ` +
            `${otherAdminsLeft} บัญชีจาก ERP + ${localAdminsLeft} บัญชี break-glass` +
            (otherAdminsLeft === 0
              ? ' ⚠️ ไม่เหลือ admin ตัวจริงเลย เหลือแต่บัญชี break-glass'
              : ''),
        );
      }

      for (const d of doomedRows) {
        // ลบเฉพาะ credential — **ไม่แตะแถว users เลย** ประวัติการนับ (count_submissions
        // เป็น ON DELETE RESTRICT) และ FK อีก 9 ตารางจึงอยู่ครบทุกแถว
        await client.query(`DELETE FROM user_credentials WHERE login_name = $1`, [d.login_name]);
        await client.query(REVOKE_ALL_SQL, [d.emp_id]);
        await client.query(AUDIT_SQL, [
          'scheduler',
          'users.erp_deactivated',
          JSON.stringify({ empId: d.emp_id, loginName: d.login_name }),
        ]);
      }
      this.logger.log(
        `ปิดล็อกอิน ${doomedRows.length} บัญชีที่หายจาก ERP เกิน ${ABSENCE_GRACE_HOURS} ชม. ` +
          `(ยังมีอีก ${absent - graceElapsed} บัญชีที่นับเวลา grace อยู่)`,
      );
      return {
        absent,
        graceElapsed,
        deactivated: doomedRows.length,
        adminsDeactivated: doomedAdmins,
        refused: graceElapsed - doomedRows.length,
      };
    });
  }

  /**
   * admin ที่ credential พ้น grace แล้วและจะถูก `sweepAbsentCredentials` ลบท้ายรอบนี้
   *
   * ใช้เงื่อนไขชุดเดียวกับ sweep เป๊ะ ๆ (source · ไม่อยู่ใน ERP รอบนี้ · พ้น grace) เพื่อให้
   * ด่าน last-admin ต่อแถวไม่ไปนับคนที่กำลังจะหายเป็น "ตาข่าย" ของ admin คนสุดท้าย
   *
   * ⚠️ คนในชุดนี้ **ไม่อยู่ใน `presentEmpIds`** อยู่แล้ว ลูปจึงไม่มีวันแก้ role ของเขาระหว่างรอบ
   *    ค่าที่อ่านมาครั้งเดียวก่อนลูปจึงยังจริงตลอดรอบ
   */
  private async doomedAdminEmpIds(presentEmpIds: ReadonlySet<string>): Promise<Set<string>> {
    const result = await this.db.query<{ emp_id: string }>(
      `SELECT c.emp_id
         FROM user_credentials c
         JOIN users u ON u.emp_id = c.emp_id
        WHERE u.role = 'admin'
          AND c.source IN ('erp', 'legacy_pin')
          AND c.emp_id <> ALL($1::text[])
          AND c.absent_since <= now() - $2::interval`,
      [[...presentEmpIds], ABSENCE_GRACE_INTERVAL],
    );
    return new Set(result.rows.map((r) => r.emp_id));
  }

  /**
   * หยุดนาฬิกา grace ของทุกคนที่ปรากฏในผล ERP รอบนี้
   *
   * ต้องเรียก **ทุกรอบ** ไม่ว่ารอบนั้นจะผ่านเพดานแถวขั้นต่ำหรือไม่: คนที่กลับมาพบแล้ว
   * ต้องได้ grace เต็มใหม่เสมอ ปล่อยให้นาฬิกาเดินต่อ = รอบหน้าที่ดึงมาครบจะลบเขาทันที
   * ทั้งที่เขาอยู่ในผล ERP มาตลอด (นี่คือคนละเรื่องกับการ "เริ่ม" จับเวลา ซึ่งยังต้องกันไว้
   * ให้รอบที่ข้อมูลน่าสงสัยทำไม่ได้)
   */
  private async clearAbsentMarks(presentEmpIds: ReadonlySet<string>): Promise<void> {
    await this.db.query(
      `UPDATE user_credentials SET absent_since = NULL
        WHERE absent_since IS NOT NULL AND emp_id = ANY($1::text[])`,
      [[...presentEmpIds]],
    );
  }

  /**
   * ใครบ้างที่รอบนี้จะได้ **เลื่อนสิทธิ์ขึ้น** และเลื่อนได้จริงไหม
   *
   * คู่ตรงข้ามของ `ERP_USER_DEACTIVATE_MAX_PCT` ซึ่งกันแต่การ "ถอน" สิทธิ์ทีละมาก ๆ —
   * ส่วนการ "ให้" สิทธิ์เดิมไม่มีการ์ดเลยแม้แต่ชั้นเดียว ทั้งที่ `ERP_USER_LEVEL_ROLE_MAP`
   * ที่พิมพ์ผิดค่าเดียว (`5=admin`) เลื่อนคนทั้งคลังเป็น admin ได้ในรอบเดียว และรอบนั้น
   * จะรายงาน 'success' เงียบ ๆ ด้วยซ้ำ (ด่าน boot ตรวจแค่ว่า "มี level ไหน map เป็น admin")
   *
   * ⚠️ นับเฉพาะคนที่ **มีแถว `users` อยู่แล้ว** และ rank ใหม่สูงกว่าเดิมเท่านั้น →
   *    รอบแรกของระบบ (ทุกคนเป็นคนใหม่ ไม่มีสิทธิ์เดิมให้เทียบ) ไม่มีใครเข้าเงื่อนไขนี้เลย
   *    จำนวนที่จะเลื่อนจึงเป็น 0 และออกจากฟังก์ชันตั้งแต่ก่อนคิดเปอร์เซ็นต์ด้วยซ้ำ
   *    รอบแรกจึงไม่มีทางถูกบล็อกด้วยด่านนี้
   *    (คนใหม่ที่ ERP บอกว่าเป็น admin ยังต้องผ่าน allowlist ของ `ERP_USER_LEVEL_ROLE_MAP`
   *     ซึ่งเป็นการ์ดของ "ใครได้บัญชีบ้าง" คนละชั้นกับการ์ดของ "ใครได้สิทธิ์เพิ่มบ้าง")
   */
  private async planElevations(
    screened: readonly ScreenedRow[],
    roleMap: ReadonlyMap<string, Role>,
    anomalies: unknown[],
  ): Promise<{ empIds: ReadonlySet<string>; blocked: boolean }> {
    // นับเฉพาะแถวที่ผ่านด่านรูปแบบเดียวกับลูปหลัก (`screenUserRows`) — แถวที่ลูปจะปฏิเสธ
    // อยู่แล้วไม่มีทางกลายเป็นการเลื่อนสิทธิ์จริง จึงห้ามเข้ามาถ่วงทั้งตัวตั้งและตัวหาร
    const intended = new Map<string, Role>();
    for (const entry of screened) {
      if (!entry.ok) continue;
      const mapped = roleMap.get(entry.row.userLevel);
      if (mapped !== undefined) intended.set(entry.empCode, mapped);
    }
    const empIds = new Set<string>();
    if (intended.size === 0) return { empIds, blocked: false };

    // source='local' ไม่ถูกแตะ role อยู่แล้ว (break-glass) จึงไม่มีทางเป็นการเลื่อนสิทธิ์
    const current = await this.db.query<{ emp_id: string; role: Role }>(
      `SELECT u.emp_id, u.role
         FROM users u
         LEFT JOIN user_credentials c ON c.emp_id = u.emp_id
        WHERE u.emp_id = ANY($1::text[])
          AND (c.source IS NULL OR c.source <> 'local')`,
      [[...intended.keys()]],
    );
    for (const row of current.rows) {
      const next = intended.get(row.emp_id);
      if (next !== undefined && ROLE_RANK[next] > ROLE_RANK[row.role]) empIds.add(row.emp_id);
    }
    if (empIds.size <= ELEVATE_ALWAYS_ALLOWED) return { empIds, blocked: false };

    // ── ตัวหาร = "คนที่ ERP คุมอยู่จริงในรอบนี้" ไม่ใช่จำนวนแถว credential ที่มีอยู่ ──────
    // ห้ามใช้ `count(*) WHERE source IN ('erp','legacy_pin')` แบบเพดาน deactivate:
    // ก่อน cutover ตาราง `user_credentials` ยังเต็มไปด้วยแถว legacy_pin ที่ schema.sql
    // backfill ให้ใหม่ทุก deploy (ปิดถาวรหลังรอบ users สำเร็จรอบแรกเท่านั้น) → ตัวหารพองตาม
    // จำนวนคนที่ ERP **ยังไม่ได้คุมเลย** เปอร์เซ็นต์จึงต่ำเกินจริงและเพดานหลวมที่สุดพอดี
    // ในช่วงที่เสี่ยงที่สุด คือรอบแรก ๆ ที่ ERP_USER_LEVEL_ROLE_MAP ยังไม่เคยถูกพิสูจน์
    // พอ cutover เสร็จแถวพวกนั้นกลายเป็น source='erp' ตัวหารเดิมก็เปลี่ยนความหมายอีกครั้ง
    // ทั้งที่โค้ดไม่ได้ขยับ = การ์ดตัวเดียวกันเข้มไม่เท่ากันตามช่วงเวลา ซึ่งอ่านจากโค้ดไม่ออก
    //
    // `intended.size` = แถวที่ผ่านด่านรูปแบบและ map เป็น role ได้ในรอบนี้ ตอบคำถามเดียวกัน
    // เป๊ะทั้งก่อนและหลัง cutover: "ในคนที่ ERP คุม รอบนี้เลื่อนสิทธิ์ไปกี่ %" และหลัง cutover
    // ค่านี้กับ count(*) ก็ลู่เข้าหากันเองเพราะเป็นคนกลุ่มเดียวกัน ไม่ต้องแก้อะไรอีก
    // (ผลรอบที่ ERP ส่งมาไม่ครบ ตัวหารจะเล็กลง = การ์ดเข้มขึ้น ซึ่งเป็นทิศทาง fail-safe)
    const governedTotal = intended.size; // > 0 แน่นอน (ออกไปตั้งแต่ intended.size === 0)
    const maxPct = this.cfg.get('ERP_USER_ELEVATE_MAX_PCT', { infer: true });
    const ratio = empIds.size / governedTotal;
    if (ratio <= maxPct / 100) return { empIds, blocked: false };

    pushAnomaly(anomalies, {
      type: 'elevate_guardrail_blocked',
      elevations: empIds.size,
      // ชื่อฟิลด์ต่างจาก `live` ของ deactivate โดยตั้งใจ — คนละความหมาย ห้ามเอาไปเทียบกันตรง ๆ
      governed: governedTotal,
      ratio,
      // 🚫 ตัวระบุอย่างเดียว และตัดให้สั้น — รอบที่เลื่อนทั้งคลังจะทำให้ jsonb บวมจนอ่านไม่ได้
      empIds: [...empIds].sort().slice(0, MAX_ANOMALY_IDS),
    });
    this.logger.warn(
      `ข้ามการเลื่อนสิทธิ์ผู้ใช้: จะเลื่อน ${empIds.size} จาก ${governedTotal} คนที่ ERP คุมรอบนี้ ` +
        `(${Math.round(ratio * 100)}% เกินเพดาน ${maxPct}%) — ตรวจ ERP_USER_LEVEL_ROLE_MAP ก่อน ` +
        'ถ้าตั้งใจให้เลื่อนจริงทั้งชุดค่อยขยับ ERP_USER_ELEVATE_MAX_PCT',
    );
    return { empIds, blocked: true };
  }

  /**
   * allowlist จาก `ERP_USER_LEVEL_ROLE_MAP` — ตัวเดียวกับที่ด่าน boot ตรวจไว้แล้ว
   * ถ้าถึงตรงนี้แล้วยังพังแปลว่ามีคนแก้ค่าโดยข้ามการ validate → ปฏิเสธทั้ง run (ไม่เดา)
   */
  private userLevelRoleMap(): Map<string, Role> {
    const raw = this.cfg.get('ERP_USER_LEVEL_ROLE_MAP', { infer: true }) ?? '';
    const parsed = parseUserLevelRoleMap(raw);
    if (parsed.errors.length > 0 || parsed.map.size === 0) {
      throw new Error(
        `ERP_USER_LEVEL_ROLE_MAP ใช้ไม่ได้: ${parsed.errors.join(' · ') || 'ไม่มีรายการ level=role'}`,
      );
    }
    return parsed.map;
  }

  // ── 3. syncCountSessions ────────────────────────────────────────────────

  /*
   * ⚠️ เคยมี syncCountSessions() / runCountSessions() / mirrorSession() อยู่ตรงนี้
   *    ดึง "รอบนับที่ทำใน ERP อยู่แล้ว" มา mirror เป็น count_sessions + count_snapshot
   *
   *    ตัดออกถาวร 22 ส.ค. 2569: ระบบดึงจาก ERP แค่จำนวนคงเหลือเท่านั้น
   *    รอบนับทั้งหมดเปิดจากแอปเราเอง (CountService.openSession) แล้ว freeze
   *    ยอดจาก items_cache ซึ่งได้ยอดมาจากสูตรของฝ่าย ERP ที่แม่น 100% แล้ว
   */

  // ── 4. อายุข้อมูล / รายงาน ──────────────────────────────────────────────

  /** ให้แอปและ CountService อ่านอายุข้อมูล (แหล่งเดียวของป้าย "ข้อมูล ณ HH:MM") */
  async lastSuccess(kind: SyncKind): Promise<SyncFreshness> {
    const row = await this.db.one<{ stock_as_of: Date | null; finished_at: Date | null }>(
      LAST_SUCCESS_SQL,
      [kind],
    );
    return { stockAsOf: row?.stock_as_of ?? null, finishedAt: row?.finished_at ?? null };
  }

  async listRuns(limit: number): Promise<SyncRunDto[]> {
    const result = await this.db.query<SyncRunRow>(SELECT_RUNS_SQL, [limit]);
    return result.rows.map((row) => ({
      id: Number(row.id),
      driver: row.driver,
      kind: row.kind,
      warehouseCode: row.warehouse_code,
      startedAt: row.started_at.toISOString(),
      finishedAt: iso(row.finished_at),
      rowsRead: row.rows_read,
      rowsUpserted: row.rows_upserted,
      rowsTombstoned: row.rows_tombstoned,
      status: row.status,
      error: row.error,
      anomalies: Array.isArray(row.anomalies) ? row.anomalies : [],
      metrics:
        typeof row.metrics === 'object' && row.metrics !== null && !Array.isArray(row.metrics)
          ? (row.metrics as Record<string, unknown>)
          : {},
      stockAsOf: iso(row.stock_as_of),
      triggeredBy: row.triggered_by,
    }));
  }

  async status(): Promise<SyncStatusDto> {
    const [items, erpOk] = await Promise.all([this.lastSuccess('items'), this.erpOk()]);
    return {
      itemsStockAsOf: iso(items.stockAsOf),
      erpOk,
    };
  }

  /** ERP ล่มต้องไม่ทำให้ endpoint นี้พัง — แอปยังต้องรู้ว่า cache เก่าแค่ไหน */
  private async erpOk(): Promise<boolean> {
    try {
      const health = await this.erp.healthCheck();
      return health.ok;
    } catch {
      return false;
    }
  }

  // ── 5. advisory lock + bookkeeping ──────────────────────────────────────

  /**
   * กันรอบซ้อน: `pg_try_advisory_lock` เป็น session-scope จึงต้องใช้ **client เดิม**
   * ตั้งแต่ lock จนถึง unlock — `db.transaction()` เป็นทางเดียวที่ได้ client ผูกกับ
   * connection เดียว (statement ของงาน sync วิ่งบน connection อื่นจาก pool ตามปกติ
   * transaction นี้ทำหน้าที่ถือ lock เท่านั้น จึงไม่ล็อกแถวใด)
   */
  private async withLock(
    kind: SyncKind,
    triggeredBy: string,
    run: (triggeredBy: string) => Promise<SyncRunResult>,
  ): Promise<SyncRunResult> {
    const key = LOCK_KEY[kind];
    return this.db.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [key],
      );
      if (lock.rows.at(0)?.locked !== true) {
        this.logger.warn(`ข้ามรอบ ${kind}: รอบก่อนหน้ายังทำงานอยู่ (advisory lock ไม่ว่าง)`);
        return this.recordSkipped(kind, triggeredBy);
      }

      try {
        return await run(triggeredBy);
      } finally {
        // ⚠️ ต้องปลดเสมอด้วย client เดิม ไม่งั้น lock ค้างจนกว่า connection จะตาย
        await client
          .query('SELECT pg_advisory_unlock($1::bigint)', [key])
          .catch((err: unknown) =>
            this.logger.error(`ปลด advisory lock ${kind} ไม่สำเร็จ: ${errorMessage(err)}`),
          );
      }
    });
  }

  private async startRun(kind: SyncKind, triggeredBy: string): Promise<number> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO sync_runs (driver, kind, warehouse_code, status, triggered_by)
       VALUES ($1, $2, $3, 'running', $4)
       RETURNING id`,
      [this.driver, kind, this.warehouseCode, triggeredBy],
    );
    if (row === null) throw new Error('บันทึกรอบ sync ลง sync_runs ไม่สำเร็จ');
    return Number(row.id);
  }

  /**
   * ปิดรอบใน `sync_runs`
   *
   * `setStockAsOf` (default `true` เพื่อไม่กระทบ `runItems` เดิม) — ตั้ง `false` สำหรับรอบที่
   * ไม่ได้ดึงสต็อก (เช่นรอบผู้ใช้) มิฉะนั้นป้าย "ข้อมูล ณ HH:MM" ใน `GET /sync/status`
   * จะโกหกว่าสต็อกเพิ่งอัปเดตทั้งที่รอบนั้นไม่ได้แตะ items_cache เลย
   */
  private async finishRun(
    runId: number,
    outcome: {
      status: SyncRunResult['status'];
      rowsRead?: number;
      rowsUpserted?: number;
      rowsTombstoned?: number;
      error?: string;
      anomalies: unknown[];
      metrics?: Record<string, number>;
    },
    opts: { setStockAsOf?: boolean } = {},
  ): Promise<SyncRunResult> {
    // CHECK ใน DB: status='failed' ต้องมี error · stock_as_of มีได้เฉพาะ success
    const error =
      outcome.status === 'failed'
        ? (outcome.error ?? 'ดึงข้อมูลจาก ERP ไม่สำเร็จ (ไม่มีรายละเอียดจาก driver)')
        : (outcome.error ?? null);

    const rowsRead = toCount(outcome.rowsRead ?? 0);
    const rowsUpserted = toCount(outcome.rowsUpserted ?? 0);
    const rowsTombstoned = toCount(outcome.rowsTombstoned ?? 0);
    const setStockAsOf = opts.setStockAsOf ?? true;

    await this.db.query(
      `UPDATE sync_runs
          SET finished_at     = now(),
              rows_read       = $2,
              rows_upserted   = $3,
              rows_tombstoned = $4,
              status          = $5,
              error           = $6,
              anomalies       = $7::jsonb,
              metrics         = $9::jsonb,
              stock_as_of     = CASE WHEN $8::boolean AND $5::sync_run_status = 'success'
                                     THEN now() ELSE NULL END
        WHERE id = $1`,
      [
        runId,
        rowsRead,
        rowsUpserted,
        rowsTombstoned,
        outcome.status,
        error,
        JSON.stringify(outcome.anomalies),
        setStockAsOf,
        JSON.stringify(outcome.metrics ?? {}),
      ],
    );

    const result: SyncRunResult = {
      runId,
      status: outcome.status,
      rowsRead,
      rowsUpserted,
      rowsTombstoned,
      anomalies: outcome.anomalies,
    };
    if (error !== null) result.error = error;
    if (outcome.metrics !== undefined) result.metrics = outcome.metrics;
    return result;
  }

  /**
   * บันทึก audit นอกทรานแซกชัน (ในทรานแซกชันใช้ `client.query(AUDIT_SQL, ...)` ตรง ๆ)
   *
   * 🚫 payload ต้องมีแต่ตัวระบุ — `audit_log` เป็น append-only ที่ระดับ engine
   *    (`deny_mutation()` trigger) ถ้าเผลอเขียนรหัสผ่านลงไปแล้ว **ลบคืนไม่ได้เลย**
   * audit ล้มเหลวห้ามทำให้รอบ sync ล้ม (เหมือน AuthService.audit)
   */
  private async audit(
    actor: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(AUDIT_SQL, [actor, action, JSON.stringify(payload)]).catch((err: unknown) => {
      this.logger.warn(`เขียน audit_log ไม่สำเร็จ: ${errorMessage(err)}`);
    });
  }

  /** รอบที่ถูกข้ามก็ต้องเห็นใน sync_runs ไม่งั้นผู้ดูแลจะไม่รู้ว่ารอบก่อนยังค้าง */
  private async recordSkipped(kind: SyncKind, triggeredBy: string): Promise<SyncRunResult> {
    const reason = 'ข้ามรอบ: รอบก่อนหน้ายังทำงานอยู่ (advisory lock ไม่ว่าง)';
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO sync_runs (driver, kind, warehouse_code, status, triggered_by, finished_at, error)
       VALUES ($1, $2, $3, 'skipped', $4, now(), $5)
       RETURNING id`,
      [this.driver, kind, this.warehouseCode, triggeredBy, reason],
    );
    return {
      runId: row === null ? 0 : Number(row.id),
      status: 'skipped',
      rowsRead: 0,
      rowsUpserted: 0,
      rowsTombstoned: 0,
      error: reason,
      anomalies: [],
    };
  }

  /** delta pull: ถอย overlap window กันแถวตกขอบ · ไม่เคยสำเร็จ = full snapshot */
  private async computeSince(kind: SyncKind): Promise<Date | undefined> {
    const last = await this.lastSuccess(kind);
    if (last.stockAsOf === null) return undefined;
    const overlapS = this.cfg.get('ERP_SYNC_OVERLAP_S', { infer: true });
    return new Date(last.stockAsOf.getTime() - overlapS * 1000);
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * Sync — trigger มือ + หน้าตรวจสุขภาพการดึงข้อมูล
 *
 * guard ระดับแอป (APP_GUARD) บังคับ login ทุก endpoint อยู่แล้ว
 * trigger มือติด `@RequireFreshRole()` เพราะ blast radius สูง (ทับ items_cache ทั้งคลัง)
 */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('items')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async runItems(@CurrentUser() user: AuthenticatedUser): Promise<SyncRunResult> {
    return this.sync.syncItems(`manual:${user.empId}`);
  }

  /**
   * trigger รอบผู้ใช้ด้วยมือ — จุดที่ Phase 3 ของคัตโอเวอร์กดครั้งแรก
   * (guard เดียวกับ items: admin + role ต้องสด เพราะ blast radius คือสิทธิ์ของทุกคน)
   */
  @Post('users')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async runUsers(@CurrentUser() user: AuthenticatedUser): Promise<SyncRunResult> {
    return this.sync.syncUsers(`manual:${user.empId}`);
  }

  /** ประวัติรอบล่าสุด — ทุก role ที่ login แล้วดูได้ */
  @Get('runs')
  async runs(@Query('limit') limit?: string): Promise<SyncRunDto[]> {
    const parsed = LimitSchema.safeParse(limit);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'limit ต้องเป็นตัวเลข 1–100' });
    }
    return this.sync.listRuns(parsed.data);
  }

  /** ป้าย "ข้อมูล ณ HH:MM" ในแอปอ่านจาก endpoint นี้ */
  @Get('status')
  async status(): Promise<SyncStatusDto> {
    return this.sync.status();
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** PostgresModule/ErpModule เป็น @Global และ ConfigModule/ScheduleModule ลงทะเบียนแบบ global แล้ว */
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
