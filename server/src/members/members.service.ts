import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  AUTH_ERROR_MESSAGE_TH,
  EmpIdSchema,
  ROLE_RANK,
  RoleSchema,
  type Role,
} from '../auth/auth.types';
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

/** แหล่งที่มาของ credential — `'erp' | 'local' | 'legacy_pin'` (ไม่มีแถว = ล็อกอินไม่ได้อยู่แล้ว) */
interface CredentialSourceRow {
  source: string;
}

const AUDIT_SQL = `INSERT INTO audit_log (actor, action, payload) VALUES ($1, $2, $3::jsonb)`;

const REVOKE_ALL_SQL = `UPDATE refresh_tokens SET revoked_at = now()
                         WHERE emp_id = $1 AND revoked_at IS NULL`;

/**
 * roster + การเปลี่ยนสิทธิ์ — **อ่าน/เขียนตาราง `users` ของระบบเราเท่านั้น**
 *
 * 🚫 ไฟล์นี้ไม่แตะ ERP เลย (ไม่ยิง query ไป ERP และห้ามเขียนกลับ ERP)
 *    ทุก statement วิ่งบน Postgres ของระบบเท่านั้น
 *
 * ⚠️ ตั้งแต่ย้ายล็อกอินไปที่ `user_credentials` แล้ว ไฟล์นี้ **ไม่สร้างผู้ใช้และ
 *    ไม่ตั้ง/รีเซ็ตรหัสผ่านอีกต่อไป** — บัญชีมาจาก sync ผู้ใช้ของ ERP (source='erp')
 *    หรือจาก CLI `create-admin` (source='local') เท่านั้น ที่นี่จึงเหลือแค่ roster
 *    กับการสลับ role ของบัญชีที่ไม่ได้ผูกกับ ERP
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

  constructor(private readonly db: PostgresService) {}

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

  // ── 2. เปลี่ยนสิทธิ์ ─────────────────────────────────────────────────

  /**
   * เปลี่ยน role + bump `role_version`
   *
   * ล็อกแถวเป้าหมาย **พร้อมกับแถว admin ทุกคนในคำสั่งเดียว** เรียงตาม emp_id
   * → นับ admin ที่เหลือได้แบบไม่มี race และไม่เกิด deadlock (ล็อกลำดับเดียวกันทุก tx)
   *
   * ⚠️ ด่าน "บัญชีของ ERP ห้ามแก้สิทธิ์ที่นี่" อยู่**ในทรานแซกชันเดียวกันนี้** และล็อกแถว
   *    `user_credentials` ด้วย `FOR UPDATE` — เดิมเช็คไว้ที่ controller เป็นคนละ query
   *    นอกทรานแซกชัน ซึ่งชนกับรอบ sync ผู้ใช้ได้ตรง ๆ: sync กำลังเปลี่ยนบัญชีคนนั้นจาก
   *    `legacy_pin` เป็น `erp` อยู่พอดี → controller อ่านได้ค่าเก่า แล้ว UPDATE ทับสิทธิ์ที่
   *    ERP เพิ่งกำหนด (ผล 200 ที่หายไปเงียบ ๆ ในรอบ sync ถัดไป — เคสที่ด่านนี้มีไว้กัน)
   *
   * ลำดับการล็อกต้องเป็น `users` ก่อนแล้วค่อย `user_credentials` เสมอ — ลำดับเดียวกับ
   * `SyncService.runUsers()` เป๊ะ (สลับลำดับที่ใดที่หนึ่ง = deadlock ระหว่างสองเส้นทาง)
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
      // ── บัญชีที่ ERP เป็นเจ้าของ: ปฏิเสธตั้งแต่ยังไม่เขียนอะไร ───────────────
      // อ่านใต้ล็อกเดียวกับที่จะ UPDATE → ค่าที่เห็นคือค่าที่ commit จริง ไม่ใช่ค่าที่
      // รอบ sync กำลังเปลี่ยนอยู่ (ยอมให้แก้ = ตอบ 200 แล้วผลหายใน sync รอบถัดไป)
      const cred = await client.query<CredentialSourceRow>(
        `SELECT source FROM user_credentials WHERE emp_id = $1 FOR UPDATE`,
        [id],
      );
      if (cred.rows[0]?.source === 'erp') {
        throw new BadRequestException({
          code: 'ERP_MANAGED',
          message: 'บัญชีนี้ผูกกับ ERP — แก้สิทธิ์ที่ระบบ ERP แล้วรอ sync รอบถัดไป',
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

  // ── 3. helper ────────────────────────────────────────────────────────

  async countAdmins(): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`,
    );
    return row?.n ?? 0;
  }

  private static toDto(row: MemberRow): MemberDto {
    return { empId: row.emp_id, name: row.name, shift: row.shift, role: row.role };
  }
}
