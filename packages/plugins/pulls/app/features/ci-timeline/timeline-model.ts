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
 *  - ONE clock. A bar ends where E8 bounded it (a step clamped inside its job ends where the job ends). An item that is
 *    still marked live ticks to `nowMs` only while its job AND its run are live too, so a "live" step in a cancelled job is
 *    never drawn past it. The wall time, the first job's wait and the wait of a job that never started are read on the
 *    same clock as the bars and the now-line, never from the snapshot's own numbers.
 *  - BOUNDED. A run draws its `DRAWN_JOBS` longest jobs and, in each, its `DRAWN_STEPS` longest steps; the rest fold into
 *    ONE "N shorter" mark per row (steps) and one "N shorter jobs" row (jobs). Nothing is lost: `hiddenJobs` and
 *    `listSteps` hand the screen every folded one as text, and the folded marks are in the keyboard order. The cost of a
 *    layout is the drawn marks, never the 256 x 500 the contract allows.
 */
import type { CiRun, CiStatus, CiStep } from '../../../contract/index.ts';

/** A drawn bar: `startMs`/`endMs` are offsets from the run's creation, both inside `[0, spanMs]`. */
export interface TimelineMark {
  /** Unique in the layout: `j<jobIndex>` for a job, `j<jobIndex>s<stepIndex>` for a step, `...more` for a folded one. */
  readonly key: string;
  /** The row this mark sits on. */
  readonly rowKey: string;
  /** `more` is the one mark that stands for several shorter jobs or steps (`count` of them). */
  readonly kind: 'job' | 'step' | 'more';
  readonly name: string;
  /** The job's name for a step or a folded set of steps; the same as `name` for a job. */
  readonly jobName: string;
  readonly status: CiStatus;
  readonly startMs: number;
  readonly endMs: number;
  readonly live: boolean;
  /** A step that fell outside its job (clock skew) and was pulled inside. */
  readonly clamped: boolean;
  /** How many jobs or steps a `more` mark folds. */
  readonly count?: number;
}

export interface TimelineRow {
  readonly key: string;
  /** Which job of the run this is (`-1` for the folded "N shorter jobs" row). */
  readonly jobIndex: number;
  /** Where the row is drawn, top to bottom (`-1` for a job that was folded away). */
  readonly rowIndex: number;
  readonly name: string;
  readonly status: CiStatus;
  readonly live: boolean;
  /** The job's own bar, or `undefined` for a job that never started (queued, skipped, cancelled before it began). */
  readonly bar: TimelineMark | undefined;
  /** The steps with a bar that are drawn (the longest few), in the order GitHub numbers them, then a folded mark. */
  readonly steps: readonly TimelineMark[];
  /** How many steps the job has in all, drawn or not. */
  readonly stepCount: number;
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
  /** The clock the layout was read on, in epoch ms. */
  readonly clockMs: number;
  /** The width of the time axis: the run's wall time (to now while live), never less than one second. */
  readonly spanMs: number;
  /** The run's wall time on the layout's clock: ticking while the run is live, else what E8 recorded. */
  readonly wallMs: number;
  /** How long the run waited before its first job started, on the layout's clock; `started` says whether one did. */
  readonly queuedMs: number;
  readonly started: boolean;
  /** Where "now" is on the axis while the run is live; `undefined` once it is final. */
  readonly nowMs: number | undefined;
  /** The drawn rows, top to bottom; the last is the folded "N shorter jobs" row when some jobs were folded. */
  readonly rows: readonly TimelineRow[];
  /** The jobs folded into that last row, in the order E8 gives, as rows without steps (`listSteps` opens one). */
  readonly hiddenJobs: readonly TimelineRow[];
}

const MIN_SPAN_MS = 1_000;
/** How many jobs get a row of their own; the rest share one "N shorter jobs" row. */
export const DRAWN_JOBS = 24;
/** How many steps of one job get a segment of their own; the rest share one "N shorter steps" mark. */
export const DRAWN_STEPS = 12;

