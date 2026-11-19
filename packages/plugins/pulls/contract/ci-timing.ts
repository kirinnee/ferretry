/**
 * CI timing (r9 E8): GitHub's workflow runs, jobs, steps and check runs folded into the `CiRun` the E9–E11 screens draw.
 * PURE: no clock (`nowMs` is an argument), no network, no state. Shared by E9 (run page), E10 (timeline) and E11
 * (flamegraph); only E8 edits it.
 *
 * What the model promises:
 *  - A running item ends at `nowMs` and is flagged `live`.
 *  - A skipped item, and an item that never started, has NO `start`/`end` (no bar).
 *  - A step outside its job (clock skew) is pulled inside the job and flagged `clamped`.
 *  - A re-run's `createdAt` is when THAT attempt began (GitHub keeps the first attempt's `created_at`), so a timeline
 *    never shows the first attempt's hours as queue time.
 */
import type { CiJob, CiRun, CiStatus, CiStep } from './wire.ts';

/** What this lib reads of a GitHub Actions run. Times are GitHub's text; `null` is "not yet". */
export interface ActionsRunInput {
  readonly id: number;
  readonly name: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly createdAt: string;
  readonly runStartedAt: string | null;
  readonly updatedAt: string;
  readonly htmlUrl: string | null;
}

export interface ActionsStepInput {
  readonly name: string;
  readonly number: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ActionsJobInput {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly htmlUrl: string | null;
  readonly steps: readonly ActionsStepInput[];
}

/** A check run from a CI that is not GitHub Actions (Jenkins, CircleCI …): one bar, no steps. */
export interface CheckRunInput {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly htmlUrl: string | null;
}

const NAME_MAX = 500;

/** The instant (ms) GitHub's text names, or `undefined` for "not yet" or text that is not a date. */
const at = (text: string | null | undefined): number | undefined => {
  if (text === null || text === undefined || text === '') return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const clip = (name: string): string => (name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name);

/**
 * GitHub's `status` + `conclusion` pair as one word. A status that is not `completed` has not finished (`in_progress`
 * is running; `queued`, `waiting`, `requested`, `pending` and anything new read as queued). A completed item is passed
 * for `success` and `neutral`, cancelled for `cancelled` and `stale`, skipped for `skipped`, queued for
 * `action_required` (nothing ran: it waits for an approval), and failed for everything else (`failure`, `timed_out`,
 * `startup_failure`, an unknown or missing conclusion): an unknown outcome is never shown as a pass.
 */
export function foldStatus(status: string, conclusion: string | null): CiStatus {
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued';
  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'passed';
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'action_required':
      return 'queued';
    default:
      return 'failed';
  }
}

const isFinal = (status: CiStatus): boolean => status !== 'queued' && status !== 'running';

interface Bounds {
  readonly start: number;
  readonly end: number;
}

function buildStep(step: ActionsStepInput, job: Bounds | undefined, nowMs: number): CiStep {
  const status = foldStatus(step.status, step.conclusion);
  const base = { name: clip(step.name), number: step.number, status };
  const start = at(step.startedAt);
  if (status === 'skipped' || status === 'queued' || start === undefined) return base;
  const done = at(step.completedAt);
  const live = status === 'running' && done === undefined;
  let from = start;
  let to = live ? nowMs : (done ?? start);
  let clamped = false;
  if (to < from) {
    to = from;
    clamped = true;
  }
  if (job !== undefined) {
    const lo = Math.min(Math.max(from, job.start), job.end);
    const hi = Math.min(Math.max(to, lo), job.end);
    if (lo !== from || hi !== to) clamped = true;
    from = lo;
    to = hi;
  }
  return {
    ...base,
    start: iso(from),
    end: iso(to),
    ...(live ? { live: true } : {}),
    ...(clamped ? { clamped: true } : {}),
  };
}

/**
 * `settledMs` is when the run last changed (its `updated_at`, never before `base`): the stable instant an item that never
 * started waited until, once the item or its run is final. Only a queued item of a live run waits until `nowMs`, so a
 * cancelled job with no timestamps never accrues queue time after its run finished.
 */
function buildJob(job: ActionsJobInput, base: number, nowMs: number, settledMs: number, runFinal: boolean): CiJob {
  const status = foldStatus(job.status, job.conclusion);
  const started = at(job.startedAt);
  const done = at(job.completedAt);
  const hasBar = status !== 'skipped' && status !== 'queued' && started !== undefined;
  const live = hasBar && status === 'running' && done === undefined;
  // A live bar ends now, but never before it began (a clock behind GitHub's would put the end before the start).
  const end = hasBar ? (live ? Math.max(nowMs, started) : Math.max(done ?? started, started)) : undefined;
  const bounds = hasBar && end !== undefined ? { start: started, end } : undefined;
  // From the run's creation to this job's start. A job that never started waited until it stopped (or until now).
  const queuedMs = hasBar
    ? Math.max(0, started - base)
    : status === 'skipped'
      ? 0
      : Math.max(0, (done ?? (isFinal(status) || runFinal ? settledMs : nowMs)) - base);
  return {
    id: job.id,
    name: clip(job.name),
    status,
    queuedMs,
    ...(hasBar && end !== undefined ? { start: iso(started), end: iso(end) } : {}),
    ...(live ? { live: true } : {}),
    steps: job.steps.map(step => buildStep(step, bounds, nowMs)),
    ...(job.htmlUrl === null ? {} : { url: job.htmlUrl }),
  };
}

const byStart = (a: CiJob, b: CiJob): number =>
  (a.start === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.start)) -
    (b.start === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.start)) || a.id - b.id;

