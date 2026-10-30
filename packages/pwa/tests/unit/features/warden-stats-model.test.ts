import { describe, expect, it } from 'bun:test';
import type { WardenActorCounts, WardenDayStats, WardenStatusView } from '@ferretry/protocol';
import {
  actorSplit,
  hasHistory,
  layerLines,
  spendTotals,
  spendUsd,
  utcDay,
  wardenDayChart,
  wardenStats,
  wholeNumberTicks,
} from '../../../src/features/warden/warden-stats-model.ts';
import { wardenAction, wardenConfig, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const NONE: WardenActorCounts = { auto: 0, jev: 0, llm: 0 };

const day = (date: string, overrides: Partial<WardenDayStats> = {}): WardenDayStats => ({
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
  ...overrides,
});

const tile = (status: WardenStatusView, period: 'today' | 'week', key: string) =>
  wardenStats(status, period, NOW).tiles.find(entry => entry.key === key);

const withHistory = (history: WardenDayStats[], overrides: Partial<WardenStatusView> = {}) =>
  wardenStatus({ history, ...overrides });

const WEEK = [
  day('2026-07-25', { flags: 4, jevDecisions: 3, investigations: 1, moved: { auto: 1, jev: 0, llm: 0 } }),
  day('2026-07-26', { flags: 1, cleared: { auto: 0, jev: 1, llm: 0 } }),
  day('2026-07-28', { flags: 10, jevDecisions: 8, investigations: 2, stopped: { auto: 0, jev: 0, llm: 1, owner: 1 } }),
  day('2026-07-29', { flags: 2 }),
  day('2026-07-30', { flags: 3 }),
  day('2026-07-31', {
    flags: 5,
    jevDecisions: 4,
    investigations: 2,
    moved: { auto: 3, jev: 5, llm: 1 },
    cleared: { auto: 0, jev: 2, llm: 0 },
    asked: { auto: 0, jev: 0, llm: 2 },
  }),
];

describe('actorSplit', () => {
  it('should list the non-zero actors in the page’s order with their words', () => {
    // Arrange / Act
    const split = actorSplit({ auto: 3, jev: 0, llm: 1, owner: 2 });

    // Assert
    expect(split).toEqual([
      { actor: 'auto', label: 'Auto', count: 3 },
      { actor: 'llm', label: 'LLM', count: 1 },
      { actor: 'owner', label: 'You', count: 2 },
    ]);
    expect(actorSplit(NONE)).toEqual([]);
  });
});

describe('wardenStats from history', () => {
  it('should read today’s tiles from today’s record', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const stats = wardenStats(status, 'today', NOW);

    // Assert
    expect(stats.source).toBe('history');
    expect(stats.coverage).toBeUndefined();
    expect(stats.tiles.map(entry => [entry.key, entry.value])).toEqual([
      ['flagged', 5],
      ['moved', 9],
      ['cleared', 2],
      ['stopped', 0],
      ['asked', 2],
    ]);
    expect(tile(status, 'today', 'flagged')?.sub).toBe('Jev decided 4 · LLM investigated 2');
    expect(tile(status, 'today', 'flagged')?.split).toEqual([]);
    expect(tile(status, 'today', 'moved')?.split.map(entry => `${entry.label} ${entry.count}`)).toEqual([
      'Auto 3',
      'Jev 5',
      'LLM 1',
    ]);
  });

  it('should add the days up for 7 days and say how many were recorded', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const stats = wardenStats(status, 'week', NOW);

    // Assert
    expect(stats.coverage).toBe('6 of 7 days recorded');
    expect(tile(status, 'week', 'flagged')).toMatchObject({ value: 25, sub: 'Jev decided 15 · LLM investigated 5' });
    expect(tile(status, 'week', 'moved')?.value).toBe(10);
    expect(tile(status, 'week', 'stopped')).toMatchObject({
      value: 2,
      split: [
        { actor: 'llm', count: 1 },
        { actor: 'owner', count: 1 },
      ],
    });
  });

  it('should not say days are missing when all seven are there', () => {
    // Arrange
    const full = [day('2026-07-27', { flags: 1 }), ...WEEK];

    // Act
    const stats = wardenStats(withHistory(full), 'week', NOW);

    // Assert
    expect(stats.coverage).toBeUndefined();
  });

  it('should ignore days older than the seven it covers', () => {
    // Arrange
    const status = withHistory([day('2026-07-10', { flags: 99 }), ...WEEK]);

    // Act / Assert
    expect(tile(status, 'week', 'flagged')?.value).toBe(25);
  });

  it('should show today as unknown, never zero, when today has no record', () => {
    // Arrange
    const status = withHistory(WEEK.slice(0, -1));

    // Act
    const stats = wardenStats(status, 'today', NOW);

    // Assert
    expect(stats.tiles.every(entry => entry.value === null)).toBe(true);
    expect(stats.tiles.every(entry => entry.split.length === 0)).toBe(true);
  });

  it('should show the week as unknown when no day in it was recorded', () => {
    // Arrange
    const status = withHistory([day('2026-07-01', { flags: 3 })]);

    // Act
    const stats = wardenStats(status, 'week', NOW);

    // Assert
    expect(stats.tiles.every(entry => entry.value === null)).toBe(true);
    expect(stats.coverage).toBe('0 of 7 days recorded');
  });
});

