// W07 upload/reaction notification bundling policy (user-confirmed 2026-10-16).
// Pure rules only; notification-events.ts applies them inside the domain
// transaction and the inbox/push queries read the result.
export type BundledKind = 'PHOTOS' | 'REACTION';
export type NotificationNavigation = 'ALBUM' | 'PHOTO' | 'COMMENT';

const MINUTE = 60_000;
// PHOTOS: same uploader + same album, 10 minutes from the bundle's FIRST photo,
// first push about 2 minutes after it. REACTION: same photo (the uploader is the
// only recipient), 30 minutes from the first reaction, push after 1 minute.
export const BUNDLE_POLICIES = {
  PHOTOS: { windowMs: 10 * MINUTE, pushDelayMs: 2 * MINUTE },
  REACTION: { windowMs: 30 * MINUTE, pushDelayMs: MINUTE },
} as const satisfies Record<
  BundledKind,
  { windowMs: number; pushDelayMs: number }
>;

export function isBundledKind(kind: string): kind is BundledKind {
  return kind === 'PHOTOS' || kind === 'REACTION';
}

// One key per recipient-independent bundle identity. It also names the
// transaction-scoped advisory lock that serializes every writer of the bundle.
export function bundleKey(
  kind: BundledKind,
  ids: { albumId: string; actorId: string; photoId: string }
) {
  return kind === 'PHOTOS'
    ? `PHOTOS:${ids.albumId}:${ids.actorId}`
    : `REACTION:${ids.photoId}`;
}

// Times are on the app clock: the same clock writes bundleUntil/nextAttemptAt
// and compares them (never mixed with PostgreSQL now()).
export function openBundle(kind: BundledKind, at: Date) {
  const policy = BUNDLE_POLICIES[kind];
  return {
    bundleUntil: new Date(at.getTime() + policy.windowMs),
    pushAt: new Date(at.getTime() + policy.pushDelayMs),
  };
}

// The window is anchored on the first activity and never extended by later
// ones: an activity joins only while at < bundleUntil (end exclusive).
export function acceptsActivity(bundle: { bundleUntil: Date }, at: Date) {
  return at.getTime() < bundle.bundleUntil.getTime();
}

// A later activity schedules one follow-up push (same tag, replaces the OS
// notification) only when no push of this bundle is still waiting to fan out.
export function followUpPushAt(kind: BundledKind, at: Date) {
  return new Date(at.getTime() + BUNDLE_POLICIES[kind].pushDelayMs);
}

// The activity sequence a push outbox event was queued for (legacy events: 1);
// it keeps each push's delivery key distinct within one bundle.
export function pushSequence(payload: unknown) {
  const value = (payload as { sequence?: unknown } | null)?.sequence;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : 1;
}

export function navigationFor(kind: string): NotificationNavigation {
  return kind === 'PHOTOS'
    ? 'ALBUM'
    : kind === 'REACTION'
      ? 'PHOTO'
      : 'COMMENT';
}

// Observed reads never move backwards and never exceed what was allocated.
export function readThroughAfter(
  current: number,
  observed: number,
  lastSequence: number
) {
  if (!Number.isInteger(observed) || observed < 1 || observed > lastSequence)
    throw new RangeError('Observed sequence was never allocated');
  return Math.max(current, observed);
}

export function isUnread(readThroughSequence: number, latestSequence: number) {
  return readThroughSequence < latestSequence;
}

// "사진 N장" / "동영상 N개" / "사진·동영상 N개" for an upload bundle (W07-3:
// a video counts as one item of the bundle).
export function mediaCountText(count: number, videoCount: number) {
  const total = Math.max(1, count);
  const videos = Math.min(Math.max(0, videoCount), total);
  if (videos === 0) return `사진 ${total}장`;
  if (videos === total) return `동영상 ${total}개`;
  return `사진·동영상 ${total}개`;
}

// 을/를 by the final syllable's batchim ("5장을", "3개를").
export function withObjectParticle(text: string) {
  const code = text.charCodeAt(text.length - 1) - 0xac00;
  const batchim = code >= 0 && code < 11172 && code % 28 !== 0;
  return `${text}${batchim ? '을' : '를'}`;
}

// Lock-screen text. Only with the preview setting on; otherwise generic. Never
// carries comment bodies, photo URLs or object keys.
export function pushBody(
  row: {
    kind: string;
    actorName: string;
    albumTitle: string;
    count: number;
    videoCount?: number;
    mediaKind?: string;
  },
  preview: boolean
) {
  if (!preview) return '새로운 소식이 있어요.';
  const count = Math.max(1, row.count);
  const media = row.mediaKind === 'VIDEO' ? '동영상' : '사진';
  switch (row.kind) {
    case 'PHOTOS':
      return `${row.actorName}님이 '${row.albumTitle}'에 ${withObjectParticle(mediaCountText(count, row.videoCount ?? 0))} 올렸어요.`;
    case 'REACTION':
      return count > 1
        ? `${row.actorName}님 외 ${count - 1}명이 내 ${media}에 반응했어요.`
        : `${row.actorName}님이 내 ${media}에 반응했어요.`;
    case 'COMMENT':
      return `${row.actorName}님이 내 ${media}에 댓글을 남겼어요.`;
    case 'PIN':
      return `${row.actorName}님이 내 ${media}에 위치 댓글을 남겼어요.`;
    default:
      return `${row.actorName}님이 새 소식이 있어요.`;
  }
}
