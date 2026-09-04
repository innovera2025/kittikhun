import { z } from 'zod';

/** สิทธิ์ในระบบ — ตรงกับ enum `user_role` ใน Postgres และ enum Role ในแอป Flutter */
export const RoleSchema = z.enum(['admin', 'staff', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, staff: 1, admin: 2 };

export function canWrite(role: Role): boolean {
  return role !== 'viewer';
}

/**
 * ตัวระบุที่ใช้ล็อกอิน (login identifier) — ชื่อฟิลด์ wire คือ `empId` ตามเดิมโดยตั้งใจ
 * (fleet ไม่อัปเดตพร้อมกัน เปลี่ยนชื่อฟิลด์ = APK เก่าได้ 400 ทันที) แต่ความหมายกว้างขึ้น:
 * สำหรับผู้ใช้ legacy/local ยังเท่ากับ lower(emp_id) เดิม สำหรับผู้ใช้ ERP คือ
 * lower(menuuser.user_name) ซึ่งอาจไม่เท่ากับ users.emp_id อีกต่อไป — lookup จริงอยู่ที่
 * user_credentials.login_name ไม่ใช่ users.emp_id ตรง ๆ
 *
 * ⚠️ schema นี้ยังถูกใช้เป็นตัวตรวจ path param ของ /members ด้วย — รูปแบบที่เข้มกว่านี้
 *    ถูกบังคับที่ระดับ engine อยู่แล้วโดย CHECK `users_emp_id_fmt` (schema.sql:130)
 */
export const EmpIdSchema = z
  .string()
  .trim()
  .min(1, 'ต้องกรอกชื่อผู้ใช้')
  .max(64, 'ชื่อผู้ใช้ยาวเกิน 64 ตัวอักษร');

/**
 * secret ของการล็อกอิน — ชื่อฟิลด์ wire ยังเป็น `pin` ตามเดิมโดยตั้งใจ (เหตุผลเดียวกับ empId)
 * ⚠️ ห้าม .trim() — ERP เทียบ a_Password แบบ string เป๊ะ ช่องว่างท้ายมีความหมาย
 */
export const SecretSchema = z
  .string()
  .min(1, 'ต้องกรอกรหัสผ่าน')
  .max(128, 'รหัสผ่านยาวเกิน 128 ตัวอักษร');

/**
 * PIN 6 หลัก — **ไม่ใช่ schema ของการล็อกอินอีกต่อไป** (ล็อกอินใช้ `SecretSchema`)
 * เหลือไว้ให้ break-glass CLI `src/cli/create-admin.ts` ที่ยังกำหนด secret เป็น 6 หลักเท่านั้น
 */
export const PinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN ต้องเป็นตัวเลข 6 หลัก');

export const LoginRequestSchema = z.object({
  empId: EmpIdSchema, // ← ชื่อคีย์ JSON ไม่เปลี่ยน
  pin: SecretSchema, // ← ชื่อคีย์ JSON ไม่เปลี่ยน
  /** ผูก refresh token กับเครื่อง — เครื่องคลังเป็น pool ที่ใช้ร่วมกัน */
  deviceId: z.string().trim().min(1).max(64),
  appVersion: z.string().trim().max(32).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().trim().min(1),
  deviceId: z.string().trim().min(1).max(64),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** โปรไฟล์ที่ส่งกลับให้แอป */
export interface UserProfile {
  empId: string;
  name: string;
  role: Role;
  shift: string | null;
  warehouseCode: string;
  /**
   * ⚠️ คงไว้ในสัญญา wire โดยตั้งใจ แม้แนวคิด "บังคับตั้ง PIN ใหม่" จะตายไปแล้ว —
   *    server ส่ง `false` เสมอ (ดู AuthService.toProfile) การลบฟิลด์ออกจาก JSON
   *    ต้องพิสูจน์ทุกจุด deserialize ของ APK ทุกเวอร์ชันที่ยัง sideload ค้างอยู่
   */
  mustChangePin: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** วินาทีจนกว่า access token จะหมดอายุ */
  expiresIn: number;
}

export interface LoginResponse extends TokenPair {
  user: UserProfile;
}

/**
 * payload ใน access JWT
 *
 * ⚠️ `role` ใน token ใช้ได้เฉพาะ gate ทั่วไป — endpoint ที่ blast radius สูง
 *    (member CRUD, เปลี่ยน role, ปิดรอบนับ) ต้องตรวจ `roleVersion` กับ DB
 *    ไม่งั้น admin ที่ถูกลดสิทธิ์ยังใช้ token เดิมได้อีกถึง 15 นาที
 */
export interface JwtPayload {
  sub: string;
  role: Role;
  wh: string;
  /** users.role_version ณ เวลาที่ออก token */
  rv: number;
  iat?: number;
  exp?: number;
}

/** ผู้เรียกที่ผ่าน guard แล้ว (แนบไว้ที่ request.user) */
export interface AuthenticatedUser {
  empId: string;
  role: Role;
  warehouseCode: string;
  roleVersion: number;
}

/**
 * error code ที่แอปใช้ map เป็นข้อความไทยตาม design
 *
 * ⚠️ design กำหนดข้อความแยกระหว่าง "ไม่พบชื่อผู้ใช้" กับ "รหัสผ่านไม่ถูกต้อง"
 *    → ยอมรับความเสี่ยง user enumeration แบบ LAN-only (ดู docs/architecture.md §7)
 *    แต่ต้อง throttle หนักและ log pattern การเดา
 *
 * ⚠️ **ห้ามเปลี่ยน string value ของ code ใด ๆ** — APK ที่ sideload ค้างอยู่เทียบค่าเหล่านี้
 *    ตรง ๆ เพื่อเคลียร์ช่องรหัสผ่าน เปลี่ยนค่า = ฟีเจอร์นั้นหายเงียบ ๆ บนเครื่องที่ยังไม่อัปเดต
 */
export const AuthErrorCode = {
  UNKNOWN_EMPLOYEE: 'UNKNOWN_EMPLOYEE',
  INVALID_PIN: 'INVALID_PIN',
  THROTTLED: 'THROTTLED',
  INVALID_REFRESH: 'INVALID_REFRESH',
  REFRESH_REUSED: 'REFRESH_REUSED',
  ROLE_CHANGED: 'ROLE_CHANGED',
} as const;
export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** ข้อความไทยที่แอปแสดง — ตรงตาม design (docs/design-fidelity.md §2.1) */
export const AUTH_ERROR_MESSAGE_TH: Record<AuthErrorCode, string> = {
  UNKNOWN_EMPLOYEE: 'ไม่พบชื่อผู้ใช้นี้ · unknown user',
  INVALID_PIN: 'รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง',
  THROTTLED: 'ลองใหม่อีกครั้งในอีกสักครู่',
  INVALID_REFRESH: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  REFRESH_REUSED: 'ตรวจพบการใช้ token ซ้ำ กรุณาเข้าสู่ระบบใหม่',
  ROLE_CHANGED: 'สิทธิ์ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่',
};
