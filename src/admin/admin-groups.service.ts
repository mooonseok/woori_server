import { Injectable } from '@nestjs/common';
import { AdminGroupsRepository } from './admin-groups.repository';
import type {
  AdminAlbumPhotoListDto,
  AdminGroupListDto,
} from './dto/admin-members.dto';
// Read-only in this slice: no admin group mutations.
@Injectable()
export class AdminGroupsService {
  constructor(private readonly repository: AdminGroupsRepository) {}
  list(query: AdminGroupListDto) {
    return this.repository.list(
      query.limit,
      { query: query.query, status: query.status },
      query.cursor
    );
  }
  view(adminId: string, groupId: string) {
    return this.repository.view(adminId, groupId);
  }
  albumPhotos(
    adminId: string,
    groupId: string,
    albumId: string,
    query: AdminAlbumPhotoListDto
  ) {
    return this.repository.albumPhotos(
      adminId,
      groupId,
      albumId,
      query.limit,
      query.cursor
    );
  }
}
