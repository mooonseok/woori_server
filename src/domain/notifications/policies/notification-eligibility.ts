// Internal worker inputs only. Membership, session, role, target visibility and
// settings must be reloaded from trusted storage at each send/digest boundary.
export type NotificationKind = 'photos' | 'comment' | 'pin' | 'reaction' | 'join-request' | 'join-result' | 'memory';
export type PreferenceKey = 'photos' | 'comments' | 'reactions' | 'join' | 'memories';
export interface Activity { eventId: string; actorId: string; sequence: number }
export interface NotificationCandidate {
  id: string;
  groupId: string;
  targetId: string;
  kind: NotificationKind;
  activities: readonly Activity[];
  readThroughSequence: number;
}
export interface EligibilityContext {
  recipientId: string;
  activeAccount: boolean;
  activeInstallationSession: boolean;
  membershipGroupId: string;
  activeMembership: boolean;
  owner: boolean;
  intendedRecipient: boolean;
  targetAvailable: boolean;
  blockedActorIds: ReadonlySet<string>;
  visibleTargetId?: string;
  pushPermission: boolean;
  enabled: boolean;
  types: Readonly<Record<PreferenceKey, boolean>>;
  groupMode: 'default' | 'mine' | 'off';
  quiet: { enabled: boolean; startMinute: number; endMinute: number; currentLocalMinute: number };
}
const preferenceKey: Record<NotificationKind, PreferenceKey> = {
  photos: 'photos', comment: 'comments', pin: 'comments', reaction: 'reactions',
  'join-request': 'join', 'join-result': 'join', memory: 'memories',
};
export type Decision = { action: 'send' | 'hold' | 'suppress'; reason: string; actorIds: string[]; unreadEventIds: string[] };
export function visibleActivities(candidate: NotificationCandidate, context: EligibilityContext): Activity[] {
  const seen = new Set<string>();
  return candidate.activities.filter(activity => {
    if (seen.has(activity.eventId) || context.blockedActorIds.has(activity.actorId) || activity.actorId === context.recipientId) return false;
    seen.add(activity.eventId); return true;
  });
}
export function isQuietTime(quiet: EligibilityContext['quiet']): boolean {
  if (!quiet.enabled) return false;
  for (const minute of [quiet.startMinute, quiet.endMinute, quiet.currentLocalMinute]) {
    if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) throw new RangeError('Quiet time requires valid local minutes');
  }
  const { startMinute: start, endMinute: end, currentLocalMinute: now } = quiet;
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
export function evaluateNotification(candidate: NotificationCandidate, context: EligibilityContext): Decision {
  const deny = (reason: string): Decision => ({ action: 'suppress', reason, actorIds: [], unreadEventIds: [] });
  if (!context.activeAccount || !context.activeInstallationSession) return deny('inactive-session');
  if (!context.activeMembership || context.membershipGroupId !== candidate.groupId) return deny('not-a-member');
  if (!context.intendedRecipient) return deny('not-a-recipient');
  if (candidate.kind === 'join-request' && !context.owner) return deny('not-current-owner');
  if (!context.targetAvailable) return deny('target-unavailable');
  const unread = visibleActivities(candidate, context).filter(a => a.sequence > candidate.readThroughSequence);
  if (!unread.length) return deny('no-unread-visible-activity');
  if (context.visibleTargetId === candidate.targetId) return deny('already-visible');
  const key = preferenceKey[candidate.kind];
  if (!context.enabled || !context.types[key]) return deny('type-disabled');
  if (context.groupMode === 'off') return deny('group-disabled');
  if (context.groupMode === 'mine' && key !== 'comments' && key !== 'reactions') return deny('group-comments-reactions-only');
  if (!context.pushPermission) return deny('permission-denied');
  return {
    action: isQuietTime(context.quiet) ? 'hold' : 'send', reason: 'eligible',
    actorIds: [...new Set(unread.map(a => a.actorId))], unreadEventIds: unread.map(a => a.eventId),
  };
}
// Uses the SAME evaluator as immediate and reaction-bundle delivery. Call after
// quiet time ends; if still quiet it holds again rather than bypassing settings.
export function evaluateDigest(candidates: readonly NotificationCandidate[], contextFor: (candidate: NotificationCandidate) => EligibilityContext) {
  const unique = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return [...unique.values()].map(candidate => ({ id: candidate.id, decision: evaluateNotification(candidate, contextFor(candidate)) }));
}
