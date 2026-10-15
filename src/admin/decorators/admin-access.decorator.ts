import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { AdminAccessLevel } from '../admin-policy';
import type { AdminRequest } from '../dto/admin-session.dto';
export const ADMIN_ACCESS = Symbol('admin-access');
export const ADMIN_REAUTH = Symbol('admin-reauth');
// Unmarked admin handlers default to 'verified' (MFA completed).
export const AdminAccess = (level: AdminAccessLevel) =>
  SetMetadata(ADMIN_ACCESS, level);
// Sensitive actions: password + TOTP re-authentication within 10 minutes.
export const RequireAdminReauth = () => SetMetadata(ADMIN_REAUTH, true);
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const session = context
      .switchToHttp()
      .getRequest<AdminRequest>().adminSession;
    if (!session)
      throw new UnauthorizedException({
        code: 'ADMIN_AUTHENTICATION_REQUIRED',
        message: '관리자 로그인이 필요해요.',
      });
    return session;
  }
);
