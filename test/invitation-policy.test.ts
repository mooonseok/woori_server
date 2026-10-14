import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateInvitationDto,
  InvitationCredentialDto,
} from '../src/domain/invitations/dto/invitation.dto';
import {
  assertInvitationAvailable,
  assertJoinableMembership,
  hashInvitation,
  invitationLookup,
  invitationSecrets,
} from '../src/domain/invitations/invitation-policy';

test('invitation stores independently hashed high-entropy link and human code', () => {
  const a = invitationSecrets();
  const b = invitationSecrets();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.code, b.code);
  assert.equal(a.tokenHash, hashInvitation(a.token));
  assert.equal(a.codeHash, hashInvitation(a.code));
  assert.notEqual(a.codeHash, a.tokenHash);
});
test('exactly one invitation credential, strict length and ambiguous letters rejected', () => {
  assert.throws(() => invitationLookup({}));
  assert.throws(() => invitationLookup({ code: 'ABCDEFGHJK', token: 'x' }));
  const dto = plainToInstance(InvitationCredentialDto, {
    code: ' abcdefghjk ',
  });
  assert.equal(dto.code, 'ABCDEFGHJK');
  assert.equal(validateSync(dto).length, 0);
  assert.equal(
    validateSync(
      plainToInstance(InvitationCredentialDto, { code: 'OOOIIIIIII' })
    ).length,
    1
  );
  assert.ok(
    validateSync(
      plainToInstance(CreateInvitationDto, { expiresInHours: 1, maxUses: 1000 })
    ).length
  );
});
test('expired, revoked and exhausted invites cannot admit a new member', () => {
  const now = new Date();
  const invite = {
    expiresAt: new Date(now.getTime() + 1000),
    revokedAt: null,
    useCount: 0,
    maxUses: 1,
  };
  assert.doesNotThrow(() => assertInvitationAvailable(invite, now));
  assert.throws(() =>
    assertInvitationAvailable({ ...invite, expiresAt: now }, now)
  );
  assert.throws(() =>
    assertInvitationAvailable({ ...invite, revokedAt: now }, now)
  );
  assert.throws(() =>
    assertInvitationAvailable({ ...invite, useCount: 1 }, now)
  );
  assert.doesNotThrow(() =>
    assertInvitationAvailable({ ...invite, useCount: 1 }, now, false)
  );
});
test('removed and pending memberships require owner intervention; left can rejoin', () => {
  assert.throws(() => assertJoinableMembership('REMOVED'));
  assert.throws(() => assertJoinableMembership('PENDING'));
  for (const status of ['LEFT', 'ACTIVE', undefined])
    assert.doesNotThrow(() => assertJoinableMembership(status));
});
