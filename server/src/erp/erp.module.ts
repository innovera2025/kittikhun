import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ERP_ADAPTER, ErpAdapter } from './erp-adapter';
import { ERP_COUNT_WRITER, type ErpCountWriter } from './erp-count-writer';
import { MssqlCountWriter } from './drivers/mssql-count-writer';
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
    {
      // เส้นทางเขียนกลับ ERP — `null` เมื่อปิดอยู่ (ค่าเริ่มต้น)
      //
      // 🚫 ใช้ **บัญชีคนละตัว** กับเส้นทางอ่านเสมอ (env.config บังคับไว้แล้ว)
      //    บัญชีอ่านต้องพิสูจน์ได้ว่าเขียนไม่ได้ตามกฎเหล็กชั้นที่ 1
      provide: ERP_COUNT_WRITER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<AppConfig, true>): ErpCountWriter | null => {
        if (!cfg.get('ERP_WRITEBACK_ENABLED', { infer: true })) return null;

        const user = cfg.get('ERP_SQL_WRITE_USER', { infer: true });
        const password = cfg.get('ERP_SQL_WRITE_PASSWORD', { infer: true });
        const host = cfg.get('ERP_SQL_HOST', { infer: true });
        const database = cfg.get('ERP_SQL_DATABASE', { infer: true });
        // env.config ตรวจครบแล้วว่าต้องมีเมื่อเปิดใช้ — เช็คซ้ำเพื่อให้ชนิดข้อมูลแคบลง
        if (!user || !password || !host || !database) return null;

        return new MssqlCountWriter({
          host,
          port: cfg.get('ERP_SQL_PORT', { infer: true }),
          user,
          password,
          database,
          encrypt: cfg.get('ERP_SQL_ENCRYPT', { infer: true }),
          trustServerCert: cfg.get('ERP_SQL_TRUST_SERVER_CERT', { infer: true }),
          timeoutMs: cfg.get('ERP_TIMEOUT_MS', { infer: true }),
          poolMax: cfg.get('ERP_SQL_POOL_MAX', { infer: true }),
          dtlVoucherNo: cfg.get('ERP_WRITEBACK_DTL_VOUCHERNO', { infer: true }),
        });
      },
    },
  ],
  exports: [ERP_ADAPTER, ERP_COUNT_WRITER],
})
export class ErpModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErpModule.name);

  constructor(
    private readonly cfg: ConfigService<AppConfig, true>,
    @Inject(ERP_ADAPTER) private readonly erp: ErpAdapter,
    // `null` เมื่อ ERP_WRITEBACK_ENABLED=false — provider คืน null ให้โดยตั้งใจ
    @Optional() @Inject(ERP_COUNT_WRITER) private readonly countWriter?: ErpCountWriter | null,
  ) {}

  /**
   * ตอน start — ต้องเรียก `driver.init()` จริง ไม่ใช่แค่ log
   *
   * ⚠️ เคยพลาดตรงนี้: เมธอดนี้ log อย่างเดียวไม่เคยเรียก init() เลย ทำให้
   *    ชั้นที่ 2 ของกฎเหล็ก (พิสูจน์ว่าเขียน ERP ไม่ได้) ไม่ทำงานตอน boot
   *    ไปทำงาน lazy ตอน query แรกแทน และ verifyThaiText() ไม่เคยรัน
   *    → charset ผิดจะทำให้ชื่อสินค้าไทยเพี้ยนไหลเข้า items_cache โดยไม่มีใครรู้
   *
   * แยกความล้มเหลว 2 ชนิดออกจากกันอย่างชัดเจน:
   *   - **เขียน ERP ได้ / charset เพี้ยน** → `ปฏิเสธการ start` (ข้อมูลผิดแย่กว่าระบบไม่ขึ้น)
   *   - **ต่อ ERP ไม่ได้** → start ต่อได้แบบ degraded (ERP ล่มต้องไม่ทำให้ทั้งระบบล่ม
   *     แอปยังต้องอ่าน items_cache และรับผลนับเข้าคิวได้)
   */
  async onModuleInit(): Promise<void> {
    const driver = this.cfg.get('ERP_DRIVER', { infer: true });
    this.logger.log(`ERP driver: ${driver} (อ่านอย่างเดียว)`);

    try {
      await this.erp.init();
      this.logger.log('ตรวจ ERP ตอน boot ผ่าน: อ่านอย่างเดียวจริง และอ่านภาษาไทยได้ถูกต้อง');
    } catch (err) {
      if (isStartupBlocker(err)) {
        // ปล่อยให้ throw ออกไป — Nest จะหยุด boot ตามที่กฎเหล็กกำหนด
        throw err;
      }
      this.logger.error(
        `ต่อ ERP ตอน boot ไม่ได้ — ระบบจะ start ต่อแบบ degraded ` +
          `(อ่าน items_cache ได้ · รับผลนับได้ · แต่ sync จาก ERP จะล้มจนกว่าจะต่อได้): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.verifyWriteAccount();
  }

  /**
   * ตรวจบัญชีเขียนตอน boot — ทำเฉพาะเมื่อเปิด `ERP_WRITEBACK_ENABLED`
   *
   * ⚠️ ก่อนหน้านี้ฝั่งเขียนไม่มีการตรวจใด ๆ ตอน start ต่างจากฝั่งอ่านที่พิสูจน์
   *    ตัวเองทุกครั้ง → รหัสผ่านผิดหรือสิทธิ์กว้างเกินขอบเขตจะรู้ตัวตอนที่ admin
   *    กดส่งเอกสารจริงแล้วเท่านั้น
   *
   * ขอบเขตผิด = หยุด boot (เหมือนฝั่งอ่านที่เขียนได้แล้วห้าม start)
   * ต่อไม่ได้ = ปล่อยผ่านแบบ degraded (ERP ล่มชั่วคราวเป็นเรื่องปกติของคลัง)
   */
  private async verifyWriteAccount(): Promise<void> {
    if (!this.countWriter) {
      this.logger.log('เส้นทางเขียนกลับ ERP: ปิดอยู่ (ERP_WRITEBACK_ENABLED=false)');
      return;
    }
    if (!this.countWriter.verifyWriteScope) {
      this.logger.warn('เส้นทางเขียนกลับ ERP: เปิดอยู่แต่ implementation นี้ตรวจสิทธิ์ตอน boot ไม่ได้');
      return;
    }

    try {
      await this.countWriter.verifyWriteScope();
      this.logger.log('เส้นทางเขียนกลับ ERP: เปิดอยู่ และขอบเขตสิทธิ์ของบัญชีเขียนถูกต้อง');
    } catch (err) {
      if (isStartupBlocker(err)) throw err;
      this.logger.error(
        `ตรวจบัญชีเขียนของ ERP ตอน boot ไม่ได้ — start ต่อแบบ degraded ` +
          `(กดส่งเอกสารจะล้มจนกว่าจะต่อได้): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** ปิด connection pool ของ ERP ตอน shutdown (main.ts เปิด enableShutdownHooks ไว้แล้ว) */
  async onModuleDestroy(): Promise<void> {
    await this.countWriter?.close().catch((err: unknown) => {
      this.logger.warn(
        `ปิด connection ของเส้นทางเขียน ERP ไม่สำเร็จ: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
    await this.erp.close().catch((err: unknown) => {
      this.logger.warn(
        `ปิด connection ของ ERP ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

/**
 * ความล้มเหลวชนิดไหนที่ต้อง **ห้าม start**
 *
 * ต่อไม่ได้ = ยอมให้ผ่าน (ERP ล่มชั่วคราวเป็นเรื่องปกติของคลัง)
 * แต่ "เขียนได้" / "คอนฟิกผิด" / "ภาษาไทยเพี้ยน" = ต้องหยุด เพราะปล่อยไปแล้วข้อมูลเสียหาย
 */
function isStartupBlocker(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'ERP_WRITE_ALLOWED' ||
    code === 'ERP_PROBE_INCONCLUSIVE' ||
    code === 'ERP_WRITE_SCOPE_TOO_WIDE' ||
    code === 'ERP_WRITE_SCOPE_INSUFFICIENT' ||
    code === 'ERP_WRITE_PROBE_INCONCLUSIVE' ||
    code === 'ERP_THAI_DECODE' ||
    code === 'ERP_CONFIG'
  );
}
