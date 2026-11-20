/**
 * CI run page, pure half (r9 E9): the words, durations and bar geometry the run list and run page draw. No React, no
 * clock (`nowMs` is an argument), no network, so every rule here is a plain unit test.
 *
 * The timing itself is E8's (`contract/ci-timing.ts`, imported by path): this file only turns its answers into words and
 * percentages.
 */
import { durationMs } from '../../../contract/ci-timing.ts';
import type { CiJob, CiRun, CiStatus, CiStep } from '../../../contract/wire.ts';

/** One status, one word (never colour alone: every state also has its own icon and this word). */
export const STATUS_WORD: Readonly<Record<CiStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** A duration as a person says it: `0.4s`, `42s`, `3m 05s`, `1h 02m`. Negative or non-finite reads as `0s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** What started a run, as words. An event this list does not know is shown as GitHub named it. */
export function triggerWord(trigger: string): string {
  switch (trigger) {
    case 'pull_request':
    case 'pull_request_target':
      return 'Pull request';
    case 'push':
      return 'Push';
    case 'schedule':
      return 'Schedule';
    case 'workflow_dispatch':
      return 'Manual';
    case 'workflow_call':
      return 'Called';
    case 'check':
      return 'Check';
    default:
      return trigger.replaceAll('_', ' ');
  }
}

/** A run's commit, short. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

const at = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** One bar's inputs: what E8 recorded for it (`start`, `end`) and whether E8 saw it still running (`live`). */
export interface Timed {
  readonly start?: string;
  readonly end?: string;
  readonly live?: boolean;
}

/**
 * How long a bar is: the ONE duration its label and its geometry both read. It is E8's own `durationMs` (the bounds E8
 * put on each item: a step clamped inside its job ends where the job ends), except that an item still running ticks to
 * `nowMs` while every level above it is live too (`ticking`). A "live" step inside a job or run that has stopped keeps
 * E8's end and never grows with the browser clock. An item with no bar (skipped, not started) is `undefined`, never `0`.
 */
export function barMs(item: Timed, nowMs: number, ticking: boolean): number | undefined {
  const start = at(item.start);
  if (start === undefined) return undefined;
  if (ticking && item.live === true) return Math.max(0, nowMs - start);
  return durationMs(item, nowMs);
}

/** The span a job's steps are drawn against: the job's own bar, so a step's bar says what share of the job it took. */
export interface BarFrame {
  readonly start: number;
  readonly length: number;
}

/** The frame of a job (`ticking`: its run is live), or `undefined` when the job has no bar (then its steps have none either). */
export function jobFrame(job: CiJob, nowMs: number, ticking: boolean): BarFrame | undefined {
  const start = at(job.start);
  const length = barMs(job, nowMs, ticking);
  return start === undefined || length === undefined ? undefined : { start, length };
}

/**
 * Where a step's bar sits inside its job's, in percent of the job's width: left edge and width. `undefined`: no bar.
 * `ticking`: the step's job and run are live too.
 */
export function stepSpan(
  step: CiStep,
  frame: BarFrame | undefined,
  nowMs: number,
  ticking: boolean,
): { readonly left: number; readonly width: number } | undefined {
  const start = at(step.start);
  const length = barMs(step, nowMs, ticking);
  if (frame === undefined || start === undefined || length === undefined) return undefined;
  // A zero-length job is one whole bar; nothing to divide.
  if (frame.length <= 0) return { left: 0, width: 100 };
  const left = Math.min(100, Math.max(0, ((start - frame.start) / frame.length) * 100));
  const width = Math.min(100 - left, Math.max(0, (length / frame.length) * 100));
  return { left, width };
}

/** A bar thinner than this is still drawn this wide, so a one-second step is visible next to a ten-minute one. */
export const MIN_BAR_PERCENT = 1.5;

/** A bar's drawn width: its true share, but never thinner than `MIN_BAR_PERCENT` (and never past the right edge). */
export function drawnSpan(span: { readonly left: number; readonly width: number }): {
  readonly left: number;
  readonly width: number;
} {
  const width = Math.max(span.width, MIN_BAR_PERCENT);
  return { left: Math.min(span.left, 100 - width), width };
}

/** A job that has stopped for good: nothing inside it is still going. */
const SETTLED_JOB: ReadonlySet<CiStatus> = new Set<CiStatus>(['passed', 'failed', 'cancelled', 'skipped']);

/** Is this job over? Then no step inside it can still be running, whatever its own data says. */
export const jobSettled = (job: CiJob): boolean => SETTLED_JOB.has(job.status);

/**
 * The status a step is DRAWN with. A step the data still calls `running` inside a job that is over (a cancelled run
 * leaves such a step behind) never spins: it was stopped, so it reads as cancelled. Every other step shows as it is.
 */
export function shownStepStatus(step: CiStep, job: CiJob): CiStatus {
  return step.status === 'running' && jobSettled(job) ? 'cancelled' : step.status;
}

/** The runs, failing first then running then the rest, each group newest first. A stable, total order. */
export function orderRuns(runs: readonly CiRun[]): readonly CiRun[] {
  const rank = (run: CiRun): number => (run.status === 'failed' ? 0 : run.status === 'running' ? 1 : 2);
  return [...runs].sort((a, b) => rank(a) - rank(b) || (at(b.createdAt) ?? 0) - (at(a.createdAt) ?? 0) || b.id - a.id);
}

/** A check from a CI that is not GitHub Actions: one bar, no jobs, `check` as its trigger (E8's `buildCheckRun`). */
export const isCheck = (run: CiRun): boolean => run.trigger === 'check' && run.jobs.length === 0;

/**
 * Where a check from another CI opens: its own page on GitHub, and only that. A check's `url` is whatever the CI told
 * GitHub, so anything but an `https://github.com/…` address (a plain http link, another host, `javascript:`) is not
 * linked at all.
 */
