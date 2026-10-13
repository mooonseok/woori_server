import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InvitationsRepository } from './invitations.repository';
import { CreateInvitationDto, InvitationCredentialDto } from './dto/invitation.dto';
import { invitationLookup, invitationSecrets } from './invitation-policy';
@Injectable()
export class InvitationsService {
  constructor(private readonly repository: InvitationsRepository) {}
  private verified(user: { emailVerified: boolean }) {
    if (!user.emailVerified) throw new ForbiddenException({ code: 'EMAIL_VERIFICATION_REQUIRED', message: '이메일 인증 후 초대를 사용해 주세요.' });
  }
  async create(groupId: string, user: { id: string; emailVerified: boolean }, dto: CreateInvitationDto) {
    this.verified(user);
    const origin = process.env.WEB_ORIGIN;
    if (!origin) throw new ServiceUnavailableException({ code: 'WEB_ORIGIN_NOT_CONFIGURED', message: '초대 링크 설정이 필요해요.' });
    let url: URL;
    try { url = new URL('/invite', origin); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); }
    catch { throw new ServiceUnavailableException({ code: 'WEB_ORIGIN_NOT_CONFIGURED', message: '초대 링크 설정이 필요해요.' }); }
    const secret = invitationSecrets();
    const invitation = await this.repository.create(groupId, user.id, {
      tokenHash: secret.tokenHash, codeHash: secret.codeHash,
      expiresAt: new Date(Date.now() + (dto.expiresInHours ?? 72) * 3_600_000), maxUses: dto.maxUses ?? 10,
    });
    url.searchParams.set('token', secret.token);
    return { id: invitation.id, code: secret.code, url: url.toString(), expiresAt: invitation.expiresAt, maxUses: invitation.maxUses };
  }
  async list(groupId: string, userId: string) { return { invitations: await this.repository.list(groupId, userId) }; }
  revoke(groupId: string, id: string, userId: string) { return this.repository.revoke(groupId, id, userId); }
  preview(dto: InvitationCredentialDto) { return this.repository.preview(invitationLookup(dto)); }
  join(dto: InvitationCredentialDto, user: { id: string; emailVerified: boolean }) {
    this.verified(user);
    return this.repository.join(invitationLookup(dto), user.id);
  }
}
