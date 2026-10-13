import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { SessionRequest } from '../dto/session-user.dto';
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<SessionRequest>().user;
  if (!user) throw new UnauthorizedException({ code: 'AUTHENTICATION_REQUIRED' });
  return user;
});
