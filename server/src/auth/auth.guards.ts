import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthService } from './auth.service';
import {
  AUTH_ERROR_MESSAGE_TH,
  AuthErrorCode,
  type AuthenticatedUser,
  type JwtPayload,
  type Role,
} from './auth.types';

/** endpoint ที่ไม่ต้อง login (login / refresh / healthz) */
export const IS_PUBLIC = 'tcl:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** สิทธิ์ที่ต้องมี */
export const REQUIRED_ROLES = 'tcl:roles';
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

/**
 * บังคับตรวจ role กับ DB (ไม่เชื่อ claim ใน token)
 * ใช้กับ endpoint blast radius สูง: member CRUD, เปลี่ยน role, ปิดรอบนับ
 */
export const FRESH_ROLE = 'tcl:freshRole';
export const RequireFreshRole = () => SetMetadata(FRESH_ROLE, true);

/** ดึงผู้เรียกที่ผ่าน guard แล้ว: `@CurrentUser() user: AuthenticatedUser` */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!req.user) throw new UnauthorizedException('ไม่พบข้อมูลผู้ใช้ใน request');
    return req.user;
  },
);

interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const raw = req.headers['authorization'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: AuthErrorCode.INVALID_REFRESH,
        message: AUTH_ERROR_MESSAGE_TH.INVALID_REFRESH,
      });
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException({
        code: AuthErrorCode.INVALID_REFRESH,
        message: AUTH_ERROR_MESSAGE_TH.INVALID_REFRESH,
      });
    }

    let role = payload.role;

    // endpoint blast radius สูง: token อายุ 15 นาที ไม่พอ — ต้องถาม DB
    const needsFresh = this.reflector.getAllAndOverride<boolean>(FRESH_ROLE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (needsFresh) {
      try {
        role = await this.auth.assertRoleFresh(payload.sub, payload.rv);
      } catch {
        throw new UnauthorizedException({
          code: AuthErrorCode.ROLE_CHANGED,
          message: AUTH_ERROR_MESSAGE_TH.ROLE_CHANGED,
        });
      }
    }

    req.user = {
      empId: payload.sub,
      role,
      warehouseCode: payload.wh,
      roleVersion: payload.rv,
    };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    if (!required.includes(user.role)) {
      // ข้อความตรงกับ toast ที่ design ใช้ (แอปกั้นที่ UI แล้ว นี่คือ backstop ฝั่ง server)
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ROLE',
        message:
          user.role === 'viewer'
            ? 'สิทธิ์ viewer นับสต็อกไม่ได้'
            : 'ต้องมีสิทธิ์ผู้ดูแลเพื่อดำเนินการนี้',
      });
    }
    return true;
  }
}
