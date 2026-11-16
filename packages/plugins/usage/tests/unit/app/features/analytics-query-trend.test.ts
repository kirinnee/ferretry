import { describe, expect, it } from 'bun:test';

import { readAnalyticsQuery } from '../../../../app/features/analytics/analytics-query-text.ts';
import { isAdditive, trendPlan } from '../../../../app/features/analytics/analytics-query-trend.ts';
import { isTrend, trendChartModel } from '../../../../app/features/analytics/analytics-trend-points.ts';
import type { AnalyticsAggregateResponse } from '../../../../app/features/analytics/analytics-result-table.tsx';
import { aggregateResponse, group, measure } from '../support/analytics-query-fixtures.ts';

const agg = (response: ReturnType<typeof aggregateResponse>) => response as AnalyticsAggregateResponse;

describe('the plan for a trend', () => {
  it('adds the bucket to the grouping and keeps the measure, the filters and the range', () => {
    const plan = trendPlan('sum(cost_usd) by (model) {harness=claude} [7d]', 'day');
    expect(plan).toEqual({
      ok: true,
      query: 'sum(cost_usd) by (model, day) {harness=claude} [7d]',
      bucket: 'day',
      fixed: false,
      addedRange: undefined,
    });
  });

  it('counts in weeks when asked to', () => {
    expect(trendPlan('sum(tokens) [30d]', 'week')).toMatchObject({ ok: true, query: 'sum(tokens) by (week) [30d]' });
  });

  it('gives a trend of an unbounded query a window, and says so', () => {
    expect(trendPlan('sum(tokens)', 'day')).toEqual({
      ok: true,
      query: 'sum(tokens) by (day) [30d]',
      bucket: 'day',
      fixed: false,
      addedRange: '30d',
    });
    expect(trendPlan('sum(tokens)', 'week')).toMatchObject({ query: 'sum(tokens) by (week) [90d]', addedRange: '90d' });
  });

  it('leaves a query that is already a time series as it is', () => {
    expect(trendPlan('sum(tokens) by (week) [90d]', 'day')).toMatchObject({
      ok: true,
      query: 'sum(tokens) by (week) [90d]',
      bucket: 'week',
      fixed: true,
    });
  });

  it('says the query\u2019s own day or week is the bucket, whichever the control was set to', () => {
    expect(trendPlan('sum(turns) by (day) [7d]', 'week')).toMatchObject({
      ok: true,
      query: 'sum(turns) by (day) [7d]',
      bucket: 'day',
      fixed: true,
    });
  });

  it('does not split a ratio metric, even under sum: a sum of per-turn times is not the pooled time per turn', () => {
    expect(isAdditive('sum', 'turns')).toBe(true);
    expect(isAdditive('count')).toBe(true);
    expect(isAdditive('sum', 'duration_active_seconds_per_turn')).toBe(false);
    expect(isAdditive('avg', 'turns')).toBe(false);
    expect(trendPlan('sum(duration_active_seconds_per_turn) by (model) [7d]', 'day')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ratio'),
    });
    // On its own it is one series, which is fine.
    expect(trendPlan('sum(duration_active_seconds_per_turn) [7d]', 'day')).toMatchObject({ ok: true });
  });

  it('has no trend of a raw query, nor of an avg, min or max split by another label', () => {
    expect(trendPlan('cost_usd [7d]', 'day')).toMatchObject({ ok: false, reason: expect.stringContaining('sum') });
    expect(trendPlan('avg(cost_usd) by (model) [7d]', 'day')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('model'),
    });
    // An avg on its own is a fine trend: one series.
    expect(trendPlan('avg(cost_usd) [7d]', 'day')).toMatchObject({ ok: true, query: 'avg(cost_usd) by (day) [7d]' });
  });

  it('refuses a fifth grouping label rather than dropping one', () => {
    const plan = trendPlan('sum(tokens) by (model, harness, project, machine) [7d]', 'day');
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining('at most 4') });
  });

  it('sends text it cannot read as it is, so the daemon says what is wrong', () => {
    expect(trendPlan('sum by (nonsense)', 'day')).toMatchObject({ ok: true, query: 'sum by (nonsense)' });
  });
});

