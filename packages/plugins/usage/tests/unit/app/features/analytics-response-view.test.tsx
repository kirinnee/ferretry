import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '../../../../contract/index.ts';
import {
  AnalyticsResponseView,
  analyticsErrorMessage,
} from '../../../../app/features/analytics/analytics-response-view.tsx';
import { act } from 'react-test-renderer';
import { render, RouterProvider } from '@ferretry/app/testing';
import { DaemonResponseError } from '../support/shell.ts';

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
        activeDurationMs: null,
        machine: null,
        timeToFirstOutputMs: null,
        contextEndPercent: null,
        stalled: false,
        failed: false,
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
        equivalentApiCostCurrentUsdMicros: { value: 1_250_000, known: 1, total: 1 },
        turns: { value: 1, known: 1, total: 1 },
        durationMs: { value: 1, known: 1, total: 1 },
        activeDurationMs: { value: 1, known: 1, total: 1 },
        timeToFirstOutputMs: { value: 1, known: 1, total: 1 },
        contextEndPercent: { value: 1, known: 1, total: 1 },
      },
    ],
  }) as AnalyticsResponse;

describe('AnalyticsResponseView', () => {
  it('renders a raw daemon response without converting unknown cost to zero', () => {
    const renderer = render(<AnalyticsResponseView response={raw()} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(renderer.root.findAllByType('p')[0]?.children.join('')).toContain('1 of 2 sessions matched');
    expect(text).toContain('session-one');
    expect(text).toContain('Unpriced');
    expect(text).not.toContain('$0.00');
  });

  it('links each session row to where the host says it opens, in-app under a router', () => {
    const linked = render(
      <AnalyticsResponseView response={raw()} sessionHref={row => `/d/elsewhere/ferrets/${row.id}`} />,
    );
    const link = linked.root.find(node => node.type === 'a' && node.props['data-raw-session'] !== undefined);
    expect(link.props.href).toBe(`/d/elsewhere/ferrets/${link.props['data-raw-session']}`);
    window.history.replaceState({}, '', '/');
    const routed = render(
      <RouterProvider>
        <AnalyticsResponseView response={raw()} sessionHref={row => `/d/elsewhere/ferrets/${row.id}`} />
      </RouterProvider>,
    );
    const inApp = routed.root.find(node => node.type === 'a' && node.props['data-raw-session'] !== undefined);
    act(() => inApp.props.onClick({ button: 0, preventDefault() {} }));
    expect(window.location.pathname).toBe(inApp.props.href);
    window.history.replaceState({}, '', '/');
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

  it('tells the reader to add a matcher when a query makes too many groups', () => {
    const message = analyticsErrorMessage(
      new DaemonResponseError(400, 'analytics query produces more than 100 groups; add a matcher', 'too_many_groups'),
    );
    expect(message).toContain('more than 100 groups');
    expect(message).toContain('matcher');
    expect(message).not.toContain('failed to handle');
    // A plain 400 keeps the daemon's own words.
    expect(analyticsErrorMessage(new DaemonResponseError(400, 'bad query', 'invalid_query'))).toBe('bad query');
  });
});