/** One GitHub Actions run and its jobs (the latest attempt's, or the attempt asked for) as a `CiRun`. */
export function buildRun(run: ActionsRunInput, jobs: readonly ActionsJobInput[], nowMs: number): CiRun {
  const created = at(run.createdAt) ?? nowMs;
  const attemptStart = at(run.runStartedAt);
  // A re-run keeps the first attempt's `created_at`; its own start is the origin of its timeline.
  const base = run.runAttempt > 1 ? (attemptStart ?? created) : created;
  const status = foldStatus(run.status, run.conclusion);
  const live = !isFinal(status);
  const settledMs = Math.max(base, at(run.updatedAt) ?? base);
  const built = jobs.map(job => buildJob(job, base, nowMs, settledMs, !live)).sort(byStart);
  const starts = built.flatMap(job => (job.start === undefined ? [] : [Date.parse(job.start)]));
  const ends = built.flatMap(job => (job.end === undefined ? [] : [Date.parse(job.end)]));
  const firstStart = starts.length === 0 ? undefined : Math.min(...starts);
  const start = attemptStart ?? firstStart;
  const end = live ? undefined : Math.max(base, ends.length === 0 ? (at(run.updatedAt) ?? base) : Math.max(...ends));
  const wallMs = Math.max(0, (end ?? nowMs) - base);
  // Creation to the first job start, or to when it stopped (or to now) while nothing has started.
  const queuedMs = Math.max(0, (firstStart ?? end ?? nowMs) - base);
  return {
    id: run.id,
    name: clip(run.name),
    status,
    trigger: run.event.slice(0, 100),
    attempt: Math.max(1, Math.floor(run.runAttempt)),
    headSha: run.headSha,
    createdAt: iso(base),
    ...(start === undefined ? {} : { start: iso(start) }),
    ...(end === undefined ? {} : { end: iso(end) }),
    queuedMs,
    wallMs,
    ...(live ? { live: true } : {}),
    jobs: built,
    ...(run.htmlUrl === null ? {} : { url: run.htmlUrl }),
  };
}

/** A check run from a CI that is not GitHub Actions: one bar, no jobs. */
export function buildCheckRun(check: CheckRunInput, headSha: string, nowMs: number): CiRun {
  const status = foldStatus(check.status, check.conclusion);
  const started = at(check.startedAt);
  const done = at(check.completedAt);
  const base = started ?? nowMs;
  const live = !isFinal(status);
  const end = live ? undefined : Math.max(base, done ?? base);
  return {
    id: check.id,
    name: clip(check.name),
    status,
    trigger: 'check',
    attempt: 1,
    headSha,
    createdAt: iso(base),
    ...(started === undefined || status === 'skipped' ? {} : { start: iso(started) }),
    ...(end === undefined ? {} : { end: iso(end) }),
    queuedMs: 0,
    wallMs: Math.max(0, (end ?? nowMs) - base),
    ...(live ? { live: true } : {}),
    jobs: [],
    ...(check.htmlUrl === null ? {} : { url: check.htmlUrl }),
  };
}

/** A bar's length in ms: the end (or `nowMs` for a live bar) minus the start; `0` for an item with no bar. */
export function durationMs(item: { readonly start?: string; readonly end?: string }, nowMs: number): number {
  if (item.start === undefined) return 0;
  const to = item.end === undefined ? nowMs : Date.parse(item.end);
  return Math.max(0, to - Date.parse(item.start));
}

/** The step that took longest across every job of a run (the first of equals), or `undefined` when none has a bar. */
export function slowestStep(run: CiRun, nowMs: number): { readonly job: CiJob; readonly step: CiStep } | undefined {
  let best: { job: CiJob; step: CiStep; ms: number } | undefined;
  for (const job of run.jobs)
    for (const step of job.steps) {
      const ms = durationMs(step, nowMs);
      if (ms > 0 && (best === undefined || ms > best.ms)) best = { job, step, ms };
    }
  return best === undefined ? undefined : { job: best.job, step: best.step };
}
