import { describe, expect, it } from 'bun:test';
import type { AnalyticsMeasure } from '@ferretry/protocol';
import {
  type AnalyticsAggregateResponse,
  AnalyticsResultTable,
  analyticsColumnsFor,
  analyticsGroupHeader,
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
      'claude-opus',
      'claude-sonnet',
      'unpriced',
    ]);
    expect(sortAnalyticsRows(rows, 'cost', 'asc').map(row => row.group)).toEqual([
      'claude-sonnet',
      'claude-opus',
      'unpriced',
    ]);
    expect(sortAnalyticsRows(rows, 'group', 'asc').map(row => row.group)[0]).toBe('claude-opus');
    expect(formatEquivalentCost(rows[1]?.cost)).toBe('Unpriced');
    expect(formatTokenMeasure(rows[1]?.total)).toBe('5,000,000');
  });

  it('formats exact cost micros and uses strict, coverage-aware total measures', () => {
    expect(formatUsdMicros(2_500_000n)).toBe('$2.50');
    expect(formatUsdMicros(-1n)).toBe('-$0.000001');
    expect(formatTokenMeasure(undefined)).toBe('—');
    expect(formatEquivalentCost(undefined)).toBe('Unpriced');
    expect(coverageNote(measure(null, 2, 5))).toBe('2/5');
    expect(coverageNote(measure(2, 2, 2))).toBeUndefined();
    const total = analyticsTotalRow([
      analyticsTableRows(response([group('known', 10, 5)]))[0]!,
      analyticsTableRows(response([group('partial', 10, null)]))[0]!,
    ]);
    expect(total.sessions).toBe(2);
    expect(total.cost).toEqual({ value: 5, known: 1, total: 2 });
    expect(formatEquivalentCost(total.cost)).toBe('≥ $0.000005');
    expect(formatTokenMeasure(total.total)).toBe('20');
    expect(formatTokenMeasure({ value: 7, known: 1, total: 2 })).toBe('≥ 7');
    expect(analyticsTotalRow([analyticsTableRows(response([group('none', 10, null)]))[0]!]).cost.value).toBeNull();
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
    expect(JSON.stringify(renderer.toJSON())).toContain('Unpriced');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('model=');
    const groupHeader = root
      .findAllByType('button')
      .find(button => button.props['aria-label'] === 'Model: sort ascending');
    expect(groupHeader).toBeDefined();
    run(() => groupHeader?.props.onClick());
    expect(root.findAllByType('button').some(button => button.props['aria-label'] === 'Model: sort descending')).toBe(
      true,
    );
  });

  it('shows only meaningful columns for count responses and an honest empty status', () => {
    const count = response([group('one', 5, 1)], 'count');
    expect(analyticsColumnsFor(count.aggregation).map(column => column.key)).toEqual(['group', 'sessions']);
    expect(defaultAnalyticsSort(count)).toEqual({ key: 'sessions', direction: 'desc' });
    const countRenderer = render(<AnalyticsResultTable response={count} />);
    expect(JSON.stringify(countRenderer.toJSON())).not.toContain('Equivalent API cost');
    const empty = render(<AnalyticsResultTable response={response([])} />);
    expect(empty.root.findByProps({ role: 'status' }).children.join('')).toContain('No groups matched');
  });

  it('reads a ledger over time in date order and names its column by the labels', () => {
    const daily = {
      kind: 'aggregate',
      aggregation: 'sum',
      query: 'sum by (day)',
      results: [
        { ...group('x', 10, 9_000_000), labels: { day: '2026-10-13' } },
        { ...group('x', 10, 1_000_000), labels: { day: '2026-10-02' } },
      ],
    } as unknown as AnalyticsAggregateResponse;
    expect(defaultAnalyticsSort(daily)).toEqual({ key: 'group', direction: 'asc' });
    expect(analyticsGroupHeader(daily)).toBe('Day');
    const renderer = render(<AnalyticsResultTable response={daily} />);
    const headers = renderer.root.findAllByProps({ scope: 'row' }).map(cell => cell.props.title);
    expect(headers).toEqual(['2026-10-02', '2026-10-13', 'Total']);
    expect(analyticsGroupHeader(response([]))).toBe('Group');
    const identity = {
      ...mixed,
      results: [{ ...group('a', 1, 1), labels: { model: 'a', pricing_model: 'b' } }],
    } as unknown as AnalyticsAggregateResponse;
    expect(analyticsGroupHeader(identity)).toBe('Model · pricing model');
    const unlabelled = { ...mixed, results: [{ ...group('a', 1, 1), labels: { model: null } }] };
    expect(analyticsTableRows(unlabelled as unknown as AnalyticsAggregateResponse)[0]?.group).toBe('unknown');
    const empty = { ...mixed, results: [{ ...group('a', 1, 1), labels: {} }] };
    expect(analyticsTableRows(empty as unknown as AnalyticsAggregateResponse)[0]?.group).toBe('All sessions');
  });

  it('gives the phone a list with the cost on the right and the total last', () => {
    const renderer = render(<AnalyticsResultTable response={mixed} />);
    const list = renderer.root.findByProps({ 'data-analytics-result-list': '' });
    const items = list.findAllByType('li');
    expect(items).toHaveLength(4);
    expect(JSON.stringify(list.props.className)).toContain('sm:hidden');
    expect(JSON.stringify(items[3]?.props.className)).toContain('font-semibold');
    expect(items[0]?.findAllByType('span')[1]?.children).toEqual(['$9.00']);
    expect(JSON.stringify(renderer.toJSON())).toContain('priced for');
    const count = render(<AnalyticsResultTable response={response([group('one', 5, 1)], 'count')} />);
    const countList = count.root.findByProps({ 'data-analytics-result-list': '' });
    expect(JSON.stringify(count.toJSON())).not.toContain('tokens');
    expect(countList.findAllByType('li')).toHaveLength(1);
  });
});
