import { Injectable } from '@nestjs/common';
import { AdminUsersRepository } from './admin-users.repository';
import type {
  AdminUserListDto,
  DeleteAdminUserDto,
  RenameAdminUserDto,
} from './dto/admin-members.dto';
@Injectable()
export class AdminUsersService {
  constructor(private readonly repository: AdminUsersRepository) {}
  list(query: AdminUserListDto) {
    return this.repository.list(
      query.limit,
      { query: query.query, status: query.status },
      query.cursor
    );
  }
  view(adminId: string, userId: string) {
    return this.repository.view(adminId, userId);
  }
  rename(adminId: string, userId: string, dto: RenameAdminUserDto) {
    return this.repository.rename(adminId, userId, dto.displayName, dto.reason);
  }
  suspend(adminId: string, userId: string, reason: string) {
    return this.repository.suspend(adminId, userId, reason);
  }
  unsuspend(adminId: string, userId: string, reason: string) {
    return this.repository.unsuspend(adminId, userId, reason);
  }
  delete(adminId: string, userId: string, dto: DeleteAdminUserDto) {
    return this.repository.delete(
      adminId,
      userId,
      dto.reason,
      dto.confirmUsername
    );
  }
}
