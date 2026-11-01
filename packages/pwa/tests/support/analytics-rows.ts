/** Analytics row and response builders shared by the overview, page and session cost suites. */

import type { AnalyticsMeasure, AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';

const analyticsIndex = {
  schemaVersion: 6,
  sessions: 10,
  tokenSessions: 10,
  transcriptSources: 10,
  indexedTranscriptSources: 10,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

export const rawRow = (overrides: Partial<AnalyticsRawSession> & { readonly id: string }): AnalyticsRawSession => ({
  agent: 'Marin',
  model: 'claude-opus-5-5',
  contextWindow: 200_000,
  harness: 'claude',
  mode: 'auto',
  status: 'completed',
  label: 'Flaky test fix',
  cwd: '/home/kirin/Workspace/ferretry',
  parent: null,
  tree: null,
  day: '2026-10-13',
  week: '2026-W42',
  createdAt: '2026-10-13T10:00:00.000Z',
  pricingModel: 'claude-opus-5-5',
  equivalentApiCostUsdMicros: 1_000_000,
  tokens: 1_000,
  inputTokens: 800,
  outputTokens: 200,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  reasoningTokens: null,
  turns: 12,
  durationMs: 1_000,
  activeDurationMs: 500,
  machine: null,
  timeToFirstOutputMs: 100,
  contextEndPercent: 40,
  stalled: false,
  failed: false,
  migrated: false,
  completed: true,
  ...overrides,
});

export const rawResponse = (
  rows: readonly AnalyticsRawSession[],
  query = '{}',
  truncated = false,
): AnalyticsResponse => ({
  kind: 'raw',
  query,
  parsed: { groupBy: [], matchers: [] },
  scope: { allSessions: true, indexed: Math.max(rows.length, 10), matched: rows.length },
  index: analyticsIndex,
  limit: 100,
  truncated,
  results: [...rows],
});

const measure = (value: number | null, known = 1, total = 1): AnalyticsMeasure => ({ value, known, total });

/** A one-group `sum by (day)` answer: `sessions` sessions, `known` of them priced. */
export const dayAggregate = (day: string, sessions: number, known: number): AnalyticsResponse => ({
  kind: 'aggregate',
  aggregation: 'sum',
  query: `sum by (day) {day="${day}"}`,
  parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
  scope: { allSessions: true, indexed: sessions, matched: sessions },
  index: analyticsIndex,
  results: [
    {
      labels: { day },
      sessions,
      rates: { stall: 0, failure: 0, completion: 100 },
      tokens: measure(1, sessions, sessions),
      inputTokens: measure(1, sessions, sessions),
      outputTokens: measure(1, sessions, sessions),
      cachedInputTokens: measure(1, sessions, sessions),
      cacheWriteInputTokens: measure(1, sessions, sessions),
      cacheWrite5mInputTokens: measure(1, sessions, sessions),
      cacheWrite1hInputTokens: measure(1, sessions, sessions),
      reasoningTokens: measure(null, 0, sessions),
      equivalentApiCostUsdMicros: measure(known === sessions ? 1 : null, known, sessions),
      equivalentApiCostCurrentUsdMicros: measure(known === sessions ? 1 : null, known, sessions),
      turns: measure(1, sessions, sessions),
      durationMs: measure(1, sessions, sessions),
      activeDurationMs: measure(1, sessions, sessions),
      timeToFirstOutputMs: measure(1, sessions, sessions),
      contextEndPercent: measure(1, sessions, sessions),
    },
  ],
});
