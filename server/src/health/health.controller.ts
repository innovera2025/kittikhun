import { Controller, Get, Inject } from '@nestjs/common';

import { Public } from '../auth/auth.guards';
import { PostgresService } from '../db/postgres.service';
import { ERP_ADAPTER, type ErpAdapter, type ErpHealth } from '../erp/erp-adapter';

/**
 * ⚠️ /healthz = liveness ของ API เท่านั้น
 *
 * Docker healthcheck ชี้มาที่นี่ — **ห้าม**ผูกกับสถานะ ERP
 * ไม่งั้น ERP ล่มจะทำให้ container ถูก restart วนและมือถือซิงค์งานค้างไม่ได้
 * สถานะ ERP อยู่ที่ /healthz/erp แยกต่างหาก
 */
@Public()
@Controller('healthz')
export class HealthController {
  constructor(
    @Inject(ERP_ADAPTER) private readonly erp: ErpAdapter,
    private readonly db: PostgresService,
  ) {}

  /**
   * liveness: event loop ตอบได้ + Postgres ของเราตอบได้
   * (Postgres เป็น dependency จริงของระบบ ต่างจาก ERP ที่ล่มได้โดยระบบยังทำงาน)
   */
  @Get()
  async liveness(): Promise<{ ok: boolean; uptimeSec: number; db: boolean }> {
    const db = await this.db.isReachable();
    return { ok: db, uptimeSec: Math.floor(process.uptime()), db };
  }

  /** สถานะ ERP สำหรับผู้ดูแล — ERP ล่มที่นี่ไม่กระทบ liveness */
  @Get('erp')
  async erpHealth(): Promise<ErpHealth> {
    try {
      return await this.erp.healthCheck();
    } catch (err) {
      return { ok: false, driver: 'unknown', error: (err as Error).message };
    }
  }
}
