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
  /**
   * ยังมีแถวใน `user_credentials` ไหม — `role='admin'` เพียว ๆ **ไม่ได้แปลว่าล็อกอินได้**
   *
   * รอบ sync ปิดบัญชีคนที่ออกจาก ERP ด้วยการลบเฉพาะแถว credential (แถว `users` ห้ามลบ
   * เพราะ FK 9 ตารางชี้มา) คนที่ออกไปแล้วจึงค้างเป็น admin ใน `users` ตลอดกาล
   * นับ "admin ผี" พวกนี้เป็นตาข่าย = ยอมลดสิทธิ์ admin ตัวจริงคนสุดท้ายจนไม่มีใครเข้าระบบได้
   */
  has_credential: boolean;
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
      // LEFT JOIN user_credentials = ความสัมพันธ์เดียวกับด่าน last-admin ของรอบ sync
      // (`user_credentials c JOIN users u ON u.emp_id = c.emp_id`) ต่างกันแค่ต้องเก็บแถว
      // เป้าหมายไว้ด้วยแม้เขาไม่มี credential จึงเป็น LEFT
      // ⚠️ `FOR UPDATE OF u` — ล็อกเฉพาะแถว `users` เหมือนเดิม (ลำดับล็อก users →
      //    user_credentials ห้ามสลับ ไม่งั้น deadlock กับ SyncService.runUsers)
      const locked = await client.query<LockedUserRow>(
        `SELECT u.emp_id, u.role, c.emp_id IS NOT NULL AS has_credential
           FROM users u
           LEFT JOIN user_credentials c ON c.emp_id = u.emp_id
          WHERE u.emp_id = $1 OR u.role = 'admin'
          ORDER BY u.emp_id
          FOR UPDATE OF u`,
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

      // ⚠️ นับเฉพาะ admin **คนอื่น** ที่ยังมี credential = ยังล็อกอินได้จริง
      //    (เดิมนับจาก `users.role` ล้วน ๆ → admin ผีที่ถูกปิดล็อกอินไปแล้วถูกนับเป็นตาข่าย
      //     และด่านนี้จะยอมให้ลดสิทธิ์ admin ตัวจริงคนสุดท้ายจนไม่มีใครเข้าระบบได้อีก)
      const otherUsableAdmins = lockedRows.filter(
        (r) => r.role === 'admin' && r.has_credential && r.emp_id !== id,
      ).length;
      if (from === 'admin' && to !== 'admin' && otherUsableAdmins === 0) {
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

  /**
   * จำนวน admin ที่ **ล็อกอินได้จริง** — ต้องมีแถวใน `user_credentials` ด้วยเสมอ
   * (รูปเดียวกับด่าน last-admin ของรอบ sync: นับจาก `users.role` ล้วน ๆ จะได้ admin ผี
   *  ที่ถูกปิดล็อกอินไปแล้วติดมาด้วย ซึ่งเป็นตาข่ายที่รับใครไม่ได้)
   */
  async countAdmins(): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_credentials c
         JOIN users u ON u.emp_id = c.emp_id
        WHERE u.role = 'admin'`,
    );
    return row?.n ?? 0;
  }

  private static toDto(row: MemberRow): MemberDto {
    return { empId: row.emp_id, name: row.name, shift: row.shift, role: row.role };
  }
}