describe('wardenStats without history', () => {
  const legacy = (overrides: Partial<WardenStatusView> = {}) =>
    wardenStatus({
      savings: { day: '2026-07-31', flags: 7, jevDecisions: 5, jevSkips: 0, investigations: 2 },
      actions: [
        wardenAction({ at: '2026-07-31T11:00:00.000Z', action: 'nudge', by: 'jev' }),
        wardenAction({ at: '2026-07-31T10:00:00.000Z', action: 'nudge', by: 'warden' }),
        wardenAction({ at: '2026-07-31T09:00:00.000Z', action: 'bless', by: 'jev', confidence: 0.9 }),
        wardenAction({ at: '2026-07-30T09:00:00.000Z', action: 'nudge', by: 'jev' }),
      ],
      ...overrides,
    });

  it('should fall back to today’s savings and count today’s recent actions, saying so', () => {
    // Arrange
    const status = legacy();

    // Act
    const stats = wardenStats(status, 'week', NOW);

    // Assert
    expect(hasHistory(status)).toBe(false);
    expect(stats.source).toBe('recent');
    expect(stats.period).toBe('today');
    expect(tile(status, 'today', 'flagged')).toMatchObject({ value: 7, sub: 'Jev decided 5 · LLM investigated 2' });
    expect(tile(status, 'today', 'moved')).toMatchObject({ value: 2, qualifier: 'recent' });
    expect(tile(status, 'today', 'cleared')).toMatchObject({ value: 1, qualifier: 'recent' });
  });

  it('should not invent flags when the savings are from another day', () => {
    // Arrange
    const status = legacy({
      savings: { day: '2026-07-30', flags: 7, jevDecisions: 5, jevSkips: 0, investigations: 2 },
    });

    // Act / Assert
    expect(tile(status, 'today', 'flagged')).toMatchObject({ value: null });
    expect(tile(status, 'today', 'flagged')?.sub).toBeUndefined();
  });

  it('should offer a history when the daemon sent one, even an empty one', () => {
    // Arrange / Act / Assert
    expect(hasHistory(withHistory([]))).toBe(true);
  });
});

