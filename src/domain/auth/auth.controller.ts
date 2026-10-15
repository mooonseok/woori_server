import { AccountSettingsService } from './account-settings.service';
import { ChangePasswordDto, RequestEmailChangeDto } from './dto/auth.dto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { RecoveryService } from './recovery.service';
import {
  RecoveryRequestDto,
  ResetPasswordDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { AuthService } from './auth.service';
import { ConfirmEmailDto, LoginDto, SignupDto } from './dto/auth.dto';
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly settings: AccountSettingsService,
    private readonly recovery: RecoveryService
  ) {}
  @Public()
  @Post('signup')
  signup(
    @Body() dto: SignupDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.signup(dto, request, response);
  }
  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.login(dto, request, response);
  }
  @Public()
  @Post('recovery/username')
  @HttpCode(202)
  recoverUsername(@Body() dto: RecoveryRequestDto, @Req() request: Request) {
    return this.recovery.request('username', dto, request);
  }
  @Public()
  @Post('recovery/password')
  @HttpCode(202)
  recoverPassword(@Body() dto: RecoveryRequestDto, @Req() request: Request) {
    return this.recovery.request('password', dto, request);
  }
  @Public()
  @Post('recovery/password/confirm')
  @HttpCode(204)
  resetPassword(@Body() dto: ResetPasswordDto, @Req() request: Request) {
    return this.recovery.reset(dto, request);
  }
  @Post('password/change')
  @HttpCode(204)
  changePassword(
    @CurrentUser() user: SessionUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.settings.changePassword(user.id, dto, request, response);
  }
  @Post('email-change/request')
  @HttpCode(202)
  requestEmailChange(
    @CurrentUser() user: SessionUser,
    @Body() dto: RequestEmailChangeDto,
    @Req() request: Request
  ) {
    return this.settings.requestEmail(user.id, dto, request);
  }
  @Post('email-change/confirm')
  @HttpCode(204)
  confirmEmailChange(
    @CurrentUser() user: SessionUser,
    @Body() dto: ConfirmEmailDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.settings.confirmEmail(user.id, dto.token, request, response);
  }
  @Patch('profile')
  profile(@CurrentUser() user: SessionUser, @Body() dto: UpdateProfileDto) {
    return this.recovery.profile(user.id, dto.displayName);
  }
  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return { user };
  }
  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return this.service.logout(request, response);
  }
  @Post('email-verification/request')
  @HttpCode(202)
  requestVerification(@CurrentUser() user: SessionUser) {
    return this.service.requestVerification(user);
  }
  @Post('email-verification/confirm')
  @HttpCode(200)
  confirmVerification(
    @CurrentUser() user: SessionUser,
    @Body() dto: ConfirmEmailDto
  ) {
    return this.service.confirmVerification(user, dto.token);
  }
}
