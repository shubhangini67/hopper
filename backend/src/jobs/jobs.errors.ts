import { HttpException, HttpStatus } from '@nestjs/common';
import type { JobRecord } from './job.types';
import { allowedTransitions } from './job-status';
import type { JobStatus } from './job-status';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  currentStatus?: JobStatus;
  requestedStatus?: JobStatus;
  allowedTransitions?: JobStatus[];
  job?: JobRecord;
}

export class JobProblemException extends HttpException {
  constructor(body: ProblemBody) {
    super(body, body.status);
  }
}

export function notFound(id: string): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Job not found',
    status: HttpStatus.NOT_FOUND,
    detail: `No job exists with id ${id}.`,
    code: 'JOB_NOT_FOUND',
  });
}

export function invalidTransition(
  job: JobRecord,
  requested: JobStatus,
  detail: string,
): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Invalid status transition',
    status: HttpStatus.CONFLICT,
    detail,
    code: 'INVALID_TRANSITION',
    currentStatus: job.status,
    requestedStatus: requested,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function staleWrite(
  job: JobRecord,
  requested: JobStatus,
): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Job was updated by someone else',
    status: HttpStatus.CONFLICT,
    detail:
      'Another request already changed this job. Refresh and try the next legal step.',
    code: 'STALE_WRITE',
    currentStatus: job.status,
    requestedStatus: requested,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function preconditionFailed(job: JobRecord): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Stale representation',
    status: HttpStatus.PRECONDITION_FAILED,
    detail:
      'If-Match did not match the current ETag. The job changed since this client last read it.',
    code: 'ETAG_MISMATCH',
    currentStatus: job.status,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function duplicateIdempotency(
  detail: string,
): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Idempotency key conflict',
    status: HttpStatus.CONFLICT,
    detail,
    code: 'IDEMPOTENCY_CONFLICT',
  });
}

export function queueEmpty(detail?: string): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Queue is empty',
    status: HttpStatus.CONFLICT,
    detail: detail ?? 'There is no waiting job to claim.',
    code: 'QUEUE_EMPTY',
  });
}

export function notHoldable(job: JobRecord): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Job cannot be held',
    status: HttpStatus.CONFLICT,
    detail: 'Only waiting jobs can be parked. In-flight work already has a lease.',
    code: 'NOT_HOLDABLE',
    currentStatus: job.status,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function heartbeatRejected(job: JobRecord): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Heartbeat rejected',
    status: HttpStatus.CONFLICT,
    detail: 'Only an in-flight job can extend its lease.',
    code: 'HEARTBEAT_REJECTED',
    currentStatus: job.status,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function deadLettered(job: JobRecord): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Retry budget spent',
    status: HttpStatus.CONFLICT,
    detail: `This job failed ${job.attempts}/${job.maxAttempts} times. It stays in the dead letter pile unless you delete it.`,
    code: 'DEAD_LETTERED',
    currentStatus: job.status,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}

export function requeueNotTerminal(job: JobRecord): JobProblemException {
  return new JobProblemException({
    type: 'about:blank',
    title: 'Job is still active',
    status: HttpStatus.CONFLICT,
    detail: 'Only finished or failed jobs can be requeued. Active work is left alone.',
    code: 'REQUEUE_ACTIVE',
    currentStatus: job.status,
    allowedTransitions: allowedTransitions(job.status),
    job,
  });
}
