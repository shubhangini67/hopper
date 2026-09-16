import type { JobStatus, JobType } from './job-status';

export const LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface JobRecord {
  id: string;
  title: string;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  assignee: string | null;
  held: boolean;
  attempts: number;
  maxAttempts: number;
  leaseUntil: string | null;
  sourceJobId: string | null;
  deadLetter: boolean;
  leaseExpired: boolean;
}

export interface QueuePulse {
  waiting: number;
  claimable: number;
  held: number;
  inFlight: number;
  stale: number;
  deadLetter: number;
  oldestWaitingMs: number | null;
}

export interface JobCounts {
  all: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface JobListResponse {
  data: JobRecord[];
  counts: JobCounts;
  pulse: QueuePulse;
}

export function etagFor(job: Pick<JobRecord, 'id' | 'updatedAt'>): string {
  return `"${job.id}:${job.updatedAt}"`;
}

export function parseIfMatch(header?: string): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  return trimmed.length ? trimmed : undefined;
}
