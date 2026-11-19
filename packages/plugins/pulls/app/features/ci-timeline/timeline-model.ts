/**
 * The timeline's LAYOUT (r9 E10), pure: a `CiRun` in, rows and segments out, in milliseconds since the run was created.
 * No clock (`nowMs` is an argument), no DOM, no pixels except the two pure maps at the bottom (`xOf`, `chartWidth`), so
 * every number the screen draws is checked here from E8's fixtures.
 *
 *  - x = time since the run was created. A re-run's `createdAt` is its own attempt's start (E8), so the origin is right.
 *  - One row per job, in the order E8 gives (by start). A run with no jobs (a check run from another CI) is one row.
 *  - A job's QUEUE WAIT is the span from the origin to its start (or, for a job that never started, `queuedMs`).
 *  - A skipped job or step has no bar; the row stays, so the matrix reads whole.
 *  - Focus order is job, then its steps, then the next job. Arrow keys move through it (`moveFocus`).
 */
import type { CiJob, CiRun, CiStatus, CiStep } from '../../../contract/index.ts';

/** A drawn bar: `startMs`/`endMs` are offsets from the run's creation, both inside `[0, spanMs]`. */
export interface TimelineMark {
  /** Unique in the layout: `j<jobIndex>` for a job, `j<jobIndex>s<stepIndex>` for a step. */
  readonly key: string;
  readonly kind: 'job' | 'step';
  readonly name: string;
  /** The job's name for a step; the same as `name` for a job. */
  readonly jobName: string;
  readonly status: CiStatus;
  readonly startMs: number;
  readonly endMs: number;
  readonly live: boolean;
  /** A step that fell outside its job (clock skew) and was pulled inside. */
  readonly clamped: boolean;
}

export interface TimelineRow {
  readonly key: string;
  readonly jobIndex: number;
  readonly name: string;
  readonly status: CiStatus;
  readonly live: boolean;
  /** The job's own bar, or `undefined` for a job that never started (queued, skipped, cancelled before it began). */
  readonly bar: TimelineMark | undefined;
  /** The steps with a bar, in the order GitHub numbers them. */
  readonly steps: readonly TimelineMark[];
  /** How long the job waited from the origin; `0` for a skipped job. The hatched span is `[0, queueMs]`. */
  readonly queueMs: number;
}

export interface TimelineTick {
  readonly ms: number;
  readonly label: string;
}

export interface TimelineLayout {
  /** The origin: the run's creation, in epoch ms. */
  readonly originMs: number;
  /** The width of the time axis: the run's wall time (to now while live), never less than one second. */
  readonly spanMs: number;
  /** Where "now" is on the axis while the run is live; `undefined` once it is final. */
  readonly nowMs: number | undefined;
  readonly rows: readonly TimelineRow[];
}

const MIN_SPAN_MS = 1_000;

const offset = (instant: string | undefined, originMs: number): number | undefined => {
  if (instant === undefined) return undefined;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? parsed - originMs : undefined;
};
const clampTo = (value: number, span: number): number => Math.min(Math.max(value, 0), span);

/** The bar of an item that has one: its offsets inside `[0, span]`, or `undefined` when it has no start. */
function barOf(
  item: { readonly start?: string; readonly end?: string; readonly live?: boolean },
  originMs: number,
  span: number,
  nowOffset: number,
): { startMs: number; endMs: number } | undefined {
  const start = offset(item.start, originMs);
  if (start === undefined) return undefined;
  const end = item.live === true ? nowOffset : (offset(item.end, originMs) ?? start);
  const from = clampTo(start, span);
  return { startMs: from, endMs: clampTo(Math.max(end, from), span) };
}

