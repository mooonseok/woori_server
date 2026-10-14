import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

// Call only while holding the parent group FOR UPDATE lock. Publication and
// reservation use the same lock, so quota is released exactly once.
export async function markPhotosDeleted(
  tx: Prisma.TransactionClient,
  groupId: string,
  scope: { albumId: string; id?: string },
) {
  const now = new Date();
  const photos = await tx.photo.findMany({
    where: { groupId, ...scope, deletedAt: null },
    select: {
      id: true, status: true, bytes: true, stagingKey: true,
      uploadExpiresAt: true, processingUntil: true,
      variants: { select: { objectKey: true } },
    },
  });
  if (!photos.length) return;
  await tx.mediaCleanupJob.createMany({
    data: photos.map((photo) => ({
      id: randomUUID(), photoId: photo.id,
      objectKeys: [
        ...photo.variants.map((variant) => variant.objectKey),
        ...(photo.stagingKey ? [photo.stagingKey] : []),
      ],
      // A signed PUT remains usable after logical deletion. Sweep after its
      // expiry, plus a margin for requests already in flight.
      availableAt: new Date(Math.max(
        now.getTime(),
        photo.uploadExpiresAt ? photo.uploadExpiresAt.getTime() + 15 * 60_000 : 0,
        photo.processingUntil ? photo.processingUntil.getTime() + 5 * 60_000 : 0,
      )),
    })),
    skipDuplicates: true,
  });
  const bytes = photos.reduce((sum, photo) => sum + (photo.status === "READY" ? photo.bytes : 0n), 0n);
  await tx.photo.updateMany({
    where: { groupId, ...scope, deletedAt: null },
    data: { deletedAt: now, status: "DELETING", reservedBytes: 0n, processingToken: null, processingUntil: null },
  });
  if (bytes > 0n) await tx.group.update({ where: { id: groupId }, data: { usedBytes: { decrement: bytes } } });
}
