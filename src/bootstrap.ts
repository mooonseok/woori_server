import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { runtimeConfig } from './common/configurations/runtime.config';
export async function createApp() {
  const config = runtimeConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  app.useBodyParser('json', { limit: '128kb' });
  app.useBodyParser('urlencoded', { limit: '128kb', extended: false });
  app.disable('x-powered-by');
  if(config.trustedProxyHops) app.set('trust proxy', config.trustedProxyHops);
  app.use((_request: import('express').Request, response: import('express').Response, next: import('express').NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Explicit origin list; empty means no cross-origin browser access.
  app.enableCors({ origin: config.allowedOrigins, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  return app;
}
