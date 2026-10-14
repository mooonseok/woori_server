import { PushModule } from './domain/push/push.module';
import { NotificationsModule } from './domain/notifications/notifications.module';
import { AuthModule } from './domain/auth/auth.module';
import { InvitationsModule } from './domain/invitations/invitations.module';
import { OriginGuard } from './common/guards/origin.guard';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { SessionGuard } from './common/guards/session.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaModule } from './common/modules/prisma/prisma.module';
import { HealthModule } from './domain/health/health.module';
import { GroupsModule } from './domain/groups/groups.module';
import { PhotosModule } from './domain/photos/photos.module';
import { AlbumsModule } from './domain/albums/albums.module';
import { PrivateApiController } from './domain/private-api.controller';
@Module({
  imports: [
    PushModule,
    AuthModule,
    InvitationsModule,
    PrismaModule,
    HealthModule,
    GroupsModule,
    AlbumsModule,
    PhotosModule,
    NotificationsModule,
    AdminModule,
  ],
  controllers: [PrivateApiController],
  providers: [
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
