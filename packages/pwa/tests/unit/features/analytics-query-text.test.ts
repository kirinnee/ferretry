import { describe, expect, it } from 'bun:test';

import {
  activeRangeSource,
  readAnalyticsQuery,
  toggleGroupLabel,
  withAggregation,
  withMetric,
  withRange,
} from '../../../src/features/analytics/analytics-query-text.ts';

describe('analytics query text editing', () => {
  it('reads with the protocol grammar and reports its sentence', () => {
    expect(readAnalyticsQuery('sum(cost_usd) by (model)')).toMatchObject({ ok: true });
    const bad = readAnalyticsQuery('sum(nope)');
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.error).toContain('unknown analytics metric');
  });

  it('rethrows what is not a query error', () => {
    expect(() => readAnalyticsQuery({ toString: () => 1 } as never)).toThrow();
  });

  it('sets and clears the metric, defaulting the aggregation to sum', () => {
    expect(withMetric('sum by (model)', 'turns')).toBe('sum(turns) by (model)');
    expect(withMetric('sum(turns) by (model)', undefined)).toBe('sum by (model)');
    expect(withMetric('{model=a}', 'turns')).toBe('sum(turns) {model=a}');
    expect(withMetric('sum(nope', 'turns')).toBe('sum(nope');
  });

  it('rethrows what the formatter raises that is not a query error', () => {
    expect(() => toggleGroupLabel('sum(cost_usd)', Symbol('label') as never)).toThrow(TypeError);
  });

  it('changes the aggregation and keeps the rest', () => {
    expect(withAggregation('sum(cost_usd) by (model) [7d]', 'avg')).toBe('avg(cost_usd) by (model) [7d]');
  });

  it('toggles a grouping label on and off', () => {
    expect(toggleGroupLabel('sum(cost_usd)', 'model')).toBe('sum(cost_usd) by (model)');
    expect(toggleGroupLabel('sum(cost_usd) by (model)', 'runtime')).toBe('sum(cost_usd) by (model, runtime)');
    expect(toggleGroupLabel('sum(cost_usd) by (model, runtime)', 'model')).toBe('sum(cost_usd) by (runtime)');
    expect(toggleGroupLabel('{model=a}', 'day')).toBe('sum by (day) {model=a}');
  });

  it('sets, replaces and clears the range', () => {
    expect(withRange('sum(cost_usd) by (model)', '7d')).toBe('sum(cost_usd) by (model) [7d]');
    expect(withRange('sum(cost_usd) [7d]', '30d')).toBe('sum(cost_usd) [30d]');
    expect(withRange('sum(cost_usd) [7d]', undefined)).toBe('sum(cost_usd)');
    expect(withRange('sum(cost_usd)', 'garbage')).toBe('sum(cost_usd)');
  });

  it('finds the active range chip only for an offered preset', () => {
    expect(activeRangeSource('sum(cost_usd) [7d]', ['7d', '30d'])).toBe('7d');
    expect(activeRangeSource('sum(cost_usd) [9d]', ['7d', '30d'])).toBeUndefined();
    expect(activeRangeSource('sum(cost_usd)', ['7d'])).toBeUndefined();
    // Compared by length: 24h is written [1d], and still lights the 24h chip.
    expect(activeRangeSource('sum(cost_usd) [1d]', ['24h', '7d'])).toBe('24h');
    expect(activeRangeSource('sum(cost_usd) [2026-10-01..2026-10-02]', ['24h'])).toBeUndefined();
    expect(activeRangeSource('sum(', ['24h'])).toBeUndefined();
  });
});

describe('a per-turn ratio metric', () => {
  it('refuses an aggregation the grammar does not allow, leaving the text alone', () => {
    const text = 'sum(duration_active_seconds_per_turn) by (model)';
    expect(withAggregation(text, 'max')).toBe(text);
    expect(withAggregation(text, 'avg')).toBe('avg(duration_active_seconds_per_turn) by (model)');
  });
});
