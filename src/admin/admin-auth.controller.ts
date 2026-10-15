import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminAuthService, adminMe } from './admin-auth.service';
import { AdminApi } from './decorators/admin-api.decorator';
import { AdminAccess, CurrentAdmin } from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminLoginDto,
  AdminMfaCodeDto,
  AdminReauthDto,
} from './dto/admin-auth.dto';
// Separate operator authentication: admin accounts, admin sessions and the
// admin cookie never authorize member routes, and member sessions never
// authorize these routes.
@AdminApi()
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly service: AdminAuthService) {}
  @AdminAccess('public')
  @Post('login')
  @HttpCode(200)
  login(
    @Body() dto: AdminLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.login(dto, request, response);
  }
  @AdminAccess('session')
  @Get('me')
  me(@CurrentAdmin() session: AdminSessionContext) {
    return adminMe(session);
  }
  @AdminAccess('session')
  @Post('mfa/setup')
  @HttpCode(200)
  setup(@CurrentAdmin() session: AdminSessionContext) {
    return this.service.setupMfa(session);
  }
  @AdminAccess('session')
  @Post('mfa/activate')
  @HttpCode(200)
  activate(
    @CurrentAdmin() session: AdminSessionContext,
    @Body() dto: AdminMfaCodeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.completeMfa(
      'ACTIVATE',
      session,
      dto,
      request,
      response
    );
  }
  @AdminAccess('session')
  @Post('mfa/verify')
  @HttpCode(200)
  verify(
    @CurrentAdmin() session: AdminSessionContext,
    @Body() dto: AdminMfaCodeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.completeMfa('VERIFY', session, dto, request, response);
  }
  @Post('reauth')
  @HttpCode(200)
  reauth(
    @CurrentAdmin() session: AdminSessionContext,
    @Body() dto: AdminReauthDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.reauthenticate(session, dto, request, response);
  }
  // Works without a valid session so a stale cookie can always be cleared.
  @AdminAccess('public')
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    await this.service.logout(request, response);
  }
}
