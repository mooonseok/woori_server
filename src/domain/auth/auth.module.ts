import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { MailService } from './mail.service';
@Module({ imports: [PrismaModule], controllers: [AuthController], providers: [AuthService, AuthRepository, AuthRateLimitService, MailService], exports: [AuthService, AuthRateLimitService] })
export class AuthModule {}
