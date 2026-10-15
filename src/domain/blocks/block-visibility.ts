import { Prisma } from '@prisma/client';

// Personal blocks ("나에게만 숨김") are one-directional: photos, comments,
// reactions and notification activity of a user the viewer blocked are hidden
// from the viewer only. Memberships, roles and the blocked user's own view never
// change. Every read path uses one of these forms of the same predicate (backed by
// the user_blocks primary key) so a list and its count cannot drift.

// Prisma relation filter on a User relation (uploader / author / actor).
export function notBlockedBy(viewerId: string) {
  return {
    blockedBy: { none: { blockerId: viewerId } },
  } satisfies Prisma.UserWhereInput;
}
// Prisma relation filter for recipients: the user has not blocked `actorId`.
export function notBlocking(actorId: string) {
  return {
    blocks: { none: { blockedId: actorId } },
  } satisfies Prisma.UserWhereInput;
}
// SQL form. `userColumn` must be a trusted column reference such as
// Prisma.sql`p."uploaderId"`; the viewer id is always a bound parameter.
export function notBlockedBySql(viewerId: string, userColumn: Prisma.Sql) {
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM woori.user_blocks ub WHERE ub."blockerId"=${viewerId}::uuid AND ub."blockedId"=${userColumn})`;
}
// READY, non-deleted photos whose uploader the viewer has not blocked.
export function visiblePhotoWhere(viewerId: string) {
  return {
    status: 'READY' as const,
    deletedAt: null,
    uploader: notBlockedBy(viewerId),
  } satisfies Prisma.PhotoWhereInput;
}
