import { describe, expect, it } from 'bun:test';
import type { AnalyticsMeasure } from '@ferretry/protocol';
import {
  AnalyticsTimeSeries,
  analyticsLineSegments,
  analyticsTimeDomainSize,
  analyticsTimeSeriesData,
  latestAnalyticsTimePoints,
} from '../../../src/features/analytics/analytics-time-series.tsx';
import type { AnalyticsAggregateResponse } from '../../../src/features/analytics/analytics-result-table.tsx';
import { render } from '../../support/react.ts';

const measure = (value: number | null): AnalyticsMeasure => ({ value, known: value === null ? 0 : 1, total: 1 });
const result = (day: string | null, tokens: number | null, cost: number | null) => ({
  labels: { day },
  sessions: 1,
  tokens: measure(tokens),
  inputTokens: measure(tokens),
  outputTokens: measure(tokens),
  cachedInputTokens: measure(0),
  cacheWriteInputTokens: measure(0),
  equivalentApiCostUsdMicros: measure(cost),
});
const response = (
  results = [result('2026-07-01', 100, 500_000), result('2026-07-03', 300, null), result(null, 9, null)],
) =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
    results,
  }) as unknown as AnalyticsAggregateResponse;

describe('AnalyticsTimeSeries', () => {
  it('preserves unknown measures and undated groups instead of inventing chart values', () => {
    expect(analyticsTimeSeriesData(response())).toEqual({
      dimension: 'day',
      omittedUntimed: 1,
      points: [
        { bucket: '2026-07-01', sessions: 1, tokens: 100, equivalentApiCostUsdMicros: 500_000 },
        { bucket: '2026-07-03', sessions: 1, tokens: 300, equivalentApiCostUsdMicros: null },
      ],
    });
    expect(
      latestAnalyticsTimePoints(analyticsTimeSeriesData(response())!.points, 30, 'day').map(point => point.bucket),
    ).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(analyticsTimeDomainSize(analyticsTimeSeriesData(response())!.points, 'day')).toBe(3);
    expect(analyticsLineSegments([100, null, 300], 100, 50).map(segment => segment.length)).toEqual([1, 1]);
  });

  it('renders three responsive SVG charts with an accessible gap disclosure', () => {
    const renderer = render(<AnalyticsTimeSeries response={response()} />);
    expect(renderer.root.findAllByType('svg')).toHaveLength(3);
    expect(renderer.root.findAllByType('footer')[0]?.findAllByType('span').at(-1)?.children.join('')).toBe(
      '1 unknown bucket',
    );
    expect(renderer.root.findAllByType('p').at(-1)?.children.join('')).toContain('1 undated group is table-only');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('$0.00');
  });

  it('declines queries whose shape cannot be represented faithfully', () => {
    const renderer = render(
      <AnalyticsTimeSeries
        response={{ ...response(), parsed: { aggregation: 'sum', groupBy: ['day', 'model'], matchers: [] } }}
      />,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('This query remains fully available in the table.');
  });

  it('keeps an all-undated query in its table rather than drawing a made-up timeline', () => {
    const renderer = render(<AnalyticsTimeSeries response={response([result(null, 9, null)])} />);
    expect(renderer.root.findAllByType('svg')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('No dated groups matched this query.');
  });
});
