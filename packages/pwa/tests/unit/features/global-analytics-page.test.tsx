import { describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  GlobalAnalyticsPage,
  GLOBAL_ANALYTICS_DEFAULT_QUERY,
  GLOBAL_ANALYTICS_STARTERS,
} from '../../../src/features/analytics/global-analytics-page.tsx';
import { render, run, runAsync } from '../../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const index = {
  schemaVersion: 6,
  sessions: 2,
  tokenSessions: 1,
  transcriptSources: 2,
  indexedTranscriptSources: 2,
  pendingTranscriptSources: 1,
  sourceErrors: 0,
  refreshing: true,
};
const aggregate = (query = GLOBAL_ANALYTICS_DEFAULT_QUERY): AnalyticsResponse =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    query,
    parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 1 },
    index,
    results: [
      {
        labels: { day: '2026-07-31' },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 100 },
        tokens: { value: 42, known: 1, total: 1 },
        inputTokens: { value: 30, known: 1, total: 1 },
        outputTokens: { value: 12, known: 1, total: 1 },
        cachedInputTokens: { value: 0, known: 1, total: 1 },
        cacheWriteInputTokens: { value: 0, known: 1, total: 1 },
        cacheWrite5mInputTokens: { value: 0, known: 1, total: 1 },
        cacheWrite1hInputTokens: { value: 0, known: 1, total: 1 },
        equivalentApiCostUsdMicros: { value: 1_250_000, known: 1, total: 1 },
        turns: { value: 1, known: 1, total: 1 },
        durationMs: { value: 1, known: 1, total: 1 },
        timeToFirstOutputMs: { value: 1, known: 1, total: 1 },
        contextEndPercent: { value: 1, known: 1, total: 1 },
      },
    ],
  }) as AnalyticsResponse;

const raw = (query: string): AnalyticsResponse =>
  ({
    kind: 'raw',
    query,
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 0 },
    index,
    limit: 200,
    truncated: false,
    results: [],
  }) as AnalyticsResponse;

