import type { AnalyticsResponse } from '../../../contract/index.ts';

export const INSTANT = '2026-07-30T12:00:00Z';

export const analyticsResponse = {
  query: '',
  parsed: { groupBy: [], matchers: [] },
  scope: { allSessions: true, indexed: 1, matched: 1 },
  index: {
    schemaVersion: 1,
    sessions: 1,
    tokenSessions: 1,
    transcriptSources: 1,
    indexedTranscriptSources: 1,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  kind: 'raw',
  limit: 10,
  truncated: false,
  results: [],
} satisfies AnalyticsResponse;
