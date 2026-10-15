import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupsRepository } from './groups.repository';
import { GroupManagementRepository } from './group-management.repository';
@Injectable()
export class GroupsService {
  constructor(
    private readonly repository: GroupsRepository,
    private readonly management: GroupManagementRepository
  ) {}
  async list(userId: string) {
    return { groups: await this.repository.list(userId) };
  }
  async get(groupId: string, userId: string) {
    const group = await this.repository.findForMember(groupId, userId);
    if (!group)
      throw new NotFoundException({
        code: 'GROUP_NOT_FOUND',
        message: '그룹을 찾을 수 없어요.',
      });
    return { group };
  }
  async create(name: string, user: { id: string; emailVerified: boolean }) {
    if (!user.emailVerified)
      throw new ForbiddenException({
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: '이메일 인증 후 그룹을 만들 수 있어요.',
      });
    return { group: await this.repository.create(name, user.id) };
  }
  members(groupId: string, userId: string, limit: number, after?: string) {
    return this.management.members(groupId, userId, limit, after);
  }
  rename(groupId: string, userId: string, name: string) {
    return this.management.rename(groupId, userId, name);
  }
  leave(groupId: string, userId: string) {
    return this.management.leave(groupId, userId);
  }
  remove(groupId: string, userId: string, targetId: string) {
    return this.management.remove(groupId, userId, targetId);
  }
  transfer(groupId: string, userId: string, targetId: string) {
    return this.management.transfer(groupId, userId, targetId);
  }
  delete(groupId: string, userId: string, name: string) {
    return this.management.delete(groupId, userId, name);
  }
}
