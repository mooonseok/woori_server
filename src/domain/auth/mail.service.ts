import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { developmentMailDirectory } from '../../common/configurations/development-mail';
// W07-4: the mail outbox passes a stable per-mail key, so a retry after a lost
// response never delivers twice (Resend Idempotency-Key; development file name).
export interface MailDeliveryOptions {
  idempotencyKey?: string;
  fileName?: string;
}
// retryable: timeouts, network/5xx/429, concurrent idempotent request or a
// missing transport configuration. Not retryable: other provider 4xx.
export class MailDeliveryError extends ServiceUnavailableException {
  constructor(
    readonly retryable: boolean,
    readonly reason: string
  ) {
    super({ code: 'MAIL_DELIVERY_UNAVAILABLE' });
  }
}
@Injectable()
export class MailService {
  async sendVerification(
    email: string,
    token: string,
    options: MailDeliveryOptions = {}
  ): Promise<void> {
    const url = this.link('/verify-email', token);
    await this.send(
      email,
      '[우리] 이메일 주소를 확인해 주세요',
      `아래 링크를 열어 이메일을 확인해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요.\n\n${url}\n\n가입한 적이 없다면 이 메일을 무시해 주세요.`,
      10000,
      options
    );
  }
  async sendUsername(
    email: string,
    username: string,
    options: MailDeliveryOptions = {}
  ) {
    await this.send(
      email,
      '[우리] 아이디를 안내해 드려요',
      `우리 아이디는 ${username} 입니다.\n\n요청한 적이 없다면 이 메일을 무시해 주세요.`,
      2000,
      options
    );
  }
  async sendPasswordReset(
    email: string,
    token: string,
    options: MailDeliveryOptions = {}
  ) {
    const url = this.link('/reset-password', token);
    await this.send(
      email,
      '[우리] 비밀번호를 다시 설정해 주세요',
      `아래 링크에서 새 비밀번호를 정해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요. 새 링크를 요청하면 이전 링크는 사용할 수 없어요.\n\n${url}\n\n요청한 적이 없다면 이 메일을 무시해 주세요. 링크를 여는 것만으로 비밀번호가 바뀌지는 않아요.`,
      2000,
      options
    );
  }
  async sendEmailChange(
    email: string,
    token: string,
    options: MailDeliveryOptions = {}
  ) {
    await this.send(
      email,
      '[우리] 새 이메일 주소를 확인해 주세요',
      `아래 링크를 열고 변경을 요청한 계정으로 로그인해 이메일 변경을 확인해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요. 새 링크를 요청하면 이전 링크는 사용할 수 없어요. 확인하면 모든 기기에서 로그아웃됩니다.\n\n${this.link('/change-email', token)}\n\n요청한 적이 없다면 이 메일을 무시해 주세요.`,
      2000,
      options
    );
  }
  async sendEmailChangedNotice(
    email: string,
    options: MailDeliveryOptions = {}
  ) {
    await this.send(
      email,
      '[우리] 계정 이메일이 변경되었어요',
      '우리 계정의 이메일 주소가 변경되었어요. 기존 기기의 로그인과 알림 연결이 해제되었습니다. 직접 변경하지 않았다면 서비스 문의로 알려 주세요. 보안을 위해 이 메일에는 새 이메일 주소를 표시하지 않습니다.',
      2000,
      options
    );
  }
  private link(path: string, token: string) {
    const origin = process.env.WEB_ORIGIN;
    if (!origin)
      throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    const base = new URL(origin);
    if (
      base.origin !== origin ||
      !['http:', 'https:'].includes(base.protocol) ||
      (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')
    )
      throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    const url = new URL(path, origin);
    url.searchParams.set('token', token);
    return url.toString();
  }
  private async send(
    email: string,
    subject: string,
    text: string,
    timeout = 10000,
    options: MailDeliveryOptions = {}
  ): Promise<void> {
    if (
      process.env.MAIL_MODE === 'file' &&
      process.env.NODE_ENV !== 'production'
    ) {
      const directory = developmentMailDirectory();
      if (!directory)
        throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const name = options.fileName ?? `${Date.now()}-${randomUUID()}`;
      if (!/^[A-Za-z0-9-]{1,100}$/.test(name))
        throw new MailDeliveryError(false, 'invalid-file-name');
      try {
        await writeFile(
          join(directory, `${name}.json`),
          JSON.stringify({ to: email, subject, text }),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
      } catch (error) {
        // The same outbox mail already written: an idempotent retry.
        if (options.fileName && (error as { code?: string }).code === 'EEXIST')
          return;
        throw error;
      }
      return;
    }
    if (
      process.env.MAIL_MODE !== 'resend' ||
      !process.env.RESEND_API_KEY ||
      !process.env.MAIL_FROM
    )
      throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(timeout),
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          ...(options.idempotencyKey
            ? { 'Idempotency-Key': options.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM,
          to: [email],
          subject,
          text,
        }),
      });
    } catch {
      // Timeout or network: the provider may have accepted it; the same
      // idempotency key makes the retry safe.
      throw new MailDeliveryError(true, 'provider-unreachable');
    }
    if (response.ok) return;
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        name?: unknown;
      };
      throw body.name === 'concurrent_idempotent_requests'
        ? new MailDeliveryError(true, 'provider-busy')
        : new MailDeliveryError(false, 'provider-409');
    }
    if (response.status === 429 || response.status >= 500)
      throw new MailDeliveryError(true, `provider-${response.status}`);
    throw new MailDeliveryError(false, `provider-${response.status}`);
  }
}
