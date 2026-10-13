import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { AuthService } from './auth.service';
import { ConfirmEmailDto, LoginDto, SignupDto } from './dto/auth.dto';
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}
  @Public() @Post('signup')
  signup(@Body() dto: SignupDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) { return this.service.signup(dto, request, response); }
  @Public() @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) { return this.service.login(dto, request, response); }
  @Get('me')
  me(@CurrentUser() user: SessionUser) { return { user }; }
  @Public() @Post('logout') @HttpCode(204)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) { return this.service.logout(request, response); }
  @Post('email-verification/request') @HttpCode(202)
  requestVerification(@CurrentUser() user: SessionUser) { return this.service.requestVerification(user); }
  @Post('email-verification/confirm') @HttpCode(200)
  confirmVerification(@CurrentUser() user: SessionUser, @Body() dto: ConfirmEmailDto) { return this.service.confirmVerification(user, dto.token); }
}
