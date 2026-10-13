import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
@Injectable()
export class MailService {
  async sendVerification(email: string, token: string): Promise<void> {
    const origin = process.env.WEB_ORIGIN;
    if (!origin) throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    const base = new URL(origin);
    if (base.origin !== origin || !['http:', 'https:'].includes(base.protocol) || (process.env.NODE_ENV === 'production' && base.protocol !== 'https:')) {
      throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    }
    const url = new URL('/verify-email', origin);
    url.searchParams.set('token', token);
    const subject = '[우리] 이메일 주소를 확인해 주세요';
    const text = `아래 링크를 열어 이메일을 확인해 주세요. 링크는 30분 동안 한 번만 사용할 수 있어요.\n\n${url.toString()}\n\n가입한 적이 없다면 이 메일을 무시해 주세요.`;
    if (process.env.MAIL_MODE === 'file' && process.env.NODE_ENV !== 'production') {
      const directory = process.env.DEV_MAIL_DIR;
      const outside = directory ? relative(process.cwd(), resolve(directory)) : '';
      if (!directory || !isAbsolute(directory) || !outside.startsWith('..')) throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ to: email, subject, text }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return;
    }
    if (process.env.MAIL_MODE !== 'resend' || !process.env.RESEND_API_KEY || !process.env.MAIL_FROM) throw new ServiceUnavailableException({ code: 'MAIL_NOT_CONFIGURED' });
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [email], subject, text }),
    });
    if (!response.ok) throw new ServiceUnavailableException({ code: 'MAIL_DELIVERY_UNAVAILABLE' });
  }
}
