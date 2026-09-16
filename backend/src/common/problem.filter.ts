import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const payload =
        typeof raw === 'string'
          ? {
              type: 'about:blank',
              title: exception.message,
              status,
              detail: raw,
              code: 'HTTP_ERROR',
            }
          : normalizeBody(raw as Record<string, unknown>, status);

      res.status(status).type('application/problem+json').json({
        ...payload,
        instance: req.originalUrl,
      });
      return;
    }

    this.logger.error(exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).type('application/problem+json').json({
      type: 'about:blank',
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Something unexpected went wrong.',
      code: 'INTERNAL_ERROR',
      instance: req.originalUrl,
    });
  }
}

function normalizeBody(
  raw: Record<string, unknown>,
  status: number,
): Record<string, unknown> {
  if (typeof raw.code === 'string' && typeof raw.detail === 'string') {
    return raw;
  }

  const message = raw.message;
  const detail = Array.isArray(message)
    ? message.join(' ')
    : typeof message === 'string'
      ? message
      : 'Request failed.';

  return {
    type: 'about:blank',
    title: status === 400 ? 'Validation failed' : 'Request failed',
    status,
    detail,
    code: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR',
  };
}
