import { describe, expect, it } from 'bun:test';
import type { AnalyticsAggregateResult, AnalyticsMeasure } from '@ferretry/protocol';
import { costGapReason, unpricedLabel } from '../../../src/features/analytics/analytics-cost-gaps.ts';
import {
  type AnalyticsAggregateResponse,
  AnalyticsResultTable,
  analyticsMetricMeasure,
  analyticsTableRows,
  analyticsTotalRow,
  formatEquivalentCost,
  formatMetricMeasure,
  formatTokenMeasure,
  sortAnalyticsRows,
} from '../../../src/features/analytics/analytics-result-table.tsx';
import { render } from '../../support/react.ts';

const measure = (value: number | null, known = 1, total = 1, knownSum?: number): AnalyticsMeasure => ({
  value,
  known,
  total,
  ...(knownSum === undefined ? {} : { knownSum }),
});

/** The shape of the owner's screenshot: 330 sessions, 320 priced, so the daemon says only a lower bound. */
const opus = {
  labels: { model: 'claude-opus-5-5' },
  sessions: 330,
  rates: { stall: 0, failure: 0, completion: 100 },
  tokens: measure(null, 320, 330, 900_000_000),
  inputTokens: measure(null, 320, 330, 800_000_000),
  outputTokens: measure(null, 320, 330, 100_000_000),
  cachedInputTokens: measure(null, 320, 330, 500_000_000),
  cacheWriteInputTokens: measure(null, 320, 330, 10_000_000),
  equivalentApiCostUsdMicros: measure(null, 320, 330, 412_500_000),
  equivalentApiCostCurrentUsdMicros: measure(null, 320, 330, 430_000_000),
  costGaps: { transcript_unresolved: 6, missing_pricing_model: 4 },
};
const sonnet = {
  ...opus,
  labels: { model: 'claude-sonnet-5-5' },
  sessions: 4,
  tokens: measure(1_000, 4, 4),
  inputTokens: measure(600, 4, 4),
  outputTokens: measure(400, 4, 4),
  cachedInputTokens: measure(0, 4, 4),
  cacheWriteInputTokens: measure(0, 4, 4),
  equivalentApiCostUsdMicros: measure(2_000_000, 4, 4),
  equivalentApiCostCurrentUsdMicros: measure(2_500_000, 4, 4),
  costGaps: undefined,
};
const unpriced = {
  ...opus,
  labels: { model: 'mystery' },
  sessions: 2,
  tokens: measure(null, 0, 2),
  equivalentApiCostUsdMicros: measure(null, 0, 2),
  equivalentApiCostCurrentUsdMicros: measure(null, 0, 2),
  costGaps: { unknown_pricing_model: 2 },
};

const response = (results: readonly unknown[]): AnalyticsAggregateResponse =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    query: 'sum by (model)',
    results,
  }) as unknown as AnalyticsAggregateResponse;

const textOf = (node: unknown): string => JSON.stringify(node);

describe('a cost that some sessions could not state', () => {
  it('prints the sessions that did state one as a lower bound, never as Unpriced', () => {
    expect(formatEquivalentCost(measure(null, 320, 330, 412_500_000))).toBe('≥ $412.50');
    expect(formatTokenMeasure(measure(null, 320, 330, 900_000_000))).toBe('≥ 900,000,000');
    expect(formatMetricMeasure('cost_usd', measure(null, 320, 330, 412.5))).toBe('≥ $412.50');
    expect(formatMetricMeasure('cost_now_usd', measure(null, 0, 3))).toBe('Unpriced');
  });

  it('keeps a group nothing could price as Unpriced', () => {
    expect(formatEquivalentCost(measure(null, 0, 2))).toBe('Unpriced');
  });

  it('puts the lower bound in the metric unit', () => {
    const [row] = response([opus]).results as AnalyticsAggregateResult[];
    const metric = analyticsMetricMeasure(row!, 'cost_usd');
    expect(metric.value).toBeNull();
    expect(metric.knownSum).toBeCloseTo(412.5);
  });

  it('sorts by what a group is known to have cost, with groups that know nothing last', () => {
    const rows = analyticsTableRows(response([unpriced, sonnet, opus]));
    expect(sortAnalyticsRows(rows, 'cost', 'desc').map(row => row.group)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'mystery',
    ]);
  });

  it('adds the stated part of an incomplete group into the total, which stays a lower bound', () => {
    const rows = analyticsTableRows(response([opus, sonnet, unpriced]));
    const total = analyticsTotalRow(rows);
    expect(total.cost).toEqual({ value: 414_500_000, known: 324, total: 336 });
    expect(total.costNow).toEqual({ value: 432_500_000, known: 324, total: 336 });
    expect(formatEquivalentCost(total.cost)).toBe('≥ $414.50');
    expect(total.costGaps).toEqual({ transcript_unresolved: 6, missing_pricing_model: 4, unknown_pricing_model: 2 });
  });

  it('says why in plain words, and falls back to the reason itself', () => {
    expect(costGapReason('transcript_unresolved')).toBe('transcript not found');
    expect(costGapReason('missing_pricing_model')).toBe('no model name recorded');
    expect(costGapReason('pricing_outside_validity_window')).toBe('no price in force that day');
    expect(costGapReason('unknown')).toBe('reason not recorded');
    expect(costGapReason('some_new_reason')).toBe('some new reason');
  });

  it('counts the unpriced sessions in the label', () => {
    expect(unpricedLabel({ transcript_unresolved: 6, missing_pricing_model: 4 })).toBe('10 unpriced');
    expect(unpricedLabel({ unknown: 1 })).toBe('1 unpriced');
    expect(unpricedLabel(undefined)).toBeUndefined();
  });
});

describe('the ledger over an incomplete group', () => {
  it('shows the lower bound, the tokens and an openable list of reasons on desktop and phone', () => {
    const renderer = render(<AnalyticsResultTable response={response([opus, sonnet])} today="2026-10-31" />);
    const text = textOf(renderer.toJSON());
    expect(text).toContain('≥ $412.50');
    expect(text).toContain('≥ 900,000,000');
    expect(text).not.toContain('Unpriced');
    expect(text).toContain('10 unpriced');
    expect(text).toContain('transcript not found');
    expect(text).toContain('no model name recorded');
    expect(renderer.root.findAllByType('details').length).toBeGreaterThanOrEqual(2);
  });

  it('shows what each session cost at the time and what the same tokens cost today, and which dates', () => {
    const renderer = render(<AnalyticsResultTable response={response([sonnet])} today="2026-10-31" />);
    const text = textOf(renderer.toJSON());
    expect(text).toContain('$2.00');
    expect(text).toContain('$2.50');
    expect(text).toContain('At the time');
    expect(text).toContain('At today');
    expect(text).toContain('2026-10-31');
  });

  it('still renders an answer from a daemon that has no today-price figure', () => {
    const { equivalentApiCostCurrentUsdMicros: _omitted, ...older } = sonnet;
    const renderer = render(<AnalyticsResultTable response={response([older])} today="2026-10-31" />);
    expect(textOf(renderer.toJSON())).toContain('$2.00');
  });
});