/** Lay a run out. `nowMs` is the clock the caller reads (a prop in a screenshot), so the same inputs always draw the same. */
export function layoutTimeline(run: CiRun, nowMs: number): TimelineLayout {
  const originMs = Date.parse(run.createdAt);
  const nowOffset = Math.max(0, nowMs - originMs);
  // Wide enough for the run's wall time AND every bar the data draws (a clock that disagrees must not clip a bar).
  const ends = [run.wallMs, run.live === true ? nowOffset : 0];
  for (const job of run.jobs) {
    ends.push(offset(job.end, originMs) ?? 0, job.queuedMs);
    for (const step of job.steps) ends.push(offset(step.end, originMs) ?? 0);
  }
  const spanMs = Math.max(MIN_SPAN_MS, ...ends);

  const rows: TimelineRow[] =
    run.jobs.length > 0
      ? run.jobs.map((job, jobIndex) => rowOfJob(job, jobIndex, originMs, spanMs, nowOffset))
      : [rowOfRun(run, originMs, spanMs, nowOffset)];
  return { originMs, spanMs, nowMs: run.live === true ? Math.min(nowOffset, spanMs) : undefined, rows };
}

function rowOfJob(job: CiJob, jobIndex: number, originMs: number, spanMs: number, nowOffset: number): TimelineRow {
  const key = `j${jobIndex}`;
  const geometry = barOf(job, originMs, spanMs, nowOffset);
  const bar: TimelineMark | undefined =
    geometry === undefined
      ? undefined
      : {
          key,
          kind: 'job',
          name: job.name,
          jobName: job.name,
          status: job.status,
          ...geometry,
          live: job.live === true,
          clamped: false,
        };
  const steps = job.steps.flatMap((step, stepIndex): TimelineMark[] => {
    const stepGeometry = barOf(step, originMs, spanMs, nowOffset);
    return stepGeometry === undefined ? [] : [stepMark(step, `${key}s${stepIndex}`, job.name, stepGeometry)];
  });
  return {
    key,
    jobIndex,
    name: job.name,
    status: job.status,
    live: job.live === true,
    bar,
    steps,
    queueMs: job.status === 'skipped' ? 0 : clampTo(bar === undefined ? job.queuedMs : bar.startMs, spanMs),
  };
}

const stepMark = (
  step: CiStep,
  key: string,
  jobName: string,
  geometry: { startMs: number; endMs: number },
): TimelineMark => ({
  key,
  kind: 'step',
  name: step.name,
  jobName,
  status: step.status,
  ...geometry,
  live: step.live === true,
  clamped: step.clamped === true,
});

/** A CI that is not GitHub Actions has no jobs: the run itself is the one row, one bar, no steps. */
function rowOfRun(run: CiRun, originMs: number, spanMs: number, nowOffset: number): TimelineRow {
  const geometry = barOf(run, originMs, spanMs, nowOffset);
  const bar: TimelineMark | undefined =
    geometry === undefined
      ? undefined
      : {
          key: 'j0',
          kind: 'job',
          name: run.name,
          jobName: run.name,
          status: run.status,
          ...geometry,
          live: run.live === true,
          clamped: false,
        };
  return {
    key: 'j0',
    jobIndex: 0,
    name: run.name,
    status: run.status,
    live: run.live === true,
    bar,
    steps: [],
    queueMs: run.status === 'skipped' ? 0 : clampTo(bar === undefined ? run.queuedMs : bar.startMs, spanMs),
  };
}

