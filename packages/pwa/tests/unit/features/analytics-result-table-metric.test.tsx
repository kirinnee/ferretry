import { describe, expect, it } from 'bun:test';
import { AnalyticsMetricSchema } from '@ferretry/protocol';

import {
  ANALYTICS_METRIC_LABELS,
  type AnalyticsAggregateResponse,
  AnalyticsResultTable,
  analyticsColumnsFor,
  analyticsMetricMeasure,
  analyticsTableRows,
  analyticsTotalRow,
  defaultAnalyticsSort,
  formatDurationSeconds,
  formatMetricMeasure,
  metricCoverageNote,
} from '../../../src/features/analytics/analytics-result-table.tsx';
import { aggregateResponse, group, measure } from '../../support/analytics-query-fixtures.ts';
import { render } from '../../support/react.ts';

const asAggregate = (response: ReturnType<typeof aggregateResponse>) => response as AnalyticsAggregateResponse;
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
};

describe('metric formatting', () => {
  it('formats durations as the two largest units', () => {
    expect(formatDurationSeconds(0)).toBe('0s');
    expect(formatDurationSeconds(-4)).toBe('0s');
    expect(formatDurationSeconds(38)).toBe('38s');
    expect(formatDurationSeconds(728)).toBe('12m 08s');
    expect(formatDurationSeconds(3725)).toBe('1h 02m');
    expect(formatDurationSeconds(3600)).toBe('1h 00m');
  });

  it('words a gap per metric and never prints a zero for it', () => {
    expect(formatMetricMeasure('cost_usd', measure(null, 0, 5))).toBe('Unpriced');
    expect(formatMetricMeasure('duration_active_seconds', measure(null, 0, 5))).toBe('Unknown');
    expect(formatMetricMeasure('cost_usd', measure(12.5, 3, 5))).toBe('≥ $12.50');
    expect(formatMetricMeasure('duration_wall_seconds', measure(90, 5, 5))).toBe('1m 30s');
    expect(formatMetricMeasure('tokens', measure(1234.56, 5, 5))).toBe('1,234.6');
    expect(metricCoverageNote('cost_usd', measure(1, 3, 5))).toBe('priced 3 of 5');
    expect(metricCoverageNote('turns', measure(1, 3, 5))).toBe('known 3 of 5');
    expect(metricCoverageNote('turns', measure(1, 5, 5))).toBeUndefined();
  });

  it('labels every metric', () => {
    expect(Object.keys(ANALYTICS_METRIC_LABELS)).toEqual([...AnalyticsMetricSchema.options]);
  });

  it('reads a group in the metric unit', () => {
    const row = group({ model: 'a' }, { sessions: 4 });
    expect(analyticsMetricMeasure(row, 'cost_usd').value).toBeCloseTo(12.34);
    expect(analyticsMetricMeasure(row, 'duration_active_seconds').value).toBeCloseTo(3725);
    expect(analyticsMetricMeasure(row, 'sessions')).toEqual({ value: 4, known: 4, total: 4 });
    expect(
      analyticsMetricMeasure(group({}, { equivalentApiCostUsdMicros: measure(null, 0, 5) }), 'cost_usd').value,
    ).toBeNull();
  });
});

describe('metric columns', () => {
  it('puts the metric first and keeps count to sessions only', () => {
    expect(analyticsColumnsFor('sum', 'cost_usd').map(column => column.key)).toEqual([
      'group',
      'metric',
      'costNow',
      'total',
      'sessions',
    ]);
    expect(analyticsColumnsFor('sum').map(column => column.key)).toContain('cost');
    expect(analyticsColumnsFor('count', 'cost_usd').map(column => column.key)).toEqual(['group', 'sessions']);
  });

  it('sorts a metric table by the metric, a time series by time', () => {
    const response = asAggregate(aggregateResponse('q', [group({ model: 'a' })], { groupBy: ['model'] }));
    expect(defaultAnalyticsSort(response, 'turns')).toEqual({ key: 'metric', direction: 'desc' });
    expect(defaultAnalyticsSort(response)).toEqual({ key: 'cost', direction: 'desc' });
    const timed = asAggregate(aggregateResponse('q', [group({ day: '2026-10-13' })], { groupBy: ['day'] }));
    expect(defaultAnalyticsSort(timed, 'turns')).toEqual({ key: 'group', direction: 'asc' });
  });

  it('totals the metric across groups', () => {
    const response = asAggregate(
      aggregateResponse('q', [group({ model: 'a' }), group({ model: 'b' })], { groupBy: ['model'] }),
    );
    expect(analyticsTotalRow(analyticsTableRows(response, 'turns')).metric.value).toBe(80);
  });
});

describe('AnalyticsResultTable with a metric', () => {
  const response = asAggregate(
    aggregateResponse(
      'sum(cost_usd) by (model)',
      [
        group({ model: 'cheap' }, { equivalentApiCostUsdMicros: measure(1_000_000, 5, 5) }),
        group({ model: 'gap' }, { equivalentApiCostUsdMicros: measure(null, 0, 5) }),
        group({ model: 'part' }, { equivalentApiCostUsdMicros: measure(9_000_000, 3, 5) }),
      ],
      { groupBy: ['model'], metric: 'cost_usd' },
    ),
  );

  it('shows the metric column first, the gap as words and the lower bound as a bound', () => {
    const renderer = render(<AnalyticsResultTable response={response} metric="cost_usd" />);
    const body = textOf(renderer.toJSON());
    expect(body).toContain('Equivalent API cost');
    expect(body).toContain('Unpriced');
    expect(body).toContain('≥ $9.00');
    expect(body).toContain('priced 3 of 5');
    expect(body).not.toContain('$0.00');
    expect(renderer.root.findAllByProps({ 'data-analytics-result-list': '' }).length).toBeGreaterThan(0);
    const headers = renderer.root.findAllByType('th').map(node => textOf(node));
    expect(headers.slice(0, 3)).toEqual(['Model', 'Equivalent API cost', "At today's prices"]);
  });

  it('falls back to the whole ledger for a count, which has no metric column', () => {
    const counted = asAggregate(
      aggregateResponse(
        'count(sessions) by (model)',
        [group({ model: 'a' })],
        { groupBy: ['model'], metric: 'sessions' },
        'count',
      ),
    );
    const renderer = render(<AnalyticsResultTable response={counted} metric="sessions" />);
    expect(renderer.root.findAllByType('th').map(node => textOf(node))).toEqual(['Model', 'Sessions', 'a']);
  });
});

describe('active time per turn', () => {
  it('divides the group sums and shows a duration', () => {
    const row = group({ model: 'a' }, { turns: measure(50, 5, 5), activeDurationMs: measure(3_000_000, 5, 5) });
    expect(analyticsMetricMeasure(row, 'duration_active_seconds_per_turn').value).toBeCloseTo(60);
    expect(formatMetricMeasure('duration_active_seconds_per_turn', measure(60, 5, 5))).toBe('1m 00s');
  });
});
