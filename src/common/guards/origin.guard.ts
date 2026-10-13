import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { runtimeConfig } from '../configurations/runtime.config';
@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const origin = request.get('Origin');
    // Both checks are necessary: untrusted origins cannot send this header via CORS.
    if (!origin || !runtimeConfig().allowedOrigins.includes(origin) || request.get('X-Woori-Request') !== '1') {
      throw new ForbiddenException({ code: 'REQUEST_ORIGIN_REJECTED', message: '허용되지 않은 요청이에요. 앱에서 다시 시도해 주세요.' });
    }
    if (request.headers['content-length'] !== '0' && request.headers['content-length'] && !request.is('application/json')) {
      throw new ForbiddenException({ code: 'JSON_REQUIRED', message: '지원하지 않는 요청 형식이에요.' });
    }
    return true;
  }
}
