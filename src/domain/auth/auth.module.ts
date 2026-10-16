import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionRepository } from './account-deletion.repository';
import { AccountSettingsRepository } from './account-settings.repository';
import { AccountSettingsService } from './account-settings.service';
import { RecoveryRepository } from './recovery.repository';
import { RecoveryService } from './recovery.service';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { MailModule } from '../mail/mail.module';
@Module({
  imports: [PrismaModule, MailModule],
  controllers: [AuthController],
  providers: [
    AccountDeletionRepository,
    AccountDeletionService,
    AccountSettingsRepository,
    AccountSettingsService,
    AuthService,
    AuthRepository,
    AuthRateLimitService,
    RecoveryRepository,
    RecoveryService,
  ],
  exports: [AuthService, AuthRateLimitService, AccountDeletionRepository],
})
export class AuthModule {}
