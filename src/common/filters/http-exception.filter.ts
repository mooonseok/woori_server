import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const body =
      error instanceof HttpException
        ? error.getResponse()
        : { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했어요.' };
    response.setHeader('Cache-Control', 'no-store');
    response
      .status(status)
      .json(
        typeof body === 'string' ? { statusCode: status, message: body } : body
      );
  }
}
