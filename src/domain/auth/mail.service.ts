import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { developmentMailDirectory } from '../../common/configurations/development-mail';
@Injectable()
export class MailService {
  async sendVerification(email: string, token: string): Promise<void> {
    const url = this.link('/verify-email', token);
    await this.send(
      email,
      '[우리] 이메일 주소를 확인해 주세요',
      `아래 링크를 열어 이메일을 확인해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요.\n\n${url}\n\n가입한 적이 없다면 이 메일을 무시해 주세요.`
    );
  }
  async sendUsername(email: string, username: string) {
    await this.send(
      email,
      '[우리] 아이디를 안내해 드려요',
      `우리 아이디는 ${username} 입니다.\n\n요청한 적이 없다면 이 메일을 무시해 주세요.`,
      2000
    );
  }
  async sendPasswordReset(email: string, token: string) {
    const url = this.link('/reset-password', token);
    await this.send(
      email,
      '[우리] 비밀번호를 다시 설정해 주세요',
      `아래 링크에서 새 비밀번호를 정해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요. 새 링크를 요청하면 이전 링크는 사용할 수 없어요.\n\n${url}\n\n요청한 적이 없다면 이 메일을 무시해 주세요. 링크를 여는 것만으로 비밀번호가 바뀌지는 않아요.`,
      2000
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
    timeout = 10000
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
      await writeFile(
        join(directory, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ to: email, subject, text }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      );
      return;
    }
    if (
      process.env.MAIL_MODE !== 'resend' ||
      !process.env.RESEND_API_KEY ||
      !process.env.MAIL_FROM
    )
      throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [email],
        subject,
        text,
      }),
    });
    if (!response.ok)
      throw new ServiceUnavailableException({
        code: 'MAIL_DELIVERY_UNAVAILABLE',
      });
  }
}
