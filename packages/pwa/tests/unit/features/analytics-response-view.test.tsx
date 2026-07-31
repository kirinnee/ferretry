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

  it('explains a daemon index catch-up without hiding other errors', () => {
    expect(analyticsErrorMessage(new DaemonResponseError(503, 'backfill'))).toContain('503');
    expect(analyticsErrorMessage(new Error('offline'))).toBe('offline');
  });
});
