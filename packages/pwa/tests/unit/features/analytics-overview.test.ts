import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import {
  analyticsAxisTicks,
  analyticsModelShares,
  analyticsMonthGlobs,
  analyticsOverview,
  analyticsRangeDays,
  durationAxisTicks,
  formatAxisDuration,
  formatAxisUsd,
  formatCount,
  formatDay,
  formatDollars,
  formatDuration,
  formatMetric,
  formatTokens,
  formatUsd,
  formatWeek,
  metricReading,
  type OverviewMachine,
  overviewGroups,
  overviewRow,
  overviewTotals,
  overviewWeeks,
  projectName,
  rankTopSessions,
  tokenTotal,
  topSessionValue,
  utcDay,
  weekStart,
} from '../../../src/features/analytics/analytics-overview.ts';
import {
  analyticsDayQuery,
  readAnalyticsWindow,
  readMachineWindow,
} from '../../../src/features/analytics/analytics-overview-load.ts';
import { sessionCost, sessionDescendants, sessionTreeMatcher } from '../../../src/features/analytics/session-cost.ts';
import { dayAggregate, rawResponse, rawRow } from '../../support/analytics-rows.ts';

const NOW = new Date('2026-10-16T23:30:00Z');
const HERE: OverviewMachine = { daemonId: 'daemon-a', name: 'studio-mac' };
const THERE: OverviewMachine = { daemonId: 'daemon-b', name: 'kirin-box' };
const row = (overrides: Parameters<typeof rawRow>[0], machine: OverviewMachine = HERE) =>
  overviewRow(rawRow(overrides), machine);

describe('the analytics window', () => {
  it('ends on the UTC day of now and runs oldest first', () => {
    expect(utcDay(NOW)).toBe('2026-10-16');
    const days = analyticsRangeDays(14, NOW);
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-10-03');
    expect(days.at(-1)).toBe('2026-10-16');
    expect(analyticsRangeDays(30, NOW)[0]).toBe('2026-09-17');
  });

  it('reads one month glob per month the window touches', () => {
    expect(analyticsMonthGlobs(analyticsRangeDays(7, NOW))).toEqual(['2026-10-*']);
    expect(analyticsMonthGlobs(analyticsRangeDays(30, NOW))).toEqual(['2026-09-*', '2026-10-*']);
  });

  it('starts a week on its Monday', () => {
    expect(weekStart('2026-10-16')).toBe('2026-10-12');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
  });
});

describe('overviewRow', () => {
  it('names the machine as the app does, splits tokens by kind and reads both durations', () => {
    const read = row({
      id: 'a',
      agent: 'claude-auto-loge',
      machine: 'hostname-the-daemon-stamped',
      cwd: '/home/kirin/Workspace/ferretry/',
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 100,
      outputTokens: 50,
      activeDurationMs: 4_000,
      durationMs: 9_000,
    });
    expect(read).toMatchObject({
      daemonId: 'daemon-a',
      machine: 'studio-mac',
      runtime: 'claude-auto-loge',
      project: 'ferretry',
      tree: 'a',
      tokens: { input: 300, output: 50, cacheRead: 600, cacheWrite: 100 },
      activeMs: 4_000,
      wallMs: 9_000,
    });
    expect(tokenTotal(read.tokens!)).toBe(1_050);
  });

  it('has no token split when any kind is missing, and never a negative uncached input', () => {
    expect(row({ id: 'a', cacheWriteInputTokens: null }).tokens).toBeNull();
    expect(row({ id: 'b', inputTokens: 10, cachedInputTokens: 20 }).tokens?.input).toBe(0);
    expect(row({ id: 'c', tree: 'root' }).tree).toBe('root');
  });

  it('names a project by its last path segment', () => {
    expect(projectName('/home/kirin/Workspace/ferretry/')).toBe('ferretry');
    expect(projectName('C:\\work\\atomi')).toBe('atomi');
    expect(projectName('/')).toBeNull();
    expect(projectName(null)).toBeNull();
  });
});

