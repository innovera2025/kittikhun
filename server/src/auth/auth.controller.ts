import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { AuthError, AuthService } from './auth.service';
import { CurrentUser, Public } from './auth.guards';
import {
  AUTH_ERROR_MESSAGE_TH,
  AuthErrorCode,
  ChangePinRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  type AuthenticatedUser,
  type LoginResponse,
  type TokenPair,
} from './auth.types';

/**
 * Auth — **ผู้ใช้เป็นของระบบเราเองทั้งหมด สร้างและจัดการที่นี่ ไม่ดึงจาก ERP**
 *
 * ⚠️ `POST /auth/refresh` ต้อง**ไม่**ถูก version-gate ด้วย APP_MIN_VERSION
 *    เครื่องที่ออฟไลน์ทั้งกะต้อง refresh ได้เพื่อส่งงานนับค้าง ก่อนถูกบังคับอัปเดตแอป
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'ข้อมูลไม่ถูกต้อง',
      });
    }
    try {
      return await this.auth.login(parsed.data);
    } catch (err) {
      throw AuthController.toHttp(err);
    }
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<TokenPair> {
    const parsed = RefreshRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง' });
    }
    try {
      return await this.auth.refresh(parsed.data);
    } catch (err) {
      throw AuthController.toHttp(err);
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { deviceId?: string },
  ): Promise<void> {
    const deviceId = body?.deviceId?.trim();
    if (!deviceId) {
      throw new BadRequestException({ code: 'VALIDATION', message: 'ต้องระบุ deviceId' });
    }
    // หมายเหตุ: ไม่แตะ outbox ของเครื่อง — งานนับที่ยังไม่ซิงค์ต้องอยู่รอด
    await this.auth.logout(user.empId, deviceId);
  }

  /** ตั้ง PIN ใหม่ — ใช้ทั้งกรณีบังคับครั้งแรก (mustChangePin) และเปลี่ยนตามปกติ */
  @Post('change-pin')
  @HttpCode(204)
  async changePin(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = ChangePinRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: parsed.error.issues[0]?.message ?? 'PIN ต้องเป็นตัวเลข 6 หลัก',
      });
    }
    try {
      await this.auth.changePin(user.empId, parsed.data);
    } catch (err) {
      throw AuthController.toHttp(err);
    }
  }

  /** แปลง AuthError → HTTP พร้อม code ให้แอป map เป็นข้อความไทยตาม design */
  private static toHttp(err: unknown): Error {
    if (err instanceof AuthError) {
      const body: Record<string, unknown> = {
        code: err.code,
        message: err.message !== err.code ? err.message : AUTH_ERROR_MESSAGE_TH[err.code],
      };
      if (err.retryAfterMs !== undefined) {
        body.retryAfterMs = err.retryAfterMs;
      }
      return err.code === AuthErrorCode.THROTTLED
        ? new BadRequestException(body)
        : new UnauthorizedException(body);
    }
    return err as Error;
  }
}
