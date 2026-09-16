import type {
  Job,
  JobListResponse,
  JobStatus,
  JobType,
  ProblemDetails,
  QueuePulse,
} from './types';

const raw = import.meta.env.VITE_API_URL as string | undefined;
const API_URL = raw?.trim() ? raw.replace(/\/$/, '') : '';

export class ApiError extends Error {
  status: number;
  problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || 'Request failed');
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }
}

export function operatorName(): string {
  return localStorage.getItem('hopper-operator')?.trim() || 'You';
}

function operatorHeaders(headers: Headers): void {
  headers.set('X-Hopper-Operator', operatorName());
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  operatorHeaders(headers);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError({
      status: 0,
      detail: 'Cannot reach the Hopper API. Is the backend running?',
      code: 'NETWORK',
      title: 'Network error',
    });
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const problem = (body ?? {}) as ProblemDetails;
    throw new ApiError({
      status: res.status,
      title: problem.title,
      detail: problem.detail || res.statusText,
      code: problem.code,
      currentStatus: problem.currentStatus,
      requestedStatus: problem.requestedStatus,
      allowedTransitions: problem.allowedTransitions,
      job: problem.job,
    });
  }

  return body as T;
}

export function listJobs(params: {
  status?: string;
  type?: string;
  q?: string;
}): Promise<JobListResponse> {
  const search = new URLSearchParams();
  if (params.status && params.status !== 'all') search.set('status', params.status);
  if (params.type && params.type !== 'all') search.set('type', params.type);
  if (params.q?.trim()) search.set('q', params.q.trim());
  const qs = search.toString();
  return request(`/jobs${qs ? `?${qs}` : ''}`);
}

export function createJob(
  input: { title: string; type: JobType },
  idempotencyKey: string,
): Promise<Job> {
  return request('/jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function updateJobStatus(input: {
  id: string;
  from: JobStatus;
  status: JobStatus;
  error?: string;
}): Promise<Job> {
  return request(`/jobs/${input.id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      from: input.from,
      status: input.status,
      error: input.error,
    }),
  });
}

export function deleteJob(id: string): Promise<void> {
  return request(`/jobs/${id}`, { method: 'DELETE' });
}

export function claimNextJob(): Promise<Job> {
  return request('/jobs/claim', { method: 'POST', body: JSON.stringify({}) });
}

export function requeueJob(id: string): Promise<Job> {
  return request(`/jobs/${id}/requeue`, { method: 'POST', body: JSON.stringify({}) });
}

export function holdJob(id: string): Promise<Job> {
  return request(`/jobs/${id}/hold`, { method: 'POST', body: JSON.stringify({}) });
}

export function releaseJob(id: string): Promise<Job> {
  return request(`/jobs/${id}/release`, { method: 'POST', body: JSON.stringify({}) });
}

export function heartbeatJob(id: string): Promise<Job> {
  return request(`/jobs/${id}/heartbeat`, { method: 'POST', body: JSON.stringify({}) });
}

export function reapStaleJobs(): Promise<{ reaped: Job[] }> {
  return request('/jobs/reap', { method: 'POST', body: JSON.stringify({}) });
}

export function fetchPulse(): Promise<QueuePulse> {
  return request('/jobs/pulse');
}

export { API_URL };