describe('the plan for a trend at the length limit', () => {
  it('refuses, rather than throws, when the added bucket pushes a valid query over 2,048 characters', () => {
    const near = `sum(tokens) {label=${'a'.repeat(2_020)}} [7d]`;
    expect(near.length).toBeLessThan(2_048);
    expect(readAnalyticsQuery(near).ok).toBe(true);
    const plan = trendPlan(near, 'day');
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining('2048') });
  });
});

describe('the chart of a trend', () => {
  const days = (
    rows: readonly [string, number][],
    extra: Record<string, string> = {},
    aggregation: 'sum' | 'avg' = 'sum',
  ) =>
    agg(
      aggregateResponse(
        'q',
        rows.map(([day, turns]) => group({ ...extra, day }, { turns: measure(turns, 5, 5) })),
        { groupBy: [...Object.keys(extra), 'day'] as never, metric: 'turns' },
        aggregation,
      ),
    );

  it('puts days in order and fills a quiet day in between as a known zero', () => {
    const { series, points } = trendChartModel(
      days([
        ['2026-10-14', 3],
        ['2026-10-12', 5],
      ]),
      'turns',
    );
    expect(series).toHaveLength(1);
    expect(points.map(point => [point.label, point.values[0], point.empty])).toEqual([
      ['10-12', 5, false],
      ['10-13', 0, true],
      ['10-14', 3, false],
    ]);
  });

  it('does not invent a zero for an average of nothing', () => {
    const { points } = trendChartModel(
      days(
        [
          ['2026-10-14', 3],
          ['2026-10-12', 5],
        ],
        {},
        'avg',
      ),
      'turns',
    );
    expect(points.map(point => point.label)).toEqual(['10-12', '10-14']);
  });

  it('steps a weekly trend by seven days', () => {
    const response = agg(
      aggregateResponse('q', [group({ week: '2026-10-05' }), group({ week: '2026-10-19' })], {
        groupBy: ['week'],
        metric: 'turns',
      }),
    );
    expect(trendChartModel(response, 'turns').points.map(point => point.key)).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
  });

  it('labels weeks by a short month and day, with the year only where it starts or changes', () => {
    const response = agg(
      aggregateResponse('q', [group({ week: '2026-12-21' }), group({ week: '2027-01-04' })], {
        groupBy: ['week'],
        metric: 'turns',
      }),
    );
    const { points } = trendChartModel(response, 'turns');
    expect(points.map(point => point.key)).toEqual(['2026-12-21', '2026-12-28', '2027-01-04']);
    expect(points.map(point => point.label)).toEqual(["Dec 21 '26", 'Dec 28', "Jan 4 '27"]);
    expect(points[1]!.readout).toStartWith('week of 2026-12-28 · ');
  });

  it('labels ISO week keys as W42, with the year only where it starts or changes', () => {
    const response = agg(
      aggregateResponse('q', [group({ week: '2026-W52' }), group({ week: '2026-W53' }), group({ week: '2027-W01' })], {
        groupBy: ['week'],
        metric: 'turns',
      }),
    );
    const { points } = trendChartModel(response, 'turns');
    expect(points.map(point => point.key)).toEqual(['2026-W52', '2026-W53', '2027-W01']);
    expect(points.map(point => point.label)).toEqual(["W52 '26", 'W53', "W01 '27"]);
    expect(points[1]!.readout).toStartWith('week of 2026-W53 · ');
  });

  it('leaves a bucket that is not a date as it is', () => {
    const response = agg(aggregateResponse('q', [group({ week: 'unknown' })], { groupBy: ['week'], metric: 'turns' }));
    const { points } = trendChartModel(response, 'turns');
    expect(points.map(point => point.label)).toEqual(['unknown']);
    expect(points[0]!.readout).toStartWith('unknown · ');
  });

  it('stacks one series per other group, biggest first, and joins the rest as Other', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((model, index) => [
      group({ model, day: '2026-10-12' }, { turns: measure((5 - index) * 10, 5, 5) }),
      group({ model, day: '2026-10-13' }, { turns: measure(1, 5, 5) }),
    ]);
    const response = agg(aggregateResponse('q', rows, { groupBy: ['model', 'day'], metric: 'turns' }));
    const { series, points } = trendChartModel(response, 'turns');
    expect(series.map(entry => entry.label)).toEqual(['a', 'b', 'c', 'Other']);
    expect(new Set(series.map(entry => entry.tone)).size).toBe(4);
    expect(points[0]!.values).toEqual([50, 40, 30, 20 + 10]);
    expect(points[0]!.readout).toContain('Other 30');
    expect(isTrend(response)).toBe(true);
  });

  it('keeps a lower bound hatched and does not draw an avg split by a label as a trend', () => {
    const partial = agg(
      aggregateResponse('q', [group({ day: '2026-10-12' }, { turns: measure(null, 2, 5) })], {
        groupBy: ['day'],
        metric: 'turns',
      }),
    );
    expect(trendChartModel(partial, 'turns').points[0]).toMatchObject({ flagged: true });
    const split = days([['2026-10-12', 3]], { model: 'a' }, 'avg');
    expect(isTrend(split)).toBe(false);
  });

  it('stacks, sums and fills nothing for a ratio metric', () => {
    const ratio = (rows: readonly [string, string][]) =>
      agg(
        aggregateResponse(
          'q',
          rows.map(([model, day]) => group({ model, day })),
          { groupBy: ['model', 'day'], metric: 'duration_active_seconds_per_turn' },
        ),
      );
    // 60 s over 2 turns and 40 s over 4 turns pool to 16.7 s per turn: a stack of the two would lie.
    expect(isTrend(ratio([['a', '2026-10-12']]))).toBe(false);
    const alone = agg(
      aggregateResponse('q', [group({ day: '2026-10-12' }), group({ day: '2026-10-14' })], {
        groupBy: ['day'],
        metric: 'duration_active_seconds_per_turn',
      }),
    );
    expect(isTrend(alone)).toBe(true);
    expect(trendChartModel(alone, 'duration_active_seconds_per_turn').points.map(point => point.label)).toEqual([
      '10-12',
      '10-14',
    ]);
  });

  describe('what each bucket knows', () => {
    const cost = (day: string, micros: Parameters<typeof measure>[0], known = 5, total = 5, knownSum?: number) =>
      group(
        { day },
        {
          equivalentApiCostUsdMicros: {
            ...measure(micros, known, total),
            ...(knownSum === undefined ? {} : { knownSum }),
          },
        },
      );
    const trendOf = (rows: ReturnType<typeof group>[], aggregation: 'sum' | 'avg' = 'sum') =>
      trendChartModel(
        agg(aggregateResponse('q', rows, { groupBy: ['day'], metric: 'cost_usd' }, aggregation)),
        'cost_usd',
      );

    it('reads a bucket nothing could price as unknown, never $0.00', () => {
      const { points } = trendOf([cost('2026-10-12', null, 0, 5), cost('2026-10-13', 2_000_000)], 'avg');
      expect(points[0]).toMatchObject({ readout: '10-12 · Unpriced', texts: ['Unpriced'], values: [0], flagged: true });
      expect(points[0]!.empty).toBe(false);
      expect(points[1]).toMatchObject({ readout: '10-13 · $2.00', flagged: false });
    });

    it('keeps a partial sum a lower bound in the readout, with the real figure in the bar', () => {
      const { points } = trendOf([cost('2026-10-12', null, 2, 5, 5_000_000)]);
      expect(points[0]).toMatchObject({ readout: '10-12 · ≥ $5.00', values: [5], flagged: true });
    });

    it('keeps an unknown-but-total-less measure unknown too', () => {
      const { points } = trendOf([cost('2026-10-12', null, 0, 0)]);
      expect(points[0]).toMatchObject({ readout: '10-12 · Unpriced', flagged: true });
    });

    it('merges the groups beyond three into an Other that is a lower bound if any part is', () => {
      const rows = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((model, index) => [
        group(
          { model, day: '2026-10-12' },
          {
            equivalentApiCostUsdMicros:
              model === 'e'
                ? { value: null, known: 1, total: 5, knownSum: 2_000_000 }
                : model === 'f'
                  ? measure(null, 0, 5)
                  : measure((10 - index) * 1_000_000, 5, 5),
          },
        ),
        group(
          { model, day: '2026-10-13' },
          { equivalentApiCostUsdMicros: 'def'.includes(model) ? measure(null, 0, 5) : measure(1_000_000) },
        ),
      ]);
      const response = agg(aggregateResponse('q', rows, { groupBy: ['model', 'day'], metric: 'cost_usd' }));
      const { series, points } = trendChartModel(response, 'cost_usd');
      expect(series.map(entry => entry.label)).toEqual(['a', 'b', 'c', 'Other']);
      // d's $7 and e's $2 are stated, f's is not: the merged bar is at least $9.
      expect(points[0]).toMatchObject({ values: [10, 9, 8, 9], flagged: true });
      expect(points[0]!.texts).toEqual(['$10.00', '$9.00', '$8.00', '≥ $9.00']);
      // Nothing in Other could be priced the next day: unknown, not $0.00.
      expect(points[1]!.texts![3]).toBe('Unpriced');
      expect(points[1]!.readout).toContain('Other Unpriced');
    });

    it('adds complete groups into an exact Other', () => {
      const rows = ['a', 'b', 'c', 'd', 'e'].map((model, index) =>
        group({ model, day: '2026-10-12' }, { equivalentApiCostUsdMicros: measure((5 - index) * 1_000_000) }),
      );
      const response = agg(aggregateResponse('q', rows, { groupBy: ['model', 'day'], metric: 'cost_usd' }));
      const { points } = trendChartModel(response, 'cost_usd');
      expect(points[0]).toMatchObject({ values: [5, 4, 3, 3], flagged: false });
      expect(points[0]!.texts![3]).toBe('$3.00');
    });
  });

  it('orders series with equal totals by name, then by identity, so the stack never reshuffles', () => {
    const tied = (labels: Record<string, string | null>[]) =>
      trendChartModel(
        agg(
          aggregateResponse(
            'q',
            labels.map(entry => group(entry, { turns: measure(5, 1, 1) })),
            { groupBy: ['model', 'day'] as never, metric: 'turns' },
            'sum',
          ),
        ),
        'turns',
      );
    expect(
      tied([
        { model: 'b', day: '2026-10-12' },
        { model: 'a', day: '2026-10-12' },
      ]).series.map(entry => entry.label),
    ).toEqual(['a', 'b']);
    // Two different tuples can spell the same name ('a · b' + 'c' vs 'a' + 'b · c'): identity breaks that tie,
    // whatever order the rows came in.
    const grouped = (rows: [string, string][]) =>
      trendChartModel(
        agg(
          aggregateResponse(
            'q',
            rows.map(([model, harness]) => group({ model, harness, day: '2026-10-12' }, { turns: measure(5, 1, 1) })),
            { groupBy: ['model', 'harness', 'day'] as never, metric: 'turns' },
            'sum',
          ),
        ),
        'turns',
      ).series.map(entry => entry.key);
    const forward = grouped([
      ['a · b', 'c'],
      ['a', 'b · c'],
    ]);
    const backward = grouped([
      ['a', 'b · c'],
      ['a · b', 'c'],
    ]);
    expect(forward).toEqual(backward);
  });

  it('keeps a missing label apart from the text "unknown", and a delimiter inside a value apart from two values', () => {
    const rows = (labels: Record<string, string | null>[]) =>
      agg(
        aggregateResponse(
          'q',
          labels.map((entry, index) => group(entry, { sessions: index + 1, turns: measure(index + 1, 1, 1) })),
          { groupBy: ['label', 'day'] as never, metric: 'turns' },
          'count',
        ),
      );
    const nulls = trendChartModel(
      rows([
        { label: null, day: '2026-10-12' },
        { label: 'unknown', day: '2026-10-12' },
      ]),
      'turns',
    );
    expect(nulls.series.map(entry => entry.label).sort()).toEqual(['unknown', 'unknown (none)']);
    expect(new Set(nulls.series.map(entry => entry.key)).size).toBe(2);
    expect([...nulls.points[0]!.values].sort()).toEqual([1, 2]);

    const delimited = trendChartModel(
      aggregateResponse(
        'q',
        [
          group({ model: 'a · b', harness: 'c', day: '2026-10-12' }, { turns: measure(3, 1, 1) }),
          group({ model: 'a', harness: 'b · c', day: '2026-10-12' }, { turns: measure(4, 1, 1) }),
        ],
        { groupBy: ['model', 'harness', 'day'] as never, metric: 'turns' },
        'count',
      ) as AnalyticsAggregateResponse,
      'turns',
    );
    expect(new Set(delimited.series.map(entry => entry.key)).size).toBe(2);
    expect([...delimited.points[0]!.values].sort()).toEqual([3, 4]);
  });

  it('is not a trend when nothing is bucketed by time', () => {
    const response = agg(aggregateResponse('q', [group({ model: 'a' })], { groupBy: ['model'] }));
    expect(isTrend(response)).toBe(false);
    expect(trendChartModel(response, 'turns').points).toEqual([]);
  });
});