describe('overviewTotals', () => {
  it('sums each figure over the sessions that have it and counts the rest beside it', () => {
    const totals = overviewTotals([
      row({ id: 'a', equivalentApiCostUsdMicros: 2_000_000, turns: 4, activeDurationMs: 8_000, durationMs: 10_000 }),
      row({
        id: 'b',
        equivalentApiCostUsdMicros: null,
        tokens: null,
        inputTokens: null,
        turns: null,
        activeDurationMs: null,
        durationMs: null,
      }),
    ]);
    expect(totals).toMatchObject({
      sessions: 2,
      costMicros: 2_000_000,
      unpriced: 1,
      tokensUnknown: 1,
      turns: 4,
      turnsUnknown: 1,
      activeMs: 8_000,
      activeUnknown: 1,
      activeTurns: 4,
      wallMs: 10_000,
      wallUnknown: 1,
    });
    expect(metricReading(totals, 'cost')).toEqual({ value: 2, unknown: 1 });
    expect(metricReading(totals, 'tokens')).toEqual({ value: 1_000, unknown: 1 });
    expect(metricReading(totals, 'turns')).toEqual({ value: 4, unknown: 1 });
    expect(metricReading(totals, 'active')).toEqual({ value: 8, unknown: 1 });
  });

  it('counts active turns as zero for a timed session whose turns are unknown', () => {
    expect(overviewTotals([row({ id: 'a', turns: null })]).activeTurns).toBe(0);
  });
});

describe('analyticsOverview', () => {
  const days = analyticsRangeDays(3, NOW);

  it('draws a day with no sessions as a known zero and ignores rows outside the window', () => {
    const overview = analyticsOverview(days, [
      row({ id: 'a', day: '2026-10-14' }),
      row({ id: 'old', day: '2026-09-01' }),
      row({ id: 'none', day: null }),
    ]);
    expect(overview.days.map(bucket => [bucket.key, bucket.totals.sessions, bucket.countedSessions])).toEqual([
      ['2026-10-14', 1, 1],
      ['2026-10-15', 0, 0],
      ['2026-10-16', 0, 0],
    ]);
    expect(overview.totals.sessions).toBe(1);
    expect(overview.partialDays).toBe(0);
  });

  it('keeps one session per machine and id, so two machines never merge two sessions', () => {
    const overview = analyticsOverview(days, [
      row({ id: 'same', day: '2026-10-15' }),
      row({ id: 'same', day: '2026-10-15' }),
      row({ id: 'same', day: '2026-10-15' }, THERE),
    ]);
    expect(overview.rows).toHaveLength(2);
    expect(overview.topSessions.map(session => session.machine)).toEqual(['studio-mac', 'kirin-box']);
  });

  it('counts a partly listed day from each machine’s own count and marks it', () => {
    const overview = analyticsOverview(
      days,
      [row({ id: 'a', day: '2026-10-15' }), row({ id: 'b', day: '2026-10-15' }, THERE)],
      [
        { day: '2026-10-15', daemonId: 'daemon-a', sessions: 40, unpriced: 2 },
        { day: '2026-10-15', daemonId: 'daemon-b', sessions: 0, unpriced: 0 },
      ],
    );
    expect(overview.days[1]).toMatchObject({ partial: true, countedSessions: 41 });
    expect(overview.partialDays).toBe(1);
    // A count with no machine stands for the whole day.
    const whole = analyticsOverview(days, [row({ id: 'a', day: '2026-10-16' })], [
      { day: '2026-10-16', sessions: 5, unpriced: 0 },
    ]);
    expect(whole.days[2]!.countedSessions).toBe(5);
  });

  it('folds days into Monday weeks, keeping only the window’s days', () => {
    const week = analyticsRangeDays(7, NOW);
    const overview = analyticsOverview(
      week,
      [row({ id: 'a', day: '2026-10-11' }), row({ id: 'b', day: '2026-10-12' }), row({ id: 'c', day: '2026-10-16' })],
      [{ day: '2026-10-16', sessions: 4, unpriced: 0 }],
    );
    const weeks = overviewWeeks(overview.days, overview.rows);
    expect(weeks.map(bucket => [bucket.key, bucket.totals.sessions, bucket.countedSessions, bucket.partial])).toEqual([
      ['2026-10-05', 1, 1, false],
      ['2026-10-12', 2, 5, true],
    ]);
  });
});

