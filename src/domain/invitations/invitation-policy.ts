import {
  BadRequestException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
export function hashInvitation(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function invitationSecrets() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = [...randomBytes(10)].map((byte) => alphabet[byte & 31]).join('');
  const token = randomBytes(32).toString('base64url');
  return {
    code,
    token,
    codeHash: hashInvitation(code),
    tokenHash: hashInvitation(token),
  };
}
export function invitationLookup(input: { code?: string; token?: string }) {
  if (Boolean(input.code) === Boolean(input.token))
    throw new BadRequestException({
      code: 'INVITATION_CREDENTIAL_REQUIRED',
      message: '초대 코드 또는 초대 링크 하나를 입력해 주세요.',
    });
  return input.code
    ? { codeHash: hashInvitation(input.code) }
    : { tokenHash: hashInvitation(input.token!) };
}
export function invalidInvitation(): never {
  throw new GoneException({
    code: 'INVITATION_UNAVAILABLE',
    message: '초대가 만료되었거나 사용할 수 없어요. 새 초대를 요청해 주세요.',
  });
}
export function assertInvitationAvailable(
  invitation: {
    revokedAt: Date | null;
    expiresAt: Date;
    maxUses: number;
    useCount: number;
  },
  now = new Date(),
  checkCapacity = true
) {
  if (
    invitation.revokedAt ||
    invitation.expiresAt <= now ||
    (checkCapacity && invitation.useCount >= invitation.maxUses)
  )
    invalidInvitation();
}
export function assertJoinableMembership(status: string | undefined) {
  if (status === 'REMOVED' || status === 'PENDING')
    throw new ForbiddenException({
      code: 'GROUP_JOIN_NOT_ALLOWED',
      message: '그룹 관리자에게 참여 가능 여부를 확인해 주세요.',
    });
}
