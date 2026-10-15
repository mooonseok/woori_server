import { Injectable } from '@nestjs/common';
import { GroupCleanupRepository } from './group-cleanup.repository';

@Injectable()
export class GroupCleanupService {
  constructor(private readonly repository: GroupCleanupRepository) {}

  async runBatch(limit = 10): Promise<{
    groups: number;
    photos: number;
    albums: number;
    completed: number;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid group cleanup batch size');
    const result = { groups: 0, photos: 0, albums: 0, completed: 0 };
    const seen: string[] = [];
    for (let index = 0; index < limit; index++) {
      const progress = await this.repository.progress(seen);
      if (!progress) break;
      seen.push(progress.groupId);
      result.groups++;
      result.photos += progress.photos;
      result.albums += progress.albums;
      result.completed += Number(progress.completed);
    }
    return result;
  }
}
