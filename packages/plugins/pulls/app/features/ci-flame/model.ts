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
 */
import { durationMs } from '../../../contract/ci-timing.ts';
import type { CiJob, CiRun, CiStatus, CiStep } from '../../../contract/index.ts';

type FlameKind = 'run' | 'job' | 'step';

export interface FlameNode {
  /** Unique in the tree: `run`, `job:<id>`, `step:<job id>:<number>`. */
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
  /** `undefined` when nothing in the run has any time to draw yet. */
  readonly root: FlameNode | undefined;
  /** Jobs and steps that have no width: skipped, still waiting, or instant. */
  readonly unplotted: number;
}

/** Time spent: a live item has been running since its start, so it is as long as `nowMs` says (its `end` is only as of the last read). */
const spent = (
  item: { readonly start?: string; readonly end?: string; readonly live?: boolean },
  nowMs: number,
): number =>
  item.live === true && item.start !== undefined
    ? Math.max(0, nowMs - Date.parse(item.start))
    : durationMs(item, nowMs);

const stepNode = (job: CiJob, step: CiStep, nowMs: number): FlameNode | undefined => {
  const ms = spent(step, nowMs);
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

const jobNode = (job: CiJob, nowMs: number): { node: FlameNode | undefined; steps: number } => {
  const steps = job.steps.flatMap(step => stepNode(job, step, nowMs) ?? []);
  const own = spent(job, nowMs);
  const ms = Math.max(
    own,
    steps.reduce((sum, step) => sum + step.ms, 0),
  );
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
  const jobs = run.jobs.map(job => jobNode(job, nowMs));
  const nodes = jobs.flatMap(job => job.node ?? []);
  const drawnSteps = jobs.reduce((sum, job) => sum + job.steps, 0);
  const allSteps = run.jobs.reduce((sum, job) => sum + job.steps.length, 0);
  const unplotted = run.jobs.length - nodes.length + (allSteps - drawnSteps);
  // No jobs at all (a CI that is not Actions): the run itself is the one bar.
  const ms = run.jobs.length === 0 ? spent(run, nowMs) : nodes.reduce((sum, node) => sum + node.ms, 0);
  if (ms <= 0) return { root: undefined, unplotted };
  return {
    root: { key: 'run', kind: 'run', name: run.name, status: run.status, ms, live: run.live === true, children: nodes },
    unplotted,
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

/**
 * The rows of the icicle for the zoomed node: its own bar fills row 0, its children sit below it in order, and so on.
 * Widths are percents of the zoomed node, so the sum on any row is at most 100.
 */
export function layoutBars(focus: FlameNode): readonly FlameBar[] {
  const bars: FlameBar[] = [];
  const place = (node: FlameNode, row: number, x: number, width: number): void => {
    bars.push({ node, row, x, width });
    let at = x;
    for (const child of node.children) {
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
