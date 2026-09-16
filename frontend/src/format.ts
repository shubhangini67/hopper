export function relativeTime(iso: string, now = Date.now()): string {
  const delta = now - new Date(iso).getTime();
  const minutes = Math.round(delta / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function elapsed(from: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins}m in flight`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m in flight`;
}

export function isStaleRunning(
  job: {
    status: string;
    startedAt: string | null;
    leaseUntil?: string | null;
    leaseExpired?: boolean;
  },
  now = Date.now(),
): boolean {
  if (job.status !== 'running') return false;
  if (job.leaseUntil) return now > new Date(job.leaseUntil).getTime();
  if (job.leaseExpired) return true;
  if (!job.startedAt) return false;
  return now - new Date(job.startedAt).getTime() > 15 * 60 * 1000;
}

export function leaseLeft(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

export function waitAge(ms: number | null): string {
  if (ms == null) return 'idle';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'fresh';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function toCsv(
  jobs: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
    assignee?: string | null;
    held?: boolean;
    attempts?: number;
    leaseUntil?: string | null;
  }>,
): string {
  const header = [
    'id',
    'title',
    'type',
    'status',
    'createdAt',
    'startedAt',
    'finishedAt',
    'lastError',
    'assignee',
    'held',
    'attempts',
    'leaseUntil',
  ];
  const lines = [
    header.join(','),
    ...jobs.map((job) =>
      header
        .map((key) => {
          const value = String(job[key as keyof typeof job] ?? '');
          return `"${String(value).replaceAll('"', '""')}"`;
        })
        .join(','),
    ),
  ];
  return `${lines.join('\n')}\n`;
}
