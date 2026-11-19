/**
 * THE FLAMEGRAPH'S NUMBERS (r9 E11): a `CiRun` folded into an icicle tree (run › jobs › steps), where a bar's width is the
 * time it spent. PURE: no clock (`nowMs` is an argument), no DOM.
 *
 * Why the widths are what they are:
 *  - A step's width is its duration, a job's is the longer of its own duration and its steps added up (a job's steps never
 *    spill outside it), and the run's is its jobs ADDED. Parallel jobs therefore add up: the run's total can be longer
 *    than its wall time, and the screen says so.
 *  - Anything with no time to draw (skipped, still waiting, or instant) is not a bar. It is counted (`unplotted`) so the
 *    screen can say so rather than hide it.
 *  - A CI that is not GitHub Actions has no jobs: the run is one bar.
 *  - ONE clock. Every duration is E8's `durationMs` (the bounds E8 already put on each item: a step clamped inside its
 *    job ends where the job ends). An item that is still running ticks to `nowMs` only while it, its job and its run
 *    are all still running: a "live" step inside a job that has stopped keeps E8's end and never grows an hour later.
 *    The run's wall time is read on the same clock (`wallMs`), so the two numbers a person compares never come from
 *    different moments.
 *  - A node with many children draws the longest few (`DRAWN_CHILDREN`) in their own order and folds the rest into ONE
 *    "N shorter" bar; `hiddenChildren` lists exactly what was folded so the screen can offer every one of them as text.
 */
import { durationMs } from '../../../contract/ci-timing.ts';
import type { CiJob, CiRun, CiStatus, CiStep } from '../../../contract/index.ts';

type FlameKind = 'run' | 'job' | 'step' | 'more';

/** How many children of one node get a bar of their own; the rest share one "N shorter" bar. */
export const DRAWN_CHILDREN = 12;

export interface FlameNode {
  /** Unique in the tree: `run`, `job:<id>`, `step:<job id>:<number>`; a folded bar is `more:<its parent's key>`. */
  readonly key: string;
  readonly kind: FlameKind;
  readonly name: string;
  readonly status: CiStatus;
  /** Time spent, in ms: the bar's width. Always positive. */
  readonly ms: number;
  /** Still running: its end is "now". */
  readonly live: boolean;
  readonly children: readonly FlameNode[];
}

export interface Flame {
  /** The run's wall time on the same clock as every bar: ticking while the run is live, else what E8 recorded. */
  readonly wallMs: number;
  /** `undefined` when nothing in the run has any time to draw yet. */
  readonly root: FlameNode | undefined;
  /** Jobs and steps that have no width: skipped, still waiting, or instant. */
  readonly unplotted: number;
}

/**
 * Time spent. A live item ticks to `nowMs` only when every level above it is live too (`ticking`); otherwise E8's own
 * `durationMs` answers, which reads the end E8 bounded it by.
 */
const spent = (
  item: { readonly start?: string; readonly end?: string; readonly live?: boolean },
  nowMs: number,
  ticking: boolean,
): number =>
  ticking && item.live === true && item.start !== undefined
    ? Math.max(0, nowMs - Date.parse(item.start))
    : durationMs(item, nowMs);

const stepNode = (job: CiJob, step: CiStep, nowMs: number, ticking: boolean): FlameNode | undefined => {
  const ms = spent(step, nowMs, ticking);
  if (ms <= 0) return undefined;
  return {
    key: `step:${job.id}:${step.number}`,
    kind: 'step',
    name: step.name,
    status: step.status,
    ms,
    live: step.live === true,
    children: [],
  };
};

const jobNode = (job: CiJob, nowMs: number, runTicking: boolean): { node: FlameNode | undefined; steps: number } => {
  const ticking = runTicking && job.live === true;
  const steps = job.steps.flatMap(step => stepNode(job, step, nowMs, ticking) ?? []);
  const own = spent(job, nowMs, runTicking);
  let inside = 0;
  for (const step of steps) inside += step.ms;
  const ms = Math.max(own, inside);
  const node: FlameNode | undefined =
    ms > 0
      ? {
          key: `job:${job.id}`,
          kind: 'job',
          name: job.name,
          status: job.status,
          ms,
          live: job.live === true,
          children: steps,
        }
      : undefined;
  return { node, steps: steps.length };
};

