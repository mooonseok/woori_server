import { Prisma } from '@prisma/client';
import { notBlockedBySql } from '../blocks/block-visibility';

// Read access to a READY photo for a current active member of its active group,
// shared by photo interactions and reports. Match media deletion's
// group -> membership/user -> album -> photo lock order. Shared locks hold access
// valid until reads/writes commit, including direct revocation.
// Returns null when the photo is missing or not visible to this user, including
// a photo whose uploader this user blocked (personal block, viewer-only).
export async function lockReadablePhoto(
  tx: Prisma.TransactionClient,
  photoId: string,
  userId: string
) {
  const photo = await tx.photo.findUnique({
    where: { id: photoId },
    select: { groupId: true, albumId: true, uploaderId: true },
  });
  if (!photo) return null;
  const groups = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM woori.groups WHERE id=${photo.groupId}::uuid AND status='ACTIVE' FOR SHARE`;
  if (!groups.length) return null;
  const members = await tx.$queryRaw<
    { role: string }[]
  >`SELECT m.role FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${photo.groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,u`;
  if (!members.length) return null;
  const albums = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM woori.albums WHERE id=${photo.albumId}::uuid AND "groupId"=${photo.groupId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
  if (!albums.length) return null;
  const photos = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT p.id FROM woori.photos p WHERE p.id=${photoId}::uuid AND p."groupId"=${photo.groupId}::uuid AND p."albumId"=${photo.albumId}::uuid AND p.status='READY' AND p."deletedAt" IS NULL AND ${notBlockedBySql(userId, Prisma.sql`p."uploaderId"`)} FOR SHARE OF p`
  );
  if (!photos.length) return null;
  return {
    groupId: photo.groupId,
    albumId: photo.albumId,
    uploaderId: photo.uploaderId,
    owner: members[0].role === 'OWNER',
  };
}
