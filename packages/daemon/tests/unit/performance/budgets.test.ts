import { describe, it } from 'bun:test';
import should from 'should';
import type { BudgetInput } from '../../../src/lib/performance/budgets.ts';
import { IDLE_DAEMON_BUDGETS, judgeBudgets, type PerformanceBudget } from '../../../src/lib/performance/budgets.ts';

function reportOf(overrides: {
  readonly cpu?: number;
  readonly syscalls?: number;
  readonly lagMs?: number;
  readonly children?: number;
  readonly files?: number;
  readonly workerChildren?: readonly number[];
}): BudgetInput {
  return {
    resources: {
      cpu: { percentOfCore: overrides.cpu ?? 1 },
      ...(overrides.syscalls === undefined ? {} : { syscalls: { perSecond: overrides.syscalls } }),
    },
    eventLoop: { lag: { maxMs: overrides.lagMs ?? 1 } },
    childProcesses: { perMinute: overrides.children ?? 1 },
    fileOperations: { perSecond: overrides.files ?? 1 },
    workers: [
      { name: 'idle' },
      ...(overrides.workerChildren ?? []).map(perMinute => ({
        name: 'busy',
        work: { childProcesses: [{ command: 'security find-generic-password', perMinute }] },
      })),
    ],
  } as unknown as BudgetInput;
}

const byName = (name: string): PerformanceBudget => {
  const found = IDLE_DAEMON_BUDGETS.find(budget => budget.name === name);
  if (found === undefined) throw new Error(`no budget named ${name}`);
  return found;
};

describe('IDLE_DAEMON_BUDGETS', () => {
  it.each([
    ['daemon CPU', { cpu: 3.5 }, 3.5, 5],
    ['child processes', { children: 12 }, 12, 30],
    ['longest event-loop block', { lagMs: 40 }, 40, 100],
    ['file operations through the daemon’s ports', { files: 7 }, 7, 100],
    ['read/write system calls', { syscalls: 250 }, 250, 1_000],
  ])('should measure %s from the report', (name, overrides, expected, limit) => {
    // Arrange
    const subject = byName(name);
    const input = reportOf(overrides);

    // Act
    const actual = subject.measure(input);

    // Assert
    should(actual).equal(expected);
    should(subject.limit).equal(limit);
  });

  it('should count the children a worker reported with the main thread’s', () => {
    // Arrange — a worker's spawn costs the machine what a main-thread one does.
    const subject = byName('child processes');

    // Act
    const actual = subject.measure(reportOf({ children: 2, workerChildren: [3, 1.5] }));

    // Assert
    should(actual).equal(6.5);
  });

  it('should leave the system-call budget unmeasured when the report has no syscalls', () => {
    // Arrange
    const subject = byName('read/write system calls');

    // Act
    const actual = subject.measure(reportOf({}));

    // Assert
    should(actual).be.undefined();
  });

  it('should be frozen', () => {
    // Assert
    should(Object.isFrozen(IDLE_DAEMON_BUDGETS)).be.true();
  });
});

describe('judgeBudgets', () => {
  it('should pass every budget a quiet daemon stays within', () => {
    // Arrange
    const input = reportOf({ cpu: 1, children: 2, lagMs: 3, files: 4, syscalls: 5 });

    // Act
    const actual = judgeBudgets(input, IDLE_DAEMON_BUDGETS);

    // Assert
    should(actual.map(verdict => verdict.ok)).deepEqual([true, true, true, true, true]);
    should(actual[0]).deepEqual({ name: 'daemon CPU', unit: '% of one core', limit: 5, actual: 1, ok: true });
  });

  it('should fail only the budgets a daemon exceeds, and pass one sitting exactly at its limit', () => {
    // Arrange
    const input = reportOf({ cpu: 5, children: 31, lagMs: 100, files: 101, syscalls: 1_001 });

    // Act
    const actual = judgeBudgets(input, IDLE_DAEMON_BUDGETS);

    // Assert
    should(actual.map(verdict => [verdict.name, verdict.ok])).deepEqual([
      ['daemon CPU', true],
      ['child processes', false],
      ['longest event-loop block', true],
      ['file operations through the daemon’s ports', false],
      ['read/write system calls', false],
    ]);
  });

  it('should leave out a budget the report cannot measure rather than pass it', () => {
    // Arrange
    const input = reportOf({});

    // Act
    const actual = judgeBudgets(input, IDLE_DAEMON_BUDGETS);

    // Assert
    should(actual.map(verdict => verdict.name)).deepEqual([
      'daemon CPU',
      'child processes',
      'longest event-loop block',
      'file operations through the daemon’s ports',
    ]);
  });

  it('should judge nothing against no budgets', () => {
    // Act + Assert
    should(judgeBudgets(reportOf({}), [])).deepEqual([]);
  });
});
