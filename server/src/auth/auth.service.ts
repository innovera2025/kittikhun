import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import {
  AuthErrorCode,
  type JwtPayload,
  type LoginRequest,
  type LoginResponse,
  type RefreshRequest,
  type Role,
  type TokenPair,
  type UserProfile,
} from './auth.types';

/** error ที่มี code ให้แอป map เป็นข้อความไทยตาม design */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

/**
 * แถวผู้ใช้จากตาราง `users` — **ไม่มี secret ติดมาด้วยโดยตั้งใจ**
 * (เส้นทาง refresh/rotate/profile ไม่มีเหตุผลจะดึง hash ขึ้นมาไว้ในหน่วยความจำ)
 */
interface UserRow {
  emp_id: string;
  name: string;
  role: Role;
  shift: string | null;
  warehouse_code: string;
  role_version: number;
  failed_attempts: number;
  /**
   * ⚠️ `timestamptz` ของ Postgres เป็น `infinity` / `-infinity` ได้ ซึ่ง node-pg
   *    แปลงกลับมาเป็น **number** ไม่ใช่ `Date` — เคยทำให้ login ตอบ 500 เพราะโค้ด
   *    เรียก `.getTime()` บนตัวเลข (ใช้ 'infinity' ปิดบัญชีถาวรเป็นเรื่องปกติ)
   */
  throttle_until: Date | number | null;
}

/** แถวผู้ใช้ + secret จาก `user_credentials` — ใช้เฉพาะเส้นทางล็อกอินเท่านั้น */
interface CredentialUserRow extends UserRow {
  /** เดิมชื่อ pin_hash — มาจาก user_credentials.secret_hash แล้ว */
  secret_hash: string;
}

