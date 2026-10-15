import { PrismaService } from '../../common/modules/prisma/prisma.service';
import type { ReconciliationReader } from '../../common/media/media-reconciliation';
const select = {
  id: true,
  status: true,
  deletedAt: true,
  stagingKey: true,
  uploadExpiresAt: true,
  processingUntil: true,
  variants: {
    select: { objectKey: true, bytes: true },
    orderBy: { objectKey: 'asc' as const },
  },
} as const;
export class PhotoReconciliationRepository implements ReconciliationReader {
  constructor(private readonly prisma: PrismaService) {}
  page(limit: number, after?: string) {
    return this.prisma.client.photo.findMany({
      where: after ? { id: { gt: after } } : {},
      orderBy: { id: 'asc' },
      take: limit,
      select,
    });
  }
  current(id: string) {
    return this.prisma.client.photo.findUnique({ where: { id }, select });
  }
}
