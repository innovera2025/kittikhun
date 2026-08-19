import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';
import {
  AuthErrorCode,
  type ChangePinRequest,
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

interface UserRow {
  emp_id: string;
  name: string;
  pin_hash: string;
  role: Role;
  shift: string | null;
  warehouse_code: string;
  role_version: number;
  must_change_pin: boolean;
  failed_attempts: number;
  throttle_until: Date | null;
}

/**
 * Auth ของระบบเราเอง — **ผู้ใช้ถูกสร้างและจัดการในระบบนี้ทั้งหมด ไม่ดึงจาก ERP**
 *
 * มาตรการที่ใช้กับ PIN 6 หลัก (เอนโทรปีต่ำ):
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
  private readonly accessTtl: string;
  private readonly refreshTtlMs: number;
  private readonly throttleBaseMs: number;
  private readonly throttleMaxMs: number;

  /** grace window: token ก่อนหน้าที่เพิ่งถูก rotate ยังใช้ได้ 60 วิ (retry ที่ตอบหาย) */
  private static readonly REFRESH_GRACE_MS = 60_000;

  /** argon2id tuning — ~250ms ต่อครั้งบนเซิร์ฟเวอร์ SME */
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
    this.accessTtl = cfg.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshTtlMs = AuthService.parseDuration(
      cfg.get('JWT_REFRESH_TTL', { infer: true }),
    );
    this.throttleBaseMs = cfg.get('AUTH_THROTTLE_BASE_MS', { infer: true });
    this.throttleMaxMs = cfg.get('AUTH_THROTTLE_MAX_MS', { infer: true });
  }

  // ── PIN hashing ──────────────────────────────────────────────────────

  /** hash PIN พร้อม server pepper — pepper ทำให้ hash ที่หลุดจาก DB ใช้ crack ไม่ได้ */
  async hashPin(pin: string): Promise<string> {
    return argon2.hash(pin + this.pepper, AuthService.ARGON_OPTS);
  }

  private async verifyPin(hash: string, pin: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, pin + this.pepper);
    } catch {
      return false;
    }
  }

  // ── Login ────────────────────────────────────────────────────────────

  async login(req: LoginRequest): Promise<LoginResponse> {
    const user = await this.db.one<UserRow>(
      `SELECT emp_id, name, pin_hash, role, shift, warehouse_code,
              role_version, must_change_pin, failed_attempts, throttle_until
         FROM users WHERE emp_id = $1`,
      [req.empId],
    );

    if (!user) {
      // design กำหนดให้แยกข้อความ "ไม่พบรหัสพนักงาน" ออกจาก "PIN ผิด"
      // → หน่วงเวลาเท่ากับกรณี PIN ผิด เพื่อไม่ให้จับเวลาแยกได้ (timing oracle)
      await this.dummyWork();
      this.logger.warn(`login ล้มเหลว: ไม่พบรหัสพนักงาน (device=${req.deviceId})`);
      throw new AuthError(AuthErrorCode.UNKNOWN_EMPLOYEE);
    }

    const now = Date.now();
    if (user.throttle_until && user.throttle_until.getTime() > now) {
      const retryAfterMs = user.throttle_until.getTime() - now;
      throw new AuthError(AuthErrorCode.THROTTLED, undefined, retryAfterMs);
    }

    const ok = await this.verifyPin(user.pin_hash, req.pin);
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
  private async registerFailure(user: UserRow): Promise<number> {
    const attempts = user.failed_attempts + 1;
    // 1s, 2s, 4s, 8s, … เพดานที่ throttleMaxMs
    const delayMs = Math.min(
      this.throttleBaseMs * 2 ** Math.max(0, attempts - 1),
      this.throttleMaxMs,
    );
    await this.db.query(
      `UPDATE users
          SET failed_attempts = $2,
              throttle_until  = now() + ($3::bigint * interval '1 millisecond'),
              updated_at      = now()
        WHERE emp_id = $1`,
      [user.emp_id, attempts, delayMs],
    );

    // log pattern การเดาไว้ตรวจย้อนหลัง (ไม่บันทึก PIN ที่กรอก)
    await this.audit(user.emp_id, 'auth.login_failed', {
      attempts,
      delayMs,
    });

    if (attempts >= 5) {
      this.logger.warn(
        `PIN ผิดต่อเนื่อง ${attempts} ครั้ง สำหรับ ${user.emp_id} — หน่วง ${delayMs}ms`,
      );
    }
    return delayMs;
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
        expiresIn: AuthService.parseDuration(this.accessTtl) / 1000,
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
    // @nestjs/jwt รับ expiresIn เป็น template type ของ ms ('15m' ฯลฯ) — ค่ามาจาก .env
    // ที่ zod validate รูปแบบไว้แล้ว จึง cast ที่จุดเดียวนี้
    return this.jwt.signAsync({ ...payload }, {
      expiresIn: this.accessTtl as unknown as number,
    });
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

  // ── เปลี่ยน PIN ───────────────────────────────────────────────────────

  /** เปลี่ยน PIN เอง (ใช้ทั้งกรณีบังคับตั้งใหม่ครั้งแรก และเปลี่ยนตามปกติ) */
  async changePin(empId: string, req: ChangePinRequest): Promise<void> {
    const user = await this.requireUser(empId);
    if (!(await this.verifyPin(user.pin_hash, req.currentPin))) {
      throw new AuthError(AuthErrorCode.INVALID_PIN);
    }
    if (req.newPin === req.currentPin) {
      throw new AuthError(AuthErrorCode.INVALID_PIN, 'PIN ใหม่ต้องไม่ซ้ำกับ PIN เดิม');
    }
    if (/^(\d)\1{5}$/.test(req.newPin) || req.newPin === '123456') {
      throw new AuthError(AuthErrorCode.INVALID_PIN, 'PIN นี้เดาง่ายเกินไป');
    }

    const hash = await this.hashPin(req.newPin);
    await this.db.query(
      `UPDATE users
          SET pin_hash = $2, must_change_pin = false,
              failed_attempts = 0, throttle_until = NULL, updated_at = now()
        WHERE emp_id = $1`,
      [empId, hash],
    );
    await this.audit(empId, 'auth.pin_changed', {});
  }

  // ── helper ───────────────────────────────────────────────────────────

  private async requireUser(empId: string): Promise<UserRow> {
    const user = await this.db.one<UserRow>(
      `SELECT emp_id, name, pin_hash, role, shift, warehouse_code,
              role_version, must_change_pin, failed_attempts, throttle_until
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
      mustChangePin: u.must_change_pin,
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

  /** '15m' '30d' '3600s' → มิลลิวินาที */
  static parseDuration(v: string): number {
    const m = /^(\d+)\s*([smhd])$/.exec(v.trim());
    if (!m) {
      const n = Number(v);
      if (Number.isFinite(n)) return n * 1000;
      throw new Error(`รูปแบบระยะเวลาไม่ถูกต้อง: ${v}`);
    }
    const n = Number(m[1]);
    const unit = m[2] as 's' | 'm' | 'h' | 'd';
    return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  }
}
