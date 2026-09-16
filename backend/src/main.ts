import { config } from 'dotenv';
config();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const extra = (process.env.FRONTEND_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...extra,
  ]);

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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
