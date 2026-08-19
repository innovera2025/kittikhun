import { randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { AuthService } from '../auth/auth.service';
import {
  AUTH_ERROR_MESSAGE_TH,
  EmpIdSchema,
  ROLE_RANK,
  RoleSchema,
  type Role,
} from '../auth/auth.types';
import type { AppConfig } from '../config/env.config';
import { PostgresService } from '../db/postgres.service';

// ---------------------------------------------------------------------------
// สัญญาข้อมูลที่ส่งออก
// ---------------------------------------------------------------------------

export interface MemberDto {
  empId: string;
  name: string;
  shift: string | null;
  role: Role;
}

/**
 * ผลลัพธ์ของ `create()` / (ส่วน initialPin ใช้ร่วมกับ `resetPin()`)
 *
 * ⚠️ `initialPin` เป็น **plaintext ที่ส่งกลับครั้งเดียว** ให้ admin แจ้งพนักงาน
 *    (docs/architecture.md §5 · design-fidelity.md §7 ข้อ 5)
 *    🚫 ห้าม log · ห้ามเขียนลง audit_log · ห้าม cache — DB เก็บแต่ argon2id hash
 */
export type MemberCreatedDto = MemberDto & { initialPin: string };

// ---------------------------------------------------------------------------
// zod: ข้อมูลจากภายนอก (bottom sheet "เพิ่มสมาชิกใหม่")
// ---------------------------------------------------------------------------

/** ข้อความเดียวกับ toast validation ใน design (design-fidelity.md §2.7) */
const INCOMPLETE_TH = 'กรอกชื่อและรหัสพนักงานให้ครบ';

/** กะเริ่มต้นเมื่อ admin ยังไม่กำหนด — สตริงเป๊ะตาม design */
const DEFAULT_SHIFT = 'ยังไม่กำหนดกะ';

export const MemberCreateSchema = z.object({
  // แอปบังคับรหัสพนักงาน ≥3 หลัก (design) — EmpIdSchema เองยอมรับตั้งแต่ 1 ตัว
  empId: EmpIdSchema.min(3, INCOMPLETE_TH),
  name: z.string().trim().min(1, INCOMPLETE_TH).max(100, 'ชื่อยาวเกิน 100 ตัวอักษร'),
  // sheet ตั้งค่าเริ่มต้นเป็น STAFF
  role: RoleSchema.default('staff'),
  shift: z.string().trim().min(1).max(32).optional(),
});

export type MemberCreateInput = z.input<typeof MemberCreateSchema>;

// ---------------------------------------------------------------------------
// แถวจาก Postgres
// ---------------------------------------------------------------------------

interface MemberRow {
  emp_id: string;
  name: string;
  shift: string | null;
  role: Role;
}

interface LockedUserRow {
  emp_id: string;
  role: Role;
}

const AUDIT_SQL = `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`;

const REVOKE_ALL_SQL = `UPDATE refresh_tokens SET revoked_at = now()
                         WHERE emp_id = $1 AND revoked_at IS NULL`;

/**
 * จัดการผู้ใช้ของ **ระบบเราเอง** — สร้าง/เปลี่ยนสิทธิ์/รีเซ็ต PIN
 *
 * 🚫 ไฟล์นี้ไม่แตะ ERP เลย (users ไม่ได้ดึงจาก ERP และห้ามเขียนกลับ ERP)
 *    ทุก statement วิ่งบน Postgres ของระบบเท่านั้น
 *
 * หลักการที่ต้องรักษา:
 * - เปลี่ยน role ต้อง **bump `role_version`** เสมอ → token เดิมใช้กับ endpoint
 *   ที่ติด `@RequireFreshRole()` ไม่ได้อีก (ไม่ต้องรอ access token หมดอายุ 15 นาที)
 * - ลดสิทธิ์ต้อง **เพิกถอน refresh token ทั้งหมด** ของคนนั้น — ไม่งั้นทำงานต่อ
 *   ด้วยสิทธิ์เก่าได้จนกว่า token จะหมดอายุ
 * - ต้องมี admin เหลืออย่างน้อย 1 คนตลอดเวลา (กันล็อคระบบตัวเอง)
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);
  private readonly warehouseCode: string;

  /** PIN ที่เดาง่ายเกินไป — กติกาเดียวกับ AuthService.changePin */
  private static readonly WEAK_PINS: ReadonlySet<string> = new Set(['123456', '654321']);

  constructor(
    private readonly db: PostgresService,
    private readonly auth: AuthService,
    cfg: ConfigService<AppConfig, true>,
  ) {
    this.warehouseCode = cfg.get('WAREHOUSE_CODE', { infer: true });
  }

  // ── 1. รายชื่อสมาชิก ─────────────────────────────────────────────────

  /** roster สำหรับแท็บสมาชิก — admin ขึ้นก่อน แล้วเรียงตามชื่อ */
  async list(warehouseCode?: string): Promise<MemberDto[]> {
    const wh = warehouseCode?.trim();
    const result = await this.db.query<MemberRow>(
      `SELECT emp_id, name, shift, role
         FROM users
        WHERE ($1::text IS NULL OR warehouse_code = $1)
        ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, name`,
      [wh && wh.length > 0 ? wh : null],
    );
    const rows: MemberRow[] = result.rows;
    return rows.map(MembersService.toDto);
  }

  // ── 2. เพิ่มสมาชิก ───────────────────────────────────────────────────

  /**
   * สร้างพนักงานใหม่ + PIN เริ่มต้นที่สุ่มมา (must_change_pin = true)
   *
   * ⚠️ ค่าที่คืนมามี `initialPin` เป็น plaintext ครั้งเดียวเท่านั้น — ห้าม log
   */
  async create(input: unknown, actor: string): Promise<MemberCreatedDto> {
    const parsed = MemberCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? INCOMPLETE_TH,
      });
    }
    const { empId, name, role, shift } = parsed.data;

    const initialPin = MembersService.randomPin();
    const pinHash = await this.auth.hashPin(initialPin);

    const row = await this.db.transaction(async (client) => {
      // ON CONFLICT DO NOTHING = กันชนแบบ race-safe (ไม่ต้อง pre-check แล้วเจอ TOCTOU)
      const inserted = await client.query<MemberRow>(
        `INSERT INTO users (emp_id, name, pin_hash, role, shift, warehouse_code, must_change_pin)
         VALUES ($1, $2, $3, $4::user_role, $5, $6, true)
         ON CONFLICT (emp_id) DO NOTHING
         RETURNING emp_id, name, shift, role`,
        [empId, name, pinHash, role, shift ?? DEFAULT_SHIFT, this.warehouseCode],
      );
      const insertedRows: MemberRow[] = inserted.rows;
      const created = insertedRows[0];
      if (!created) {
        throw new ConflictException({
          code: 'DUPLICATE_EMP_ID',
          message: 'รหัสพนักงานนี้มีอยู่แล้ว',
        });
      }
      // 🚫 ห้ามใส่ PIN ลง audit_log (append-only + อ่านได้ทีหลัง)
      await client.query(AUDIT_SQL, [
        actor,
        'members.created',
        JSON.stringify({ empId, role, by: actor }),
      ]);
      return created;
    });

    this.logger.log(`เพิ่มสมาชิก ${empId} (${role}) โดย ${actor}`);
    return { ...MembersService.toDto(row), initialPin };
  }

  // ── 3. เปลี่ยนสิทธิ์ ─────────────────────────────────────────────────

  /**
   * เปลี่ยน role + bump `role_version`
   *
   * ล็อกแถวเป้าหมาย **พร้อมกับแถว admin ทุกคนในคำสั่งเดียว** เรียงตาม emp_id
   * → นับ admin ที่เหลือได้แบบไม่มี race และไม่เกิด deadlock (ล็อกลำดับเดียวกันทุก tx)
   */
  async changeRole(
    empId: string,
    newRole: Role,
    actor: string,
  ): Promise<{ empId: string; role: Role }> {
    const target = EmpIdSchema.safeParse(empId);
    const role = RoleSchema.safeParse(newRole);
    if (!target.success || !role.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง' });
    }
    const id = target.data;
    const to = role.data;

    return this.db.transaction(async (client) => {
      const locked = await client.query<LockedUserRow>(
        `SELECT emp_id, role FROM users
          WHERE emp_id = $1 OR role = 'admin'
          ORDER BY emp_id
          FOR UPDATE`,
        [id],
      );
      const lockedRows: LockedUserRow[] = locked.rows;
      const current = lockedRows.find((r) => r.emp_id === id);
      if (!current) {
        throw new NotFoundException({
          code: 'UNKNOWN_EMPLOYEE',
          message: AUTH_ERROR_MESSAGE_TH.UNKNOWN_EMPLOYEE,
        });
      }
      const from = current.role;
      // ไม่มีอะไรเปลี่ยน → ไม่ bump role_version (ไม่ทำให้ token ทุกเครื่องเสียเปล่า ๆ)
      if (from === to) return { empId: id, role: from };

      const adminCount = lockedRows.filter((r) => r.role === 'admin').length;
      if (from === 'admin' && to !== 'admin' && adminCount <= 1) {
        throw new BadRequestException({
          code: 'LAST_ADMIN',
          message: 'ต้องมีผู้ดูแลอย่างน้อย 1 คน',
        });
      }

      await client.query(
        `UPDATE users
            SET role = $2::user_role, role_version = role_version + 1, updated_at = now()
          WHERE emp_id = $1`,
        [id, to],
      );

      // ลดสิทธิ์ → ตัด refresh token ทุกเครื่อง ไม่ให้ทำงานต่อด้วยสิทธิ์เก่า
      const demoted = ROLE_RANK[to] < ROLE_RANK[from];
      if (demoted) {
        await client.query(REVOKE_ALL_SQL, [id]);
      }

      await client.query(AUDIT_SQL, [
        actor,
        'members.role_changed',
        JSON.stringify({ empId: id, from, to, by: actor }),
      ]);

      this.logger.log(
        `เปลี่ยนสิทธิ์ ${id}: ${from} → ${to} โดย ${actor}${demoted ? ' (เพิกถอน refresh token แล้ว)' : ''}`,
      );
      return { empId: id, role: to };
    });
  }

  // ── 4. รีเซ็ต PIN ────────────────────────────────────────────────────

  /**
   * admin สั่งรีเซ็ต PIN — คืน PIN ใหม่เป็น plaintext ครั้งเดียว (⚠️ ห้าม log)
   * เคลียร์ throttle ให้ด้วย เพราะเคสจริงคือ "พนักงานลืม PIN แล้วยิงผิดจนโดนหน่วง"
   */
  async resetPin(empId: string, actor: string): Promise<{ empId: string; initialPin: string }> {
    const parsed = EmpIdSchema.safeParse(empId);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง' });
    }
    const id = parsed.data;

    const initialPin = MembersService.randomPin();
    const pinHash = await this.auth.hashPin(initialPin);

    await this.db.transaction(async (client) => {
      const updated = await client.query<{ emp_id: string }>(
        `UPDATE users
            SET pin_hash = $2, must_change_pin = true,
                failed_attempts = 0, throttle_until = NULL, updated_at = now()
          WHERE emp_id = $1
        RETURNING emp_id`,
        [id, pinHash],
      );
      if (updated.rows.length === 0) {
        throw new NotFoundException({
          code: 'UNKNOWN_EMPLOYEE',
          message: AUTH_ERROR_MESSAGE_TH.UNKNOWN_EMPLOYEE,
        });
      }
      // PIN เปลี่ยนแล้ว = เซสชันเดิมทุกเครื่องต้องตาย
      await client.query(REVOKE_ALL_SQL, [id]);
      await client.query(AUDIT_SQL, [
        actor,
        'members.pin_reset',
        JSON.stringify({ empId: id, by: actor }),
      ]);
    });

    this.logger.log(`รีเซ็ต PIN ของ ${id} โดย ${actor}`);
    return { empId: id, initialPin };
  }

  // ── 5. helper ────────────────────────────────────────────────────────

  async countAdmins(): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`,
    );
    return row?.n ?? 0;
  }

  /**
   * PIN เริ่มต้น 6 หลักแบบสุ่มเข้ารหัส
   * `crypto.randomInt` เท่านั้น (Math.random เดาย้อนได้จาก state ของ V8)
   */
  private static randomPin(): string {
    for (;;) {
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!MembersService.isWeakPin(pin)) return pin;
    }
  }

  /** เลขซ้ำทั้งหมด (000000–999999 แบบ dddddd) และเรียงเป็นชุด */
  private static isWeakPin(pin: string): boolean {
    return /^(\d)\1{5}$/.test(pin) || MembersService.WEAK_PINS.has(pin);
  }

  private static toDto(row: MemberRow): MemberDto {
    return { empId: row.emp_id, name: row.name, shift: row.shift, role: row.role };
  }
}
