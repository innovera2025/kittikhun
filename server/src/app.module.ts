import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { JwtAuthGuard, RolesGuard } from './auth/auth.guards';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { AppConfigModule } from './config/env.config';
import { CountModule } from './count/count.module';
import { PostgresModule } from './db/postgres.service';
import { ErpModule } from './erp/erp.module';
import { HealthController } from './health/health.controller';
import { MembersModule } from './members/members.module';
import { SyncModule } from './sync/sync.module';

/**
 * โมดูลราก
 *
 * พร้อมใช้งานแล้ว:
 *   AppConfigModule — โหลด/ตรวจ .env ด้วย zod (isGlobal: ConfigService ใช้ได้ทุกโมดูล)
 *   PostgresModule  — @Global · Postgres ของระบบเราเอง (users / รอบนับ / ผลนับ) เขียนได้ปกติ
 *   ScheduleModule  — cron runtime สำหรับ SyncModule ในเฟสถัดไป
 *   ErpModule       — @Global · ERP อ่านอย่างเดียว ห้ามเขียนกลับเด็ดขาด
 *   AuthModule      — POST /auth/login (argon2id + escalating throttle), refresh, logout, change-pin
 *   MembersModule   — roster + role/PIN admin (ตรวจ role_version กับ DB ไม่เชื่อ JWT claim)
 *   CatalogModule   — GET /items?since=row_version (delta feed + tombstone), /items/by-barcode/:code,
 *                     /items/search, POST /items/scan-events
 *   CountModule     — GET /count-sessions/active, POST /:id/submissions (ผลรายบรรทัด),
 *                     GET /:id/variance (คำตอบ "ต่างกันเท่าไหร่" + ?format=csv), conflicts/close
 *   SyncModule      — scheduler ดึง ERP ตามรอบ (advisory lock กันรอบซ้อน) → items_cache
 *   HealthController — /healthz (liveness, ไม่ผูก ERP) · /healthz/erp
 */
@Module({
  imports: [
    AppConfigModule,
    PostgresModule,
    ScheduleModule.forRoot(),
    ErpModule,
    AuthModule,
    MembersModule,
    CatalogModule,
    CountModule,
    SyncModule,
  ],
  controllers: [HealthController],
  providers: [
    // ปิดทุก endpoint เป็นค่าเริ่มต้น — ต้อง opt-out ด้วย @Public() รายจุด
    // (ปัจจุบันมี: AuthController.login/refresh และ HealthController ทั้ง class)
    //
    // ⚠️ ลำดับสำคัญ: Nest รัน global guard ตามลำดับที่ประกาศ
    //    JwtAuthGuard ต้องมาก่อนเพราะเป็นตัวเซ็ต req.user ที่ RolesGuard ใช้ตัดสิน
    //    ถ้าสลับลำดับ RolesGuard จะเห็น req.user เป็น undefined แล้วโยน 401 ผิดสาเหตุ
    //
    // useExisting: ใช้ instance เดิมที่ AuthModule provide/export ไว้
    //    (ไม่สร้างซ้ำ และไม่ต้องประกาศ dependency ของ guard ใหม่ที่นี่)
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
})
export class AppModule {}
