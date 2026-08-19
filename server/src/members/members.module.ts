import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
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
import {
  MemberCreateSchema,
  MembersService,
  type MemberCreatedDto,
  type MemberDto,
} from './members.service';

/** body ของ PATCH /members/:empId/role */
const ChangeRoleBodySchema = z.object({ role: RoleSchema });

/**
 * Members — **ผู้ใช้เป็นของระบบเราเองทั้งหมด สร้าง/เปลี่ยนสิทธิ์/รีเซ็ต PIN ที่นี่**
 * 🚫 ไม่แตะ ERP เลย (roster ไม่ได้ดึงจาก ERP และห้ามเขียนกลับ ERP)
 *
 * ⚠️ endpoint ที่เปลี่ยน roster ติด `@RequireFreshRole()` — blast radius สูง
 *    จึงต้องเทียบ `users.role_version` กับ DB ไม่เชื่อ claim `role` ใน token
 *    (admin ที่ถูกลดสิทธิ์ยังถือ access token เดิมได้อีกถึง 15 นาที)
 *
 * ⚠️ `initialPin` ที่ create/reset-pin ตอบกลับเป็น plaintext ครั้งเดียวสำหรับ
 *    ให้ admin แจ้งพนักงาน — ห้าม log ห้าม cache (design-fidelity.md §7 ข้อ 5)
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

  /** เพิ่มสมาชิก (bottom sheet "เพิ่มสมาชิกใหม่") — ตอบ PIN เริ่มต้นให้ admin แจ้งพนักงาน */
  @Post()
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<MemberCreatedDto> {
    // ใช้สคีมาตัวเดียวกับ service เพื่อไม่ให้กติกา validation แตกเป็นสองชุด
    const parsed = MemberCreateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'กรอกชื่อและรหัสพนักงานให้ครบ',
      });
    }
    return this.members.create(parsed.data, user.empId);
  }

  /** สลับสิทธิ์ (แตะ role pill) — กติกา "ต้องเหลือ admin ≥ 1 คน" บังคับที่ service */
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

  /** admin รีเซ็ต PIN ให้พนักงานที่ลืม PIN (เคลียร์ throttle + ตัดเซสชันทุกเครื่อง) */
  @Post(':empId/reset-pin')
  @Roles('admin')
  @RequireFreshRole()
  @HttpCode(200)
  async resetPin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('empId') empIdParam: string,
  ): Promise<{ empId: string; initialPin: string }> {
    const empId = MembersController.parseEmpId(empIdParam);
    return this.members.resetPin(empId, user.empId);
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