describe('layerLines', () => {
  it('should say each layer’s decisions and spend against its cap, with a ratio', () => {
    // Arrange
    const status = withHistory(WEEK, {
      config: wardenConfig({ layers: { jev: true, llm: true } }),
      spend: {
        ...wardenStatus().spend,
        jevUsd: 0.25,
        jevCapUsd: 0.5,
        investigationUsd: 1.2,
        investigationCapUsd: 2,
        pendingInvestigations: 1,
      },
      savings: { day: '2026-07-31', flags: 5, jevDecisions: 4, jevSkips: 0, investigations: 2, savedUsd: 11.07 },
    });

    // Act
    const [jev, llm] = layerLines(status);

    // Assert
    expect(jev).toEqual({
      key: 'jev',
      name: 'Jev',
      summary: '4 decisions · $0.25 of $0.50 today',
      clause: '~$11.07 saved vs investigating all',
      ratio: 0.5,
      warn: false,
    });
    expect(llm).toMatchObject({
      key: 'llm',
      summary: '2 investigations · $1.20 of $2.00 today · 1 pending',
      ratio: 0.6,
      warn: false,
    });
  });

  it('should word pacing and take the warning tone when a layer is paced', () => {
    // Arrange
    const status = wardenStatus({
      config: wardenConfig({ layers: { jev: true, llm: false } }),
      spend: {
        ...wardenStatus().spend,
        jevUsd: 0.5,
        jevCapUsd: 0.5,
        capsHit: ['jev'],
        capsPaced: ['jev'],
        pacedUntil: '2026-07-31T13:00:00.000Z',
      },
    });

    // Act
    const lines = layerLines(status);

    // Assert
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      summary: '0 decisions · $0.50 of $0.50 today · Jev paused until 13:00 UTC: this hour’s share of the cap reached',
      ratio: 1,
      warn: true,
    });
  });

  it('should say a cap hit for the day, and leave off layers that are switched off', () => {
    // Arrange
    const status = wardenStatus({
      config: wardenConfig({ layers: { jev: false, llm: true } }),
      spend: { ...wardenStatus().spend, investigationUsd: 2, investigationCapUsd: 2, capsHit: ['investigation'] },
    });

    // Act
    const lines = layerLines(status);

    // Assert
    expect(lines.map(line => line.key)).toEqual(['llm']);
    expect(lines[0]).toMatchObject({ warn: true });
    expect(lines[0]?.summary).toContain('cap hit, back at midnight UTC');
  });

  it('should give no ratio when the cap is not a positive number', () => {
    // Arrange
    const status = wardenStatus({
      config: wardenConfig({ layers: { jev: true, llm: false } }),
      spend: { ...wardenStatus().spend, jevCapUsd: 0 },
    });

    // Act / Assert
    expect(layerLines(status)[0]?.ratio).toBeUndefined();
  });

  it('should take today’s counts from the history when the daemon sent it', () => {
    // Arrange
    const status = withHistory([day('2026-07-31', { jevDecisions: 9, investigations: 3 })], {
      config: wardenConfig({ layers: { jev: true, llm: true } }),
    });

    // Act
    const [jev, llm] = layerLines(status);

    // Assert
    expect(jev?.summary).toStartWith('9 decisions');
    expect(llm?.summary).toStartWith('3 investigations');
  });
});

