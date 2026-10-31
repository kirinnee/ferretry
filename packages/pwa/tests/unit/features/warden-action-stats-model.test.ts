import { describe, expect, it } from 'bun:test';
import type { WardenActionTally, WardenDayStats, WardenReviveResults } from '@ferretry/protocol';
import {
  ACTION_CHART_DAYS,
  wardenActionChart,
  wardenActionStats,
} from '../../../src/features/warden/warden-action-stats-model.ts';
import { wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const NONE = { auto: 0, jev: 0, llm: 0 };

const tally = (
  action: WardenActionTally['action'],
  counts: Partial<typeof NONE>,
  outcome: WardenActionTally['outcome'] = 'done',
): WardenActionTally => ({ action, outcome, ...NONE, ...counts });

const day = (
  date: string,
  acts?: readonly WardenActionTally[],
  reviveResults?: WardenReviveResults,
): WardenDayStats => ({
  day: date,
  flags: 0,
  jevDecisions: 0,
  investigations: 0,
  jevUsd: 0,
  investigationUsd: 0,
  moved: NONE,
  cleared: NONE,
  stopped: NONE,
  asked: NONE,
  ...(acts === undefined ? {} : { acts: [...acts] }),
  ...(reviveResults === undefined ? {} : { reviveResults }),
});

const statusOf = (history: WardenDayStats[]) => wardenStatus({ history });

describe('wardenActionStats revives', () => {
  it('should count revives and resumes that were done, split by who decided them, over three spans', () => {
    // Arrange
    const status = statusOf([
      day('2026-07-10', [tally('revive', { auto: 4 })]),
      day('2026-07-27', [tally('revive', { auto: 1, jev: 2 }), tally('resume', { llm: 1 })]),
      day('2026-07-31', [
        tally('revive', { jev: 1 }),
        tally('nudge', { jev: 9 }),
        tally('revive', { auto: 5 }, 'failed'),
      ]),
    ]);

    // Act
    const [today, week, month] = wardenActionStats(status, NOW).revives;

    // Assert
    expect(today?.total).toBe(1);
    expect(today?.split.map(entry => `${entry.label} ${entry.count}`)).toEqual(['Jev 1']);
    expect(week?.total).toBe(5);
    expect(week?.split.map(entry => `${entry.label} ${entry.count}`)).toEqual(['Auto 1', 'Jev 3', 'LLM 1']);
    expect(month?.total).toBe(9);
  });

  it('should not turn a day nobody tallied into a zero, and say how much of the span was tallied', () => {
    // Arrange
    const status = statusOf([day('2026-07-31', [tally('revive', { auto: 2 })]), day('2026-07-30')]);

    // Act
    const [today, week] = wardenActionStats(status, NOW).revives;

    // Assert
    expect(today?.total).toBe(2);
    expect(week?.total).toBe(2);
    expect(week?.coverage).toBe('1 of 7 days tallied');
  });

  it('should say nothing was recorded when no day carries a tally', () => {
    // Act
    const actual = wardenActionStats(statusOf([day('2026-07-31')]), NOW);

    // Assert
    expect(actual.recorded).toBe(false);
    expect(actual.revives.every(span => span.total === null)).toBe(true);
  });
});

describe('wardenActionStats success rate', () => {
  it('should be the revives that took over the revives that were settled, with each decider’s share', () => {
    // Arrange
    const status = statusOf([
      day('2026-07-30', [], { progressed: { auto: 3, jev: 1, llm: 0 }, stalled: { auto: 1, jev: 0, llm: 0 } }),
      day('2026-07-31', [], { progressed: { auto: 0, jev: 0, llm: 1 }, stalled: { auto: 0, jev: 1, llm: 1 } }),
    ]);

    // Act
    const { success } = wardenActionStats(status, NOW);

    // Assert
    expect(success.rate).toBeCloseTo(5 / 8);
    expect(success.percent).toBe('63%');
    expect(success.sentence).toBe('5 of 8 got moving within 10 minutes');
    expect(success.byActor).toEqual(['Auto 3 of 4', 'Jev 1 of 2', 'LLM 1 of 2']);
  });

  it('should be unknown, not 0% or 100%, while nothing has been settled', () => {
    // Act
    const { success } = wardenActionStats(statusOf([day('2026-07-31', [tally('revive', { auto: 1 })])]), NOW);

    // Assert
    expect(success.rate).toBeNull();
    expect(success.percent).toBe('—');
  });
});

describe('wardenActionChart', () => {
  const status = statusOf([
    day('2026-07-29', [tally('revive', { auto: 2 }), tally('nudge', { jev: 3 })]),
    day('2026-07-30', [tally('revive', { llm: 1 }, 'failed')]),
    day('2026-07-31', [tally('revive', { auto: 1, jev: 2 }), tally('resume', { llm: 1 }), tally('stop', { jev: 1 })]),
  ]);

  it('should draw fourteen days, today last, stacked auto then jev then llm for the chosen action', () => {
    // Act
    const chart = wardenActionChart(status, NOW, 'revived');

    // Assert
    expect(chart?.points).toHaveLength(ACTION_CHART_DAYS);
    expect(chart?.points.at(-1)?.values).toEqual([1, 2, 1]);
    expect(chart?.points.at(-3)?.values).toEqual([2, 0, 0]);
  });

  it('should count every action under All and mark days with no tally as unknown', () => {
    // Act
    const chart = wardenActionChart(status, NOW, 'all');

    // Assert
    expect(chart?.points.at(-1)?.values).toEqual([1, 3, 1]);
    expect(chart?.missing).toBe(ACTION_CHART_DAYS - 3);
    expect(chart?.points[0]?.label).toBe('18?');
  });

  it('should say failed attempts in the readout without counting them as done', () => {
    // Act
    const chart = wardenActionChart(status, NOW, 'revived');

    // Assert
    expect(chart?.points.at(-2)?.empty).toBe(true);
    expect(chart?.points.at(-2)?.readout).toContain('1 failed');
  });

  it('should offer only the filters that have something to show', () => {
    // Act
    const keys = wardenActionChart(status, NOW, 'all')?.filters.map(filter => filter.key);

    // Assert
    expect(keys).toEqual(['all', 'revived', 'nudge', 'stop']);
  });

  it('should draw nothing when the daemon tallied no day', () => {
    expect(wardenActionChart(statusOf([day('2026-07-31')]), NOW, 'all')).toBeUndefined();
  });
});
