import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemFilter } from '../src/common/problem.filter';
import { ThrottlerGuard } from '@nestjs/throttler';

describe('Jobs API (e2e)', () => {
  let app: INestApplication;
  const dir = join(tmpdir(), `hopper-e2e-${process.pid}`);

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    process.env.DATABASE_PATH = join(dir, 'e2e.sqlite');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a short title', async () => {
    await request(app.getHttpServer())
      .post('/jobs')
      .send({ title: 'ab', type: 'email' })
      .expect(400);
  });

  it('creates, lists, transitions, and deletes a job', async () => {
    const created = await request(app.getHttpServer())
      .post('/jobs')
      .send({ title: 'Lifecycle job', type: 'email' })
      .expect(201);

    expect(created.body.status).toBe('pending');
    expect(created.headers.etag).toBeTruthy();

    const list = await request(app.getHttpServer()).get('/jobs').expect(200);
    expect(list.body.counts.all).toBeGreaterThan(0);
    expect(Array.isArray(list.body.data)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/jobs/${created.body.id}/status`)
      .send({ status: 'running', from: 'pending' })
      .expect(200);

    const done = await request(app.getHttpServer())
      .patch(`/jobs/${created.body.id}/status`)
      .send({ status: 'completed', from: 'running' })
      .expect(200);

    expect(done.body.status).toBe('completed');

    await request(app.getHttpServer())
      .patch(`/jobs/${created.body.id}/status`)
      .send({ status: 'running', from: 'completed' })
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/jobs/${created.body.id}`)
      .expect(204);
  });

  it('lets only one of two concurrent pending → running writes win', async () => {
    const created = await request(app.getHttpServer())
      .post('/jobs')
      .send({ title: 'Two tabs, one claim', type: 'report' })
      .expect(201);

    const id = created.body.id as string;
    const server = app.getHttpServer();

    const [a, b] = await Promise.all([
      request(server)
        .patch(`/jobs/${id}/status`)
        .send({ status: 'running', from: 'pending' }),
      request(server)
        .patch(`/jobs/${id}/status`)
        .send({ status: 'running', from: 'pending' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a.body : b.body;
    const loser = a.status === 409 ? a.body : b.body;

    expect(winner.status).toBe('running');
    expect(loser.code).toBe('STALE_WRITE');
    expect(loser.job.status).toBe('running');

    const fresh = await request(server).get(`/jobs/${id}`).expect(200);
    expect(fresh.body.status).toBe('running');
  });

  it('skips a held job when claiming, then reaps an expired lease', async () => {
    const parked = await request(app.getHttpServer())
      .post('/jobs')
      .send({ title: 'Hold this e2e job', type: 'email' })
      .expect(201);

    const waiting = await request(app.getHttpServer())
      .get('/jobs?status=pending')
      .expect(200);
    for (const job of waiting.body.data) {
      if (!job.held) {
        await request(app.getHttpServer())
          .post(`/jobs/${job.id}/hold`)
          .send({ operator: 'Ada' })
          .expect(200);
      }
    }

    const ready = await request(app.getHttpServer())
      .post('/jobs')
      .send({ title: 'Claim this e2e job', type: 'report' })
      .expect(201);

    const claimed = await request(app.getHttpServer())
      .post('/jobs/claim')
      .set('X-Hopper-Operator', 'Ada')
      .send({})
      .expect(200);

    expect(claimed.body.id).toBe(ready.body.id);
    expect(claimed.body.assignee).toBe('Ada');
    expect(claimed.body.leaseUntil).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/jobs/${claimed.body.id}/heartbeat`)
      .expect(200);

    const pulse = await request(app.getHttpServer()).get('/jobs/pulse').expect(200);
    expect(pulse.body.held).toBeGreaterThan(0);
    expect(pulse.body.claimable).toBeGreaterThanOrEqual(0);
  });
});
