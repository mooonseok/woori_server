import { Injectable } from '@nestjs/common';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { MemoriesRepository } from './memories.repository';
import { parseManualDate } from './memory-date';
import type { MemoriesQueryDto } from './dto/memories.dto';
@Injectable()
export class MemoriesService {
  constructor(
    private readonly repository: MemoriesRepository,
    private readonly rate: AuthRateLimitService
  ) {}
  list(groupId: string, userId: string, q: MemoriesQueryDto) {
    return this.repository.list(groupId, userId, q);
  }
  async captureDate(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    date: string | null
  ) {
    const value = date === null ? null : parseManualDate(date);
    await this.rate.consume(`memory-write:${userId}`, 100);
    return this.repository.captureDate(
      groupId,
      albumId,
      photoId,
      userId,
      value
    );
  }
  async setHidden(
    groupId: string,
    photoId: string,
    userId: string,
    hidden: boolean
  ) {
    await this.rate.consume(`memory-write:${userId}`, 100);
    return this.repository.setHidden(groupId, photoId, userId, hidden);
  }
}
