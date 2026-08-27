import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import type { AppConfig } from '../config/env.config';

/**
 * Postgres ของ **ระบบเราเอง** (system of record ของ users / รอบนับ / ผลนับ)
 *
 * ⚠️ ห้ามสับสนกับ connection ของ ERP — ตัวนี้เขียนได้ปกติ
 *    connection ของ ERP อยู่ใน src/erp/drivers/ และเป็น read-only เท่านั้น
 */
@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresService.name);
  private readonly pool: Pool;

  constructor(cfg: ConfigService<AppConfig, true>) {
    this.pool = new Pool({
      connectionString: cfg.get('DATABASE_URL', { infer: true }),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => {
      // connection ใน pool ตายระหว่าง idle — log แล้วให้ pool สร้างใหม่ ห้ามทำให้ process ตาย
      this.logger.error(`pool error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
      this.logger.log('เชื่อมต่อ Postgres ของระบบสำเร็จ');
    } catch (err) {
      // DB ของเราเป็น dependency จริง (ต่างจาก ERP) — แจ้งชัดแต่ยังไม่ kill process
      // ให้ /healthz ตอบ liveness ได้และ Docker restart policy จัดการต่อ
      this.logger.error(`เชื่อมต่อ Postgres ไม่ได้: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params as unknown[]);
  }

  /** คืนแถวแรกหรือ null */
  async one<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const r = await this.query<T>(sql, params);
    return r.rows[0] ?? null;
  }

  /** รันหลาย statement ใน transaction เดียว (rollback อัตโนมัติเมื่อ throw) */
  /**
   * ยืม client หนึ่งตัวจาก pool โดย **ไม่** เปิด transaction
   *
   * ใช้กับ session-level advisory lock ที่ต้องถือข้ามงานยาว ๆ (เช่นการเขียน
   * เอกสารเข้า ERP) — เปิด transaction ค้างไว้นานขนาดนั้นจะขวาง vacuum
   * ข้อดีของ session lock: process ตายเมื่อไหร่ connection ปิด Postgres ปลดล็อกให้เอง
   */
  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** true = ต่อ DB ได้ (ใช้ใน /healthz) */
  async isReachable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

@Global()
@Module({
  providers: [PostgresService],
  exports: [PostgresService],
})
export class PostgresModule {}