describe('splits and top sessions', () => {
  const rows = [
    row({ id: 'a', model: 'opus', equivalentApiCostUsdMicros: 5_000_000, agent: null }),
    row({ id: 'b', model: 'opus', equivalentApiCostUsdMicros: 1_000_000 }),
    row({ id: 'c', model: 'astra', equivalentApiCostUsdMicros: null, cwd: null }),
    row({ id: 'd', model: null, equivalentApiCostUsdMicros: 500_000 }, THERE),
  ];

  it('groups by each label, largest first, an unknown group named and a fully unknown one last', () => {
    expect(overviewGroups(rows, 'model', 'cost').map(group => group.key)).toEqual(['opus', 'unknown model', 'astra']);
    expect(overviewGroups(rows, 'runtime', 'cost').map(group => group.key)).toEqual(['unknown runtime', 'Marin']);
    expect(overviewGroups(rows, 'machine', 'turns').map(group => group.key)).toEqual(['studio-mac', 'kirin-box']);
    expect(overviewGroups(rows, 'project', 'cost').map(group => group.key)).toEqual(['ferretry', 'no project']);
    // Equal values with equal gaps fall back to the name.
    expect(overviewGroups([row({ id: 'y', model: 'b' }), row({ id: 'z', model: 'a' })], 'model', 'cost').map(group => group.key)).toEqual(['a', 'b']);
  });

  it('ranks trees by tokens, duration or cost, with an unknown value last and never as zero', () => {
    const trees = analyticsOverview(
      ['2026-10-13'],
      [
        row({ id: 'root', tree: 'root', tokens: 10, inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 }),
        row({ id: 'kid', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: null }),
        row({ id: 'big', equivalentApiCostUsdMicros: 9_000_000, activeDurationMs: 60_000 }),
        row({
          id: 'blank',
          equivalentApiCostUsdMicros: null,
          inputTokens: null,
          activeDurationMs: null,
        }),
        row({ id: 'orphan', tree: 'gone', parent: 'gone' }),
      ],
    ).topSessions;
    const root = trees.find(session => session.id === 'root')!;
    expect(root.children).toBe(1);
    expect(trees.find(session => session.id === 'gone')!.label).toBe('Flaky test fix');
    expect(rankTopSessions(trees, 'cost').map(session => session.id)).toEqual(['big', 'gone', 'root', 'blank']);
    expect(rankTopSessions(trees, 'duration').map(session => session.id).at(-1)).toBe('blank');
    expect(rankTopSessions(trees, 'tokens').map(session => session.id)).toEqual(['root', 'big', 'gone', 'blank']);
    const blank = trees.find(session => session.id === 'blank')!;
    expect([topSessionValue(blank, 'tokens'), topSessionValue(blank, 'duration'), topSessionValue(blank, 'cost')]).toEqual([
      null,
      null,
      null,
    ]);
    expect(topSessionValue(root, 'cost')).toBe(1);
    expect(rankTopSessions([blank, { ...blank, id: 'another' }], 'cost').map(session => session.id)).toEqual([
      'another',
      'blank',
    ]);
  });

  it('keeps the session pane’s priced split per model', () => {
    expect(
      analyticsModelShares([
        rawRow({ id: 'a', model: null, equivalentApiCostUsdMicros: 2 }),
        rawRow({ id: 'b', equivalentApiCostUsdMicros: 3 }),
        rawRow({ id: 'c', equivalentApiCostUsdMicros: 1 }),
        rawRow({ id: 'd', equivalentApiCostUsdMicros: null }),
      ]),
    ).toEqual([
      { model: 'claude-opus-5-5', costMicros: 4, sessions: 2 },
      { model: 'unknown model', costMicros: 2, sessions: 1 },
    ]);
  });
});

