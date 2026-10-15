import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_PATH_PATTERN,
  ADMIN_ROUTE,
} from '../decorators/admin-route.decorator';
import { PUBLIC_ROUTE } from '../decorators/public.decorator';
import type { SessionRequest } from '../dto/session-user.dto';
import { AuthService } from '../../domain/auth/auth.service';
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    // Admin routes are authorized only by the separate admin session guard
    // (applied together with this marker); a member session is never consulted.
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ROUTE, targets))
      return true;
    const request = context.switchToHttp().getRequest<SessionRequest>();
    // Defense in depth: nothing under /v1/admin is ever authorized by a member
    // session, even a route that was registered without the admin marker.
    if (ADMIN_PATH_PATTERN.test(request.path))
      throw new UnauthorizedException({
        code: 'ADMIN_AUTHENTICATION_REQUIRED',
        message: '관리자 로그인이 필요해요.',
      });
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets))
      return true;
    const user = await this.auth.resolveSession(request);
    if (!user)
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: '로그인이 필요해요.',
      });
    request.user = user;
    return true;
  }
}
