import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNotification,
  evaluateDigest,
  isQuietTime,
  visibleActivities,
  type EligibilityContext,
  type NotificationCandidate,
} from '../src/domain/notifications/policies/notification-eligibility';
const candidate = (): NotificationCandidate => ({
  id: 'n',
  groupId: 'g',
  targetId: 'p',
  kind: 'reaction',
  activities: [{ eventId: 'e1', actorId: 'a', sequence: 1 }],
  readThroughSequence: 0,
});
const context = (): EligibilityContext => ({
  recipientId: 'me',
  activeAccount: true,
  activeInstallationSession: true,
  membershipGroupId: 'g',
  activeMembership: true,
  owner: true,
  intendedRecipient: true,
  targetAvailable: true,
  blockedActorIds: new Set(),
  pushPermission: true,
  enabled: true,
  types: {
    photos: true,
    comments: true,
    reactions: true,
    join: true,
    memories: false,
  },
  groupMode: 'default',
  quiet: {
    enabled: false,
    startMinute: 1320,
    endMinute: 480,
    currentLocalMinute: 720,
  },
});
test('all private recipient conditions fail closed', () => {
  for (const field of [
    'activeAccount',
    'activeInstallationSession',
    'activeMembership',
    'intendedRecipient',
    'targetAvailable',
    'pushPermission',
    'enabled',
  ] as const) {
    assert.equal(
      evaluateNotification(candidate(), { ...context(), [field]: false })
        .action,
      'suppress',
      field
    );
  }
  assert.equal(
    evaluateNotification(candidate(), {
      ...context(),
      membershipGroupId: 'other',
    }).action,
    'suppress'
  );
});
test('digest rechecks current group settings and current owner using same policy', () => {
  const photos = { ...candidate(), kind: 'photos' as const };
  assert.equal(
    evaluateDigest([photos], () => ({ ...context(), groupMode: 'mine' }))[0]
      .decision.action,
    'suppress'
  );
  const request = { ...candidate(), kind: 'join-request' as const };
  assert.equal(
    evaluateDigest([request], () => ({ ...context(), owner: false }))[0]
      .decision.action,
    'suppress'
  );
  assert.equal(
    evaluateDigest([photos], () => ({
      ...context(),
      activeInstallationSession: false,
    }))[0].decision.action,
    'suppress'
  );
});
test('partial blocked bundle removes actor from content, count and eligibility', () => {
  const n = {
    ...candidate(),
    activities: [
      ...candidate().activities,
      { eventId: 'e2', actorId: 'b', sequence: 2 },
    ],
  };
  const ctx = { ...context(), blockedActorIds: new Set(['a']) };
  assert.deepEqual(
    visibleActivities(n, ctx).map((a) => a.actorId),
    ['b']
  );
  assert.deepEqual(evaluateNotification(n, ctx).actorIds, ['b']);
  assert.equal(
    evaluateNotification(n, { ...ctx, blockedActorIds: new Set(['a', 'b']) })
      .action,
    'suppress'
  );
});
test('new activity after reading creates unread work without replaying old activities', () => {
  const n = {
    ...candidate(),
    readThroughSequence: 1,
    activities: [
      ...candidate().activities,
      { eventId: 'e2', actorId: 'b', sequence: 2 },
    ],
  };
  assert.deepEqual(evaluateNotification(n, context()).unreadEventIds, ['e2']);
  assert.equal(
    evaluateNotification({ ...n, readThroughSequence: 2 }, context()).action,
    'suppress'
  );
});
test('quiet boundaries include midnight and end is exclusive', () => {
  const q = {
    enabled: true,
    startMinute: 1320,
    endMinute: 480,
    currentLocalMinute: 1390,
  };
  assert.equal(isQuietTime(q), true);
  assert.equal(isQuietTime({ ...q, currentLocalMinute: 450 }), true);
  assert.equal(isQuietTime({ ...q, currentLocalMinute: 480 }), false);
  assert.equal(isQuietTime({ ...q, startMinute: 480 }), false);
  assert.throws(
    () => isQuietTime({ ...q, currentLocalMinute: -1 }),
    RangeError
  );
  assert.equal(
    evaluateNotification(candidate(), { ...context(), quiet: q }).action,
    'hold'
  );
});
test('read, own actions, duplicates and currently viewed photo do not send', () => {
  const own = {
    ...candidate(),
    activities: [{ eventId: 'e1', actorId: 'me', sequence: 1 }],
  };
  assert.equal(evaluateNotification(own, context()).action, 'suppress');
  assert.equal(
    evaluateNotification(candidate(), { ...context(), visibleTargetId: 'p' })
      .action,
    'suppress'
  );
  const duplicate = {
    ...candidate(),
    activities: [...candidate().activities, ...candidate().activities],
  };
  assert.deepEqual(evaluateNotification(duplicate, context()).unreadEventIds, [
    'e1',
  ]);
  assert.equal(evaluateDigest([candidate(), candidate()], context).length, 1);
});