describe('GlobalAnalyticsPage', () => {
  it('renders paired-daemon results, starter requests, and an honest index status', async () => {
    const calls: Array<{ daemon: string; query: string | undefined }> = [];
    const renderer = render(
      <GlobalAnalyticsPage
        connection={daemonA}
        requestAnalytics={async (daemon, query) => {
          calls.push({ daemon: daemon.daemonId, query });
          return calls.length === 1 ? aggregate(query) : raw(query ?? '');
        }}
      />,
    );
    await runAsync(async () => await Promise.resolve());
    expect(calls).toEqual([{ daemon: 'daemon-a', query: GLOBAL_ANALYTICS_DEFAULT_QUERY }]);
    expect(renderer.root.findByProps({ 'data-daemon': 'daemon-a' }).props['aria-label']).toBe('Global analytics');
    expect(JSON.stringify(renderer.toJSON())).toContain('backfill in progress');
    expect(JSON.stringify(renderer.toJSON())).toContain('Time series');
    const weekly = renderer.root.findAllByType('button').find(button => button.children.join('') === 'Weekly');
    if (!weekly) throw new Error('weekly starter missing');
    await runAsync(async () => {
      weekly.props.onClick();
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({ daemon: 'daemon-a', query: 'sum by (week)' });
    expect(JSON.stringify(renderer.toJSON())).toContain('No indexed session matched this query.');
  });

  it('renders the query controls as kteam does: default-size outline buttons with 44px touch targets', async () => {
    // Arrange
    const renderer = render(<GlobalAnalyticsPage connection={daemonA} requestAnalytics={async () => aggregate()} />);
    await runAsync(async () => await Promise.resolve());

    // Act — the query controls, straight off the host elements
    const starters = renderer.root.findByProps({ role: 'toolbar' }).findAllByType('button');
    const submit = renderer.root.findAllByType('button').filter(button => button.props.type === 'submit');

    // Assert — one control per starter plus Run
    expect(starters).toHaveLength(GLOBAL_ANALYTICS_STARTERS.length);
    expect(submit).toHaveLength(1);

    // Assert — starters are `.kt-btn` at the DEFAULT size: `kt-btn--sm` would
    // override the themed control height, inline padding and font size.
    for (const starter of starters) {
      expect(starter.props.className).toBe('kt-btn min-h-[44px] shrink-0 text-xs');
      expect(starter.props.className).not.toContain('kt-btn--sm');
      expect(starter.props['data-variant']).toBeUndefined();
    }

    // Assert — Run is the resting outline style, not an accent-filled primary
    expect(submit[0]?.props.className).toBe('kt-btn min-h-[44px] shrink-0');
    expect(submit[0]?.props['data-variant']).toBeUndefined();
  });

  it('labels each starter with its own query and keeps the hints as titles', async () => {
    // Arrange
    const calls: (string | undefined)[] = [];
    const renderer = render(
      <GlobalAnalyticsPage
        connection={daemonA}
        requestAnalytics={async (_daemon, query) => {
          calls.push(query);
          return aggregate(query);
        }}
      />,
    );
    await runAsync(async () => await Promise.resolve());

    // Act — click every starter in turn
    const starters = renderer.root.findByProps({ role: 'toolbar' }).findAllByType('button');
    for (const [index, starter] of starters.entries()) {
      expect(starter.props.title).toBe(GLOBAL_ANALYTICS_STARTERS[index]?.hint);
      await runAsync(async () => {
        starter.props.onClick();
        await Promise.resolve();
      });
    }

    // Assert — the mount request, then one request per starter, in order
    expect(calls).toEqual([GLOBAL_ANALYTICS_DEFAULT_QUERY, ...GLOBAL_ANALYTICS_STARTERS.map(starter => starter.query)]);
  });

  it('submits trimmed blank input, loads autocomplete values, and reports failed requests', async () => {
    const calls: string[] = [];
    const renderer = render(
      <GlobalAnalyticsPage
        connection={daemonA}
        requestAnalytics={async (_daemon, query) => {
          calls.push(query ?? '');
          if (query === 'count by (status)') return aggregate(query);
          if (query === undefined) throw new Error('offline');
          return aggregate(query);
        }}
      />,
    );
    await runAsync(async () => await Promise.resolve());
    const input = renderer.root.findByProps({ role: 'combobox' });
    run(() => input.props.onChange({ currentTarget: { value: '   ', selectionStart: 3 } }));
    const form = renderer.root.findByType('form');
    await runAsync(async () => {
      form.props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    expect(calls).toContain('');
    expect(JSON.stringify(renderer.toJSON())).toContain('offline');
    run(() => input.props.onChange({ currentTarget: { value: '{status=', selectionStart: 8 } }));
    await runAsync(async () => await Promise.resolve());
    expect(calls).toContain('count by (status)');
  });

  it('drops a late daemon response when the route switches to another paired daemon', async () => {
    let resolveA: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics = (daemon: typeof daemonA, query?: string) =>
      new Promise<AnalyticsResponse>(resolve => {
        if (daemon.daemonId === 'daemon-a') resolveA = resolve;
        else resolve(raw(`${daemon.daemonId}:${query}`));
      });
    const renderer = render(<GlobalAnalyticsPage connection={daemonA} requestAnalytics={requestAnalytics} />);
    run(() => renderer.update(<GlobalAnalyticsPage connection={daemonB} requestAnalytics={requestAnalytics} />));
    await runAsync(async () => await Promise.resolve());
    if (!resolveA) throw new Error('first daemon request missing');
    await runAsync(async () => {
      resolveA?.(aggregate('stale daemon-a'));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(renderer.root.findByProps({ 'data-daemon': 'daemon-b' })).toBeTruthy();
    expect(text).not.toContain('stale daemon-a');
    expect(text).toContain('daemon-b:sum by (day)');
  });
});
