import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { PushTransport } from '../../common/push/push-transport';
import { PushDispatchRepository } from '../../worker/push/push-dispatch.repository';
import { PushDispatchService } from '../../worker/push/push-dispatch.service';
import { AuthModule } from '../auth/auth.module';
import { PushController } from './push.controller';
import { PushRepository } from './push.repository';
import { PushService } from './push.service';
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PushController],
  providers: [
    PushRepository,
    PushService,
    PushTransport,
    PushDispatchRepository,
    PushDispatchService,
  ],
  exports: [PushDispatchService],
})
export class PushModule {}