describe('axis and formatting', () => {
  it('picks round ticks from zero past the maximum', () => {
    expect(analyticsAxisTicks(109.4)).toEqual([0, 50, 100, 150]);
    expect(analyticsAxisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(analyticsAxisTicks(0.6)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(analyticsAxisTicks(0.7)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(analyticsAxisTicks(0)).toEqual([0, 1]);
  });

  it('picks duration ticks of whole hours, minutes or seconds', () => {
    expect(durationAxisTicks(5 * 3600)).toEqual([0, 7_200, 14_400, 21_600]);
    expect(durationAxisTicks(600)).toEqual([0, 300, 600]);
    expect(durationAxisTicks(30)).toEqual([0, 10, 20, 30]);
    expect([0, 7_200, 300, 45].map(formatAxisDuration)).toEqual(['0', '2h', '5m', '45s']);
  });

  it('formats dollars, tokens, counts, durations and days for people', () => {
    expect(formatUsd(614_800_000)).toBe('$614.80');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1_000)).toBe('<$0.01');
    expect(formatDollars(12.5)).toBe('$12.50');
    expect(formatAxisUsd(50)).toBe('$50');
    expect(formatAxisUsd(0.25)).toBe('$0.25');
    expect(formatTokens(144_000_000)).toBe('144M');
    expect(formatCount(1_284)).toBe('1,284');
    expect([42, 425, 11_520, 190_800, -3].map(formatDuration)).toEqual(['42s', '7m 05s', '3h 12m', '2d 5h', '0s']);
    expect(formatDay('2026-10-02')).toBe('2 Oct');
    expect(formatDay('2026-13-02')).toBe('2 13');
    expect(formatWeek('2026-10-12')).toBe('wk 12 Oct');
    expect(['cost', 'tokens', 'turns', 'active'].map(metric => formatMetric(metric as never, 1_500))).toEqual([
      '$1,500.00',
      '1.5K',
      '1,500',
      '25m 00s',
    ]);
  });
});
describe('readAnalyticsWindow', () => {
  const days = analyticsRangeDays(3, NOW);

  it('reads a small month in one request', async () => {
    const queries: string[] = [];
    const read = await readAnalyticsWindow(async query => {
      queries.push(query);
      return rawResponse([rawRow({ id: 'a', day: '2026-10-15' })], query);
    }, days);
    expect(queries).toEqual([analyticsDayQuery('2026-10-*')]);
    expect(queries[0]).toBe('{day="2026-10-*"}');
    expect(read.rows.map(row => row.id)).toEqual(['a']);
    expect(read.partial).toEqual([]);
  });

  it('narrows a truncated month to the window days, and counts a truncated day from its aggregate', async () => {
    const queries: string[] = [];
    const answers: Record<string, AnalyticsResponse> = {
      '{day="2026-10-*"}': rawResponse([], '', true),
      '{day="2026-10-14"}': rawResponse([rawRow({ id: 'a', day: '2026-10-14' })]),
      '{day="2026-10-15"}': rawResponse([rawRow({ id: 'b', day: '2026-10-15' })], '', true),
      'sum by (day) {day="2026-10-15"}': dayAggregate('2026-10-15', 140, 137),
      '{day="2026-10-16"}': rawResponse([], '', true),
      'sum by (day) {day="2026-10-16"}': rawResponse([]),
    };
    const read = await readAnalyticsWindow(async query => {
      queries.push(query);
      return answers[query]!;
    }, days);
    expect(queries).toContain('{day="2026-10-14"}');
    expect(read.rows.map(row => row.id).sort()).toEqual(['a', 'b']);
    expect(read.partial).toEqual([
      { day: '2026-10-15', sessions: 140, unpriced: 3 },
      { day: '2026-10-16', sessions: 0, unpriced: 0 },
    ]);
  });

  it('refuses an answer that is not session rows', async () => {
    await expect(readAnalyticsWindow(async () => dayAggregate('x', 1, 1), days)).rejects.toThrow(
      'expected session rows',
    );
  });
});

describe('sessionCost', () => {
  const root = rawRow({
    id: 'root',
    tree: 'root',
    equivalentApiCostUsdMicros: 40,
    inputTokens: 100,
    cachedInputTokens: 16,
  });
  const tree = [
    root,
    rawRow({ id: 'a', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: 10, model: 'sonnet' }),
    rawRow({ id: 'b', tree: 'root', parent: 'a', equivalentApiCostUsdMicros: null }),
    rawRow({ id: 'sibling', tree: 'root', parent: 'elsewhere', equivalentApiCostUsdMicros: 99 }),
  ];

  it('counts descendants only, through parent links', () => {
    expect(sessionDescendants(tree, 'root').map(row => row.id)).toEqual(['a', 'b']);
    expect(sessionDescendants(tree, 'a').map(row => row.id)).toEqual(['b']);
  });

  it('answers this session, with children, and the model split', () => {
    const cost = sessionCost(root, tree, false);
    expect(cost.children).toBe(2);
    expect(cost.withChildrenMicros).toBe(50);
    expect(cost.unpriced).toBe(1);
    expect(cost.cacheReadPercent).toBe(16);
    expect(cost.models.map(share => share.model)).toEqual(['claude-opus-5-5', 'sonnet']);
    expect(sessionCost(rawRow({ id: 'x', inputTokens: 0 }), [], true)).toMatchObject({
      childrenPartial: true,
      cacheReadPercent: null,
    });
  });

  it('matches the tree exactly, falling back to the session for a tree-less row', () => {
    expect(sessionTreeMatcher(root)).toBe('{tree=="root"}');
    expect(sessionTreeMatcher(rawRow({ id: 'a*b' }))).toBe('{tree=="a*b"}');
  });
});

describe('readMachineWindow', () => {
  it('tags every row and partial day with the machine it came from', async () => {
    const read = await readMachineWindow(
      async query =>
        query === '{day="2026-10-*"}'
          ? rawResponse([], query, true)
          : query.startsWith('sum')
            ? dayAggregate('2026-10-16', 9, 9)
            : rawResponse([rawRow({ id: 'a', day: '2026-10-16' })], query, true),
      ['2026-10-16'],
      THERE,
    );
    expect(read.rows.map(entry => [entry.id, entry.machine])).toEqual([['a', 'kirin-box']]);
    expect(read.partial).toEqual([{ day: '2026-10-16', daemonId: 'daemon-b', sessions: 9, unpriced: 0 }]);
  });
});
