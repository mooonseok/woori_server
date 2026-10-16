import { Injectable } from '@nestjs/common';
import { AlbumsRepository } from './albums.repository';
@Injectable()
export class AlbumsService {
  constructor(private readonly repository: AlbumsRepository) {}
  async create(groupId: string, userId: string, title: string) {
    return { album: await this.repository.create(groupId, userId, title) };
  }
  list(groupId: string, userId: string, limit: number, cursor?: unknown) {
    return this.repository.list(groupId, userId, limit, cursor);
  }
  async rename(
    groupId: string,
    albumId: string,
    userId: string,
    title: string
  ) {
    return {
      album: await this.repository.rename(groupId, albumId, userId, title),
    };
  }
  remove(groupId: string, albumId: string, userId: string) {
    return this.repository.remove(groupId, albumId, userId);
  }
}