// ─── time words ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `45 s`, `1 m 28 s`, `2 h 05 m`: what a person says about a CI step. Under a second reads as `<1 s`. */
export function formatSpan(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000));
  if (whole === 0) return ms > 0 ? '<1 s' : '0 s';
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} m` : `${minutes} m ${String(seconds).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} m`;
}

/** `+12 s` since the run was created; `at creation` for the origin itself. */
export const formatOffset = (ms: number): string =>
  Math.round(ms / 1000) === 0 ? 'at creation' : `+${formatSpan(ms)}`;

const STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
  7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const;

/**
 * Round ticks from zero: the smallest step in the list that leaves at most `maxTicks` ticks, so every label is a number
 * a person would say ("30 s", "5 m"). At least the origin; never more than `maxTicks + 1`.
 */
export function timelineTicks(spanMs: number, maxTicks: number): readonly TimelineTick[] {
  const limit = Math.max(1, Math.floor(maxTicks));
  const step = STEPS_MS.find(candidate => spanMs / candidate <= limit) ?? STEPS_MS[STEPS_MS.length - 1]!;
  const ticks: TimelineTick[] = [];
  for (let ms = 0; ms <= spanMs && ticks.length <= limit; ms += step)
    ticks.push({ ms, label: ms === 0 ? '0' : formatSpan(ms) });
  return ticks;
}

// ─── pixels ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Narrower than this and a 20-step job is unreadable: the chart then scrolls sideways inside its own box. */
export const PLOT_MIN_PX = 640;
/** The room to the right of the last tick, so its label and a live now-line are never clipped. */
const PLOT_PAD_PX = 16;

/**
 * The plot's width: the box's own room when it fits (or when the person pressed Fit), otherwise the minimum that keeps
 * the chart readable, which the box then scrolls.
 */
export const plotWidth = (roomPx: number, fit: boolean): number =>
  fit ? Math.max(120, roomPx) : Math.max(PLOT_MIN_PX, roomPx);

/** Whether Fit changes anything: only when the readable minimum is wider than the room. */
export const canFit = (roomPx: number): boolean => roomPx > 0 && roomPx < PLOT_MIN_PX;

/** The room to the left of second zero, so the first bar never sits on the names' divider. */
const PLOT_LEFT_PX = 8;

/** An offset on the axis as an x in a plot `widthPx` wide (the left inset and the right padding stay free). */
export const xOf = (ms: number, spanMs: number, widthPx: number): number =>
  PLOT_LEFT_PX + (Math.min(Math.max(ms, 0), spanMs) / spanMs) * Math.max(0, widthPx - PLOT_PAD_PX - PLOT_LEFT_PX);

/** A bar's width, never under 2 px: a very short step is still a mark, never a hole. */
export const barWidth = (mark: { startMs: number; endMs: number }, spanMs: number, widthPx: number): number =>
  Math.max(2, xOf(mark.endMs, spanMs, widthPx) - xOf(mark.startMs, spanMs, widthPx));

// ─── keyboard ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every focusable mark, in reading order: a job, then its steps, then the next job. */
export const focusOrder = (layout: TimelineLayout): readonly TimelineMark[] =>
  layout.rows.flatMap(row => (row.bar === undefined ? row.steps : [row.bar, ...row.steps]));

export type FocusKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
export const FOCUS_KEYS: readonly string[] = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * Where a key takes focus. Left and right walk the marks of one row (the job, then its steps); up and down move to the
 * same place in the next or previous row that has marks (the same step number, or its last step when it has fewer);
 * Home and End are the first and last mark. The edge stays put, nothing wraps.
 */
export function moveFocus(layout: TimelineLayout, current: string | undefined, key: FocusKey): string | undefined {
  const order = focusOrder(layout);
  if (order.length === 0) return undefined;
  const at = order.findIndex(mark => mark.key === current);
  if (at < 0 || key === 'Home') return order[0]!.key;
  if (key === 'End') return order[order.length - 1]!.key;
  const rows = layout.rows
    .map(row => (row.bar === undefined ? row.steps : [row.bar, ...row.steps]))
    .filter(r => r.length > 0);
  const rowAt = rows.findIndex(marks => marks.some(mark => mark.key === current));
  const row = rows[rowAt]!;
  const column = row.findIndex(mark => mark.key === current);
  if (key === 'ArrowRight') return row[Math.min(row.length - 1, column + 1)]!.key;
  if (key === 'ArrowLeft') return row[Math.max(0, column - 1)]!.key;
  const next = rows[Math.min(rows.length - 1, Math.max(0, rowAt + (key === 'ArrowDown' ? 1 : -1)))]!;
  return next[Math.min(next.length - 1, column)]!.key;
}

/** One sentence for a mark: name, status, when it started and how long it took. Read aloud and shown in the readout. */
export function describeMark(
  mark: TimelineMark,
  queueMs: number,
  localTime: (offsetMs: number) => string = () => '',
): string {
  const what = mark.kind === 'step' ? `${mark.jobName} › ${mark.name}` : mark.name;
  const length = `${mark.live ? 'running for ' : ''}${formatSpan(mark.endMs - mark.startMs)}`;
  const wait = mark.kind === 'job' && queueMs > 0 ? `, waited ${formatSpan(queueMs)} first` : '';
  return `${what}: ${mark.status}, started ${formatOffset(mark.startMs)}${localTime(mark.startMs) === '' ? '' : ` (${localTime(mark.startMs)})`}, ${length}${wait}${mark.clamped ? ' (time adjusted to fit its job)' : ''}`;
}
