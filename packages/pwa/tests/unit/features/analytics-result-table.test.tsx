import { describe, expect, it } from 'bun:test';
import type { AnalyticsMeasure } from '@ferretry/protocol';
import {
  AnalyticsResultTable,
  type AnalyticsAggregateResponse,
  analyticsColumnsFor,
  analyticsTableRows,
  analyticsTotalRow,
  coverageNote,
  defaultAnalyticsSort,
  formatEquivalentCost,
  formatTokenMeasure,
  formatUsdMicros,
  sortAnalyticsRows,
} from '../../../src/features/analytics/analytics-result-table.tsx';
import { render, run } from '../../support/react.ts';

const measure = (value: number | null, known = 1, total = 1): AnalyticsMeasure => ({ value, known, total });

const group = (name: string, tokens: number, cost: number | null, sessions = 1) => ({
  labels: { model: name },
  sessions,
  rates: { stall: 0, failure: 0, completion: 1 },
  tokens: measure(tokens, sessions, sessions),
  inputTokens: measure(tokens * 0.6, sessions, sessions),
  outputTokens: measure(tokens * 0.4, sessions, sessions),
  cachedInputTokens: measure(tokens * 0.3, sessions, sessions),
  cacheWriteInputTokens: measure(tokens * 0.1, sessions, sessions),
  equivalentApiCostUsdMicros: measure(cost, cost === null ? 0 : sessions, sessions),
});

const response = (results: readonly ReturnType<typeof group>[], aggregation = 'sum'): AnalyticsAggregateResponse =>
  ({ kind: 'aggregate', aggregation, query: 'sum by (model)', results }) as unknown as AnalyticsAggregateResponse;

const mixed = response([
  group('claude-sonnet', 1_000, 2_000_000),
  group('unpriced', 5_000_000, null),
  group('claude-opus', 2_000, 9_000_000),
]);

describe('analytics result table', () => {
  it('keeps unknown pricing visible and sorts it after every known price', () => {
    const rows = analyticsTableRows(mixed);
    expect(sortAnalyticsRows(rows, 'cost', 'desc').map(row => row.group)).toEqual([
      'model=claude-opus',
      'model=claude-sonnet',
      'model=unpriced',
    ]);
    expect(sortAnalyticsRows(rows, 'cost', 'asc').map(row => row.group)).toEqual([
      'model=claude-sonnet',
      'model=claude-opus',
      'model=unpriced',
    ]);
    expect(sortAnalyticsRows(rows, 'group', 'asc').map(row => row.group)[0]).toBe('model=claude-opus');
    expect(formatEquivalentCost(rows[1]?.cost)).toBe('Cost unknown');
    expect(formatTokenMeasure(rows[1]?.total)).toBe('5,000,000');
  });

  it('formats exact cost micros and uses strict, coverage-aware total measures', () => {
    expect(formatUsdMicros(2_500_000n)).toBe('$2.50');
    expect(formatUsdMicros(-1n)).toBe('-$0.000001');
    expect(formatTokenMeasure(undefined)).toBe('—');
    expect(formatEquivalentCost(undefined)).toBe('Cost unknown');
    expect(coverageNote(measure(null, 2, 5))).toBe('2/5');
    expect(coverageNote(measure(2, 2, 2))).toBeUndefined();
    const total = analyticsTotalRow([
      analyticsTableRows(response([group('known', 10, 5)]))[0]!,
      analyticsTableRows(response([group('partial', 10, null)]))[0]!,
    ]);
    expect(total.sessions).toBe(2);
    expect(total.cost).toEqual({ value: null, known: 1, total: 2 });
  });

  it('renders an accessible sortable ledger, confines its own horizontal overflow, and changes sort on a real click', () => {
    const renderer = render(<AnalyticsResultTable response={mixed} caption="Fleet cost ledger" />);
    const root = renderer.root;
    const table = root.findByType('table');
    expect(table.props.className).toContain('min-w-[44rem]');
    expect(root.findByProps({ className: 'grid min-w-0 gap-2' })).toBeTruthy();
    expect(root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(
      root.findAllByType('button').some(button => button.props['aria-label'] === 'Equivalent API cost: sort ascending'),
    ).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Cost unknown');
    expect(JSON.stringify(renderer.toJSON())).toContain('Equivalent API cost is a comparison');
    const groupHeader = root
      .findAllByType('button')
      .find(button => button.props['aria-label'] === 'Group: sort ascending');
    expect(groupHeader).toBeDefined();
    run(() => groupHeader?.props.onClick());
    expect(root.findAllByType('button').some(button => button.props['aria-label'] === 'Group: sort descending')).toBe(
      true,
    );
  });

  it('shows only meaningful columns for count responses and an honest empty status', () => {
    const count = response([group('one', 5, 1)], 'count');
    expect(analyticsColumnsFor(count.aggregation).map(column => column.key)).toEqual(['group', 'sessions']);
    expect(defaultAnalyticsSort(count.aggregation)).toEqual({ key: 'sessions', direction: 'desc' });
    const countRenderer = render(<AnalyticsResultTable response={count} />);
    expect(JSON.stringify(countRenderer.toJSON())).not.toContain('Equivalent API cost is a comparison');
    const empty = render(<AnalyticsResultTable response={response([])} />);
    expect(empty.root.findByProps({ role: 'status' }).children.join('')).toContain('No groups matched');
  });
});
