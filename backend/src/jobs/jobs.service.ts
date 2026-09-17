import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { CreateJobDto } from './dto/create-job.dto';
import { QueryJobsDto } from './dto/query-jobs.dto';
import {
  JobCounts,
  JobListResponse,
  JobRecord,
  QueuePulse,
  DEFAULT_MAX_ATTEMPTS,
  LEASE_MS,
  etagFor,
} from './job.types';
import {
  duplicateIdempotency,
  invalidTransition,
  notFound,
  notHoldable,
  heartbeatRejected,
  deadLettered,
  preconditionFailed,
  queueEmpty,
  requeueNotTerminal,
  staleWrite,
} from './jobs.errors';
import {
  canTransition,
  transitionDetail,
} from './job-status';
import type { JobStatus, JobType } from './job-status';

interface JobRow {
  id: string;
  title: string;
  type: string;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  assignee: string | null;
  held: number;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  source_job_id: string | null;
}

const SEED: Array<{ title: string; type: JobType; status: JobStatus }> = [
  { title: 'Send March invoices', type: 'email', status: 'pending' },
  { title: 'Pull warehouse snapshot', type: 'import', status: 'pending' },
  { title: 'Weekly ops digest', type: 'digest', status: 'running' },
  { title: 'Export billing CSV', type: 'export', status: 'running' },
  { title: 'Quarterly usage report', type: 'report', status: 'completed' },
  { title: 'Welcome sequence, cohort B', type: 'email', status: 'completed' },
  { title: 'Rebuild search index dump', type: 'export', status: 'completed' },
  { title: 'Retry failed card receipts', type: 'import', status: 'failed' },
  { title: 'Nightly digest dry-run', type: 'digest', status: 'pending' },
  { title: 'Board packet PDF', type: 'report', status: 'pending' },
];

