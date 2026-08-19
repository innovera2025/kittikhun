import { z } from 'zod';

/** สิทธิ์ในระบบ — ตรงกับ enum `user_role` ใน Postgres และ enum Role ในแอป Flutter */
export const RoleSchema = z.enum(['admin', 'staff', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, staff: 1, admin: 2 };

export function canWrite(role: Role): boolean {
  return role !== 'viewer';
}

/**
 * รหัสพนักงาน — ระบบเราเป็นผู้สร้างและจัดการเองทั้งหมด (ไม่ดึงจาก ERP)
 * แอปกรอกเป็นตัวเลข ≤6 หลัก แต่ schema ยอมรับ A-Z 0-9 . _ - ได้ถึง 32 ตัว
 */
export const EmpIdSchema = z
  .string()
  .trim()
  .min(1, 'ต้องมีรหัสพนักงาน')
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'รหัสพนักงานใช้ได้เฉพาะ A-Z a-z 0-9 . _ -');

/** PIN 6 หลัก — เอนโทรปีต่ำ จึง hash ด้วย argon2id + server pepper และมี throttle */
export const PinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN ต้องเป็นตัวเลข 6 หลัก');

export const LoginRequestSchema = z.object({
  empId: EmpIdSchema,
  pin: PinSchema,
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

export const ChangePinRequestSchema = z.object({
  currentPin: PinSchema,
  newPin: PinSchema,
});
export type ChangePinRequest = z.infer<typeof ChangePinRequestSchema>;

/** โปรไฟล์ที่ส่งกลับให้แอป */
export interface UserProfile {
  empId: string;
  name: string;
  role: Role;
  shift: string | null;
  warehouseCode: string;
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
 * ⚠️ design กำหนดข้อความแยกระหว่าง "ไม่พบรหัสพนักงาน" กับ "PIN ไม่ถูกต้อง"
 *    → ยอมรับความเสี่ยง user enumeration แบบ LAN-only (ดู docs/architecture.md §7)
 *    แต่ต้อง throttle หนักและ log pattern การเดา
 */
export const AuthErrorCode = {
  UNKNOWN_EMPLOYEE: 'UNKNOWN_EMPLOYEE',
  INVALID_PIN: 'INVALID_PIN',
  THROTTLED: 'THROTTLED',
  MUST_CHANGE_PIN: 'MUST_CHANGE_PIN',
  INVALID_REFRESH: 'INVALID_REFRESH',
  REFRESH_REUSED: 'REFRESH_REUSED',
  ROLE_CHANGED: 'ROLE_CHANGED',
} as const;
export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** ข้อความไทยที่แอปแสดง — ตรงตาม design (docs/design-fidelity.md §2.1) */
export const AUTH_ERROR_MESSAGE_TH: Record<AuthErrorCode, string> = {
  UNKNOWN_EMPLOYEE: 'ไม่พบรหัสพนักงานนี้ · unknown employee ID',
  INVALID_PIN: 'PIN ไม่ถูกต้อง ลองอีกครั้ง',
  THROTTLED: 'ลองใหม่อีกครั้งในอีกสักครู่',
  MUST_CHANGE_PIN: 'ต้องตั้ง PIN ใหม่ก่อนเข้าใช้งาน',
  INVALID_REFRESH: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  REFRESH_REUSED: 'ตรวจพบการใช้ token ซ้ำ กรุณาเข้าสู่ระบบใหม่',
  ROLE_CHANGED: 'สิทธิ์ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่',
};
