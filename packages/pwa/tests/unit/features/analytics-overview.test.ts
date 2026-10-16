import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import {
  analyticsAxisTicks,
  analyticsModelShares,
  analyticsMonthGlobs,
  analyticsOverview,
  analyticsRangeDays,
  analyticsTopSessions,
  formatAxisUsd,
  formatDay,
  formatTokens,
  formatUsd,
  projectName,
  utcDay,
} from '../../../src/features/analytics/analytics-overview.ts';
import { analyticsDayQuery, readAnalyticsWindow } from '../../../src/features/analytics/analytics-overview-load.ts';
import { sessionCost, sessionDescendants, sessionTreeMatcher } from '../../../src/features/analytics/session-cost.ts';
import { dayAggregate, rawResponse, rawRow } from '../../support/analytics-rows.ts';

const NOW = new Date('2026-10-16T23:30:00Z');

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
});

describe('analyticsOverview', () => {
  const days = ['2026-10-12', '2026-10-13', '2026-10-14'];

  it('keeps the known total when a session is unpriced and counts the gap beside it', () => {
    const overview = analyticsOverview(days, [
      rawRow({ id: 'a', day: '2026-10-12', equivalentApiCostUsdMicros: 2_000_000 }),
      rawRow({ id: 'b', day: '2026-10-12', equivalentApiCostUsdMicros: null, model: 'mystery' }),
      rawRow({ id: 'c', day: '2026-10-14', equivalentApiCostUsdMicros: 4_000_000, model: 'claude-sonnet-5-5' }),
      rawRow({ id: 'outside', day: '2026-09-01' }),
      rawRow({ id: 'undated', day: null }),
    ]);
    expect(overview.costMicros).toBe(6_000_000);
    expect(overview.unpriced).toBe(1);
    expect(overview.sessions).toBe(3);
    expect(overview.pricedSessions).toBe(2);
    expect(overview.averageMicros).toBe(3_000_000);
    expect(overview.busiest?.day).toBe('2026-10-12');
    expect(overview.partialDays).toBe(0);
    expect(overview.models.map(share => share.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('draws a day with no sessions as a known zero, not a gap', () => {
    const overview = analyticsOverview(days, [rawRow({ id: 'a', day: '2026-10-12' })]);
    expect(overview.days.map(day => [day.day, day.sessions, day.costMicros])).toEqual([
      ['2026-10-12', 1, 1_000_000],
      ['2026-10-13', 0, 0],
      ['2026-10-14', 0, 0],
    ]);
  });

  it('counts a partly listed day from the daemon and marks it', () => {
    const overview = analyticsOverview(
      days,
      [rawRow({ id: 'a', day: '2026-10-13' })],
      [{ day: '2026-10-13', sessions: 140, unpriced: 3 }],
    );
    const busy = overview.days[1]!;
    expect(busy).toEqual({ day: '2026-10-13', sessions: 140, costMicros: 1_000_000, unpriced: 3, partial: true });
    expect(overview.partialDays).toBe(1);
    expect(overview.unpriced).toBe(3);
  });

  it('sums tokens, cache share and unknown token counts from the rows that have them', () => {
    const overview = analyticsOverview(days, [
      rawRow({ id: 'a', inputTokens: 1_000, cachedInputTokens: 250, tokens: 1_200 }),
      rawRow({ id: 'b', tokens: null, inputTokens: null, cachedInputTokens: null }),
    ]);
    expect(overview.tokens).toBe(1_200);
    expect(overview.tokensUnknown).toBe(1);
    expect(overview.cacheReadPercent).toBe(25);
  });

  it('has no average, busiest day or cache share for an empty window', () => {
    const overview = analyticsOverview(days, []);
    expect(overview.averageMicros).toBeNull();
    expect(overview.busiest).toBeNull();
    expect(overview.cacheReadPercent).toBeNull();
    expect(overview.topSessions).toEqual([]);
  });

  it('dedupes a session listed by two reads', () => {
    const row = rawRow({ id: 'a' });
    expect(analyticsOverview(days, [row, row]).sessions).toBe(1);
  });
});

describe('model shares and top sessions', () => {
  it('splits priced cost by model, naming a missing model', () => {
    expect(
      analyticsModelShares([
        rawRow({ id: 'a', model: null, equivalentApiCostUsdMicros: 5 }),
        rawRow({ id: 'b', model: 'x', equivalentApiCostUsdMicros: 5 }),
        rawRow({ id: 'c', model: 'x', equivalentApiCostUsdMicros: null }),
      ]),
    ).toEqual([
      { model: 'unknown model', costMicros: 5, sessions: 1 },
      { model: 'x', costMicros: 5, sessions: 1 },
    ]);
  });

  it('groups a tree under its root with its children counted and ranks trees by cost', () => {
    const top = analyticsTopSessions([
      rawRow({ id: 'root', tree: 'root', agent: 'Marin', cwd: '/w/ferretry/', equivalentApiCostUsdMicros: 10 }),
      rawRow({ id: 'kid', tree: 'root', parent: 'root', agent: 'Kid', equivalentApiCostUsdMicros: null }),
      rawRow({ id: 'solo', agent: 'Hadi', cwd: null, equivalentApiCostUsdMicros: 30 }),
      rawRow({ id: 'orphan', tree: 'gone', agent: 'Wren', equivalentApiCostUsdMicros: 30 }),
    ]);
    expect(top.map(session => session.id)).toEqual(['gone', 'solo', 'root']);
    expect(top[0]).toMatchObject({ agent: 'Wren', children: 1 });
    expect(top[1]).toMatchObject({ agent: 'Hadi', project: null, children: 0 });
    expect(top[2]).toMatchObject({ agent: 'Marin', project: 'ferretry', children: 1, unpriced: 1, costMicros: 10 });
  });

  it('names a project by its last path segment', () => {
    expect(projectName('C:\\work\\atomi')).toBe('atomi');
    expect(projectName('/')).toBeNull();
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

  it('formats dollars, tokens and days for people', () => {
    expect(formatUsd(614_800_000)).toBe('$614.80');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1_000)).toBe('<$0.01');
    expect(formatAxisUsd(50)).toBe('$50');
    expect(formatAxisUsd(0.25)).toBe('$0.25');
    expect(formatTokens(144_000_000)).toBe('144M');
    expect(formatDay('2026-10-02')).toBe('2 Oct');
    expect(formatDay('2026-13-02')).toBe('2 13');
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
