import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, claimNextJob, createJob, deleteJob, heartbeatJob, holdJob, listJobs, operatorName, reapStaleJobs, releaseJob, requeueJob, updateJobStatus } from './api';
import { clock, elapsed, isStaleRunning, leaseLeft, relativeTime, shortId, toCsv, waitAge } from './format';
import {
  JOB_STATUSES,
  JOB_TYPES,
  STATUS_META,
  TYPE_META,
  canTransition,
  type Job,
  type JobStatus,
  type JobType,
  type ProblemDetails,
} from './types';

const CHANNEL = 'hopper-jobs';
const EMPTY_COUNTS = {
  all: 0,
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
};
const EMPTY_PULSE = {
  waiting: 0,
  claimable: 0,
  held: 0,
  inFlight: 0,
  stale: 0,
  deadLetter: 0,
  oldestWaitingMs: null as number | null,
};

type Toast = { id: number; kind: 'ok' | 'err' | 'warn'; text: string };
type Theme = 'day' | 'night';
type Density = 'roomy' | 'compact';
type SortKey = 'newest' | 'oldest' | 'title';

function initialTheme(): Theme {
  const saved = localStorage.getItem('hopper-theme');
  if (saved === 'night' || saved === 'day') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
}

export default function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'board' | 'list'>(() =>
    localStorage.getItem('hopper-view') === 'list' ? 'list' : 'board',
  );
  const [statusFilter, setStatusFilter] = useState<'all' | JobStatus>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | JobType>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conflict, setConflict] = useState<ProblemDetails | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Job | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [failTarget, setFailTarget] = useState<Job | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem('hopper-density') === 'compact' ? 'compact' : 'roomy'),
  );
  const [hideFinished, setHideFinished] = useState(false);
  const [attentionOn, setAttentionOn] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [operator, setOperator] = useState(() => operatorName());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    localStorage.setItem('hopper-view', view);
  }, [view]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hopper-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('hopper-density', density);
  }, [density]);

  useEffect(() => {
    localStorage.setItem('hopper-hide-finished', hideFinished ? '1' : '0');
  }, [hideFinished]);

  useEffect(() => {
    localStorage.setItem('hopper-operator', operator.trim() || 'You');
  }, [operator]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT';
      if (event.key === 'n' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setCreateOpen(true);
      }
      if ((event.key === 'd' || event.key === 'D') && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setTheme((current) => (current === 'day' ? 'night' : 'day'));
      }
      if ((event.key === 'b' || event.key === 'B') && !typing) {
        event.preventDefault();
        setView('board');
      }
      if ((event.key === 'l' || event.key === 'L') && !typing) {
        event.preventDefault();
        setView('list');
      }
      if (!typing && ['1', '2', '3', '4', '0'].includes(event.key)) {
        const map = {
          '0': 'all',
          '1': 'pending',
          '2': 'running',
          '3': 'completed',
          '4': 'failed',
        } as const;
        setStatusFilter(map[event.key as keyof typeof map]);
      }
      if ((event.key === 'c' || event.key === 'C') && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        document.getElementById('hopper-claim')?.click();
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        document.getElementById('hopper-search')?.focus();
      }
      if (event.key === 'Escape') {
        setCreateOpen(false);
        setConflict(null);
        setPendingDelete(null);
        setInspectedId(null);
        setFailTarget(null);
        setAttentionOn(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    };
    return () => channel.close();
  }, [queryClient]);

  const jobsQuery = useQuery({
    queryKey: ['jobs', typeFilter, debounced],
    queryFn: () =>
      listJobs({
        type: typeFilter,
        q: debounced,
      }),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });

  const jobs = jobsQuery.data?.data ?? [];
  const counts = jobsQuery.data?.counts ?? EMPTY_COUNTS;
  const pulse = jobsQuery.data?.pulse ?? EMPTY_PULSE;

  useEffect(() => {
    const id = window.setInterval(() => {
      const mine = jobs.filter(
        (job) => job.status === 'running' && job.assignee === operator,
      );
      if (mine.length === 0) return;
      void Promise.all(mine.map((job) => heartbeatJob(job.id)))
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
        })
        .catch(() => undefined);
    }, 45_000);
    return () => window.clearInterval(id);
  }, [jobs, operator, queryClient]);

  const pushToast = (kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-4), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4200);
  };

  const bump = () => {
    void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    new BroadcastChannel(CHANNEL).postMessage('changed');
  };

  const createMut = useMutation({
    mutationFn: (input: { title: string; type: JobType; key: string }) =>
      createJob({ title: input.title, type: input.type }, input.key),
    onSuccess: (job) => {
      bump();
      setCreateOpen(false);
      pushToast('ok', `Queued “${job.title}”.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const statusMut = useMutation({
    mutationFn: updateJobStatus,
    onSuccess: (job) => {
      bump();
      pushToast('ok', `${job.title} is ${STATUS_META[job.status].label.toLowerCase()}.`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.job) {
        setConflict(error.problem);
        bump();
        return;
      }
      pushToast('err', error.message);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (job: Job) => deleteJob(job.id),
    onSuccess: (_, job) => {
      bump();
      setPendingDelete(null);
      if (inspectedId === job.id) setInspectedId(null);
      pushToast('ok', `Deleted “${job.title}”.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const claimMut = useMutation({
    mutationFn: claimNextJob,
    onSuccess: (job) => {
      bump();
      setInspectedId(job.id);
      pushToast('ok', `Claimed “${job.title}”.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const requeueMut = useMutation({
    mutationFn: requeueJob,
    onSuccess: (job) => {
      bump();
      setInspectedId(job.id);
      pushToast('ok', `Requeued as a new waiting job.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const holdMut = useMutation({
    mutationFn: holdJob,
    onSuccess: (job) => {
      bump();
      pushToast('ok', `Held “${job.title}”. Claim next will skip it.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const releaseMut = useMutation({
    mutationFn: releaseJob,
    onSuccess: (job) => {
      bump();
      pushToast('ok', `Released “${job.title}” back into the line.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const heartbeatMut = useMutation({
    mutationFn: heartbeatJob,
    onSuccess: (job) => {
      bump();
      pushToast('ok', `Lease extended on “${job.title}”.`);
    },
    onError: (error) => pushToast('err', error.message),
  });

  const reapMut = useMutation({
    mutationFn: reapStaleJobs,
    onSuccess: (result) => {
      bump();
      if (result.reaped.length === 0) {
        pushToast('ok', 'No expired leases to reap.');
        return;
      }
      pushToast(
        'warn',
        `Reaped ${result.reaped.length} stale ${result.reaped.length === 1 ? 'job' : 'jobs'}.`,
      );
    },
    onError: (error) => pushToast('err', error.message),
  });

  const requestMove = (job: Job, next: JobStatus) => {
    if (next === 'failed') {
      setFailTarget(job);
      return;
    }
    statusMut.mutate({ id: job.id, from: job.status, status: next });
  };

  const scopedJobs = useMemo(() => {
    if (!attentionOn) return jobs;
    return jobs.filter(
      (job) => job.held || isStaleRunning(job, now) || job.deadLetter,
    );
  }, [jobs, attentionOn, now]);

  const visibleJobs = useMemo(() => {
    let list = scopedJobs;
    if (view === 'list' && statusFilter !== 'all') {
      list = list.filter((job) => job.status === statusFilter);
    }
    if (hideFinished) {
      list = list.filter(
        (job) => job.status === 'pending' || job.status === 'running',
      );
    }
    const copy = [...list];
    if (sortKey === 'title') copy.sort((a, b) => a.title.localeCompare(b.title));
    if (sortKey === 'oldest') copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sortKey === 'newest') copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return copy;
  }, [scopedJobs, view, statusFilter, hideFinished, sortKey]);

  const grouped = useMemo(() => {
    const map: Record<JobStatus, Job[]> = {
      pending: [],
      running: [],
      completed: [],
      failed: [],
    };
    for (const job of scopedJobs) map[job.status].push(job);
    return map;
  }, [scopedJobs]);

  const boardStatuses = useMemo(() => {
    const base = hideFinished
      ? (['pending', 'running'] as JobStatus[])
      : [...JOB_STATUSES];
    const filtered =
      statusFilter === 'all' ? base : base.filter((status) => status === statusFilter);
    return filtered;
  }, [hideFinished, statusFilter]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const job = event.active.data.current?.job as Job | undefined;
    const to = event.over?.id as JobStatus | undefined;
    if (!job || !to || job.status === to) return;
    if (!canTransition(job.status, to)) {
      pushToast(
        'warn',
        `A ${STATUS_META[job.status].label.toLowerCase()} job cannot move to ${STATUS_META[to].label.toLowerCase()}.`,
      );
      return;
    }
    requestMove(job, to);
  };

  const inspected = jobs.find((job) => job.id === inspectedId) ?? null;
  const claimHint =
    pulse.claimable > 0
      ? `Take the oldest waiting job. ${pulse.claimable} ready.`
      : pulse.held > 0
        ? 'Every waiting job is on hold. Release one, or queue a new job.'
        : 'Nothing waiting. Queue a new job first.';

  const exportVisible = () => {
    const blob = new Blob([toCsv(visibleJobs)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hopper-jobs.csv';
    link.click();
    URL.revokeObjectURL(url);
    pushToast('ok', `Exported ${visibleJobs.length} jobs.`);
  };

  return (
    <div className="shell">
      <div className="chrome">
        <header className="topbar">
        <div className="brand">
          <Logo />
          <h1>Hopper</h1>
        </div>
        <label className="search">
          <span className="sr-only">Search jobs</span>
          <input
            id="hopper-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search jobs"
          />
        </label>
        <div className="top-actions">
          <div className="seg" role="tablist" aria-label="Layout">
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>
              Board
            </button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
              List
            </button>
          </div>
          <button
            className="lamp"
            onClick={() => setTheme((current) => (current === 'day' ? 'night' : 'day'))}
            aria-label={theme === 'day' ? 'Switch to night' : 'Switch to day'}
          >
            {theme === 'day' ? <MoonIcon /> : <SunIcon />}
          </button>
          <button
            id="hopper-claim"
            className={`btn ${pulse.claimable === 0 ? 'idle' : ''}`}
            aria-label="Claim next waiting job"
            title={claimHint}
            disabled={claimMut.isPending}
            onClick={() => {
              if (pulse.claimable === 0) {
                pushToast('warn', claimHint);
                return;
              }
              claimMut.mutate();
            }}
          >
            Claim next
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            New job
          </button>
        </div>
      </header>

        <section className="stats" aria-label="Status counts">
          {(
            [
              ['all', 'All', counts.all],
              ...JOB_STATUSES.map(
                (status) =>
                  [status, STATUS_META[status].label, counts[status]] as const,
              ),
            ] as Array<['all' | JobStatus, string, number]>
          ).map(([key, label, value]) => (
            <button
              key={key}
              className={`stat ${key} ${statusFilter === key ? 'on' : ''}`}
              onClick={() => setStatusFilter(key)}
            >
              <span>{label}</span>
              <strong>{jobsQuery.isLoading ? '—' : value}</strong>
            </button>
          ))}
        </section>

        <div className="pulse" aria-label="Queue pulse">
          <span>
            Oldest wait <strong>{jobsQuery.isLoading ? '—' : waitAge(pulse.oldestWaitingMs)}</strong>
          </span>
          <span>
            Claimable <strong>{pulse.claimable}</strong>
          </span>
          <span>
            Held <strong>{pulse.held}</strong>
          </span>
          <span className={pulse.stale > 0 ? 'hot' : ''}>
            Stale leases <strong>{pulse.stale}</strong>
          </span>
          <span className={pulse.deadLetter > 0 ? 'hot' : ''}>
            Dead letter <strong>{pulse.deadLetter}</strong>
          </span>
          <button
            className="btn tiny"
            disabled={reapMut.isPending || pulse.stale === 0}
            onClick={() => reapMut.mutate()}
          >
            Reap stale
          </button>
        </div>

      <div className="subbar">
        <label className="check">
          <input
            type="checkbox"
            checked={hideFinished}
            onChange={(e) => setHideFinished(e.target.checked)}
          />
          Active only
        </label>
        <button
          className={`btn tiny ${attentionOn ? 'on' : ''}`}
          onClick={() => setAttentionOn((on) => !on)}
        >
          Needs attention
        </button>
        <label className="desk">
          <span className="sr-only">Operator name</span>
          <input
            value={operator}
            onChange={(e) => setOperator(e.target.value.slice(0, 40))}
            placeholder="Your name"
            maxLength={40}
            aria-label="Operator name"
          />
        </label>
        <button
          className={`btn tiny ${density === 'compact' ? 'on' : ''}`}
          onClick={() => setDensity(density === 'compact' ? 'roomy' : 'compact')}
        >
          {density === 'compact' ? 'Compact' : 'Roomy'}
        </button>
        {view === 'list' && (
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            aria-label="Sort jobs"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title</option>
          </select>
        )}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as 'all' | JobType)}
          aria-label="Filter by type"
        >
          <option value="all">All types</option>
          {JOB_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_META[type].label}
            </option>
          ))}
        </select>
        <button className="btn tiny" onClick={exportVisible} disabled={visibleJobs.length === 0}>
          CSV
        </button>
      </div>
      </div>

      <main className="floor">
        {jobsQuery.isLoading && (
          <div className="board cols-4" aria-hidden="true">
            {JOB_STATUSES.map((status) => (
              <section key={status} className={`bin ${status} skeleton`} />
            ))}
          </div>
        )}
        {jobsQuery.isError && (
          <div className="banner error" role="alert">
            <div>
              <strong>Could not load jobs.</strong>
              <p>{(jobsQuery.error as Error).message}</p>
            </div>
            <button className="btn" onClick={() => void jobsQuery.refetch()}>
              Retry
            </button>
          </div>
        )}

        {!jobsQuery.isLoading &&
          !jobsQuery.isError &&
          ((view === 'list' && visibleJobs.length === 0) ||
            (view === 'board' && boardStatuses.length === 0)) && (
            <div className="empty">
              <h2>{attentionOn ? 'Nothing needs attention' : 'Nothing in this view'}</h2>
              <p>
                {attentionOn
                  ? 'No holds, expired leases, or dead letters right now.'
                  : 'Queue a job, or clear the filters.'}
              </p>
              <button className="btn primary" onClick={() => setCreateOpen(true)}>
                Queue a job
              </button>
            </div>
          )}

        {view === 'board' && !jobsQuery.isLoading && !jobsQuery.isError && (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className={`board cols-${boardStatuses.length}`}>
              {boardStatuses.map((status) => (
                <Column
                  key={status}
                  status={status}
                  jobs={grouped[status]}
                  count={grouped[status].length}
                  dim={false}
                  busy={
                    statusMut.isPending ||
                    requeueMut.isPending ||
                    holdMut.isPending ||
                    releaseMut.isPending ||
                    heartbeatMut.isPending
                  }
                  now={now}
                  onMove={requestMove}
                  onDelete={setPendingDelete}
                  onInspect={setInspectedId}
                  onRequeue={(job) => requeueMut.mutate(job.id)}
                  onHold={(job) => holdMut.mutate(job.id)}
                  onRelease={(job) => releaseMut.mutate(job.id)}
                  onHeartbeat={(job) => heartbeatMut.mutate(job.id)}
                />
              ))}
            </div>
          </DndContext>
        )}

        {view === 'list' && visibleJobs.length > 0 && (
          <div className="table-wrap">
            <table className="jobs">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleJobs.map((job) => (
                  <tr key={job.id} onClick={() => setInspectedId(job.id)}>
                    <td>
                      <button className="card-title" onClick={() => setInspectedId(job.id)}>
                        {job.title}
                      </button>
                      <div className="muted mono">{shortId(job.id)}</div>
                    </td>
                    <td>{TYPE_META[job.type].label}</td>
                    <td>
                      <span className={`pill ${job.status}`}>
                        {STATUS_META[job.status].label}
                      </span>
                      {isStaleRunning(job, now) && <span className="pill stale">Stale</span>}
                      {job.held && <span className="pill held">Held</span>}
                      {job.deadLetter && <span className="pill failed">Dead letter</span>}
                    </td>
                    <td className="muted">{relativeTime(job.createdAt, now)}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <JobActions
                        job={job}
                        busy={
                          statusMut.isPending ||
                          requeueMut.isPending ||
                          holdMut.isPending ||
                          releaseMut.isPending ||
                          heartbeatMut.isPending
                        }
                        onMove={(next) => requestMove(job, next)}
                        onDelete={() => setPendingDelete(job)}
                        onRequeue={() => requeueMut.mutate(job.id)}
                        onHold={() => holdMut.mutate(job.id)}
                        onRelease={() => releaseMut.mutate(job.id)}
                        onHeartbeat={() => heartbeatMut.mutate(job.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {createOpen && (
        <CreatePanel
          busy={createMut.isPending}
          error={createMut.error?.message}
          onClose={() => setCreateOpen(false)}
          onSubmit={(title, type, key) => createMut.mutate({ title, type, key })}
        />
      )}

      {conflict && (
        <div className="overlay" onClick={() => setConflict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <p className="eyebrow">Another tab got there first</p>
            <h2>{conflict.title ?? 'Job already moved'}</h2>
            <p>{conflict.detail}</p>
            {conflict.job && (
              <p className="muted">
                “{conflict.job.title}” is now{' '}
                <strong>{STATUS_META[conflict.job.status].label}</strong>.
              </p>
            )}
            <div className="row">
              <button className="btn" onClick={() => setConflict(null)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="overlay" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <p className="eyebrow">Delete job</p>
            <h2>Remove “{pendingDelete.title}”?</h2>
            <p>This cannot be undone. History of the row is gone with it.</p>
            <div className="row">
              <button className="btn" onClick={() => setPendingDelete(null)}>
                Keep
              </button>
              <button
                className="btn danger"
                onClick={() => deleteMut.mutate(pendingDelete)}
                disabled={deleteMut.isPending}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {failTarget && (
        <FailPanel
          job={failTarget}
          busy={statusMut.isPending}
          onClose={() => setFailTarget(null)}
          onConfirm={(error) => {
            statusMut.mutate(
              {
                id: failTarget.id,
                from: failTarget.status,
                status: 'failed',
                error,
              },
              { onSuccess: () => setFailTarget(null) },
            );
          }}
        />
      )}

      {inspected && (
        <Inspector
          job={inspected}
          now={now}
          busy={
            statusMut.isPending ||
            requeueMut.isPending ||
            holdMut.isPending ||
            releaseMut.isPending ||
            heartbeatMut.isPending
          }
          onClose={() => setInspectedId(null)}
          onMove={(next) => requestMove(inspected, next)}
          onDelete={() => setPendingDelete(inspected)}
          onRequeue={() => requeueMut.mutate(inspected.id)}
          onHold={() => holdMut.mutate(inspected.id)}
          onRelease={() => releaseMut.mutate(inspected.id)}
          onHeartbeat={() => heartbeatMut.mutate(inspected.id)}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Column({
  status,
  jobs,
  count,
  dim,
  busy,
  now,
  onMove,
  onDelete,
  onInspect,
  onRequeue,
  onHold,
  onRelease,
  onHeartbeat,
}: {
  status: JobStatus;
  jobs: Job[];
  count: number;
  dim: boolean;
  busy: boolean;
  now: number;
  onMove: (job: Job, next: JobStatus) => void;
  onDelete: (job: Job) => void;
  onInspect: (id: string) => void;
  onRequeue: (job: Job) => void;
  onHold: (job: Job) => void;
  onRelease: (job: Job) => void;
  onHeartbeat: (job: Job) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section className={`bin ${status} ${isOver ? 'over' : ''} ${dim ? 'dim' : ''}`}>
      <header>
        <h2>{STATUS_META[status].label}</h2>
        <span className="count">{count}</span>
      </header>
      <div ref={setNodeRef} className="stack">
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            busy={busy}
            now={now}
            onMove={onMove}
            onDelete={onDelete}
            onInspect={onInspect}
            onRequeue={onRequeue}
            onHold={onHold}
            onRelease={onRelease}
            onHeartbeat={onHeartbeat}
          />
        ))}
        {jobs.length === 0 && (
          <p className="column-empty">No {STATUS_META[status].label.toLowerCase()} jobs</p>
        )}
      </div>
    </section>
  );
}

function JobCard({
  job,
  busy,
  now,
  onMove,
  onDelete,
  onInspect,
  onRequeue,
  onHold,
  onRelease,
  onHeartbeat,
}: {
  job: Job;
  busy: boolean;
  now: number;
  onMove: (job: Job, next: JobStatus) => void;
  onDelete: (job: Job) => void;
  onInspect: (id: string) => void;
  onRequeue: (job: Job) => void;
  onHold: (job: Job) => void;
  onRelease: (job: Job) => void;
  onHeartbeat: (job: Job) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: job.id,
      data: { job },
      disabled: job.status === 'completed' || job.status === 'failed',
    });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  const stale = isStaleRunning(job, now);

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`ticket ${job.status} ${isDragging ? 'dragging' : ''} ${stale ? 'stale' : ''}`}
    >
      <div className="card-head" {...listeners} {...attributes}>
        <button className="card-title" onClick={() => onInspect(job.id)}>
          {job.title}
        </button>
        <span className="type">{TYPE_META[job.type].label}</span>
      </div>
      <p className="muted mono">
        {shortId(job.id)} · {relativeTime(job.createdAt, now)}
        {job.status === 'running' && job.startedAt ? ` · ${elapsed(job.startedAt, now)}` : ''}
        {job.status === 'running'
          ? ` · lease ${leaseLeft(job.leaseUntil, now) ?? (stale ? 'expired' : 'open')}`
          : ''}
        {stale ? ' · stale' : ''}
        {job.assignee ? ` · ${job.assignee}` : ''}
      </p>
      {(job.held || job.attempts > 0 || job.deadLetter) && (
        <div className="flags">
          {job.held && <span className="pill held">Held</span>}
          {job.attempts > 0 && (
            <span className="pill pending">
              {job.attempts}/{job.maxAttempts} tries
            </span>
          )}
          {job.deadLetter && <span className="pill failed">Dead letter</span>}
        </div>
      )}
      {job.lastError && <p className="error-note">{job.lastError}</p>}
      <JobActions
        job={job}
        busy={busy}
        onMove={(next) => onMove(job, next)}
        onDelete={() => onDelete(job)}
        onRequeue={() => onRequeue(job)}
        onHold={() => onHold(job)}
        onRelease={() => onRelease(job)}
        onHeartbeat={() => onHeartbeat(job)}
      />
    </article>
  );
}

function JobActions({
  job,
  busy,
  onMove,
  onDelete,
  onRequeue,
  onHold,
  onRelease,
  onHeartbeat,
}: {
  job: Job;
  busy: boolean;
  onMove: (next: JobStatus) => void;
  onDelete: () => void;
  onRequeue: () => void;
  onHold: () => void;
  onRelease: () => void;
  onHeartbeat: () => void;
}) {
  return (
    <div className="actions">
      {canTransition(job.status, 'running') && !job.held && (
        <button className="btn tiny" disabled={busy} onClick={() => onMove('running')}>
          Start
        </button>
      )}
      {job.status === 'pending' && !job.held && (
        <button className="btn tiny" disabled={busy} onClick={onHold}>
          Hold
        </button>
      )}
      {job.status === 'pending' && job.held && (
        <button className="btn tiny" disabled={busy} onClick={onRelease}>
          Release
        </button>
      )}
      {job.status === 'running' && (
        <button className="btn tiny" disabled={busy} onClick={onHeartbeat}>
          Keep alive
        </button>
      )}
      {canTransition(job.status, 'completed') && (
        <button className="btn tiny" disabled={busy} onClick={() => onMove('completed')}>
          Complete
        </button>
      )}
      {canTransition(job.status, 'failed') && (
        <button className="btn tiny" disabled={busy} onClick={() => onMove('failed')}>
          Fail
        </button>
      )}
      {(job.status === 'completed' || job.status === 'failed') && !job.deadLetter && (
        <button className="btn tiny" disabled={busy} onClick={onRequeue}>
          Requeue
        </button>
      )}
      <button className="btn tiny" disabled={busy} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function Inspector({
  job,
  now,
  busy,
  onClose,
  onMove,
  onDelete,
  onRequeue,
  onHold,
  onRelease,
  onHeartbeat,
}: {
  job: Job;
  now: number;
  busy: boolean;
  onClose: () => void;
  onMove: (next: JobStatus) => void;
  onDelete: () => void;
  onRequeue: () => void;
  onHold: () => void;
  onRelease: () => void;
  onHeartbeat: () => void;
}) {
  const copyId = async () => {
    await navigator.clipboard.writeText(job.id);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="work-order" onClick={(e) => e.stopPropagation()} role="dialog">
        <p className="eyebrow">{TYPE_META[job.type].label}</p>
        <h2>{job.title}</h2>
        <div className="meta-row">
          <span className={`pill ${job.status}`}>{STATUS_META[job.status].label}</span>
          {isStaleRunning(job, now) && <span className="pill stale">Stale lease</span>}
          {job.held && <span className="pill held">Held</span>}
          {job.deadLetter && <span className="pill failed">Dead letter</span>}
        </div>
        <ol className="timeline">
          <li>
            <strong>Created</strong>
            <span>{clock(job.createdAt)}</span>
          </li>
          <li>
            <strong>Started</strong>
            <span>
              {job.startedAt
                ? `${clock(job.startedAt)}${job.status === 'running' ? ` · ${elapsed(job.startedAt, now)}` : ''}`
                : 'Not yet'}
            </span>
          </li>
          <li>
            <strong>Lease</strong>
            <span>
              {job.status === 'running'
                ? leaseLeft(job.leaseUntil, now) ?? 'No expiry'
                : 'Not in flight'}
            </span>
          </li>
          <li>
            <strong>Assignee</strong>
            <span>{job.assignee ?? 'Unclaimed'}</span>
          </li>
          <li>
            <strong>Tries</strong>
            <span>
              {job.attempts}/{job.maxAttempts}
            </span>
          </li>
          <li>
            <strong>Finished</strong>
            <span>{job.finishedAt ? clock(job.finishedAt) : 'Still open'}</span>
          </li>
        </ol>
        {job.sourceJobId && (
          <p className="muted">Retry of {shortId(job.sourceJobId)}</p>
        )}
        {job.lastError && <p className="error-note">{job.lastError}</p>}
        <p className="muted mono">
          {job.id}{' '}
          <button className="linkish" onClick={() => void copyId()}>
            Copy ID
          </button>
        </p>
        <JobActions
          job={job}
          busy={busy}
          onMove={onMove}
          onDelete={onDelete}
          onRequeue={onRequeue}
          onHold={onHold}
          onRelease={onRelease}
          onHeartbeat={onHeartbeat}
        />
        <div className="row">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}

function FailPanel({
  job,
  busy,
  onClose,
  onConfirm,
}: {
  job: Job;
  busy: boolean;
  onClose: () => void;
  onConfirm: (error: string) => void;
}) {
  const [error, setError] = useState('Marked failed by an operator.');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <p className="eyebrow">Mark failed</p>
        <h2>{job.title}</h2>
        <p>Add a short reason. This is stored on the job for the next person who looks.</p>
        <label className="block-label">
          Reason
          <input
            autoFocus
            value={error}
            onChange={(e) => setError(e.target.value)}
            maxLength={240}
          />
        </label>
        <div className="row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={busy || error.trim().length < 3}
            onClick={() => onConfirm(error.trim())}
          >
            Fail job
          </button>
        </div>
      </div>
    </div>
  );
}

function CreatePanel({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (title: string, type: JobType, key: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<JobType>('email');
  const [key] = useState(() => crypto.randomUUID());

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="work-order" onClick={(e) => e.stopPropagation()} role="dialog">
        <p className="eyebrow">New ticket</p>
        <h2>Queue a job</h2>
        <p className="muted">
          New work always enters as waiting. Starting it is a separate, atomic
          claim.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(title.trim(), type, key);
          }}
        >
          <label>
            Title
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              minLength={3}
              maxLength={120}
              required
              placeholder="Send March invoices"
            />
          </label>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as JobType)}>
              {JOB_TYPES.map((item) => (
                <option key={item} value={item}>
                  {TYPE_META[item].label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error-note">{error}</p>}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || title.trim().length < 3}>
              {busy ? 'Queuing…' : 'Create job'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="6" fill="#c2410c" />
      <path d="M7 7h14l-4 7v6l-3 3-3-3v-6L7 7z" fill="#fff7f2" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 14.5A7.5 7.5 0 0 1 9.5 6 7.5 7.5 0 1 0 18 14.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="currentColor" />
      <path
        d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
