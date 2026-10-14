import { Injectable } from '@nestjs/common';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { NotificationsRepository } from './notifications.repository';
import type {
  ObservedNotificationDto,
  UpdateGroupPreferenceDto,
  UpdatePreferencesDto,
} from './dto/notifications.dto';
@Injectable()
export class NotificationsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly rateLimit: AuthRateLimitService
  ) {}
  list(userId: string, limit: number, cursor?: string) {
    return this.repository.list(userId, limit, cursor);
  }
  target(userId: string, id: string) {
    return this.repository.target(userId, id);
  }
  async read(userId: string, items: ObservedNotificationDto[]) {
    await this.rateLimit.consume(`notification-read:${userId}`, 300);
    return this.repository.read(userId, items);
  }
  preferences(userId: string) {
    return this.repository.preferences(userId);
  }
  async update(userId: string, dto: UpdatePreferencesDto) {
    await this.rateLimit.consume(`notification-settings:${userId}`, 120);
    return this.repository.updatePreferences(userId, dto);
  }
  async group(userId: string, groupId: string, dto: UpdateGroupPreferenceDto) {
    await this.rateLimit.consume(`notification-settings:${userId}`, 120);
    return this.repository.updatePreferences(
      userId,
      { version: dto.version },
      { id: groupId, mode: dto.mode }
    );
  }
}
