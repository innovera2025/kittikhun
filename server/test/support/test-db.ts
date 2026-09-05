import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../src/config/env.config';
import { PostgresService } from '../../src/db/postgres.service';

/**
 * ตัวช่วยต่อ Postgres จริงสำหรับ integration test
 *
 * เทสต์ชุดนี้ต้องใช้ DB จริงเพราะสิ่งที่ต้องพิสูจน์อยู่ **ในตัว engine เอง**:
 * trigger append-only, advisory lock, unique constraint แบบ partial, view v_variance
 * — mock DB พิสูจน์อะไรพวกนี้ไม่ได้เลย
 *
 * ไม่ตั้งตัวแปร TEST_DATABASE_URL → ข้ามทั้ง suite
 * (ไม่ทำให้ `npx jest` แดงบนเครื่องที่ไม่มี DB)
 *
 * เปิด DB ชั่วคราวสำหรับเทสต์:
 *   docker run -d --name tcl-test-pg \
 *     -e POSTGRES_PASSWORD=testpw -e POSTGRES_USER=tcl \
 *     -e POSTGRES_DB=tcl_test -p 55432:5432 postgres:16-alpine
 *   export TEST_DATABASE_URL='postgres://tcl:testpw@localhost:55432/tcl_test'
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** ใช้แทน `describe` ในไฟล์ที่ต้องมี DB จริง */
export const describeWithDb: jest.Describe = TEST_DATABASE_URL ? describe : describe.skip;

/** ค่า config สำหรับเทสต์ — pepper/secret เป็นค่าปลอมล้วน ห้ามใช้จริง */
export const TEST_CONFIG: Record<string, string | number> = {
  DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://unused',
  PIN_PEPPER: 'test-pepper-ห้ามใช้จริง',
  JWT_ACCESS_SECRET: 'test-access-secret-ห้ามใช้จริง-อย่างน้อย32ตัวอักษร',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  AUTH_THROTTLE_BASE_MS: 1,
  AUTH_THROTTLE_MAX_MS: 4,
  WAREHOUSE_CODE: 'WH01',
  // role เดียวที่ผู้ใช้จาก ERP ได้ทุกคน — `AuthService` ใช้ตอน upsert แถว `users`
  // ของคนที่เพิ่งล็อกอินผ่าน ERP ครั้งแรก (ค่าเดียวกับ default จริงใน env.config)
  ERP_USER_FIXED_ROLE: 'staff',
};

export function testConfigService(
  overrides: Record<string, string | number> = {},
): ConfigService<AppConfig, true> {
  const merged = { ...TEST_CONFIG, ...overrides };
  return { get: (k: string) => merged[k] } as unknown as ConfigService<AppConfig, true>;
}

export function makeDb(overrides: Record<string, string | number> = {}): PostgresService {
  return new PostgresService(testConfigService(overrides));
}

/** สร้างตารางทั้งหมดจาก db/schema.sql (idempotent — schema เขียนแบบ IF NOT EXISTS) */
export async function applySchema(db: PostgresService): Promise<void> {
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
}

/** ตารางทั้งหมดที่เทสต์แตะ — TRUNCATE CASCADE ล้างได้ในครั้งเดียว */
const TABLES = [
  'audit_log',
  'closed_variance',
  'count_submissions',
  'count_snapshot',
  'count_zone_assign',
  'count_sessions',
  'scan_events',
  'item_barcodes',
  'items_cache',
  'refresh_tokens',
  'user_credentials',
  'devices',
  'sync_runs',
  'users',
];

/** ล้างข้อมูลระหว่างเทสต์ให้แต่ละเคสเริ่มจากสถานะสะอาดเสมอ */
export async function truncateAll(db: PostgresService): Promise<void> {
  await db.query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
