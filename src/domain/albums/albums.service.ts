import { Injectable, NotFoundException } from '@nestjs/common';
import { AlbumsRepository } from './albums.repository';
@Injectable()
export class AlbumsService {
 constructor(private readonly repository: AlbumsRepository) {}
 async list(groupId: string, userId: string) {
  const membership = await this.repository.hasMember(groupId, userId);
  if (!membership) throw new NotFoundException({code:'GROUP_NOT_FOUND',message:'그룹을 찾을 수 없어요.'});
  return {albums: await this.repository.findActiveForMember(groupId,userId)};
 }
}
