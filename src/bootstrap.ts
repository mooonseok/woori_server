import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { runtimeConfig } from './common/configurations/runtime.config';
import { ADMIN_PATH_PATTERN } from './common/decorators/admin-route.decorator';
export async function createApp() {
  const config = runtimeConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    abortOnError: false,
  });
  app.useBodyParser('json', { limit: '128kb' });
  app.useBodyParser('urlencoded', { limit: '128kb', extended: false });
  app.disable('x-powered-by');
  if (config.trustedProxyHops) app.set('trust proxy', config.trustedProxyHops);
  app.use(
    (
      _request: import('express').Request,
      response: import('express').Response,
      next: import('express').NextFunction
    ) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    }
  );
  // Explicit origin list; empty means no cross-origin browser access. Admin
  // routes are readable only from ADMIN_WEB_ORIGIN, never the member web.
  const adminOrigins = config.admin ? [config.admin.webOrigin] : [];
  app.enableCors((request: import('express').Request, callback) =>
    callback(null, {
      origin: ADMIN_PATH_PATTERN.test(request.path ?? request.url ?? '')
        ? adminOrigins
        : config.allowedOrigins,
      credentials: true,
    })
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );
  app.enableShutdownHooks();
  return app;
}
