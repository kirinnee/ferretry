import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import {
  analyticsErrorMessage,
  AnalyticsResponseView,
} from '../../../src/features/analytics/analytics-response-view.tsx';
import { render } from '../../support/react.ts';

const index = {
  schemaVersion: 6,
  sessions: 2,
  tokenSessions: 1,
  transcriptSources: 2,
  indexedTranscriptSources: 2,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

const raw = (overrides: Partial<Extract<AnalyticsResponse, { kind: 'raw' }>> = {}): AnalyticsResponse =>
  ({
    kind: 'raw',
    query: '{status=running}',
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 1 },
    index,
    limit: 200,
    truncated: false,
    results: [
      {
        id: 'session-one',
        agent: null,
        model: 'gpt-5.6-sol',
        contextWindow: null,
        harness: null,
        mode: null,
        status: 'running',
        label: null,
        cwd: null,
        parent: null,
        day: null,
        week: null,
        createdAt: null,
        pricingModel: null,
        equivalentApiCostUsdMicros: null,
        tokens: 42,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        cacheWrite5mInputTokens: null,
        cacheWrite1hInputTokens: null,
        reasoningTokens: null,
        turns: null,
        durationMs: null,
        timeToFirstOutputMs: null,
        contextEndPercent: null,
        stalled: false,
        failed: false,
        migrated: false,
        completed: false,
      },
    ],
    ...overrides,
  }) as AnalyticsResponse;

const aggregate = (): AnalyticsResponse =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    query: 'sum by (model)',
    parsed: { aggregation: 'sum', groupBy: ['model'], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 1 },
    index,
    results: [
      {
        labels: { model: 'gpt-5.6-sol' },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 100 },
        tokens: { value: 42, known: 1, total: 1 },
        inputTokens: { value: 30, known: 1, total: 1 },
        outputTokens: { value: 12, known: 1, total: 1 },
        cachedInputTokens: { value: 0, known: 1, total: 1 },
        cacheWriteInputTokens: { value: 0, known: 1, total: 1 },
        cacheWrite5mInputTokens: { value: 0, known: 1, total: 1 },
        cacheWrite1hInputTokens: { value: 0, known: 1, total: 1 },
        reasoningTokens: { value: null, known: 0, total: 1 },
        equivalentApiCostUsdMicros: { value: 1_250_000, known: 1, total: 1 },
        turns: { value: 1, known: 1, total: 1 },
        durationMs: { value: 1, known: 1, total: 1 },
        timeToFirstOutputMs: { value: 1, known: 1, total: 1 },
        contextEndPercent: { value: 1, known: 1, total: 1 },
      },
    ],
  }) as AnalyticsResponse;

describe('AnalyticsResponseView', () => {
  it('renders a raw daemon response without converting unknown cost to zero', () => {
    const renderer = render(<AnalyticsResponseView response={raw()} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(renderer.root.findAllByType('p')[0]?.children.join('')).toContain('1 matched');
    expect(text).toContain('session-one');
    expect(text).toContain('Cost unknown');
    expect(text).not.toContain('$0.00');
  });

  it('keeps truncation and an empty response explicit', () => {
    const renderer = render(<AnalyticsResponseView response={raw({ results: [], truncated: true })} />);
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toContain('server-capped');
    expect(JSON.stringify(renderer.toJSON())).toContain('No indexed session matched this query.');
  });

  it('delegates aggregate responses to the daemon-backed sortable ledger', () => {
    const renderer = render(<AnalyticsResponseView response={aggregate()} />);
    expect(renderer.root.findByType('caption').children.join('')).toContain('Result for sum by (model)');
  });

  it('explains a daemon index catch-up without hiding other errors', () => {
    expect(analyticsErrorMessage(new DaemonResponseError(503, 'backfill'))).toContain('503');
    expect(analyticsErrorMessage(new Error('offline'))).toBe('offline');
  });
});
