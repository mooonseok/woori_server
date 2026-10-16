import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { notBlockedBySql } from '../blocks/block-visibility';
import type {
  ObservedNotificationDto,
  UpdateGroupPreferenceDto,
  UpdatePreferencesDto,
} from './dto/notifications.dto';
export function notificationNotFound(): never {
  throw new NotFoundException({
    code: 'NOTIFICATION_NOT_FOUND',
    message: '알림을 찾을 수 없거나 더 이상 접근할 수 없어요.',
  });
}
export function validateQuietPreferences(p: {
  timeZone: string;
  quietEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
}) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: p.timeZone }).format();
  } catch {
    throw new BadRequestException({
      code: 'INVALID_TIME_ZONE',
      message: '올바른 시간대를 선택해 주세요.',
    });
  }
  if (p.quietEnabled && p.quietStartMinute === p.quietEndMinute)
    throw new BadRequestException({
      code: 'INVALID_QUIET_HOURS',
      message: '방해 금지 시작과 종료 시간을 다르게 설정해 주세요.',
    });
}
// Shared by inbox list, unread count, /target, read, read-all and web push
// eligibility/display: activity by an actor the recipient blocked is never shown,
// and a target photo whose uploader the recipient blocked is invisible (the same
// predicate as MediaPhoto reads). The recipient must be ACTIVE; an actor follows
// the group roster (ACTIVE or SUSPENDED stays visible, withdrawn is hidden).
export function visible(userId: string) {
  return Prisma.sql`SELECT n.id,n.kind,n."groupId",g.name AS "groupName",p."albumId",a.title AS "albumTitle",p.id AS "photoId",p."uploaderId",c.id AS "commentId",n."createdAt",n."readThroughSequence",act.sequence AS "latestSequence",u.id AS "actorId",u."displayName" AS "actorName"
    FROM woori.notifications n
    JOIN woori.groups g ON g.id=n."groupId" AND g.status='ACTIVE'
    JOIN woori.memberships m ON m."groupId"=g.id AND m."userId"=${userId}::uuid AND m.status='ACTIVE'
    JOIN woori.users recipient ON recipient.id=m."userId" AND recipient.status='ACTIVE'
    JOIN woori.notification_activities act ON act."notificationId"=n.id AND act.sequence=1
    JOIN woori.users u ON u.id=act."actorId" AND u.status IN ('ACTIVE','SUSPENDED')
    LEFT JOIN woori.comments c ON n.kind IN ('COMMENT','PIN') AND c.id=n."targetId" AND c."groupId"=g.id AND c."deletedAt" IS NULL
    JOIN woori.photos p ON p.id=CASE WHEN n.kind IN ('COMMENT','PIN') THEN c."photoId" ELSE n."targetId" END AND p."groupId"=g.id AND p.status='READY' AND p."deletedAt" IS NULL
    JOIN woori.albums a ON a.id=p."albumId" AND a."groupId"=g.id AND a."deletedAt" IS NULL
    WHERE n."recipientId"=${userId}::uuid AND act."actorId"<>${userId}::uuid
      AND ${notBlockedBySql(userId, Prisma.sql`act."actorId"`)}
      AND ${notBlockedBySql(userId, Prisma.sql`p."uploaderId"`)}
      AND n.kind IN ('PHOTOS','COMMENT','PIN','REACTION')
      AND (n.kind<>'REACTION' OR EXISTS(SELECT 1 FROM woori.reactions r WHERE r."photoId"=p.id AND r."userId"=act."actorId"))`;
}
export type InboxRow = {
  id: string;
  kind: string;
  groupId: string;
  groupName: string;
  albumId: string;
  albumTitle: string;
  photoId: string;
  uploaderId: string;
  commentId: string | null;
  createdAt: Date;
  readThroughSequence: number;
  latestSequence: number;
  actorId: string;
  actorName: string;
};
const defaults = {
  enabled: true,
  photos: true,
  comments: true,
  reactions: true,
  join: true,
  memories: false,
  preview: false,
  quietEnabled: false,
  quietStartMinute: 1320,
  quietEndMinute: 480,
  timeZone: 'Asia/Seoul',
  version: 0,
};
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async list(userId: string, limit: number, cursor?: string) {
    return this.prisma.client.$transaction(
      async (tx) => {
        if (
          cursor &&
          !(await tx.notification.findFirst({
            where: { id: cursor, recipientId: userId },
            select: { id: true },
          }))
        )
          notificationNotFound();
        const after = cursor
          ? Prisma.sql`AND (v."createdAt",v.id)<(SELECT "createdAt",id FROM woori.notifications WHERE id=${cursor}::uuid AND "recipientId"=${userId}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<InboxRow[]>(
          Prisma.sql`WITH visible AS (${visible(userId)}) SELECT * FROM visible v WHERE true ${after} ORDER BY v."createdAt" DESC,v.id DESC LIMIT ${limit + 1}`
        );
        const counts = await tx.$queryRaw<{ count: bigint }[]>(
          Prisma.sql`WITH visible AS (${visible(userId)}) SELECT COUNT(*) AS count FROM visible WHERE "readThroughSequence"<"latestSequence"`
        );
        const more = rows.length > limit;
        if (more) rows.pop();
        return {
          // The inbox item shape is unchanged; uploaderId is only used by /target.
          notifications: rows.map(
            ({ actorId, actorName, uploaderId: _, ...row }) => ({
              ...row,
              actor: { id: actorId, displayName: actorName },
              unread: row.readThroughSequence < row.latestSequence,
            })
          ),
          nextCursor: more ? rows.at(-1)!.id : null,
          unreadCount: Number(counts[0].count),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  async target(userId: string, id: string) {
    const rows = await this.prisma.client.$queryRaw<
      (InboxRow & { uploaderName: string })[]
    >(
      Prisma.sql`WITH visible AS (${visible(userId)}) SELECT v.*,pu."displayName" AS "uploaderName" FROM visible v JOIN woori.users pu ON pu.id=v."uploaderId" WHERE v.id=${id}::uuid`
    );
    if (!rows.length) notificationNotFound();
    const { groupId, albumId, photoId, commentId, latestSequence } = rows[0];
    // The target photo's uploader lets the viewer report or block from here.
    const uploader = {
      id: rows[0].uploaderId,
      displayName: rows[0].uploaderName,
    };
    return { groupId, albumId, photoId, commentId, latestSequence, uploader };
  }
  async read(userId: string, items: ObservedNotificationDto[]) {
    const ids = [...new Set(items.map((i) => i.id))];
    return this.prisma.client.$transaction(async (tx) => {
      // A single statement validates every submitted recipient/target and changes
      // only the observed sequence. Concurrent new arrivals cannot be consumed.
      const changed = await tx.$queryRaw<
        { id: string; readThroughSequence: number }[]
      >(Prisma.sql`
        WITH visible AS (${visible(userId)}), eligible AS (SELECT id FROM visible WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}))
        UPDATE woori.notifications n SET "readThroughSequence"=GREATEST(n."readThroughSequence",1)
        WHERE n.id IN (SELECT id FROM eligible) AND (SELECT COUNT(*) FROM eligible)=${ids.length}
        RETURNING n.id,n."readThroughSequence"`);
      if (changed.length !== ids.length) notificationNotFound();
      return changed;
    });
  }
  private async preferencesIn(tx: Prisma.TransactionClient, userId: string) {
    const stored = await tx.notificationPreference.findUnique({
      where: { userId },
    });
    const members = await tx.membership.findMany({
      where: { userId, status: 'ACTIVE', group: { status: 'ACTIVE' } },
      select: { groupId: true, group: { select: { name: true } } },
      orderBy: { groupId: 'asc' },
    });
    const overrides = await tx.groupNotificationPreference.findMany({
      where: { userId, groupId: { in: members.map((m) => m.groupId) } },
    });
    const preferences = stored
      ? Object.fromEntries(
          Object.entries(stored).filter(([key]) => key !== 'userId')
        )
      : defaults;
    return {
      preferences,
      groups: members.map((m) => ({
        groupId: m.groupId,
        groupName: m.group.name,
        mode: overrides.find((p) => p.groupId === m.groupId)?.mode ?? 'DEFAULT',
      })),
    };
  }
  preferences(userId: string) {
    return this.prisma.client.$transaction(
      (tx) => this.preferencesIn(tx, userId),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
    group?: { id: string; mode: UpdateGroupPreferenceDto['mode'] }
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      if (group) {
        const groups = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM woori.groups WHERE id=${group.id}::uuid AND status='ACTIVE' FOR SHARE`;
        const members = await tx.$queryRaw<
          { groupId: string }[]
        >`SELECT "groupId" FROM woori.memberships WHERE "groupId"=${group.id}::uuid AND "userId"=${userId}::uuid AND status='ACTIVE' FOR SHARE`;
        if (!groups.length || !members.length) notificationNotFound();
      }
      // Lock the account before the first preference insert as well, avoiding
      // concurrent first-write upserts bypassing the version check.
      const accounts = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`;
      if (!accounts.length) notificationNotFound();
      const current =
        (await tx.notificationPreference.findUnique({ where: { userId } })) ??
        defaults;
      if (current.version !== dto.version)
        throw new ConflictException({
          code: 'PREFERENCES_CONFLICT',
          message:
            '다른 화면에서 설정이 변경됐어요. 새로 불러온 뒤 다시 설정해 주세요.',
        });
      const { version, ...patch } = dto;
      validateQuietPreferences({ ...current, ...patch });
      await tx.notificationPreference.upsert({
        where: { userId },
        create: { userId, ...patch, version: version + 1 },
        update: { ...patch, version: version + 1 },
      });
      if (group)
        await tx.groupNotificationPreference.upsert({
          where: { userId_groupId: { userId, groupId: group.id } },
          create: { userId, groupId: group.id, mode: group.mode },
          update: { mode: group.mode },
        });
      return this.preferencesIn(tx, userId);
    });
  }
}
