import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { notBlockedBySql } from '../blocks/block-visibility';
import {
  isUnread,
  navigationFor,
  readThroughAfter,
} from './notification-bundles';
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
// W07 bundles: one row per notification aggregating only its VISIBLE activities
// (PHOTOS: each activity's own photo; REACTION: reactors whose reaction still
// exists). count = visible photos (PHOTOS) / reactors (REACTION) / 1; the latest
// visible activity gives latestSequence, latestAt, actor and photo. A bundle with
// no visible activity left is not returned at all (no stale counts).
export function visible(userId: string) {
  return Prisma.sql`SELECT n.id,n.kind,n."groupId",g.name AS "groupName",latest."albumId",latest."albumTitle",latest."photoId",latest."uploaderId",latest."commentId",n."createdAt",n."readThroughSequence",n."lastSequence",latest.sequence AS "latestSequence",latest."createdAt" AS "latestAt",latest.count::int AS count,latest."videoCount"::int AS "videoCount",latest."mediaKind",latest."actorId",latest."actorName"
    FROM woori.notifications n
    JOIN woori.groups g ON g.id=n."groupId" AND g.status='ACTIVE'
    JOIN woori.memberships m ON m."groupId"=g.id AND m."userId"=${userId}::uuid AND m.status='ACTIVE'
    JOIN woori.users recipient ON recipient.id=m."userId" AND recipient.status='ACTIVE'
    JOIN LATERAL (
      SELECT va.*,COUNT(*) OVER () AS count,COUNT(*) FILTER (WHERE va."mediaKind"='VIDEO') OVER () AS "videoCount" FROM (
        SELECT act.sequence,act."createdAt",u.id AS "actorId",u.nickname AS "actorName",p.id AS "photoId",p."uploaderId",p."mediaKind"::text AS "mediaKind",a.id AS "albumId",a.title AS "albumTitle",c.id AS "commentId"
        FROM woori.notification_activities act
        JOIN woori.users u ON u.id=act."actorId" AND u.status IN ('ACTIVE','SUSPENDED')
        LEFT JOIN woori.comments c ON n.kind IN ('COMMENT','PIN') AND c.id=n."targetId" AND c."groupId"=g.id AND c."deletedAt" IS NULL
        JOIN woori.photos p ON p.id=CASE WHEN n.kind IN ('COMMENT','PIN') THEN c."photoId" WHEN n.kind='PHOTOS' THEN COALESCE(act."photoId",n."targetId") ELSE n."targetId" END AND p."groupId"=g.id AND p.status='READY' AND p."deletedAt" IS NULL
        JOIN woori.albums a ON a.id=p."albumId" AND a."groupId"=g.id AND a."deletedAt" IS NULL
        WHERE act."notificationId"=n.id AND act."actorId"<>${userId}::uuid
          AND ${notBlockedBySql(userId, Prisma.sql`act."actorId"`)}
          AND ${notBlockedBySql(userId, Prisma.sql`p."uploaderId"`)}
          AND (n.kind<>'REACTION' OR EXISTS(SELECT 1 FROM woori.reactions r WHERE r."photoId"=p.id AND r."userId"=act."actorId"))
      ) va ORDER BY va.sequence DESC LIMIT 1
    ) latest ON true
    WHERE n."recipientId"=${userId}::uuid
      AND n.kind IN ('PHOTOS','COMMENT','PIN','REACTION')`;
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
  lastSequence: number;
  latestSequence: number;
  latestAt: Date;
  count: number;
  // W07-3: videos among the visible media (PHOTOS bundles), and the kind of
  // photoId (the item's media).
  videoCount: number;
  mediaKind: string;
  actorId: string;
  actorName: string;
};
// Inbox item: the bundle's latest visible actor/photo plus its visible count.
// Internal columns (uploaderId, lastSequence) stay server-side.
export function inboxItem({
  actorId,
  actorName,
  uploaderId: _uploader,
  lastSequence: _last,
  ...row
}: InboxRow) {
  return {
    ...row,
    actor: { id: actorId, displayName: actorName, nickname: actorName },
    navigation: navigationFor(row.kind),
    unread: isUnread(row.readThroughSequence, row.latestSequence),
  };
}
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
        // Newest activity first: a bundle that gains a photo/reactor moves up.
        // A cursor no longer visible keeps its position by its raw latest
        // activity time (it still belongs to this recipient, checked above).
        const after = cursor
          ? Prisma.sql`AND (v."latestAt",v.id)<(SELECT COALESCE((SELECT x."latestAt" FROM visible x WHERE x.id=${cursor}::uuid),(SELECT MAX(a."createdAt") FROM woori.notification_activities a WHERE a."notificationId"=${cursor}::uuid),(SELECT "createdAt" FROM woori.notifications WHERE id=${cursor}::uuid)),${cursor}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<InboxRow[]>(
          Prisma.sql`WITH visible AS (${visible(userId)}) SELECT * FROM visible v WHERE true ${after} ORDER BY v."latestAt" DESC,v.id DESC LIMIT ${limit + 1}`
        );
        const counts = await tx.$queryRaw<{ count: bigint }[]>(
          Prisma.sql`WITH visible AS (${visible(userId)}) SELECT COUNT(*) AS count FROM visible WHERE "readThroughSequence"<"latestSequence"`
        );
        const more = rows.length > limit;
        if (more) rows.pop();
        return {
          notifications: rows.map(inboxItem),
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
      Prisma.sql`WITH visible AS (${visible(userId)}) SELECT v.*,pu.nickname AS "uploaderName" FROM visible v JOIN woori.users pu ON pu.id=v."uploaderId" WHERE v.id=${id}::uuid`
    );
    if (!rows.length) notificationNotFound();
    const {
      kind,
      groupId,
      albumId,
      photoId,
      commentId,
      latestSequence,
      mediaKind,
    } = rows[0];
    // The target photo's uploader lets the viewer report or block from here.
    // PHOTOS bundles navigate to the album; photoId is its latest visible photo
    // and mediaKind is that item's kind (never null: a target always has one).
    const uploader = {
      id: rows[0].uploaderId,
      displayName: rows[0].uploaderName,
      nickname: rows[0].uploaderName,
    };
    return {
      groupId,
      albumId,
      photoId,
      commentId,
      latestSequence,
      mediaKind,
      navigation: navigationFor(kind),
      uploader,
    };
  }
  async read(userId: string, items: ObservedNotificationDto[]) {
    // Duplicate ids keep the highest observed sequence.
    const observed = new Map<string, number>();
    for (const item of items)
      observed.set(
        item.id,
        Math.max(observed.get(item.id) ?? 0, item.throughSequence)
      );
    const values = Prisma.join(
      [...observed].map(
        ([id, through]) => Prisma.sql`(${id}::uuid,${through}::int)`
      )
    );
    return this.prisma.client.$transaction(async (tx) => {
      // Every submitted id must be a visible notification of this recipient
      // (404 otherwise, before any sequence check), and an observed sequence can
      // never exceed what was allocated (400). One statement then raises only the
      // observed sequence: activity arriving after the client looked stays unread.
      const eligible = await tx.$queryRaw<
        {
          id: string;
          through: number;
          readThroughSequence: number;
          lastSequence: number;
        }[]
      >(Prisma.sql`
        WITH visible AS (${visible(userId)}), observed(id,through) AS (VALUES ${values})
        SELECT v.id,o.through,v."readThroughSequence",v."lastSequence" FROM visible v JOIN observed o ON o.id=v.id`);
      if (eligible.length !== observed.size) notificationNotFound();
      try {
        for (const row of eligible)
          readThroughAfter(
            row.readThroughSequence,
            row.through,
            row.lastSequence
          );
      } catch {
        throw new BadRequestException({
          code: 'NOTIFICATION_SEQUENCE_INVALID',
          message: '확인한 알림 순서가 올바르지 않아요. 새로고침해 주세요.',
        });
      }
      const changed = await tx.$queryRaw<
        { id: string; readThroughSequence: number }[]
      >(Prisma.sql`
        WITH observed(id,through) AS (VALUES ${values})
        UPDATE woori.notifications n SET "readThroughSequence"=GREATEST(n."readThroughSequence",o.through)
        FROM observed o WHERE n.id=o.id AND n."recipientId"=${userId}::uuid
        RETURNING n.id,n."readThroughSequence"`);
      if (changed.length !== observed.size) notificationNotFound();
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
