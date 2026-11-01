import { describe, expect, it } from 'bun:test';

import {
  AnalyticsQueryChart,
  isTimeGrouped,
  QUERY_CHART_MAX_BARS,
  queryChartMetric,
  queryChartPoints,
} from '../../../src/features/analytics/analytics-query-chart.tsx';
import type { AnalyticsAggregateResponse } from '../../../src/features/analytics/analytics-result-table.tsx';
import { aggregateResponse, group, measure } from '../../support/analytics-query-fixtures.ts';
import { render } from '../../support/react.ts';

const agg = (response: ReturnType<typeof aggregateResponse>) => response as AnalyticsAggregateResponse;

describe('query chart model', () => {
  it('picks the asked metric, else cost, else sessions for a count', () => {
    expect(queryChartMetric(agg(aggregateResponse('q', [], { metric: 'turns' })))).toBe('turns');
    expect(queryChartMetric(agg(aggregateResponse('q', [])))).toBe('cost_usd');
    expect(queryChartMetric(agg(aggregateResponse('q', [], {}, 'count')))).toBe('sessions');
  });

  it('orders a time series by time and shortens a day', () => {
    const response = agg(
      aggregateResponse('q', [group({ day: '2026-10-14' }), group({ day: '2026-10-13' })], { groupBy: ['day'] }),
    );
    expect(isTimeGrouped(response)).toBe(true);
    expect(queryChartPoints(response, 'turns').map(point => point.label)).toEqual(['10-13', '10-14']);
    const weeks = agg(aggregateResponse('q', [group({ week: '2026-W42' })], { groupBy: ['week'] }));
    expect(queryChartPoints(weeks, 'turns')[0]!.label).toBe('2026-W42');
  });

  it('orders categories biggest first, caps them, and flags a lower bound and a known zero', () => {
    const groups = Array.from({ length: QUERY_CHART_MAX_BARS + 3 }, (_, index) =>
      group({ model: `m${index}` }, { turns: measure(index, 5, 5) }),
    );
    groups.push(group({ model: 'partial' }, { turns: measure(1000, 2, 5) }));
    groups.push(group({ model: null }, { turns: measure(0, 5, 5) }));
    const response = agg(aggregateResponse('q', groups, { groupBy: ['model'] }));
    const points = queryChartPoints(response, 'turns');
    expect(points).toHaveLength(QUERY_CHART_MAX_BARS);
    expect(points[0]).toMatchObject({ label: 'partial', flagged: true, values: [1000] });
    const all = queryChartPoints(agg(aggregateResponse('q', groups.slice(-2), { groupBy: ['model'] })), 'turns');
    expect(all.at(-1)).toMatchObject({ label: 'unknown', empty: true });
    expect(
      queryChartPoints(agg(aggregateResponse('q', [group({}, { turns: measure(null, 0, 5) })])), 'turns')[0],
    ).toMatchObject({ label: 'All sessions', values: [0], flagged: true });
  });
});

describe('AnalyticsQueryChart', () => {
  it('draws nothing for an empty result and a chart otherwise', () => {
    expect(render(<AnalyticsQueryChart response={agg(aggregateResponse('q', []))} />).toJSON()).toBeNull();
    const cost = render(
      <AnalyticsQueryChart response={agg(aggregateResponse('q', [group({ model: 'a' })], { groupBy: ['model'] }))} />,
    );
    expect(JSON.stringify(cost.toJSON())).toContain('Equivalent API cost');
    const time = render(
      <AnalyticsQueryChart
        response={agg(aggregateResponse('q', [group({ model: 'a' })], { groupBy: ['model'], metric: 'turns' }))}
      />,
    );
    expect(JSON.stringify(time.toJSON())).toContain('Turns');
  });
});

describe('AnalyticsQueryChart durations', () => {
  it('draws a duration on a whole-minute axis', () => {
    const rendered = render(
      <AnalyticsQueryChart
        response={agg(
          aggregateResponse('q', [group({ model: 'a' })], { groupBy: ['model'], metric: 'duration_active_seconds' }),
        )}
      />,
    );
    expect(JSON.stringify(rendered.toJSON())).toContain('Active time');
  });
});

describe('a bar for a group some sessions could not price', () => {
  it('draws the part that was priced, flagged as a lower bound, instead of an empty bar', () => {
    const partial = group(
      { model: 'claude-opus-5-5' },
      { equivalentApiCostUsdMicros: { value: null, known: 320, total: 330, knownSum: 412_500_000 } },
    );
    const nothing = group({ model: 'mystery' }, { equivalentApiCostUsdMicros: measure(null, 0, 5) });
    const points = queryChartPoints(
      agg(aggregateResponse('q', [nothing, partial], { groupBy: ['model'] })),
      'cost_usd',
    );
    expect(points.map(point => [point.label, point.values[0], point.flagged])).toEqual([
      ['claude-opus-5-5', 412.5, true],
      ['mystery', 0, true],
    ]);
  });
});

describe('the names under a by-model chart', () => {
  const byModel = (names: readonly string[]) =>
    agg(
      aggregateResponse(
        'q',
        names.map(model => group({ model })),
        { groupBy: ['model'] },
      ),
    );
  const labelsOf = (rendered: ReturnType<typeof render>) =>
    rendered.root.findAll(node => node.props['data-chart-xlabel'] !== undefined);

  it('rotates long names so every bar keeps a readable one under it', () => {
    const rendered = render(
      <AnalyticsQueryChart
        response={byModel([
          'claude-opus-5-5',
          'claude-sonnet-5-5',
          'glm-5.3',
          'gpt-6-astra',
          'deepseek-flash',
          'gpt-6.1-sol',
          'minimax-m3.1-flash-preview',
        ])}
      />,
    );
    const labels = labelsOf(rendered);
    expect(labels.length).toBeGreaterThanOrEqual(7);
    expect(new Set(labels.map(node => node.props['data-chart-xlabel'])).size).toBeGreaterThanOrEqual(7);
    expect(labels.every(node => String(node.props.className).includes('[writing-mode:vertical-rl]'))).toBe(true);
    expect(labels.every(node => String(node.props.className).includes('truncate'))).toBe(true);
  });

  it('keeps dates flat, thinned the way they were', () => {
    const response = agg(
      aggregateResponse('q', [group({ day: '2026-10-13' }), group({ day: '2026-10-14' })], { groupBy: ['day'] }),
    );
    const labels = labelsOf(render(<AnalyticsQueryChart response={response} />));
    expect(labels.every(node => !String(node.props.className).includes('vertical-rl'))).toBe(true);
  });
});
