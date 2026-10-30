import type { BudgetVerdict, PerformanceReport } from '@ferretry/protocol';

/**
 * WHAT AN IDLE DAEMON MAY COST.
 *
 * "Idle" is the owner's fleet with nobody touching it: 36 sessions, 5 of them running agents that are
 * themselves idle. A daemon in that state is doing nothing a person asked for, so everything it spends
 * is overhead — and on a corporate Mac, where endpoint security inspects every process start and every
 * file open, overhead is what made it lag. The same numbers are held in the realworld tier by the idle-budget test and
 * printed in every `fy daemon profile`, so a regression and a slow machine are read against one bar.
 */
export interface PerformanceBudget {
  readonly name: string;
  readonly unit: string;
  readonly limit: number;
  /** The measurement, or `undefined` where this report cannot see it (a gap, never a pass). */
  readonly measure: (report: BudgetInput) => number | undefined;
}

/** The parts of a report a budget reads. */
export type BudgetInput = Pick<
  PerformanceReport,
  'resources' | 'eventLoop' | 'childProcesses' | 'fileOperations' | 'workers'
>;

/**
 * Every child the daemon started, per minute: the main thread's and every worker's. A child a worker
 * starts costs the machine exactly what one started on the main thread does — moving a spawn onto a
 * thread changes where it blocks, not what endpoint security inspects.
 */
const childrenPerMinute = (report: BudgetInput): number =>
  report.workers.reduce(
    (sum, worker) => sum + (worker.work?.childProcesses ?? []).reduce((within, entry) => within + entry.perMinute, 0),
    report.childProcesses.perMinute,
  );

export const IDLE_DAEMON_BUDGETS: readonly PerformanceBudget[] = Object.freeze([
  {
    name: 'daemon CPU',
    unit: '% of one core',
    limit: 5,
    measure: report => report.resources.cpu.percentOfCore,
  },
  {
    name: 'child processes',
    unit: 'per minute',
    limit: 30,
    measure: childrenPerMinute,
  },
  {
    name: 'longest event-loop block',
    unit: 'ms',
    limit: 100,
    measure: report => report.eventLoop.lag.maxMs,
  },
  {
    name: 'file operations through the daemon’s ports',
    unit: 'per second',
    limit: 100,
    measure: report => report.fileOperations.perSecond,
  },
  {
    name: 'read/write system calls',
    unit: 'per second',
    limit: 1_000,
    measure: report => report.resources.syscalls?.perSecond,
  },
]);

/** How `report` measured against `budgets`. A budget this report cannot see is left out, not passed. */
export function judgeBudgets(report: BudgetInput, budgets: readonly PerformanceBudget[]): BudgetVerdict[] {
  return budgets.flatMap(budget => {
    const actual = budget.measure(report);
    if (actual === undefined) return [];
    return [{ name: budget.name, unit: budget.unit, limit: budget.limit, actual, ok: actual <= budget.limit }];
  });
}
