import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';

export function corsOrigins(): Set<string> {
  const extra = (process.env.FRONTEND_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...extra,
  ]);
}

export async function createHopperApp(
  expressApp?: Express,
): Promise<INestApplication> {
  const app = expressApp
    ? await NestFactory.create(AppModule, new ExpressAdapter(expressApp))
    : await NestFactory.create(AppModule);
  const allowed = corsOrigins();

  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!requestOrigin || allowed.has(requestOrigin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
    exposedHeaders: ['ETag'],
    allowedHeaders: [
      'Content-Type',
      'If-Match',
      'Idempotency-Key',
      'Accept',
      'X-Hopper-Operator',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new ProblemFilter());
  return app;
}