describe('wardenDayChart', () => {
  it('should draw nothing without a history', () => {
    // Arrange / Act / Assert
    expect(wardenDayChart(wardenStatus(), NOW)).toBeUndefined();
    expect(wardenDayChart(withHistory([]), NOW)).toBeUndefined();
  });

  it('should draw the last seven UTC days, oldest first, stacked by actor', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const chart = wardenDayChart(status, NOW);

    // Assert
    expect(chart?.points.map(point => point.key)).toEqual([
      '2026-07-25',
      '2026-07-26',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    expect(chart?.points.map(point => point.label)).toEqual(['Sat', 'Sun', 'Mon?', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(chart?.points[0]?.values).toEqual([1, 0, 0]);
    expect(chart?.points[6]?.values).toEqual([3, 7, 3]);
  });

  it('should mark a day with no record as unknown, not as a quiet day', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const chart = wardenDayChart(status, NOW);

    // Assert
    expect(chart?.missing).toBe(1);
    expect(chart?.points[2]).toMatchObject({ label: 'Mon?', readout: 'Mon 27 Jul · no record', values: [0, 0, 0] });
    expect(chart?.points[2]?.empty).toBeUndefined();
  });

  it('should draw a known quiet day as a drawn zero', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const chart = wardenDayChart(status, NOW);

    // Assert
    expect(chart?.points[4]).toMatchObject({ label: 'Wed', empty: true, values: [0, 0, 0] });
  });

  it('should read each day out with its actors and flags', () => {
    // Arrange
    const status = withHistory(WEEK);

    // Act
    const chart = wardenDayChart(status, NOW);

    // Assert
    expect(chart?.points[6]?.readout).toBe(
      'Fri 31 Jul · 13 actions — Auto 3, Jev 7, LLM 3 · 5 flags · Jev $0.00, LLM $0.00',
    );
    expect(chart?.points[4]?.readout).toBe('Wed 29 Jul · no actions · 2 flags · Jev $0.00, LLM $0.00');
    expect(chart?.points[0]?.readout).toBe('Sat 25 Jul · 1 action — Auto 1 · 4 flags · Jev $0.00, LLM $0.00');
  });
});

describe('small helpers', () => {
  it('should name the UTC day of an instant', () => {
    // Arrange / Act / Assert
    expect(utcDay(NOW)).toBe('2026-07-31');
    expect(utcDay('2026-08-01T00:30:00.000Z')).toBe('2026-08-01');
  });

  it('should give whole-number ticks from zero that cover the maximum', () => {
    // Arrange / Act / Assert
    expect(wholeNumberTicks(0)).toEqual([0, 1]);
    expect(wholeNumberTicks(3)).toEqual([0, 1, 2, 3]);
    expect(wholeNumberTicks(7)).toEqual([0, 2, 4, 6, 8]);
    const big = wholeNumberTicks(57);
    expect(big[0]).toBe(0);
    expect(big.at(-1)).toBeGreaterThanOrEqual(57);
    expect(big.every(Number.isInteger)).toBe(true);
  });
});

describe('Jev’s checks', () => {
  /** 2026-10-29 in miniature: Jev looked at every flag, handed every one on, and spent its cap. */
  const jevDay = (date: string, checks: Partial<NonNullable<WardenDayStats['jev']>> = {}): WardenDayStats =>
    day(date, {
      flags: 9,
      jevDecisions: 6,
      investigations: 2,
      cleared: { auto: 0, jev: 1, llm: 1 },
      jev: { checks: 6, healthy: 1, acted: 0, handedOn: 5, skippedForCap: 0, ...checks },
    });

  it('should say Jev checked, counting the flags it handed on, when the day kept its checks', () => {
    // Arrange
    const status = withHistory([jevDay('2026-07-31', { checks: 7, handedOn: 6 })]);

    // Act / Assert
    expect(tile(status, 'today', 'flagged')?.sub).toBe('Jev checked 7 · LLM investigated 2');
  });

  it('should fall back to decisions over a week in which some day did not keep checks', () => {
    // Arrange
    const status = withHistory([day('2026-07-30', { jevDecisions: 3 }), jevDay('2026-07-31')]);

    // Act / Assert
    expect(tile(status, 'week', 'flagged')?.sub).toBe('Jev decided 9 · LLM investigated 2');
  });

  it('should spell out Jev’s checks on its line, and say it is paused when its daily cap is reached', () => {
    // Arrange
    const status = withHistory([jevDay('2026-07-31', { skippedForCap: 3 })], {
      config: wardenConfig({ layers: { jev: true, llm: true } }),
      spend: { ...wardenStatus().spend, jevUsd: 0.51, jevCapUsd: 0.5, capsHit: ['jev'] },
    });

    // Act
    const [jev] = layerLines(status);

    // Assert
    expect(jev).toMatchObject({
      summary:
        '6 checks: 1 healthy · 0 acted · 5 handed on · $0.51 of $0.50 today · Jev paused: daily cap reached, back at midnight UTC',
      clause: '~$0.09 per check · 3 flags not checked for the cap',
      warn: true,
    });
  });

  it('should say this hour’s share is reached when Jev is paced, and add what Jev saved', () => {
    // Arrange
    const status = withHistory([jevDay('2026-07-31')], {
      config: wardenConfig({ layers: { jev: true, llm: true } }),
      spend: {
        ...wardenStatus().spend,
        jevUsd: 0.13,
        jevCapUsd: 0.5,
        capsHit: ['jev'],
        capsPaced: ['jev'],
        pacedUntil: '2026-07-31T13:00:00.000Z',
      },
      savings: { ...wardenStatus().savings, savedUsd: 0.4 },
    });

    // Act
    const [jev] = layerLines(status);

    // Assert
    expect(jev?.summary).toEndWith(' · Jev paused until 13:00 UTC: this hour’s share of the cap reached');
    expect(jev?.clause).toBe('~$0.02 per check · ~$0.40 saved vs investigating all');
  });

  it('should say nothing about a pause while Jev is under its cap', () => {
    // Arrange
    const status = withHistory([jevDay('2026-07-31')], { config: wardenConfig({ layers: { jev: true, llm: false } }) });

    // Act
    const [jev] = layerLines(status);

    // Assert
    expect(jev?.summary).toBe('6 checks: 1 healthy · 0 acted · 5 handed on · $0.00 of $0.50 today');
    expect(jev?.warn).toBe(false);
    expect(jev).not.toHaveProperty('clause');
  });

  it('should draw Jev’s bar as its checks and say so', () => {
    // Arrange
    const status = withHistory([day('2026-07-30', { flags: 1 }), jevDay('2026-07-31')]);

    // Act
    const chart = wardenDayChart(status, NOW);

    // Assert
    expect(chart?.title).toBe('Actions and Jev checks per day');
    expect(chart?.points[6]).toMatchObject({
      values: [0, 6, 1],
      readout: 'Fri 31 Jul · Jev 6 checks, LLM 1 · 9 flags · Jev $0.00, LLM $0.00',
    });
    expect(chart?.points[5]?.readout).toBe('Thu 30 Jul · no actions · 1 flag · Jev $0.00, LLM $0.00');
  });

  it('should say a day that kept checks and did nothing did nothing', () => {
    // Arrange
    const status = withHistory([
      day('2026-07-31', { jev: { checks: 0, healthy: 0, acted: 0, handedOn: 0, skippedForCap: 0 } }),
    ]);

    // Act / Assert
    expect(wardenDayChart(status, NOW)?.points[6]?.readout).toBe(
      'Fri 31 Jul · nothing done · 0 flags · Jev $0.00, LLM $0.00',
    );
  });

  it('should keep the old title for a week no day of which kept checks', () => {
    // Act / Assert
    expect(wardenDayChart(withHistory(WEEK), NOW)?.title).toBe('Actions per day');
  });
});

describe('spend at a glance', () => {
  const spending = (layers: { jev: boolean; llm: boolean }, jevUsd: number, investigationUsd: number) =>
    wardenStatus({
      config: wardenConfig({ layers }),
      spend: { ...wardenStatus().spend, jevUsd, investigationUsd },
    });

  it('should give both layers and their sum, an amount under a cent to four places', () => {
    // Act / Assert
    expect(spendTotals(spending({ jev: true, llm: true }, 0.0055, 1.2))).toBe(
      'Today: Jev $0.0055 · LLM $1.20 · together $1.21',
    );
  });

  it('should leave out a layer that is off, and the sum with it', () => {
    // Act / Assert
    expect(spendTotals(spending({ jev: true, llm: false }, 0.51, 0))).toBe('Today: Jev $0.51');
    expect(spendTotals(spending({ jev: false, llm: true }, 0, 0))).toBe('Today: LLM $0.00');
    expect(spendTotals(spending({ jev: false, llm: false }, 0, 0))).toBeUndefined();
  });

  it('should never round a spend under a cent down to nothing', () => {
    // Act / Assert
    expect(spendUsd(0.0004)).toBe('$0.0004');
    expect(spendUsd(0)).toBe('$0.00');
    expect(spendUsd(0.25)).toBe('$0.25');
  });

  it('should say what one Jev check costs, at the real price too', () => {
    // Arrange: six checks at $0.0042 each.
    const status = withHistory(
      [day('2026-07-31', { jev: { checks: 6, healthy: 1, acted: 0, handedOn: 5, skippedForCap: 0 } })],
      {
        config: wardenConfig({ layers: { jev: true, llm: false } }),
        spend: { ...wardenStatus().spend, jevUsd: 0.0252 },
      },
    );

    // Act
    const [jev] = layerLines(status);

    // Assert
    expect(jev?.summary).toContain('$0.03 of $0.50 today');
    expect(jev?.clause).toBe('~$0.0042 per check');
  });
});
