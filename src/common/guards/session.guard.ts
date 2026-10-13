import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from '../decorators/public.decorator';
import type { SessionRequest } from '../dto/session-user.dto';
import { AuthService } from '../../domain/auth/auth.service';
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const user = await this.auth.resolveSession(request);
    if (!user) throw new UnauthorizedException({ code: 'AUTHENTICATION_REQUIRED', message: '로그인이 필요해요.' });
    // User sessions never authorize the separately scoped, unfinished admin API.
    if (/^\/(?:api\/)?v1\/admin(?:\/|$)/i.test(request.path)) throw new ForbiddenException({ code: 'ADMIN_AUTHENTICATION_REQUIRED' });
    request.user = user;
    return true;
  }
}
