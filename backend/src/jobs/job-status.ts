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

/**
 * The assignment graph, encoded once and reused by the service, tests, and
 * error payloads. React may hide illegal buttons, but this module is the
 * actual rulebook.
 *
 * pending  →  running  →  completed
 *    \            ↘
 *     ↘            failed
 *      failed
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

export function allowedTransitions(from: JobStatus): JobStatus[] {
  return [...TRANSITIONS[from]];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionDetail(from: JobStatus, to: JobStatus): string {
  if (from === to) {
    return `Job is already ${from}.`;
  }
  if (
    (from === 'completed' || from === 'failed') &&
    (to === 'running' || to === 'pending')
  ) {
    return `A ${from} job cannot become ${to} again.`;
  }
  const allowed = allowedTransitions(from);
  if (allowed.length === 0) {
    return `A ${from} job is terminal and cannot change status.`;
  }
  return `Cannot move a ${from} job to ${to}. Allowed: ${allowed.join(', ')}.`;
}