const offset = (instant: string | undefined, originMs: number): number | undefined => {
  if (instant === undefined) return undefined;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? parsed - originMs : undefined;
};
const clampTo = (value: number, span: number): number => Math.min(Math.max(value, 0), span);

/** An item's bar before it is fitted to the axis: offsets from the origin, the end never before the start. */
interface Raw {
  readonly start: number;
  readonly end: number;
}

/**
 * The bar of an item that has one, or `undefined` when it has no start. It ends where E8 ended it, unless `mayTick` (its
 * job and its run are live) and it is itself live: then it ends now.
 */
function rawBar(
  item: { readonly start?: string; readonly end?: string; readonly live?: boolean },
  originMs: number,
  nowOffset: number,
  mayTick: boolean,
): Raw | undefined {
  const start = offset(item.start, originMs);
  if (start === undefined) return undefined;
  const end = mayTick && item.live === true ? nowOffset : (offset(item.end, originMs) ?? start);
  return { start, end: Math.max(end, start) };
}

/** A raw bar fitted inside `[0, span]`. */
const fitted = (raw: Raw, span: number): { startMs: number; endMs: number } => {
  const startMs = clampTo(raw.start, span);
  return { startMs, endMs: clampTo(Math.max(raw.end, startMs), span) };
};

/** The bad news first: a folded mark wears the most urgent status among what it holds. */
const URGENCY: readonly CiStatus[] = ['failed', 'cancelled', 'running', 'passed', 'queued', 'skipped'];
function mostUrgent(statuses: readonly CiStatus[]): CiStatus {
  let best = URGENCY.length;
  for (const status of statuses) best = Math.min(best, URGENCY.indexOf(status));
  return URGENCY[best] ?? 'skipped';
}

/** The `limit` longest of `items` (the first of equals) in their own order, and the rest, also in their own order. */
function longest<T>(
  items: readonly T[],
  length: (item: T) => number,
  limit: number,
): { readonly shown: readonly T[]; readonly rest: readonly T[] } {
  if (items.length <= limit) return { shown: items, rest: [] };
  const chosen = new Set(
    items
      .map((item, index) => ({ index, ms: length(item) }))
      .sort((a, b) => b.ms - a.ms || a.index - b.index)
      .slice(0, limit)
      .map(entry => entry.index),
  );
  return {
    shown: items.filter((_, index) => chosen.has(index)),
    rest: items.filter((_, index) => !chosen.has(index)),
  };
}

const lengthOf = (raw: Raw | undefined): number => (raw === undefined ? 0 : raw.end - raw.start);
const jobsWord = (count: number): string => `${count} shorter ${count === 1 ? 'job' : 'jobs'}`;
const stepsWord = (count: number): string => `${count} shorter ${count === 1 ? 'step' : 'steps'}`;

/** What a row is drawn from: a job, or, for a CI that is not GitHub Actions, the run itself. */
interface Subject {
  readonly index: number;
  readonly name: string;
  readonly status: CiStatus;
  readonly live: boolean;
  readonly queuedMs: number;
  readonly steps: readonly CiStep[];
  readonly raw: Raw | undefined;
}

/** A step with a bar, before it is fitted. */
interface StepBar {
  readonly index: number;
  readonly step: CiStep;
  readonly raw: Raw;
}

const stepMark = (bar: StepBar, rowKey: string, jobName: string, span: number): TimelineMark => ({
  key: `${rowKey}s${bar.index}`,
  rowKey,
  kind: 'step',
  name: bar.step.name,
  jobName,
  status: bar.step.status,
  ...fitted(bar.raw, span),
  live: bar.step.live === true,
  clamped: bar.step.clamped === true,
});

