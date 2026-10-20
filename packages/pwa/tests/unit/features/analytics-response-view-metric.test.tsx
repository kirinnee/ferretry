import { describe, expect, it } from 'bun:test';

import { AnalyticsResponseView } from '../../../src/features/analytics/analytics-response-view.tsx';
import { aggregateResponse, group } from '../../support/analytics-query-fixtures.ts';
import { rawResponse, rawRow } from '../../support/analytics-rows.ts';
import { render } from '../../support/react.ts';

const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
};

describe('AnalyticsResponseView with a metric', () => {
  it('shows each raw session by the asked metric, a gap as Unknown', () => {
    const response = {
      ...rawResponse(
        [rawRow({ id: 'a', durationMs: 90_000 }), rawRow({ id: 'b', durationMs: null })],
        'duration_wall_seconds',
      ),
      parsed: { groupBy: [], matchers: [], metric: 'duration_wall_seconds' },
    } as never;
    const body = textOf(render(<AnalyticsResponseView response={response} />).toJSON());
    expect(body).toContain('1m 30s');
    expect(body).toContain('Unknown');
    expect(body).toContain('Wall time');
  });

  it('draws the chart above an aggregate only when asked', () => {
    const response = aggregateResponse('sum(turns) by (model)', [group({ model: 'a' })], {
      groupBy: ['model'],
      metric: 'turns',
    });
    expect(JSON.stringify(render(<AnalyticsResponseView response={response} chart />).toJSON())).toContain('Turns');
    expect(render(<AnalyticsResponseView response={response} />).root.findAllByType('figure')).toHaveLength(0);
    expect(
      render(<AnalyticsResponseView response={response} chart />).root.findAllByType('figure').length,
    ).toBeGreaterThan(0);
  });
});