export function buildFlame(run: CiRun, nowMs: number): Flame {
  const runTicking = run.live === true;
  const wallMs = runTicking ? Math.max(0, nowMs - Date.parse(run.createdAt)) : run.wallMs;
  const jobs = run.jobs.map(job => jobNode(job, nowMs, runTicking));
  const nodes = jobs.flatMap(job => job.node ?? []);
  let drawnSteps = 0;
  for (const job of jobs) drawnSteps += job.steps;
  let allSteps = 0;
  for (const job of run.jobs) allSteps += job.steps.length;
  const unplotted = run.jobs.length - nodes.length + (allSteps - drawnSteps);
  // No jobs at all (a CI that is not Actions): the run itself is the one bar.
  let ms = run.jobs.length === 0 ? spent(run, nowMs, runTicking) : 0;
  for (const node of nodes) ms += node.ms;
  if (ms <= 0) return { root: undefined, unplotted, wallMs };
  return {
    root: { key: 'run', kind: 'run', name: run.name, status: run.status, ms, live: run.live === true, children: nodes },
    unplotted,
    wallMs,
  };
}

/** One bar to draw: where it starts and how wide it is, as a percent of the zoomed bar. */
export interface FlameBar {
  readonly node: FlameNode;
  readonly row: number;
  readonly x: number;
  readonly width: number;
}

/** The node with `key`, and the path from the root to it (root first); `undefined` when the tree has no such node. */
export function findPath(root: FlameNode, key: string): readonly FlameNode[] | undefined {
  if (root.key === key) return [root];
  for (const child of root.children) {
    const below = findPath(child, key);
    if (below !== undefined) return [root, ...below];
  }
  return undefined;
}

/** The word for what a folded bar holds: steps under a job, jobs under the run. */
const folded = (parent: FlameNode, count: number): string =>
  `${count} shorter ${parent.kind === 'run' ? (count === 1 ? 'job' : 'jobs') : count === 1 ? 'step' : 'steps'}`;

/** The bad news first: a folded bar wears the most urgent status among what it holds. */
const URGENCY: readonly CiStatus[] = ['failed', 'cancelled', 'running', 'passed', 'queued', 'skipped'];

/** The children of `parent` that have a bar of their own: the `DRAWN_CHILDREN` longest (first of equals), in their own order. */
function drawnChildren(parent: FlameNode): ReadonlySet<FlameNode> {
  if (parent.children.length <= DRAWN_CHILDREN) return new Set(parent.children);
  const longest = parent.children
    .map((node, index) => ({ node, index }))
    .sort((a, b) => b.node.ms - a.node.ms || a.index - b.index)
    .slice(0, DRAWN_CHILDREN);
  return new Set(longest.map(entry => entry.node));
}

/** The children of `parent` folded into its "N shorter" bar, in their own order (empty when every child has a bar). */
export function hiddenChildren(parent: FlameNode): readonly FlameNode[] {
  if (parent.children.length <= DRAWN_CHILDREN) return [];
  const drawn = drawnChildren(parent);
  return parent.children.filter(child => !drawn.has(child));
}

/** The "N shorter" bar for `hidden`: as wide as they are together, coloured by the most urgent of them. */
const foldedNode = (parent: FlameNode, hidden: readonly FlameNode[]): FlameNode => {
  let ms = 0;
  for (const child of hidden) ms += child.ms;
  const status = URGENCY.find(word => hidden.some(child => child.status === word)) ?? 'skipped';
  return {
    key: `more:${parent.key}`,
    kind: 'more',
    name: folded(parent, hidden.length),
    status,
    ms,
    live: hidden.some(child => child.live),
    children: [],
  };
};

/** What `parent` draws under itself: its longest children, then one bar for all the rest. */
function visibleChildren(parent: FlameNode): readonly FlameNode[] {
  const hidden = hiddenChildren(parent);
  if (hidden.length === 0) return parent.children;
  const drawn = drawnChildren(parent);
  return [...parent.children.filter(child => drawn.has(child)), foldedNode(parent, hidden)];
}

/**
 * The rows of the icicle for the zoomed node: its own bar fills row 0, its children sit below it in order, and so on.
 * Widths are percents of the zoomed node, so the sum on any row is at most 100. A node with more than
 * `DRAWN_CHILDREN` children draws its longest and one "N shorter" bar, so the chart never grows with the run.
 */
export function layoutBars(focus: FlameNode): readonly FlameBar[] {
  const bars: FlameBar[] = [];
  const place = (node: FlameNode, row: number, x: number, width: number): void => {
    bars.push({ node, row, x, width });
    let at = x;
    for (const child of visibleChildren(node)) {
      const share = node.ms === 0 ? 0 : (child.ms / node.ms) * width;
      place(child, row + 1, at, share);
      at += share;
    }
  };
  place(focus, 0, 0, 100);
  return bars;
}

/** The sum of the widths on each row, in order (row 0 first): what the "widths sum per level" promise is measured on. */
export const rowTotals = (bars: readonly FlameBar[]): readonly number[] => {
  const totals: number[] = [];
  for (const bar of bars) totals[bar.row] = (totals[bar.row] ?? 0) + bar.width;
  return totals;
};
