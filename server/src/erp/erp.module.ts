import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ERP_ADAPTER, ErpAdapter } from './erp-adapter';
import { MssqlDriver } from './drivers/mssql.driver';
import { MockDriver } from './drivers/mock.driver';
import type { AppConfig } from '../config/env.config';

/**
 * โมดูล ERP — สร้าง driver ตัวเดียวตาม ERP_DRIVER ใน .env ตอน boot
 *
 * 🚫 กฎเหล็ก: ERP อ่านอย่างเดียว ห้ามเขียนกลับเด็ดขาด
 *    ชั้นบังคับ: (1) สิทธิ์ DB db_datareader (2) boot probe ที่นี่
 *    (3) statement guard ใน erp-adapter (4) interface ไม่มี method เขียน
 *    (5) read-only connection option
 */
@Global()
@Module({
  providers: [
    {
      provide: ERP_ADAPTER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<AppConfig, true>): ErpAdapter => {
        const driver = cfg.get('ERP_DRIVER', { infer: true });
        switch (driver) {
          case 'sql':
            return new MssqlDriver(cfg);
          case 'mock':
            return new MockDriver();
          case 'rest':
            throw new Error(
              'ERP_DRIVER=rest ยังไม่ implement ในเฟสนี้ — โปรเจคนี้ใช้ sql (SQL Server) หรือ mock',
            );
          default:
            throw new Error(`ERP_DRIVER ไม่รู้จัก: ${String(driver)}`);
        }
      },
    },
  ],
  exports: [ERP_ADAPTER],
})
export class ErpModule implements OnModuleInit {
  private readonly logger = new Logger(ErpModule.name);

  constructor(private readonly cfg: ConfigService<AppConfig, true>) {}

  /**
   * ตอน start:
   * - ชั้นที่ 2: driver ที่เชื่อม DB จริงต้องพิสูจน์ว่าเขียนไม่ได้ (ทำใน driver.init())
   * - connectivity probe: **ไม่ block การ start** — ERP ล่มต้องไม่ทำให้ระบบล่ม
   */
  async onModuleInit(): Promise<void> {
    const driver = this.cfg.get('ERP_DRIVER', { infer: true });
    this.logger.log(`ERP driver: ${driver} (อ่านอย่างเดียว)`);
  }
}
