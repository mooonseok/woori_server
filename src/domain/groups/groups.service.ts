import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupsRepository } from './groups.repository';
@Injectable()
export class GroupsService {
  constructor(private readonly repository: GroupsRepository) {}
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
}
