export const JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'email',
  'report',
  'import',
  'export',
  'digest',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface Job {
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
  data: Job[];
  counts: JobCounts;
  pulse: QueuePulse;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status: number;
  detail: string;
  code?: string;
  currentStatus?: JobStatus;
  requestedStatus?: JobStatus;
  allowedTransitions?: JobStatus[];
  job?: Job;
}

export const STATUS_META: Record<
  JobStatus,
  { label: string; hint: string }
> = {
  pending: { label: 'Waiting', hint: 'Queued, not started' },
  running: { label: 'In flight', hint: 'Someone claimed it' },
  completed: { label: 'Finished', hint: 'Terminal' },
  failed: { label: 'Failed', hint: 'Terminal' },
};

export const TYPE_META: Record<JobType, { label: string }> = {
  email: { label: 'Email' },
  report: { label: 'Report' },
  import: { label: 'Import' },
  export: { label: 'Export' },
  digest: { label: 'Digest' },
};

export const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
