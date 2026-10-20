import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import type { AnalyticsRequest } from '../../../src/features/analytics/analytics-custom-query.tsx';
import {
  type SessionAnalyticsRequest,
  SessionAnalyticsSurface,
  sessionAnalyticsLinkQuery,
} from '../../../src/features/analytics/session-analytics-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { rawResponse, rawRow } from '../../support/analytics-rows.ts';
import '../../support/dom.ts';
import { render, run, runAsync } from '../../support/react.ts';

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
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await runAsync(async () => await Promise.resolve());
};
const textOf = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
};
const text = (renderer: ReactTestRenderer): string => textOf(renderer.toJSON());

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const scope = daemonSessionScope(daemonA, 'root');

const ROOT = rawRow({
  id: 'root',
  tree: 'root',
  equivalentApiCostUsdMicros: 43_510_000,
  tokens: 10_800_000,
  inputTokens: 1_000,
  cachedInputTokens: 160,
  contextEndPercent: 62,
  turns: 41,
});
const TREE = [
  ROOT,
  rawRow({ id: 'a', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: 37_000_000 }),
  rawRow({ id: 'b', tree: 'root', parent: 'a', model: 'claude-sonnet-5-5', equivalentApiCostUsdMicros: 5_400_000 }),
  rawRow({ id: 'c', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: null }),
];

const scoped =
  (rows: readonly (typeof ROOT)[], calls: string[] = []): SessionAnalyticsRequest =>
  async (_daemon, target, query) => {
    calls.push(`${target.sessionId}:${query}`);
    return rawResponse(
      rows.filter(row => row.id === target.sessionId),
      query,
    );
  };
const fleet =
  (rows: readonly (typeof ROOT)[], calls: string[] = [], truncated = false): AnalyticsRequest =>
  async (_daemon, query) => {
    calls.push(query ?? '');
    return rawResponse(rows, query, truncated);
  };

describe('SessionAnalyticsSurface', () => {
  it('answers this session and with children first, then the model split and context facts', async () => {
    const calls: string[] = [];
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={scoped(TREE, calls)}
        requestFleetAnalytics={fleet(TREE, calls)}
      />,
    );
    expect(text(renderer)).toContain("Reading this session's cost");
    await settle();
    expect(calls).toEqual(['root:{id="root"}', '{tree=="root"}']);
    const output = text(renderer);
    expect(output).toContain('This session$43.51');
    expect(output).toContain('10.8M tokens');
    expect(output).toContain('With children$85.91');
    expect(output).toContain('1 unpriced');
    expect(output).toContain('3 children');
    expect(output).toContain('Context at 62% · 41 turns · cache reads 16%');
    expect(output).not.toContain('sum by');
    const rows = renderer.root.findAll(node => node.type === 'li' && node.props['data-cost-row'] !== undefined);
    expect(rows.map(row => row.props['data-cost-row'])).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'unpriced']);
    const link = renderer.root.find(node => node.type === 'a' && node.props['data-open-analytics'] === '');
    expect(link.props.href).toBe(
      `/d/daemon-a/analytics/query?q=${encodeURIComponent('sum by (model) {tree=="root"}')}`,
    );
    expect(renderer.root.findByProps({ 'aria-label': 'Session cost' }).props['data-session-cost']).toBe('ready');
  });

  it('says an unpriced, childless session is unpriced and marks a truncated tree', async () => {
    const lone = rawRow({
      id: 'root',
      equivalentApiCostUsdMicros: null,
      tokens: null,
      contextEndPercent: null,
      turns: null,
      inputTokens: null,
    });
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={scoped([lone])}
        requestFleetAnalytics={fleet([lone], [], true)}
      />,
    );
    await settle();
    const output = text(renderer);
    expect(output).toContain('This sessionUnpriced');
    expect(output).toContain('Tokens not counted');
    expect(output).toContain('0+ children');
    expect(output).not.toContain('Context at');
    expect(sessionAnalyticsLinkQuery(lone)).toBe('sum by (model) {tree=="root"}');
  });

  it('counts one child in the singular and survives a tree answer that is not rows', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={scoped([ROOT])}
        requestFleetAnalytics={async (_daemon, query) =>
          ({
            ...rawResponse([], query),
            kind: 'aggregate',
            aggregation: 'sum',
            parsed: { aggregation: 'sum', groupBy: [], matchers: [] },
            results: [],
          }) as AnalyticsResponse
        }
      />,
    );
    await settle();
    expect(text(renderer)).toContain('0 children');
    const one = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={scoped([ROOT])}
        requestFleetAnalytics={fleet([ROOT, TREE[1]!])}
      />,
    );
    await settle();
    expect(text(one)).toContain('1 child');
  });

  it('says a session that is not indexed yet is not counted, and still links to Analytics', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={scoped([])}
        requestFleetAnalytics={fleet([])}
      />,
    );
    await settle();
    expect(text(renderer)).toContain('Not counted yet');
    const link = renderer.root.find(node => node.type === 'a' && node.props['data-open-analytics'] === '');
    expect(link.props.href).toContain(encodeURIComponent('{tree=="root"}'));
  });

  it('reports a failed read without inventing a zero', async () => {
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={async () => {
          throw new DaemonResponseError(503, 'busy');
        }}
      />,
    );
    await settle();
    expect(text(renderer)).toContain('Cost could not load: Analytics index is unavailable');
    expect(text(renderer)).toContain('Nothing was assumed to be zero.');
  });

  it('drops a late answer for the previous daemon or session', async () => {
    let resolveA: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics: SessionAnalyticsRequest = (daemon, target, query) =>
      new Promise(resolve => {
        if (daemon.daemonId === 'daemon-a') resolveA = resolve;
        else resolve(rawResponse([rawRow({ id: target.sessionId, equivalentApiCostUsdMicros: 2_000_000 })], query));
      });
    const renderer = mount(
      <SessionAnalyticsSurface
        connection={daemonA}
        scope={scope}
        requestAnalytics={requestAnalytics}
        requestFleetAnalytics={fleet([])}
      />,
    );
    run(() =>
      renderer.update(
        <SessionAnalyticsSurface
          connection={daemonB}
          scope={daemonSessionScope(daemonB, 'root')}
          requestAnalytics={requestAnalytics}
          requestFleetAnalytics={fleet([])}
        />,
      ),
    );
    await settle();
    await runAsync(async () => {
      resolveA?.(rawResponse([rawRow({ id: 'root', equivalentApiCostUsdMicros: 99_000_000 })]));
      await Promise.resolve();
    });
    expect(text(renderer)).toContain('$2.00');
    expect(text(renderer)).not.toContain('$99.00');
  });

  it('opens Analytics in-app when a router is mounted', async () => {
    window.history.replaceState({}, '', '/d/daemon-a/session/root');
    const renderer = mount(
      <RouterProvider>
        <SessionAnalyticsSurface
          connection={daemonA}
          scope={scope}
          requestAnalytics={scoped(TREE)}
          requestFleetAnalytics={fleet(TREE)}
        />
      </RouterProvider>,
    );
    await settle();
    const link = renderer.root.find(node => node.type === 'a' && node.props['data-open-analytics'] === '');
    run(() => link.props.onClick({ button: 0, preventDefault() {} }));
    expect(window.location.pathname).toBe('/d/daemon-a/analytics/query');
    expect(new URLSearchParams(window.location.search).get('q')).toBe('sum by (model) {tree=="root"}');
    window.history.replaceState({}, '', '/');
  });
});
