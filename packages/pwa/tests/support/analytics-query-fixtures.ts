/** Aggregate answers for the Query page suites: groups with chosen measures, and a builder for the response. */

import type { AnalyticsAggregateResult, AnalyticsMeasure, AnalyticsResponse } from '@ferretry/protocol';

export const measure = (value: number | null, known = 1, total = 1): AnalyticsMeasure => ({ value, known, total });

export const group = (
  labels: Record<string, string | null>,
  overrides: Partial<AnalyticsAggregateResult> = {},
): AnalyticsAggregateResult => ({
  labels,
  sessions: 5,
  rates: { stall: 0, failure: 0, completion: 100 },
  tokens: measure(5_000, 5, 5),
  inputTokens: measure(4_000, 5, 5),
  outputTokens: measure(1_000, 5, 5),
  cachedInputTokens: measure(500, 5, 5),
  cacheWriteInputTokens: measure(100, 5, 5),
  cacheWrite5mInputTokens: measure(100, 5, 5),
  cacheWrite1hInputTokens: measure(0, 5, 5),
  reasoningTokens: measure(null, 0, 5),
  equivalentApiCostUsdMicros: measure(12_340_000, 5, 5),
  equivalentApiCostCurrentUsdMicros: measure(12_340_000, 5, 5),
  turns: measure(40, 5, 5),
  durationMs: measure(7_200_000, 5, 5),
  activeDurationMs: measure(3_725_000, 5, 5),
  timeToFirstOutputMs: measure(100, 5, 5),
  contextEndPercent: measure(40, 5, 5),
  ...overrides,
});

export const aggregateResponse = (
  query: string,
  groups: readonly AnalyticsAggregateResult[],
  parsed: Partial<Extract<AnalyticsResponse, { kind: 'aggregate' }>['parsed']> = {},
  aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count' = 'sum',
): AnalyticsResponse => ({
  kind: 'aggregate',
  aggregation,
  query,
  parsed: { aggregation, groupBy: [], matchers: [], ...parsed },
  scope: { allSessions: true, indexed: 20, matched: groups.reduce((sum, item) => sum + item.sessions, 0) },
  index: {
    schemaVersion: 7,
    sessions: 20,
    tokenSessions: 20,
    transcriptSources: 20,
    indexedTranscriptSources: 20,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  results: [...groups],
});
