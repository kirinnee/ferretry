import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { AnalyticsResponse } from '@ferretry/protocol';

import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { fetchSessionAnalytics } from '../../../src/features/analytics/analytics-api.ts';
import {
  analyticsIdQuery,
  sessionAnalyticsDefaultQuery,
} from '../../../src/features/analytics/session-analytics-query.ts';
import {
  SessionAnalyticsSurface,
  sessionAnalyticsLabelValues,
  type SessionAnalyticsRequest,
} from '../../../src/features/analytics/session-analytics-surface.tsx';
import { render, run, runAsync } from '../../support/react.ts';

// Unmount every renderer inside `act` after each test, so a pending async update
// from one surface can never resolve against a later test's act scope.
const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const renderer of renderers) renderer.unmount();
  });
  renderers.length = 0;
});
const mount = (element: ReactElement): ReactTestRenderer => {
  const renderer = render(element);
  renderers.push(renderer);
  return renderer;
};

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
// Same id across daemons, and same daemon across sessions, so staleness is about the (daemon, session) pair, not the id alone.
const scopeASession = daemonSessionScope(daemonA, 'session-a');
const scopeBSession = daemonSessionScope(daemonA, 'session-b');
const scopeBDaemon = daemonSessionScope(daemonB, 'session-a');

const SESSION_A_DEFAULT = sessionAnalyticsDefaultQuery('session-a'); // sum by (model) {id="session-a"}

const measure = (value: number | null, known = 1, total = 1) => ({ value, known, total });

/** Concatenates every text node in a rendered tree (JSX interpolation splits phrases across children). */
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
};

interface IndexOverrides {
  readonly pendingTranscriptSources?: number;
  readonly refreshing?: boolean;
  readonly tokenSessions?: number;
  readonly sessions?: number;
}
const index = (overrides: IndexOverrides = {}) => ({
  schemaVersion: 6,
  sessions: overrides.sessions ?? 2,
  tokenSessions: overrides.tokenSessions ?? 1,
  transcriptSources: 2,
  indexedTranscriptSources: 2,
  pendingTranscriptSources: overrides.pendingTranscriptSources ?? 1,
  sourceErrors: 0,
  refreshing: overrides.refreshing ?? false,
});

/** A session-scoped aggregate. `costValue: null` models unknown pricing so it can never read as $0.00. */
const aggregate = (
  query = SESSION_A_DEFAULT,
  {
    costValue = 1_250_000,
    index: idx,
  }: { readonly costValue?: number | null; readonly index?: ReturnType<typeof index> } = {},
): AnalyticsResponse =>
  ({
    kind: 'aggregate',
    aggregation: 'sum',
    query,
    parsed: { aggregation: 'sum', groupBy: ['model'], matchers: [] },
    scope: { allSessions: true, indexed: 2, matched: 1 },
    index: idx ?? index(),
    results: [
      {
        labels: { model: 'claude-foo' },
        sessions: 1,
        rates: { stall: 0, failure: 0, completion: 100 },
        tokens: measure(42),
        inputTokens: measure(30),
        outputTokens: measure(12),
        cachedInputTokens: measure(0),
        cacheWriteInputTokens: measure(0),
        cacheWrite5mInputTokens: measure(0),
        cacheWrite1hInputTokens: measure(0),
        reasoningTokens: measure(0),
        equivalentApiCostUsdMicros: measure(costValue),
        turns: measure(1),
        durationMs: measure(1),
        timeToFirstOutputMs: measure(1),
        contextEndPercent: measure(1),
      },
    ],
  }) as AnalyticsResponse;

