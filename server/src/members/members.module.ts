import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import {
  CurrentUser,
  JwtAuthGuard,
  RequireFreshRole,
  Roles,
  RolesGuard,
} from '../auth/auth.guards';
import { AuthModule } from '../auth/auth.module';
import { EmpIdSchema, RoleSchema, type AuthenticatedUser, type Role } from '../auth/auth.types';
import { MembersService, type MemberDto } from './members.service';

/** body ของ PATCH /members/:empId/role */
const ChangeRoleBodySchema = z.object({ role: RoleSchema });

/**
 * Members — roster (`GET`) + สลับสิทธิ์ (`PATCH :empId/role`) เท่านั้น
 * 🚫 ไม่แตะ ERP เลย (ไม่ยิง query ไป ERP และห้ามเขียนกลับ ERP)
 *
 * ⚠️ `POST /members` (เพิ่มสมาชิก) และ `POST /members/:empId/reset-pin` **ถูกลบแล้ว**:
 *    ตัวยืนยันตัวตนย้ายไปตาราง `user_credentials` ที่ sync ของ ERP เป็นเจ้าของ —
 *    endpoint ที่ตั้ง PIN ให้คนใหม่จะถูกรอบ sync ถัดไปเขียนทับหรือกวาดทิ้งอยู่ดี
 *    ทางเดียวที่สร้างบัญชีที่ ERP ไม่ได้เป็นเจ้าของคือ CLI `create-admin` (source='local')
 *
 * ⚠️ endpoint ที่เปลี่ยน roster ติด `@RequireFreshRole()` — blast radius สูง
 *    จึงต้องเทียบ `users.role_version` กับ DB ไม่เชื่อ claim `role` ใน token
 *    (admin ที่ถูกลดสิทธิ์ยังถือ access token เดิมได้อีกถึง 15 นาที)
 *
 * guard ผูกที่ controller เพราะแอปยังไม่ลงทะเบียน guard ระดับ APP_GUARD
 * error: service โยน HttpException ที่มี body `{code, message}` มาแล้ว จึงปล่อยผ่าน
 * ให้ Nest จัดการ (error อื่นเป็น 500 กลาง ไม่หลุดข้อความจากไดรเวอร์ Postgres)
 */
@Controller('members')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** roster ของแท็บสมาชิก — ทุก role ที่ login แล้วอ่านได้ เห็นเฉพาะคลังของตัวเอง */
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<MemberDto[]> {
    return this.members.list(user.warehouseCode);
  }

  /**
   * สลับสิทธิ์ (แตะ role pill) — กติกา "ต้องเหลือ admin ≥ 1 คน" บังคับที่ service
   *
   * ⚠️ บัญชีที่ ERP เป็นเจ้าของ (`source='erp'`) ถูกปฏิเสธด้วย `400 ERP_MANAGED`: รอบ sync
   *    ถัดไปแปลง `menuuser.user_level` เป็น role แล้วเขียนทับอยู่ดี ปล่อยให้แก้ได้
   *    เท่ากับตอบ 200 ให้ admin แล้วผลหายไปเงียบ ๆ ภายในไม่กี่นาที
   *
   *    ด่านนั้นอยู่**ในทรานแซกชันเดียวกับการเปลี่ยน role** ที่ `MembersService.changeRole`
   *    ไม่ใช่ query แยกที่ controller อีกต่อไป — อ่านแหล่งที่มาก่อนแล้วค่อยเข้าทรานแซกชัน
   *    คือช่องว่างให้รอบ sync แทรกกลางระหว่างสองคำสั่งได้ (TOCTOU)
   */
  @Patch(':empId/role')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async changeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('empId') empIdParam: string,
    @Body() body: unknown,
  ): Promise<{ empId: string; role: Role }> {
    const empId = MembersController.parseEmpId(empIdParam);
    const parsed = ChangeRoleBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'สิทธิ์ต้องเป็น admin, staff หรือ viewer',
      });
    }
    return this.members.changeRole(empId, parsed.data.role, user.empId);
  }

  /** empId ที่มาจาก path ต้องผ่าน zod ก่อนใช้เสมอ */
  private static parseEmpId(raw: string): string {
    const parsed = EmpIdSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'รหัสพนักงานไม่ถูกต้อง',
      });
    }
    return parsed.data;
  }
}

/** PostgresModule เป็น @Global และ ConfigModule ตั้ง isGlobal ไว้แล้ว จึงไม่ต้อง import */
@Module({
  imports: [AuthModule],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
