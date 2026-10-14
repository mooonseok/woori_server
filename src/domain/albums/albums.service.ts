import { Injectable, NotFoundException } from "@nestjs/common";
import { AlbumsRepository } from "./albums.repository";
@Injectable()
export class AlbumsService {
  constructor(private readonly repository: AlbumsRepository) {}
  async create(groupId: string, userId: string, title: string) {
    return { album: await this.repository.create(groupId, userId, title) };
  }
  async list(groupId: string, userId: string) {
    const membership = await this.repository.hasMember(groupId, userId);
    if (!membership)
      throw new NotFoundException({
        code: "GROUP_NOT_FOUND",
        message: "그룹을 찾을 수 없어요.",
      });
    return {
      albums: (await this.repository.findActiveForMember(groupId, userId)).map(
        (album) => ({
          id: album.id,
          groupId: album.groupId,
          title: album.title,
          createdAt: album.createdAt,
          photoCount: album._count.photos,
          coverPhotoId: album.photos[0]?.id ?? null,
        }),
      ),
    };
  }
}