/**
 * Auth — ตรวจตัวตนจากตาราง `user_credentials` (login_name → secret_hash) ไม่ใช่
 * `users.pin_hash` อีกต่อไป · ฐานคือ Postgres ของเราเองเสมอ **ล็อกอินจึงทำงานได้แม้ ERP ล่ม**
 *
 * มาตรการที่ใช้กับ secret เอนโทรปีต่ำ (PIN 6 หลักเดิม และรหัสผ่าน ERP ที่คุมความยาวไม่ได้):
 * - argon2id + server pepper (`PIN_PEPPER`) → hash ช้าพอที่ brute force ออฟไลน์ไม่คุ้ม
 * - **escalating delay ต่อ empId** (1s → 5s → 30s → … เพดาน AUTH_THROTTLE_MAX_MS)
 *   ⚠️ จงใจ**ไม่ใช้การล็อคตายตัว** เพราะ empId เดาง่าย (52xxx บนป้ายชื่อ) →
 *   ใครก็ยิง PIN ผิดเพื่อล็อคคนอื่นได้ทั้งกะ (DoS) · ดู docs/architecture.md §7
 * - refresh token: เก็บเฉพาะ sha256 · rotate ทุกครั้ง · **grace window** กัน WiFi
 *   คลังหลุดกลางทางแล้ว retry ด้วย token เดิมจนโดน revoke ทั้ง family
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly pepper: string;
  /** อายุ access token เป็น **วินาที** — ใช้ค่าเดียวกันทั้งตอน sign และตอนบอกแอป */
  private readonly accessTtlSec: number;
  private readonly refreshTtlMs: number;
  private readonly throttleBaseMs: number;
  private readonly throttleMaxMs: number;

  /** grace window: token ก่อนหน้าที่เพิ่งถูก rotate ยังใช้ได้ 60 วิ (retry ที่ตอบหาย) */
  private static readonly REFRESH_GRACE_MS = 60_000;

  /**
   * argon2id tuning — ค่านี้คือ **ค่าต่ำสุดที่ OWASP แนะนำสำหรับ argon2id**
   * (m = 19456 KiB ≈ 19 MiB · t = 2 · p = 1) ไม่ใช่ค่าที่จูนจากนาฬิกาของเครื่องไหน
   *
   * 🚫 ห้ามเขียนกำกับว่า "กี่ ms ต่อครั้ง" — เวลาจริงขึ้นกับ CPU/โหลดของเครื่องที่รัน
   *    (เดิมคอมเมนต์นี้เขียนว่า ~250ms ซึ่งวัดจริงแล้วคลาดไปหลายเท่า) สิ่งที่คงที่คือ
   *    "หน่วยความจำ × รอบ" ที่ผู้โจมตีต้องจ่ายต่อการเดา 1 ครั้ง — นั่นคือของที่เราซื้อ
   *
   * ทำไมค่าต่ำสุดของ OWASP ถึงรับได้: หลังคัตโอเวอร์ secret ที่ hash ตรงนี้คือ
   * **รหัสผ่าน ERP** (จาก `menuuser`) ไม่ใช่ PIN 6 หลักเอนโทรปีต่ำแบบเดิมอีกต่อไป
   * ส่วนแถว `legacy_pin` ที่ยังเหลือระหว่างทาง พึ่ง server pepper (`PIN_PEPPER`) กับ
   * escalating delay ต่อ empId เป็นด่านหลัก — argon2 ไม่ใช่ตัวเดียวที่ต้องรับน้ำหนัก
   * ⚠️ ถ้าจะขยับค่าเหล่านี้ ต้องเป็นการตัดสินใจที่บันทึกไว้ ไม่ใช่แก้ผ่าน ๆ
   *    และต้องแก้ ARGON_OPTS ใน src/cli/create-admin.ts ให้ตรงกันเป๊ะ ๆ ด้วย
   */
  private static readonly ARGON_OPTS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  };

  constructor(
    private readonly db: PostgresService,
    private readonly jwt: JwtService,
    cfg: ConfigService<AppConfig, true>,
  ) {
    this.pepper = cfg.get('PIN_PEPPER', { infer: true });
    this.accessTtlSec = Math.floor(
      AuthService.parseDuration(cfg.get('JWT_ACCESS_TTL', { infer: true })) / 1000,
    );
    this.refreshTtlMs = AuthService.parseDuration(
      cfg.get('JWT_REFRESH_TTL', { infer: true }),
    );
    this.throttleBaseMs = cfg.get('AUTH_THROTTLE_BASE_MS', { infer: true });
    this.throttleMaxMs = cfg.get('AUTH_THROTTLE_MAX_MS', { infer: true });
  }

  // ── Secret hashing ───────────────────────────────────────────────────

  /** hash secret พร้อม server pepper — pepper ทำให้ hash ที่หลุดจาก DB ใช้ crack ไม่ได้ */
  async hashPin(pin: string): Promise<string> {
    return argon2.hash(pin + this.pepper, AuthService.ARGON_OPTS);
  }

  /** ⚠️ public โดยตั้งใจ — รอบ sync ผู้ใช้ต้องเรียกเพื่อเช็คว่ารหัสผ่าน ERP เปลี่ยนไปหรือยัง */
  async verifyPin(hash: string, pin: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, pin + this.pepper);
    } catch {
      return false;
    }
  }

  // ── Login ────────────────────────────────────────────────────────────

  async login(req: LoginRequest): Promise<LoginResponse> {
    // สิ่งที่ผู้ใช้พิมพ์คือ login_name (lower เสมอ) ไม่ใช่ users.emp_id ตรง ๆ อีกต่อไป
    const loginName = req.empId.trim().toLowerCase();
    const user = await this.db.one<CredentialUserRow>(
      `SELECT u.emp_id, u.name, u.role, u.shift, u.warehouse_code, u.role_version,
              u.failed_attempts, u.throttle_until, c.secret_hash
         FROM user_credentials c
         JOIN users u ON u.emp_id = c.emp_id
        WHERE c.login_name = $1`,
      [loginName],
    );

    if (!user) {
      // design กำหนดให้แยกข้อความ "ไม่พบชื่อผู้ใช้" ออกจาก "รหัสผ่านผิด"
      // → หน่วงเวลาเท่ากับกรณีรหัสผ่านผิด เพื่อไม่ให้จับเวลาแยกได้ (timing oracle)
      await this.dummyWork();
      this.logger.warn(`login ล้มเหลว: ไม่พบชื่อผู้ใช้ (device=${req.deviceId})`);
      throw new AuthError(AuthErrorCode.UNKNOWN_EMPLOYEE);
    }

    this.assertNotThrottled(user);

    const ok = await this.verifyPin(user.secret_hash, req.pin);
    if (!ok) {
      const retryAfterMs = await this.registerFailure(user);
      throw new AuthError(AuthErrorCode.INVALID_PIN, undefined, retryAfterMs);
    }

    await this.db.query(
      `UPDATE users
          SET failed_attempts = 0, throttle_until = NULL, updated_at = now()
        WHERE emp_id = $1`,
      [user.emp_id],
    );

    await this.touchDevice(req.deviceId, user.emp_id, req.appVersion);

    const tokens = await this.issueTokens(user, req.deviceId);
    return { ...tokens, user: AuthService.toProfile(user) };
  }

  /**
   * บันทึกความล้มเหลว + คำนวณหน่วงเวลาแบบทวีคูณ
   * (ไม่ล็อคบัญชี — คืนเวลาที่ต้องรอ)
   */
  private async registerFailure(user: UserRow, action = 'auth.login_failed'): Promise<number> {
    // ⚠️ ต้องนับเพิ่มใน SQL (`failed_attempts + 1`) ไม่ใช่คำนวณจากค่าที่อ่านมาก่อน verify
    //    เดิมเขียนเป็น `SET failed_attempts = $2` จาก snapshot ก่อนตรวจ PIN ซึ่งเป็น
    //    read-modify-write ที่ไม่ atomic: ยิงพร้อมกัน N request ทุกตัวอ่านค่าเดิม แล้ว
    //    เขียนทับเป็น 1 เท่ากันหมด → ตัวนับค้างที่ 1 หน่วงเวลาไม่ทวีคูณ
    //    การกัน brute force เลยเหลือแค่ ~1 วินาทีต่อการเดา N ครั้งพร้อมกัน
    //
    // คำนวณ delay ใน SQL ด้วยเพื่อให้ใช้ค่า attempts ที่เพิ่งเพิ่มจริง (ไม่ใช่ค่าที่เดา)
    const updated = await this.db.one<{ failed_attempts: number; delay_ms: string }>(
      `UPDATE users
          SET failed_attempts = failed_attempts + 1,
              throttle_until  = now() + (LEAST(
                $2::bigint * pow(2, GREATEST(failed_attempts, 0))::bigint,
                $3::bigint
              ) * interval '1 millisecond'),
              updated_at      = now()
        WHERE emp_id = $1
    RETURNING failed_attempts,
              LEAST(
                $2::bigint * pow(2, GREATEST(failed_attempts - 1, 0))::bigint,
                $3::bigint
              )::text AS delay_ms`,
      [user.emp_id, this.throttleBaseMs, this.throttleMaxMs],
    );

    const attempts = updated?.failed_attempts ?? user.failed_attempts + 1;
    const delayMs = Number(updated?.delay_ms ?? this.throttleBaseMs);

    // log pattern การเดาไว้ตรวจย้อนหลัง (ไม่บันทึก PIN ที่กรอก)
    await this.audit(user.emp_id, action, { attempts, delayMs });

    if (attempts >= 5) {
      this.logger.warn(
        `PIN ผิดต่อเนื่อง ${attempts} ครั้ง สำหรับ ${user.emp_id} — หน่วง ${delayMs}ms`,
      );
    }
    return delayMs;
  }

  /**
   * ปฏิเสธทันทีถ้ายังอยู่ในช่วงหน่วงเวลา — ต้องเรียกใน**ทุก**เส้นทางที่ตรวจ secret
   * (ตอนนี้เหลือ `login` ทางเดียว) ไม่งั้นเส้นทางที่ลืมเรียกจะกลายเป็นช่องเดารหัสแบบไม่จำกัด
   */
  private assertNotThrottled(user: UserRow): void {
    const until = AuthService.throttleUntilMs(user.throttle_until);
    if (until === null) return;

    const remaining = until - Date.now();
    if (remaining <= 0) return;

    // ตัดที่เพดานเสมอ: `infinity` ทำให้ค่านี้เป็น Infinity ซึ่ง JSON.stringify
    // แปลงเป็น null → เครื่องลูกข่ายอ่านเวลารอไม่ได้
    throw new AuthError(
      AuthErrorCode.THROTTLED,
      undefined,
      Math.min(remaining, this.throttleMaxMs),
    );
  }

  /** แปลง `throttle_until` เป็นมิลลิวินาที — รองรับทั้ง `Date`, ±`infinity` และ null */
  private static throttleUntilMs(value: Date | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value; // Infinity / -Infinity จาก timestamptz
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  /** ทำงานเทียบเท่า argon2.verify เพื่อให้เวลาตอบกลับใกล้เคียงกัน */
  private async dummyWork(): Promise<void> {
    await argon2.hash('x' + this.pepper, AuthService.ARGON_OPTS).catch(() => undefined);
  }

  // ── Refresh ──────────────────────────────────────────────────────────

  async refresh(req: RefreshRequest): Promise<TokenPair> {
    const hash = AuthService.sha256(req.refreshToken);

    const row = await this.db.one<{
      token_hash: string;
      emp_id: string;
      device_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      issued_at: Date;
      replaced_by: string | null;
    }>(
      `SELECT t.token_hash, t.emp_id, t.device_id, t.expires_at, t.revoked_at, t.issued_at,
              (SELECT c.token_hash FROM refresh_tokens c
                WHERE c.rotated_from = t.token_hash
                ORDER BY c.issued_at DESC LIMIT 1) AS replaced_by
         FROM refresh_tokens t
        WHERE t.token_hash = $1`,
      [hash],
    );

    if (!row || row.device_id !== req.deviceId) {
      throw new AuthError(AuthErrorCode.INVALID_REFRESH);
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw new AuthError(AuthErrorCode.INVALID_REFRESH);
    }

    // ── grace window ──
    // token ถูก rotate ไปแล้ว แต่ client อาจไม่ได้รับ response (WiFi คลังหลุด)
    // ถ้ายังอยู่ในช่วงผ่อนผัน → คืนคู่ token *ตัวเดิมที่ rotate ไปแล้ว* ไม่ถือเป็นการใช้ซ้ำ
    if (row.revoked_at) {
      const withinGrace =
        Date.now() - row.revoked_at.getTime() <= AuthService.REFRESH_GRACE_MS;
      if (withinGrace && row.replaced_by) {
        const user = await this.requireUser(row.emp_id);
        return this.reissueForExistingChild(user, row.device_id, row.replaced_by);
      }

      // ใช้ token เก่าที่พ้นช่วงผ่อนผันแล้ว = สงสัยว่าถูกขโมย → เพิกถอนทั้ง family
      await this.revokeFamily(row.emp_id, row.device_id);
      await this.audit(row.emp_id, 'auth.refresh_reused', { deviceId: row.device_id });
      throw new AuthError(AuthErrorCode.REFRESH_REUSED);
    }

    const user = await this.requireUser(row.emp_id);
    return this.rotate(user, row.device_id, hash);
  }

  private async reissueForExistingChild(
    user: UserRow,
    deviceId: string,
    childHash: string,
  ): Promise<TokenPair> {
    // เราเก็บเฉพาะ hash จึงคืน refresh token ดิบตัวเดิมไม่ได้ →
    // ออกตัวใหม่ที่ต่อจาก child เดิม (chain ยังตรวจสอบย้อนได้)
    return this.rotate(user, deviceId, childHash);
  }

  private async rotate(
    user: UserRow,
    deviceId: string,
    previousHash: string | null,
  ): Promise<TokenPair> {
    return this.db.transaction(async (client) => {
      if (previousHash) {
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE token_hash = $1 AND revoked_at IS NULL`,
          [previousHash],
        );
      }
      const raw = AuthService.newRefreshToken();
      const hash = AuthService.sha256(raw);
      await client.query(
        `INSERT INTO refresh_tokens (token_hash, emp_id, device_id, expires_at, rotated_from)
         VALUES ($1, $2, $3, now() + ($4::bigint * interval '1 millisecond'), $5)`,
        [hash, user.emp_id, deviceId, this.refreshTtlMs, previousHash],
      );
      return {
        accessToken: await this.signAccess(user),
        refreshToken: raw,
        expiresIn: this.accessTtlSec,
      };
    });
  }

  private async issueTokens(user: UserRow, deviceId: string): Promise<TokenPair> {
    return this.rotate(user, deviceId, null);
  }

  private async signAccess(user: UserRow): Promise<string> {
    const payload: JwtPayload = {
      sub: user.emp_id,
      role: user.role,
      wh: user.warehouse_code,
      rv: user.role_version,
    };
    // ส่งเป็น **ตัวเลขวินาที** ไม่ใช่สตริง — jsonwebtoken ตีความ number เป็นวินาทีเสมอ
    // (ถ้าส่งสตริง '3600' ไลบรารี `ms` จะอ่านเป็น 3600 มิลลิวินาที = token หมดอายุใน
    //  3.6 วินาที ขณะที่เราบอกแอปว่า expiresIn = 3600 วินาที)
    return this.jwt.signAsync({ ...payload }, { expiresIn: this.accessTtlSec });
  }

  // ── Logout / revoke ──────────────────────────────────────────────────

  /**
   * ออกจากระบบ — เพิกถอน refresh token ของเครื่องนั้น
   *
   * ⚠️ **ห้ามแตะ outbox ของเครื่อง** — งานนับที่ยังไม่ซิงค์ต้องอยู่รอด
   *    และซิงค์ภายใต้ actor เดิม (docs/architecture.md §7)
   */
  async logout(empId: string, deviceId: string): Promise<void> {
    await this.revokeFamily(empId, deviceId);
  }

  private async revokeFamily(empId: string, deviceId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE emp_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
      [empId, deviceId],
    );
  }

  // ── helper ───────────────────────────────────────────────────────────

  /**
   * อ่านผู้ใช้เพื่อออก token ใหม่ (เส้นทาง refresh) — ไม่ดึง secret ขึ้นมาด้วยโดยตั้งใจ
   * ⚠️ `changePin` ถูกลบทั้งเส้นทางแล้ว: credential เป็นของ ERP รอบ sync ถัดไปเขียนทับอยู่ดี
   */
  private async requireUser(empId: string): Promise<UserRow> {
    const user = await this.db.one<UserRow>(
      `SELECT emp_id, name, role, shift, warehouse_code,
              role_version, failed_attempts, throttle_until
         FROM users WHERE emp_id = $1`,
      [empId],
    );
    if (!user) throw new AuthError(AuthErrorCode.UNKNOWN_EMPLOYEE);
    return user;
  }

  /**
   * ตรวจว่า role ใน token ยังตรงกับ DB — ใช้กับ endpoint blast radius สูง
   * (member CRUD / เปลี่ยน role / ปิดรอบนับ) เพราะ token อายุ 15 นาที
   */
  async assertRoleFresh(empId: string, roleVersionInToken: number): Promise<Role> {
    const row = await this.db.one<{ role: Role; role_version: number }>(
      `SELECT role, role_version FROM users WHERE emp_id = $1`,
      [empId],
    );
    if (!row) throw new AuthError(AuthErrorCode.UNKNOWN_EMPLOYEE);
    if (row.role_version !== roleVersionInToken) {
      throw new AuthError(AuthErrorCode.ROLE_CHANGED);
    }
    return row.role;
  }

  private async touchDevice(
    deviceId: string,
    empId: string,
    appVersion?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO devices (device_id, app_version, last_seen_at, last_emp_id)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (device_id) DO UPDATE
         SET app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
             last_seen_at = now(),
             last_emp_id  = EXCLUDED.last_emp_id`,
      [deviceId, appVersion ?? null, empId],
    );
  }

  private async audit(
    actor: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`,
        [actor, action, JSON.stringify(payload)],
      )
      .catch((err: unknown) => {
        // audit ล้มเหลวต้องไม่ทำให้ login ล้มเหลว
        this.logger.warn(`เขียน audit_log ไม่สำเร็จ: ${(err as Error).message}`);
      });
  }

  private static toProfile(u: UserRow): UserProfile {
    return {
      empId: u.emp_id,
      name: u.name,
      role: u.role,
      shift: u.shift,
      warehouseCode: u.warehouse_code,
      // คงฟิลด์ไว้ในสัญญา wire แต่ค่าตายตัว — ไม่มีเส้นทางเปลี่ยน PIN ในระบบแล้ว (ดู auth.types.ts)
      mustChangePin: false,
    };
  }

  private static newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  static sha256(v: string): string {
    return createHash('sha256').update(v).digest('hex');
  }

  /** เทียบ string แบบ constant-time (กัน timing attack) */
  static safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  /**
   * '15m' '30d' '3600s' '2w' → มิลลิวินาที
   *
   * ⚠️ ต้องรองรับ **ทุกหน่วยที่ `DURATION_RE` ใน env.config ยอมรับ** (ms|s|m|h|d|w|y)
   *    เดิมรองรับแค่ `[smhd]` ตัวเล็ก → ตั้ง `JWT_REFRESH_TTL=2w` ผ่าน validation ของ
   *    คอนฟิกได้ แต่มาระเบิดใน constructor ของ AuthService ตอน boot
   *    โดยข้อความ error ไม่บอกว่าตัวแปรไหนผิด
   *
   * ตัวเลขล้วน = **วินาที** (ตามที่เอกสารระบุ) — ห้ามส่งค่านี้เข้า jsonwebtoken
   * เป็นสตริง เพราะไลบรารี `ms` จะอ่าน '3600' เป็นมิลลิวินาที
   */
  static parseDuration(v: string): number {
    const m = /^(\d+)\s*(ms|s|m|h|d|w|y)?$/i.exec(v.trim());
    if (!m) throw new Error(`รูปแบบระยะเวลาไม่ถูกต้อง: ${v}`);

    const n = Number(m[1]);
    const unit = (m[2] ?? 's').toLowerCase() as 'ms' | 's' | 'm' | 'h' | 'd' | 'w' | 'y';
    const factor = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      y: 31_536_000_000,
    }[unit];
    return n * factor;
  }
}