export function checkHref(run: CiRun): string | undefined {
  if (run.url === undefined) return undefined;
  try {
    const url = new URL(run.url);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' && url.password === ''
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The one line over the run list: how many, and how many need a look. */
export function runsSummary(runs: readonly CiRun[]): string {
  if (runs.length === 0) return 'No CI runs';
  const failed = runs.filter(run => run.status === 'failed').length;
  const running = runs.filter(run => run.status === 'running' || run.status === 'queued').length;
  const parts = [`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} in progress`);
  return parts.join(' · ');
}

/**
 * Does a run still move? Then the screen keeps asking and keeps its clock ticking. Only the run's own state says so: a job
 * or step E8 still flags live inside a run that has finished is stale (it never grows), so it keeps nothing ticking.
 */
export const isLive = (run: CiRun): boolean => run.live === true;

/** Does any run in the list still move? */
export const anyLive = (runs: readonly CiRun[]): boolean => runs.some(isLive);

/** How many jobs open by themselves: a run with 256 failed jobs must not mount 256 step lists on arrival. */
export const DEFAULT_OPEN_JOBS = 4;

/** How many steps of an open job are drawn before "Show more": a job may carry 500, and each is a row. */
export const STEPS_FIRST_PAGE = 25;

/** A job needs a look when it failed, or is still going. */
const needsLook = (job: CiJob): boolean => job.status === 'failed' || job.status === 'running';

/**
 * The jobs that open by themselves: the first `DEFAULT_OPEN_JOBS` that need a look, failed ones before running ones, each
 * group in the run's own order. The rest stay shut until asked (their header still says Failed or Running).
 */
export function opensByDefault(jobs: readonly CiJob[]): ReadonlySet<number> {
  const failed = jobs.filter(job => job.status === 'failed');
  const running = jobs.filter(job => job.status === 'running');
  return new Set([...failed, ...running].slice(0, DEFAULT_OPEN_JOBS).map(job => job.id));
}

/** How many jobs need a look in all (to say how many stayed shut). */
export const needLookCount = (jobs: readonly CiJob[]): number => jobs.filter(needsLook).length;

/** The sentence for a step that took longest, or `undefined` when no step has a bar. */
export function slowestSentence(job: string, step: string, ms: number): string {
  return `Slowest step: ${step} in ${job}, ${formatDuration(ms)}`;
}