/** One mark for several folded ones: it spans from the first start to the last end and wears the most urgent status. */
function foldedMark(
  key: string,
  rowKey: string,
  name: string,
  jobName: string,
  folded: readonly { readonly raw: Raw; readonly status: CiStatus; readonly live: boolean }[],
  count: number,
  span: number,
): TimelineMark | undefined {
  if (folded.length === 0) return undefined;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const item of folded) {
    start = Math.min(start, item.raw.start);
    end = Math.max(end, item.raw.end);
  }
  return {
    key,
    rowKey,
    kind: 'more',
    name,
    jobName,
    status: mostUrgent(folded.map(item => item.status)),
    ...fitted({ start, end: Math.max(end, start) }, span),
    live: folded.some(item => item.live),
    clamped: false,
    count,
  };
}

const stepBars = (subject: Subject, originMs: number, nowOffset: number, mayTick: boolean): readonly StepBar[] =>
  subject.steps.flatMap((step, index): StepBar[] => {
    const raw = rawBar(step, originMs, nowOffset, mayTick);
    return raw === undefined ? [] : [{ index, step, raw }];
  });

/** Lay a run out. `nowMs` is the clock the caller reads (a prop in a screenshot), so the same inputs always draw the same. */
export function layoutTimeline(run: CiRun, nowMs: number): TimelineLayout {
  const originMs = Date.parse(run.createdAt);
  const nowOffset = Math.max(0, nowMs - originMs);
  const runTicking = run.live === true;
  const wallMs = runTicking ? nowOffset : run.wallMs;

  const subjects: readonly Subject[] =
    run.jobs.length > 0
      ? run.jobs.map((job, index) => ({
          index,
          name: job.name,
          status: job.status,
          live: job.live === true,
          queuedMs: job.queuedMs,
          steps: job.steps,
          raw: rawBar(job, originMs, nowOffset, runTicking),
        }))
      : [
          {
            index: 0,
            name: run.name,
            status: run.status,
            live: runTicking,
            queuedMs: run.queuedMs,
            steps: [],
            raw: rawBar(run, originMs, nowOffset, runTicking),
          },
        ];

  // A job that never started waits until now while the run is live and the job is not final (E8 stops it at the run's
  // last change once it is); a job that started waited until it did.
  const waitOf = (subject: Subject): number => {
    if (subject.status === 'skipped') return 0;
    if (subject.raw !== undefined) return Math.max(0, subject.raw.start);
    return runTicking && (subject.status === 'queued' || subject.status === 'running') ? nowOffset : subject.queuedMs;
  };

  let firstStart: number | undefined;
  if (run.jobs.length > 0)
    for (const subject of subjects)
      if (subject.raw !== undefined)
        firstStart = firstStart === undefined ? subject.raw.start : Math.min(firstStart, subject.raw.start);

  const { shown, rest } = longest(subjects, subject => lengthOf(subject.raw), DRAWN_JOBS);
  const bars = shown.map(subject =>
    longest(stepBars(subject, originMs, nowOffset, runTicking && subject.live), bar => lengthOf(bar.raw), DRAWN_STEPS),
  );

  // Wide enough for the run's wall time AND every bar the data draws (a clock that disagrees must not clip a bar).
  let spanMs = Math.max(MIN_SPAN_MS, wallMs);
  for (const subject of subjects) spanMs = Math.max(spanMs, waitOf(subject), subject.raw?.end ?? 0);
  for (const { shown: drawn, rest: folded } of bars)
    for (const bar of [...drawn, ...folded]) spanMs = Math.max(spanMs, bar.raw.end);

  const rowOf = (subject: Subject, rowIndex: number, steps: readonly TimelineMark[]): TimelineRow => {
    const key = `j${subject.index}`;
    const bar: TimelineMark | undefined =
      subject.raw === undefined
        ? undefined
        : {
            key,
            rowKey: key,
            kind: 'job',
            name: subject.name,
            jobName: subject.name,
            status: subject.status,
            ...fitted(subject.raw, spanMs),
            live: subject.live,
            clamped: false,
          };
    return {
      key,
      jobIndex: subject.index,
      rowIndex,
      name: subject.name,
      status: subject.status,
      live: subject.live,
      bar,
      steps,
      stepCount: subject.steps.length,
      queueMs: clampTo(waitOf(subject), spanMs),
    };
  };

  const rows: TimelineRow[] = shown.map((subject, at) => {
    const key = `j${subject.index}`;
    const { shown: drawn, rest: folded } = bars[at] ?? { shown: [], rest: [] };
    const more = foldedMark(
      `${key}more`,
      key,
      stepsWord(folded.length),
      subject.name,
      folded.map(bar => ({ raw: bar.raw, status: bar.step.status, live: bar.step.live === true })),
      folded.length,
      spanMs,
    );
    return rowOf(subject, at, [...drawn.map(bar => stepMark(bar, key, subject.name, spanMs)), ...(more ? [more] : [])]);
  });

  const hiddenJobs = rest.map(subject => rowOf(subject, -1, []));
  if (rest.length > 0) {
    const name = jobsWord(rest.length);
    const bar = foldedMark(
      'jmore',
      'jmore',
      name,
      name,
      rest.flatMap(subject =>
        subject.raw === undefined ? [] : [{ raw: subject.raw, status: subject.status, live: subject.live }],
      ),
      rest.length,
      spanMs,
    );
    rows.push({
      key: 'jmore',
      jobIndex: -1,
      rowIndex: rows.length,
      name,
      status: mostUrgent(rest.map(subject => subject.status)),
      live: rest.some(subject => subject.live),
      bar,
      steps: [],
      stepCount: 0,
      queueMs: 0,
    });
  }

  return {
    originMs,
    clockMs: nowMs,
    spanMs,
    wallMs,
    queuedMs:
      firstStart !== undefined ? Math.max(0, firstStart) : runTicking && run.jobs.length > 0 ? nowOffset : run.queuedMs,
    started: firstStart !== undefined,
    nowMs: runTicking ? Math.min(nowOffset, spanMs) : undefined,
    rows,
    hiddenJobs,
  };
}

