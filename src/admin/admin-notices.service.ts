import { BadRequestException, Injectable } from '@nestjs/common';
import { publishAtError } from './admin-content-policy';
import { AdminNoticesRepository } from './admin-notices.repository';
import type {
  AdminNoticeListDto,
  CreateAdminNoticeDto,
  PublishAdminNoticeDto,
  UpdateAdminNoticeDto,
} from './dto/admin-content.dto';
@Injectable()
export class AdminNoticesService {
  constructor(private readonly repository: AdminNoticesRepository) {}
  list(query: AdminNoticeListDto) {
    return this.repository.list(query.limit, query.status, query.cursor);
  }
  detail(noticeId: string) {
    return this.repository.detail(noticeId);
  }
  create(adminId: string, dto: CreateAdminNoticeDto) {
    return this.repository.create(adminId, {
      title: dto.title,
      body: dto.body,
    });
  }
  update(adminId: string, noticeId: string, dto: UpdateAdminNoticeDto) {
    if (dto.title === undefined && dto.body === undefined)
      throw new BadRequestException({
        code: 'ADMIN_NOTICE_UPDATE_EMPTY',
        message: '수정할 제목이나 본문을 입력해 주세요.',
      });
    return this.repository.update(adminId, noticeId, {
      ...(dto.title === undefined ? {} : { title: dto.title }),
      ...(dto.body === undefined ? {} : { body: dto.body }),
    });
  }
  publish(adminId: string, noticeId: string, dto: PublishAdminNoticeDto) {
    const now = new Date();
    const publishedAt = dto.publishAt ? new Date(dto.publishAt) : now;
    if (publishAtError(publishedAt, now))
      throw new BadRequestException({
        code: 'ADMIN_NOTICE_PUBLISH_AT_INVALID',
        message: '게시 시각은 지금부터 90일 이내로 지정해 주세요.',
      });
    return this.repository.publish(adminId, noticeId, publishedAt);
  }
  archive(adminId: string, noticeId: string) {
    return this.repository.archive(adminId, noticeId);
  }
}
