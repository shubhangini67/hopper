import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../database/database.service';
import { JobsService } from './jobs.service';

describe('JobsService', () => {
  let service: JobsService;
  let database: DatabaseService;
  const dir = join(tmpdir(), `hopper-unit-${process.pid}`);

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    process.env.DATABASE_PATH = join(dir, 'test.sqlite');
    database = new DatabaseService();
    database.onModuleInit();
    service = new JobsService(database);
    service.onModuleInit();
  });

  afterAll(() => {
    database.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates jobs as pending', () => {
    const job = service.create({ title: 'Send invoice batch', type: 'email' });
    expect(job.status).toBe('pending');
    expect(job.title).toBe('Send invoice batch');
  });

  it('replays POST with the same idempotency key', () => {
    const first = service.create(
      { title: 'Idempotent digest', type: 'digest' },
      'key-1',
    );
    const second = service.create(
      { title: 'Idempotent digest', type: 'digest' },
      'key-1',
    );
    expect(second.id).toBe(first.id);
  });

  it('walks the happy path pending → running → completed', () => {
    const created = service.create({ title: 'Happy path', type: 'report' });
    const running = service.updateStatus(created.id, 'running', {
      from: 'pending',
    });
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeTruthy();
    const done = service.updateStatus(created.id, 'completed', {
      from: 'running',
    });
    expect(done.status).toBe('completed');
    expect(done.finishedAt).toBeTruthy();
  });

  it('rejects completed → running', () => {
    const created = service.create({ title: 'Stay finished', type: 'export' });
    service.updateStatus(created.id, 'running', { from: 'pending' });
    const done = service.updateStatus(created.id, 'completed', {
      from: 'running',
    });
    expect(() =>
      service.updateStatus(done.id, 'running', { from: 'completed' }),
    ).toThrow();
  });

  it('lets only one claim win when two writers race', () => {
    const created = service.create({ title: 'Race me', type: 'import' });
    const db = database.connection;

    const claim = db.prepare(
      `UPDATE jobs
       SET status = 'running', updated_at = ?
       WHERE id = ? AND status = 'pending' AND updated_at = ?`,
    );

    const first = claim.run(new Date().toISOString(), created.id, created.updatedAt);
    const second = claim.run(new Date().toISOString(), created.id, created.updatedAt);

    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
    expect(service.getById(created.id).status).toBe('running');
  });

  it('claims the oldest waiting job', () => {
    const oldest = database.connection
      .prepare(
        `SELECT id FROM jobs WHERE status = 'pending' ORDER BY datetime(created_at) ASC LIMIT 1`,
      )
      .get() as { id: string };
    const claimed = service.claimNext();
    expect(claimed.id).toBe(oldest.id);
    expect(claimed.status).toBe('running');
  });

  it('requeues a finished job as a new pending row', () => {
    const created = service.create({ title: 'Run again', type: 'report' });
    service.updateStatus(created.id, 'running', { from: 'pending' });
    service.updateStatus(created.id, 'completed', { from: 'running' });
    const copy = service.requeue(created.id);
    expect(copy.id).not.toBe(created.id);
    expect(copy.status).toBe('pending');
    expect(copy.title).toBe('Run again');
    expect(service.getById(created.id).status).toBe('completed');
  });

  it('skips held jobs when claiming the next waiter', () => {
    const parked = service.create({ title: 'Park me please now', type: 'email' });
    for (const job of service.list({ status: 'pending' }).data) {
      if (!job.held) service.hold(job.id, 'Ada');
    }
    expect(service.getById(parked.id).held).toBe(true);
    const ready = service.create({ title: 'Take me instead now', type: 'email' });
    const claimed = service.claimNext('Ada');
    expect(claimed.id).toBe(ready.id);
    expect(claimed.assignee).toBe('Ada');
    expect(claimed.leaseUntil).toBeTruthy();
    const still = service.getById(parked.id);
    expect(still.status).toBe('pending');
    expect(still.held).toBe(true);
  });

  it('reaps an expired in-flight lease as failed', () => {
    const created = service.create({ title: 'Expired worker job', type: 'import' });
    const running = service.updateStatus(created.id, 'running', { from: 'pending' });
    database.connection
      .prepare('UPDATE jobs SET lease_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), running.id);
    const result = service.reapStale();
    expect(result.reaped.some((job) => job.id === running.id)).toBe(true);
    const fresh = service.getById(running.id);
    expect(fresh.status).toBe('failed');
    expect(fresh.lastError).toMatch(/Lease expired/);
  });

  it('blocks requeue once the retry budget is spent', () => {
    let job = service.create({ title: 'Out of retries job', type: 'export' });
    for (let i = 0; i < 3; i += 1) {
      job = service.updateStatus(job.id, 'running', { from: 'pending' });
      const failed = service.updateStatus(job.id, 'failed', {
        from: 'running',
        error: 'boom',
      });
      if (i < 2) {
        job = service.requeue(failed.id);
      } else {
        expect(failed.deadLetter).toBe(true);
        expect(() => service.requeue(failed.id)).toThrow();
      }
    }
  });
});