/**
 * Every step of one job that has a bar and is NOT drawn on its row (the shorter ones, or every one of a job that was
 * folded away), in the order GitHub numbers them. Read on the layout's own clock, so they agree with the chart.
 */
export function listSteps(run: CiRun, layout: TimelineLayout, jobIndex: number): readonly TimelineMark[] {
  const job = run.jobs[jobIndex];
  if (job === undefined) return [];
  const drawn = new Set(layout.rows.find(row => row.jobIndex === jobIndex)?.steps.map(mark => mark.key));
  const nowOffset = Math.max(0, layout.clockMs - layout.originMs);
  const mayTick = run.live === true && job.live === true;
  const rowKey = `j${jobIndex}`;
  return stepBars(
    {
      index: jobIndex,
      name: job.name,
      status: job.status,
      live: job.live === true,
      queuedMs: job.queuedMs,
      steps: job.steps,
      raw: undefined,
    },
    layout.originMs,
    nowOffset,
    mayTick,
  )
    .filter(bar => !drawn.has(`${rowKey}s${bar.index}`))
    .map(bar => stepMark(bar, rowKey, job.name, layout.spanMs));
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
  const alone = mark.kind === 'job' || (mark.kind === 'more' && mark.jobName === mark.name);
  const what = alone ? mark.name : `${mark.jobName} › ${mark.name}`;
  const length = `${mark.live ? 'running for ' : ''}${formatSpan(mark.endMs - mark.startMs)}`;
  const wait = mark.kind === 'job' && queueMs > 0 ? `, waited ${formatSpan(queueMs)} first` : '';
  return `${what}: ${mark.status}, started ${formatOffset(mark.startMs)}${localTime(mark.startMs) === '' ? '' : ` (${localTime(mark.startMs)})`}, ${length}${wait}${mark.clamped ? ' (time adjusted to fit its job)' : ''}${mark.kind === 'more' ? ' (press Enter to list them)' : ''}`;
}
