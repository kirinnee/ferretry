import { describe, expect, it } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import {
  type AnalyticsIndexStatus,
  type AnalyticsRawSession,
  DEFAULT_SESSION_ANALYTICS_QUERY,
  scopeAnalyticsQuery,
} from '../../../contract/index.ts';
import { insightsForPort, scopedInsightsQuery } from '../../../daemon/routes/insights.ts';

const status: AnalyticsIndexStatus = {
  schemaVersion: 1,
  sessions: 2,
  tokenSessions: 2,
  transcriptSources: 2,
  indexedTranscriptSources: 2,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

const row = (id: string, tokens: number): AnalyticsRawSession => ({
  id,
  agent: 'claude',
  model: 'claude-opus-5-5',
  contextWindow: 1_000_000,
  harness: 'claude',
  mode: 'auto',
  status: 'completed',
  label: id,
  cwd: '/work',
  parent: null,
  tree: null,
  day: '2026-10-30',
  week: '2026-10-26',
  createdAt: '2026-10-30T09:00:00.000Z',
  pricingModel: 'claude-opus-5-5',
  equivalentApiCostUsdMicros: tokens,
  tokens,
  inputTokens: tokens,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  cacheWrite5mInputTokens: null,
  cacheWrite1hInputTokens: null,
  reasoningTokens: null,
  turns: 1,
  durationMs: 1_000,
  activeDurationMs: 500,
  machine: null,
  timeToFirstOutputMs: null,
  contextEndPercent: null,
  stalled: false,
  failed: false,
  completed: true,
});

const subsystem = {
  index: () => ({ rows: [row('alpha', 10), row('beta', 30)], status, now: '2026-10-30T12:00:00.000Z' }),
};

describe('the Usage port insights read', () => {
  it('answers every ferret when no session is named', () => {
    const answer = insightsForPort(subsystem, {}, null);

    expect(answer.scope.matched).toBe(2);
    expect(answer.scope.allSessions).toBe(true);
  });

  it('scopes the answer to the one ferret named by `session`, as the route does', () => {
    const answer = insightsForPort(subsystem, { session: 'beta' }, null);

    expect(answer.scope.matched).toBe(1);
    expect(answer.query).toBe(scopeAnalyticsQuery(undefined, 'beta'));
    expect(answer.kind === 'aggregate' ? answer.results.map(result => result.sessions) : []).toEqual([1]);
  });

  it('scopes a caller-written query too, replacing any id the query names', () => {
    const answer = insightsForPort(subsystem, { query: '{id=alpha}', session: 'beta' }, null);

    expect(answer.scope.matched).toBe(1);
    expect(answer.query).toBe(scopeAnalyticsQuery('{id=alpha}', 'beta'));
  });

  it('refuses a blank `session` instead of reading it as no scope', () => {
    for (const session of ['', '   ']) {
      const refused = (() => {
        try {
          insightsForPort(subsystem, { session }, null);
          return undefined;
        } catch (error) {
          return error;
        }
      })();

      expect(refused).toBeInstanceOf(ApiError);
      expect((refused as ApiError).status).toBe(400);
    }
  });

  it('turns a session into the same query the route reads', () => {
    expect(scopedInsightsQuery(undefined, undefined)).toBeUndefined();
    expect(scopedInsightsQuery('count', undefined)).toBe('count');
    expect(scopedInsightsQuery(undefined, 'beta')).toBe(scopeAnalyticsQuery(undefined, 'beta'));
    expect(DEFAULT_SESSION_ANALYTICS_QUERY.length).toBeGreaterThan(0);
  });
});