describe('SessionAnalyticsSurface', () => {
  it('issues exactly one default request on mount and echoes the canonical query into the box', async () => {
    const calls: Array<{ daemon: string; sessionId: string; query: string | undefined }> = [];
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async (daemon, scope, query) => {
          calls.push({ daemon: daemon.daemonId, sessionId: scope.sessionId, query });
          return aggregate(query ?? SESSION_A_DEFAULT);
        }}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });

    // One request, scoped to the session's exact id, threading connection and scope.
    expect(calls).toEqual([{ daemon: 'daemon-a', sessionId: 'session-a', query: SESSION_A_DEFAULT }]);
    // The box shows what the daemon actually ran (the echoed canonical query).
    expect(renderer.root.findByProps({ role: 'combobox' }).props.value).toBe(SESSION_A_DEFAULT);
  });

  it('renders the query controls as kteam does: default-size outline buttons with 44px touch targets', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={async () => aggregate()} />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });

    // Starters are `.kt-btn` at the DEFAULT size with the session-only mono font:
    // `kt-btn--sm` would override the themed height/padding/font, and a primary
    // fill would make the box the loudest thing on the page.
    const starters = renderer.root.findByProps({ 'aria-label': 'Aggregations' }).findAllByType('button');
    for (const starter of starters) {
      expect(starter.props.className).toBe('kt-btn min-h-[44px] shrink-0 font-mono text-xs');
      expect(starter.props.className).not.toContain('kt-btn--sm');
      expect(starter.props['data-variant']).toBeUndefined();
    }
    // Run is the resting outline style, not an accent-filled primary.
    const submit = renderer.root.findAllByType('button').filter(button => button.props.type === 'submit');
    expect(submit).toHaveLength(1);
    expect(submit[0]?.props.className).toBe('kt-btn min-h-[44px] shrink-0');
    expect(submit[0]?.props['data-variant']).toBeUndefined();
  });

  it('does not refetch when an equivalent scope object is recreated', async () => {
    const calls: (string | undefined)[] = [];
    const requestAnalytics: SessionAnalyticsRequest = async (_daemon, _scope, query) => {
      calls.push(query);
      return aggregate(query ?? '');
    };
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const afterMount = calls.length; // the single default request

    // Recreate the scope with an identical (daemonId, sessionId). Because effects
    // key off those primitives — not the scope object's identity — there is no refetch.
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface
          connection={daemonA}
          scope={daemonSessionScope(daemonA, 'session-a')}
          requestAnalytics={requestAnalytics}
        />,
      ),
    );
    await runAsync(async () => {
      await Promise.resolve();
    });

    expect(calls.length).toBe(afterMount);
  });

  it('clears the prior scope result during the re-scoped render, before the new request lands', async () => {
    let resolveB: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics: SessionAnalyticsRequest = (_daemon, scope, _query) =>
      new Promise<AnalyticsResponse>(resolve => {
        if (scope.sessionId === 'session-a') resolve(aggregate('LEDGER-A'));
        else resolveB = resolve; // session-b stays pending
      });
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain('LEDGER-A');

    // Switch session; session-b's request is held pending, yet the prior ledger
    // is already gone — the re-scoped render cleared it instead of holding it.
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface connection={daemonA} scope={scopeBSession} requestAnalytics={requestAnalytics} />,
      ),
    );
    expect(renderer.root.findByProps({ role: 'combobox' }).props.value).toBe(sessionAnalyticsDefaultQuery('session-b'));
    expect(renderer.root.findAllByType('button').find(button => button.props.type === 'submit')?.props.disabled).toBe(
      true,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).not.toContain('LEDGER-A');

    await runAsync(async () => {
      resolveB?.(aggregate('LEDGER-B'));
      await Promise.resolve();
    });
  });

  it('runs a starter query into the same surface when a chip is clicked', async () => {
    const calls: (string | undefined)[] = [];
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async (_daemon, _scope, query) => {
          calls.push(query);
          return aggregate(query ?? '');
        }}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const count = renderer.root
      .findByProps({ 'aria-label': 'Aggregations' })
      .findAllByType('button')
      .find(button => button.children.join('') === 'count');
    if (!count) throw new Error('count starter missing');

    await runAsync(async () => {
      count.props.onClick();
      await Promise.resolve();
    });

    // The count starter writes a real, session-scoped query through the same input.
    expect(calls.at(-1)).toBe(`count by (status) ${analyticsIdQuery('session-a')}`);

    // Submitting uses the same visible query path as the Run control rather
    // than relying on the autocomplete's keyboard shortcut.
    const form = renderer.root.findByType('form');
    let prevented = false;
    await runAsync(async () => {
      form.props.onSubmit({ preventDefault: () => (prevented = true) });
      await Promise.resolve();
    });
    expect(prevented).toBe(true);
    expect(calls.at(-1)).toBe(`count by (status) ${analyticsIdQuery('session-a')}`);
  });

  it('disables every control while a query is in flight', async () => {
    let resolveFirst: ((response: AnalyticsResponse) => void) | undefined;
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={(_daemon, _scope, query) =>
          new Promise<AnalyticsResponse>(resolve => {
            if (resolveFirst === undefined) resolveFirst = resolve;
            else resolve(aggregate(query ?? ''));
          })
        }
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });

    const starters = renderer.root.findByProps({ 'aria-label': 'Aggregations' }).findAllByType('button');
    const submit = renderer.root.findAllByType('button').filter(button => button.props.type === 'submit');
    const input = renderer.root.findByProps({ role: 'combobox' });

    // The mount request is still pending, so every control is locked.
    for (const starter of starters) expect(starter.props.disabled).toBe(true);
    expect(submit).toHaveLength(1);
    expect(submit[0]?.props.disabled).toBe(true);
    expect(input.props.disabled).toBe(true);

    await runAsync(async () => {
      resolveFirst?.(aggregate(SESSION_A_DEFAULT));
      await Promise.resolve();
    });
  });

  it('loads autocomplete label values via a count query scoped to the session', async () => {
    const calls: (string | undefined)[] = [];
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async (_daemon, _scope, query) => {
          calls.push(query);
          return aggregate(query ?? '');
        }}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const input = renderer.root.findByProps({ role: 'combobox' });
    run(() => input.props.onChange({ currentTarget: { value: '{status=', selectionStart: 8 } }));
    await runAsync(async () => {
      await Promise.resolve();
    });

    // Typing a matcher label asks the autocomplete to enumerate its values with `count by (…)`.
    expect(calls).toContain('count by (status)');
  });

  it('drops the previous scope autocomplete cache before new values arrive', async () => {
    let resolveBValues: ((response: AnalyticsResponse) => void) | undefined;
    const withStatus = (value: string, query: string): AnalyticsResponse => {
      const response = aggregate(query);
      if (response.kind !== 'aggregate') throw new Error('aggregate fixture changed kind');
      return {
        ...response,
        results: response.results.map((row, index) =>
          index === 0 ? { ...row, labels: { ...row.labels, status: value } } : row,
        ),
      };
    };
    const requestAnalytics: SessionAnalyticsRequest = async (_daemon, scope, query) => {
      if (query !== 'count by (status)') return aggregate(query ?? '');
      if (scope.sessionId === 'session-a') return withStatus('daemon-a-only', query);
      return new Promise<AnalyticsResponse>(resolve => {
        resolveBValues = resolve;
      });
    };
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const openStatusValues = async () => {
      const input = renderer.root.findByProps({ role: 'combobox' });
      run(() => {
        input.props.onFocus();
        input.props.onChange({ currentTarget: { value: '{status=', selectionStart: 8 } });
      });
      await runAsync(async () => {
        await Promise.resolve();
      });
    };
    await openStatusValues();
    expect(textOf(renderer.toJSON())).toContain('daemon-a-only');

    run(() =>
      renderer.update(
        <SessionAnalyticsSurface connection={daemonA} scope={scopeBSession} requestAnalytics={requestAnalytics} />,
      ),
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    await openStatusValues();

    // Session B's value request is deliberately pending. Session A's cached
    // matcher must already be absent instead of flashing in the new scope.
    expect(textOf(renderer.toJSON())).not.toContain('daemon-a-only');
    await runAsync(async () => {
      resolveBValues?.(withStatus('daemon-b-only', 'count by (status)'));
      await Promise.resolve();
    });
    expect(textOf(renderer.toJSON())).toContain('daemon-b-only');
  });

  it('renders an unknown cost as unknown and never as a zero dollar figure', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async () => aggregate(SESSION_A_DEFAULT, { costValue: null })}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain('Cost unknown');
    expect(text).not.toContain('$0.00');
  });

  it('reports a 503 with the catch-up wording and the no-zero-assumed suffix', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async () => {
          throw new DaemonResponseError(503, 'Service Unavailable', 'unavailable');
        }}
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain('Analytics index is unavailable while the daemon catches up (503).');
    expect(text).toContain('Cost remains unknown; no zero was assumed.');
  });

  it('surfaces the cross-daemon guard when the connection and scope disagree', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeBDaemon} // session-a belongs to daemon-b, not the supplied connection
        requestAnalytics={(daemon, scope, query) =>
          // Delegate to the real transport with a fetcher that must never run: the guard fires first.
          fetchSessionAnalytics(daemon, scope, query, async () => {
            throw new Error('guard should have prevented the request');
          })
        }
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain('analytics scope must belong to the requested daemon');
  });

  it('renders the index footer with correct source plurality and the refreshing suffix', async () => {
    // Arrange — singular source, backfill in progress.
    const singular = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async () =>
          aggregate(SESSION_A_DEFAULT, { index: index({ pendingTranscriptSources: 1, refreshing: true }) })
        }
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    let text = textOf(singular.toJSON());
    expect(text).toContain('1 source pending (backfill in progress).');

    // Arrange — plural sources, no backfill.
    const plural = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scopeASession}
        requestAnalytics={async () =>
          aggregate(SESSION_A_DEFAULT, { index: index({ pendingTranscriptSources: 2, refreshing: false }) })
        }
      />,
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    text = textOf(plural.toJSON());
    expect(text).toContain('2 sources pending.');
    expect(text).not.toContain('backfill in progress');
  });

  it('drops a late response when the session changes on the same daemon', async () => {
    let resolveA: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics = (_daemon: typeof daemonA, scope: typeof scopeASession, query?: string) =>
      new Promise<AnalyticsResponse>(resolve => {
        if (scope.sessionId === 'session-a') resolveA = resolve;
        else resolve(aggregate(`fresh ${scope.sessionId}:${query ?? ''}`));
      });
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface connection={daemonA} scope={scopeBSession} requestAnalytics={requestAnalytics} />,
      ),
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    if (!resolveA) throw new Error('first session request missing');

    await runAsync(async () => {
      resolveA?.(aggregate('stale session-a'));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).not.toContain('stale session-a');
    expect(text).toContain('fresh session-b:');
  });

  it('drops a late response when the daemon changes for the same session id', async () => {
    let resolveA: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics = (_daemon: typeof daemonA, scope: typeof scopeASession, query?: string) =>
      new Promise<AnalyticsResponse>(resolve => {
        if (scope.daemonId === daemonA.daemonId) resolveA = resolve;
        else resolve(aggregate(`fresh ${scope.daemonId}:${query ?? ''}`));
      });
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface connection={daemonB} scope={scopeBDaemon} requestAnalytics={requestAnalytics} />,
      ),
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    if (!resolveA) throw new Error('first daemon request missing');

    await runAsync(async () => {
      resolveA?.(aggregate('stale daemon-a'));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    expect(text).not.toContain('stale daemon-a');
    expect(text).toContain('fresh daemon-b:');
  });

  it('drops a late error when the daemon changes before the rejection lands', async () => {
    let rejectA: ((reason: unknown) => void) | undefined;
    const requestAnalytics = (_daemon: typeof daemonA, scope: typeof scopeASession) =>
      new Promise<AnalyticsResponse>((resolve, reject) => {
        if (scope.daemonId === daemonA.daemonId) rejectA = reject;
        else resolve(aggregate('fresh daemon-b'));
      });
    const renderer = mount(
      <SessionAnalyticsSurface connection={daemonA} scope={scopeASession} requestAnalytics={requestAnalytics} />,
    );
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface connection={daemonB} scope={scopeBDaemon} requestAnalytics={requestAnalytics} />,
      ),
    );
    await runAsync(async () => {
      await Promise.resolve();
    });
    if (!rejectA) throw new Error('first daemon request missing');

    await runAsync(async () => {
      rejectA?.(new DaemonResponseError(503, 'down', 'unavailable'));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());

    // The stale 503 never reaches the alert region; the fresh daemon-b result is shown instead.
    expect(text).not.toContain('Analytics index is unavailable');
    expect(text).not.toContain('no zero was assumed');
    expect(text).toContain('fresh daemon-b');
  });
});

