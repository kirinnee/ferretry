import { describe, expect, it } from 'bun:test';

import { AnalyticsMetricSchema, parseAnalyticsQuery } from '@ferretry/protocol';
import {
  ANALYTICS_RANGE_PRESETS,
  type AnalyticsCompletion,
  analyticsCompletions,
  quoteAnalyticsValue,
  rankAnalyticsCompletions,
} from '../../../src/features/analytics/analytics-query-complete.ts';

const labels = (text: string, caret = text.length) =>
  analyticsCompletions(text, caret).candidates.map(candidate => candidate.label);

describe('analytics query completion', () => {
  it('offers protocol aggregations and replaces only the active token', () => {
    expect(labels('')).toEqual([
      'sum',
      'avg',
      'min',
      'max',
      'count',
      '{',
      'id',
      'agent',
      'model',
      // Derived from the protocol label set, so a label added there shows up here and pushes the
      // last candidate off the bounded list rather than quietly going unofferable.
      'pricing_model',
      'context_window',
      'harness',
    ]);
    expect(analyticsCompletions('su', 2)).toMatchObject({ context: 'aggregation', replaceRange: { start: 0, end: 2 } });
    expect(analyticsCompletions('summary', 3).replaceRange).toEqual({ start: 0, end: 7 });
  });

  it('offers clauses after an aggregation and suppresses a second grouping clause', () => {
    expect(labels('sum ').slice(0, 3)).toEqual(['(', 'by', '[']);
    expect(labels('sum by (model) ')).not.toContain('by');
    expect(analyticsCompletions('sum ', -30).replaceRange).toEqual({ start: 0, end: 3 });
  });

  it('completes grouping labels, skips duplicates, and states the parser cap', () => {
    expect(analyticsCompletions('sum by (', 8).context).toBe('grouping-label');
    expect(labels('sum by (model, ')).not.toContain('model');
    const full = 'sum by (model, agent, status, mode, ';
    expect(analyticsCompletions(full, full.length)).toMatchObject({
      candidates: [],
      notice: 'at most 4 grouping labels are allowed',
    });
  });

  it('completes matcher labels and valid operator pairs', () => {
    const partial = analyticsCompletions('sum {mo', 7);
    expect(partial).toMatchObject({ context: 'matcher-label', replaceRange: { start: 5, end: 7 } });
    expect(partial.candidates[0]).toMatchObject({ label: 'model', replacement: 'model=' });
    expect(
      analyticsCompletions('{tree', 5)
        .candidates.filter(candidate => candidate.kind === 'operator')
        .map(candidate => candidate.replacement),
    ).toEqual(['tree=']);
    expect(
      analyticsCompletions('{model', 6)
        .candidates.filter(candidate => candidate.kind === 'operator')
        .map(candidate => candidate.replacement),
    ).toEqual(['model=', 'model=~']);
  });

  it('uses low-cardinality values, leaves unbounded values alone, and protects tree exactness', () => {
    const cached = analyticsCompletions('{status=', 8, {
      valuesFor: label => (label === 'status' ? ['completed', 'failed'] : undefined),
    });
    expect(cached.candidates.map(candidate => candidate.label)).toEqual(['completed', 'failed']);
    expect(analyticsCompletions('{status=', 8).pendingValueLabel).toBe('status');
    expect(analyticsCompletions('{cwd=', 5).notice).toContain('unbounded');
    expect(analyticsCompletions('{tree=', 6).notice).toContain('one exact session id');
    expect(
      analyticsCompletions('{tree=', 6, { treeIds: [{ id: 'session-a', detail: 'current session' }] }).candidates[0],
    ).toMatchObject({ replacement: 'session-a', detail: 'current session' });
    expect(analyticsCompletions('{tree=~session', 15).notice).toContain('use tree=');
  });

  it('does not offer completions in quoted literals and honours escaped quotes', () => {
    expect(analyticsCompletions('{label="ui build', 16)).toMatchObject({
      candidates: [],
      notice: 'Close the quote to continue.',
    });
    expect(analyticsCompletions('{label="a,\\"b", mo', 18).context).toBe('matcher-label');
  });

  it('quotes unsafe values and ranks by kind before fuzzy score', () => {
    expect(quoteAnalyticsValue('ui build')).toBe('"ui build"');
    expect(quoteAnalyticsValue('claude-auto-*')).toBe('claude-auto-*');
    const entries: AnalyticsCompletion[] = [
      { id: 'value', kind: 'value', label: 'model', replacement: 'model', group: 'Values', rankPriority: 20 },
      { id: 'agg', kind: 'aggregation', label: 'max', replacement: 'max ', group: 'Aggregations', rankPriority: 100 },
    ];
    expect(rankAnalyticsCompletions(entries, 'm').map(entry => entry.id)).toEqual(['agg', 'value']);
    expect(rankAnalyticsCompletions(entries, 'nope')).toEqual([]);
    expect(rankAnalyticsCompletions(entries, '', 1)).toHaveLength(1);
  });
});

describe('analytics query completion: metrics and ranges', () => {
  it('offers every protocol metric inside the aggregation parentheses', () => {
    const result = analyticsCompletions('sum(', 4);
    expect(result.context).toBe('metric');
    expect(result.candidates.map(candidate => candidate.label)).toEqual([...AnalyticsMetricSchema.options]);
    const typed = analyticsCompletions('sum(cost', 8);
    expect(typed.candidates[0]).toMatchObject({ label: 'cost_usd', replacement: 'cost_usd)' });
    expect(typed.replaceRange).toEqual({ start: 4, end: 8 });
  });

  it('offers range presets inside brackets, and only until a range exists', () => {
    const result = analyticsCompletions('sum(cost_usd) [', 15);
    expect(result.context).toBe('range');
    expect(result.candidates.map(candidate => candidate.label)).toEqual([...ANALYTICS_RANGE_PRESETS]);
    expect(result.candidates[0]!.replacement).toBe('24h]');
    expect(labels('sum(cost_usd) [7d] ')).not.toContain('[');
    expect(labels('sum(cost_usd) ')).not.toContain('(');
    expect(labels('sum(cost_usd) ')).toContain('[');
  });

  it('offers values for the machine, runtime and project labels from a result', () => {
    const sources = { valuesFor: (label: string) => (label === 'runtime' ? ['claude-a'] : undefined) };
    expect(analyticsCompletions('{runtime=', 9, sources).candidates.map(candidate => candidate.label)).toEqual([
      'claude-a',
    ]);
    expect(analyticsCompletions('{machine=', 9, sources).pendingValueLabel).toBe('machine');
  });

  it('only offers ranges the protocol parser accepts', () => {
    for (const preset of ANALYTICS_RANGE_PRESETS)
      expect(parseAnalyticsQuery(`sum(cost_usd) [${preset}]`).range).toBeDefined();
  });
});