@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    const count = this.database
      .connection.prepare('SELECT COUNT(*) AS n FROM jobs')
      .get() as { n: number };
    if (count.n === 0) {
      this.seed();
      this.logger.log(`Seeded ${SEED.length} demo jobs`);
    }
  }

  list(query: QueryJobsDto): JobListResponse {
    const counts = this.counts();
    const clauses: string[] = [];
    const params: string[] = [];

    if (query.status && query.status !== 'all') {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.type) {
      clauses.push('type = ?');
      params.push(query.type);
    }
    if (query.q?.trim()) {
      clauses.push('(LOWER(title) LIKE ? OR id LIKE ?)');
      const needle = `%${query.q.trim().toLowerCase()}%`;
      params.push(needle, `%${query.q.trim()}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM jobs ${where} ORDER BY datetime(created_at) DESC`,
      )
      .all(...params) as JobRow[];

    return { data: rows.map(mapJob), counts, pulse: this.pulse() };
  }

  pulse(): QueuePulse {
    const now = Date.now();
    const rows = this.database.connection
      .prepare('SELECT * FROM jobs')
      .all() as JobRow[];
    const jobs = rows.map(mapJob);
    const waiting = jobs.filter((job) => job.status === 'pending');
    const oldest = waiting
      .filter((job) => !job.held)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return {
      waiting: waiting.length,
      claimable: waiting.filter((job) => !job.held).length,
      held: waiting.filter((job) => job.held).length,
      inFlight: jobs.filter((job) => job.status === 'running').length,
      stale: jobs.filter((job) => isLeaseExpired(job, now)).length,
      deadLetter: jobs.filter((job) => job.deadLetter).length,
      oldestWaitingMs: oldest
        ? Math.max(0, now - new Date(oldest.createdAt).getTime())
        : null,
    };
  }

  getById(id: string): JobRecord {
    const job = this.find(id);
    if (!job) throw notFound(id);
    return job;
  }

  create(
    dto: CreateJobDto,
    idempotencyKey?: string,
    extras?: { attempts?: number; maxAttempts?: number; sourceJobId?: string },
  ): JobRecord {
    const title = dto.title.trim();
    const now = nowIso();
    const requestHash = hashPayload({ title, type: dto.type });

    const createRow = this.database.connection.transaction(() => {
      if (idempotencyKey) {
        const existing = this.database.connection
          .prepare(
            'SELECT job_id, request_hash FROM idempotency_keys WHERE key = ?',
          )
          .get(idempotencyKey) as
          | { job_id: string; request_hash: string }
          | undefined;

        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw duplicateIdempotency(
              'This Idempotency-Key was already used with a different payload.',
            );
          }
          const replay = this.find(existing.job_id);
          if (replay) return replay;
        }
      }

      const job: JobRecord = {
        id: randomUUID(),
        title,
        type: dto.type,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        assignee: null,
        held: false,
        attempts: extras?.attempts ?? 0,
        maxAttempts: extras?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        leaseUntil: null,
        sourceJobId: extras?.sourceJobId ?? null,
        deadLetter: false,
        leaseExpired: false,
      };

      this.insert(job);

      if (idempotencyKey) {
        this.database.connection
          .prepare(
            `INSERT INTO idempotency_keys (key, job_id, request_hash, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(idempotencyKey, job.id, requestHash, now);
      }

      return job;
    });

    return createRow();
  }

  /**
   * Worker-style pull: oldest waiting job, claimed with the same CAS write
   * as a manual Start. Two callers cannot receive the same row.
   */
  claimNext(operator?: string): JobRecord {
    const oldest = this.database.connection
      .prepare(
        `SELECT id FROM jobs
         WHERE status = 'pending' AND held = 0
         ORDER BY datetime(created_at) ASC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!oldest) {
      const held = this.database.connection
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND held = 1`,
        )
        .get() as { n: number };
      throw queueEmpty(
        held.n > 0
          ? 'Every waiting job is on hold. Release one, or queue a new job.'
          : undefined,
      );
    }
    return this.updateStatus(oldest.id, 'running', {
      from: 'pending',
      operator,
    });
  }

  hold(id: string, operator?: string): JobRecord {
    const run = this.database.connection.transaction(() => {
      const job = this.find(id);
      if (!job) throw notFound(id);
      if (job.status !== 'pending') throw notHoldable(job);
      if (job.held) return job;
      const updatedAt = nowIso();
      const result = this.database.connection
        .prepare(
          `UPDATE jobs
           SET held = 1, assignee = ?, updated_at = ?
           WHERE id = ? AND status = 'pending' AND held = 0`,
        )
        .run(operatorName(operator), updatedAt, id);
      if (result.changes !== 1) {
        const fresh = this.find(id);
        if (!fresh) throw notFound(id);
        if (fresh.status !== 'pending') throw notHoldable(fresh);
        return fresh;
      }
      return this.find(id)!;
    });
    return run();
  }

  release(id: string): JobRecord {
    const run = this.database.connection.transaction(() => {
      const job = this.find(id);
      if (!job) throw notFound(id);
      if (job.status !== 'pending') throw notHoldable(job);
      if (!job.held) return job;
      const updatedAt = nowIso();
      this.database.connection
        .prepare(
          `UPDATE jobs SET held = 0, updated_at = ? WHERE id = ? AND status = 'pending'`,
        )
        .run(updatedAt, id);
      return this.find(id)!;
    });
    return run();
  }

  heartbeat(id: string): JobRecord {
    const run = this.database.connection.transaction(() => {
      const job = this.find(id);
      if (!job) throw notFound(id);
      if (job.status !== 'running') throw heartbeatRejected(job);
      const updatedAt = nowIso();
      const leaseUntil = leaseFrom(updatedAt);
      const result = this.database.connection
        .prepare(
          `UPDATE jobs
           SET lease_until = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(leaseUntil, updatedAt, id);
      if (result.changes !== 1) {
        const fresh = this.find(id);
        if (!fresh) throw notFound(id);
        throw heartbeatRejected(fresh);
      }
      return this.find(id)!;
    });
    return run();
  }

  reapStale(): { reaped: JobRecord[] } {
    const run = this.database.connection.transaction(() => {
      const now = Date.now();
      const running = (
        this.database.connection
          .prepare(`SELECT * FROM jobs WHERE status = 'running'`)
          .all() as JobRow[]
      ).map(mapJob);
      const reaped: JobRecord[] = [];
      for (const job of running) {
        if (!isLeaseExpired(job, now)) continue;
        reaped.push(
          this.updateStatus(job.id, 'failed', {
            from: 'running',
            error: 'Lease expired — no heartbeat.',
          }),
        );
      }
      return { reaped };
    });
    return run();
  }

  requeue(id: string): JobRecord {
    const job = this.find(id);
    if (!job) throw notFound(id);
    if (job.status !== 'completed' && job.status !== 'failed') {
      throw requeueNotTerminal(job);
    }
    if (job.deadLetter) throw deadLettered(job);
    return this.create({ title: job.title, type: job.type }, undefined, {
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      sourceJobId: job.id,
    });
  }

  /**
   * Two tabs can both read `pending` and both send `running`. The lock is
   * this write — not React, not a mutex:
   *
   *   UPDATE jobs SET status = :next
   *   WHERE id = :id AND status = :from
   *
   * First commit updates one row. Second commit updates zero rows and
   * becomes 409 STALE_WRITE. Illegal graph moves never reach a successful
   * write (409 INVALID_TRANSITION). Optional If-Match is a 412 if the
   * client is holding a stale ETag.
   */
  updateStatus(
    id: string,
    next: JobStatus,
    options: {
      from: JobStatus;
      ifMatch?: string;
      error?: string;
      operator?: string;
    },
  ): JobRecord {
    const run = this.database.connection.transaction(() => {
      const current = this.find(id);
      if (!current) throw notFound(id);

      if (options.ifMatch && options.ifMatch !== etagFor(current)) {
        throw preconditionFailed(current);
      }

      if (current.status !== options.from) {
        throw staleWrite(current, next);
      }

      if (!canTransition(options.from, next)) {
        throw invalidTransition(
          current,
          next,
          transitionDetail(options.from, next),
        );
      }

      const updatedAt = nowIso();
      const startedAt =
        next === 'running' ? updatedAt : current.startedAt;
      const finishedAt =
        next === 'completed' || next === 'failed' ? updatedAt : null;
      const lastError =
        next === 'failed'
          ? options.error?.trim() || 'Marked failed by an operator.'
          : null;
      const attempts =
        next === 'failed' ? current.attempts + 1 : current.attempts;
      const assignee =
        next === 'running'
          ? operatorName(options.operator, current.assignee)
          : current.assignee;
      const leaseUntil = next === 'running' ? leaseFrom(updatedAt) : null;
      const held = 0;

      const result = this.database.connection
        .prepare(
          `UPDATE jobs
           SET status = ?, updated_at = ?, started_at = ?, finished_at = ?,
               last_error = ?, assignee = ?, held = ?, attempts = ?, lease_until = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          next,
          updatedAt,
          startedAt,
          finishedAt,
          lastError,
          assignee,
          held,
          attempts,
          leaseUntil,
          id,
          options.from,
        );

      if (result.changes !== 1) {
        const fresh = this.find(id);
        if (!fresh) throw notFound(id);
        throw staleWrite(fresh, next);
      }

      const saved = this.find(id);
      if (!saved) throw notFound(id);
      return saved;
    });

    return run();
  }

  ping(): void {
    this.database.connection.prepare('SELECT 1').get();
  }

  remove(id: string): void {
    const result = this.database.connection
      .prepare('DELETE FROM jobs WHERE id = ?')
      .run(id);
    if (result.changes !== 1) throw notFound(id);
  }

  private insert(job: JobRecord): void {
    this.database.connection
      .prepare(
        `INSERT INTO jobs (
          id, title, type, status, created_at, updated_at,
          started_at, finished_at, last_error, assignee, held,
          attempts, max_attempts, lease_until, source_job_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.title,
        job.type,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.startedAt,
        job.finishedAt,
        job.lastError,
        job.assignee,
        job.held ? 1 : 0,
        job.attempts,
        job.maxAttempts,
        job.leaseUntil,
        job.sourceJobId,
      );
  }

  private find(id: string): JobRecord | undefined {
    const row = this.database.connection
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  private counts(): JobCounts {
    const rows = this.database.connection
      .prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; n: number }>;

    const counts: JobCounts = {
      all: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.n;
      counts.all += row.n;
    }
    return counts;
  }

  private seed(): void {
    const seedTx = this.database.connection.transaction(() => {
      SEED.forEach((item, index) => {
        const created = new Date(
          Date.now() - (SEED.length - index) * 36 * 60 * 1000,
        ).toISOString();
        const startedAt = item.status === 'pending' ? null : created;
        const finishedAt =
          item.status === 'completed' || item.status === 'failed'
            ? created
            : null;
        const held = item.title === 'Board packet PDF';
        const attempts =
          item.title === 'Retry failed card receipts' ? 3 : item.status === 'failed' ? 1 : 0;
        const leaseUntil =
          item.status === 'running'
            ? new Date(Date.now() - 60_000).toISOString()
            : null;
        this.insert({
          id: randomUUID(),
          title: item.title,
          type: item.type,
          status: item.status,
          createdAt: created,
          updatedAt: created,
          startedAt,
          finishedAt,
          lastError: item.status === 'failed' ? 'Upstream timed out.' : null,
          assignee: item.status === 'running' ? 'seed-worker' : null,
          held,
          attempts,
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          leaseUntil,
          sourceJobId: null,
          deadLetter: attempts >= DEFAULT_MAX_ATTEMPTS && item.status === 'failed',
          leaseExpired: false,
        });
      });
    });

    seedTx();
  }
}

function mapJob(row: JobRow): JobRecord {
  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
  const status = row.status as JobStatus;
  const job: JobRecord = {
    id: row.id,
    title: row.title,
    type: row.type as JobType,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    assignee: row.assignee,
    held: Number(row.held) === 1,
    attempts,
    maxAttempts,
    leaseUntil: row.lease_until,
    sourceJobId: row.source_job_id,
    deadLetter: status === 'failed' && attempts >= maxAttempts,
    leaseExpired: false,
  };
  job.leaseExpired = isLeaseExpired(job, Date.now());
  return job;
}

function isLeaseExpired(job: JobRecord, now: number): boolean {
  if (job.status !== 'running') return false;
  if (job.leaseUntil) return now > new Date(job.leaseUntil).getTime();
  if (!job.startedAt) return false;
  return now - new Date(job.startedAt).getTime() > LEASE_MS;
}

function leaseFrom(iso: string): string {
  return new Date(new Date(iso).getTime() + LEASE_MS).toISOString();
}

function operatorName(raw?: string, fallback?: string | null): string {
  const name = raw?.trim() || fallback?.trim() || 'operator';
  return name.slice(0, 40);
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