describe('sessionAnalyticsLabelValues', () => {
  const rows = (labels: Record<string, string>): Record<string, unknown> => ({ labels });
  const aggregateRows = (results: readonly Record<string, unknown>[]): AnalyticsResponse =>
    ({
      kind: 'aggregate',
      aggregation: 'sum',
      query: 'count by (status)',
      parsed: { aggregation: 'sum', groupBy: ['status'], matchers: [] },
      scope: { allSessions: true, indexed: 0, matched: 0 },
      index: index(),
      results,
    }) as unknown as AnalyticsResponse;
  const raw: AnalyticsResponse = {
    kind: 'raw',
    query: 'raw',
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: 0, matched: 0 },
    index: index(),
    limit: 200,
    truncated: false,
    results: [],
  } as AnalyticsResponse;

  it('returns distinct, sorted label values and drops blanks and other labels', () => {
    // Arrange — duplicates, out of order, one blank, one under a different label.
    const response = aggregateRows([
      rows({ status: 'beta', model: 'm' }),
      rows({ status: 'alpha' }),
      rows({ status: 'beta' }),
      rows({ status: '' }),
      rows({ model: 'ignored' }),
    ]);

    // Act + Assert — deduped, sorted, blanks and unrelated labels excluded.
    expect(sessionAnalyticsLabelValues(response, 'status')).toEqual(['alpha', 'beta']);
  });

  it('offers no values for a raw (non-aggregate) response', () => {
    expect(sessionAnalyticsLabelValues(raw, 'status')).toEqual([]);
  });
});
