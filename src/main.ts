import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './bootstrap';
import { runtimeConfig } from './common/configurations/runtime.config';
import { startupFailure } from './common/configurations/startup-diagnostics';

async function main() {
  let app: NestExpressApplication | undefined;
  let port: number | undefined;
  try {
    port = runtimeConfig().port;
    const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
    app = await createApp();
    await app.listen(port, host);
    const address = await app.getUrl();
    console.info(`[우리 API] HTTP 서버 실행 완료: ${address}`);
    console.info(`[우리 API] 상태 확인: http://127.0.0.1:${port}/healthz`);
    console.info(`[우리 API] DB·서비스 준비 확인: http://127.0.0.1:${port}/readyz`);
    if (host === '0.0.0.0') console.info('[우리 API] 모든 네트워크 인터페이스에서 수신 중입니다. 외부 접속은 배포 도메인을 사용하세요.');
  } catch (error) {
    console.error(`[우리 API] 실행 실패: ${startupFailure(error, port)}`);
    process.exitCode = 1;
    if (app) {
      try { await app.close(); }
      catch { console.error('[우리 API] 실패 후 리소스 정리에도 오류가 발생했습니다.'); }
    }
  }
}
void main();
