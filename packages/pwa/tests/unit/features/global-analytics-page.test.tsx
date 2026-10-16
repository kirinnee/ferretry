import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  AnalyticsCustomQuery,
  GLOBAL_ANALYTICS_DEFAULT_QUERY,
  GLOBAL_ANALYTICS_STARTERS,
} from '../../../src/features/analytics/analytics-custom-query.tsx';
import {
  analyticsLinkQuery,
  GlobalAnalyticsPage,
  TOP_SESSIONS_SHOWN,
} from '../../../src/features/analytics/global-analytics-page.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { RouterProvider } from '../../../src/lib/router.tsx';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';
import { dayAggregate, rawResponse, rawRow } from '../../support/analytics-rows.ts';
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
/** Every text node in the rendered tree, concatenated: JSX interpolation splits a phrase across children. */
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
const NOW = () => new Date('2026-10-16T12:00:00Z');

const FLEET = [
  rawRow({ id: 'root', tree: 'root', agent: 'Marin', label: 'Flaky test fix', equivalentApiCostUsdMicros: 43_510_000 }),
  rawRow({ id: 'kid', tree: 'root', parent: 'root', agent: 'Marin', equivalentApiCostUsdMicros: 40_690_000 }),
  rawRow({ id: 'hadi', agent: 'Hadi', label: null, day: '2026-10-14', equivalentApiCostUsdMicros: 61_700_000 }),
  rawRow({
    id: 'free',
    agent: null,
    cwd: null,
    label: null,
    model: null,
    day: '2026-10-15',
    equivalentApiCostUsdMicros: null,
  }),
  ...Array.from({ length: 5 }, (_, index) =>
    rawRow({ id: `small-${index}`, agent: `Small ${index}`, day: '2026-10-10', equivalentApiCostUsdMicros: 100_000 }),
  ),
];

const aggregate = (query: string): AnalyticsResponse => ({ ...dayAggregate('2026-10-13', 2, 2), query });

/** A daemon over FLEET: window reads get rows, anything aggregated gets a one-row ledger. */
const fleet =
  (calls: string[] = []) =>
  async (_daemon: unknown, query?: string): Promise<AnalyticsResponse> => {
    calls.push(query ?? '');
    if (query?.startsWith('{day=')) return rawResponse(FLEET, query);
    if (query === undefined) throw new Error('offline');
    return aggregate(query);
  };

describe('GlobalAnalyticsPage', () => {
  it('leads with the known total and the unpriced count, then the chart, models and top sessions', async () => {
    const calls: string[] = [];
    const renderer = mount(
      <GlobalAnalyticsPage connection={daemonA} requestAnalytics={fleet(calls)} now={NOW} initialQuery={null} />,
    );
    expect(text(renderer)).toContain("Reading this period's sessions");
    await settle();
    expect(calls).toEqual(['{day="2026-10-*"}']);
    const output = text(renderer);
    expect(output).toContain('$146.40');
    expect(output).toContain('1 unpriced');
    expect(output).toContain('Equivalent cost per day');
    expect(output).toContain('By model');
    expect(output).toContain('last 14 days');
    expect(output).toContain('% cache reads');
    expect(output).not.toContain('Cost unknown');
    const rows = renderer.root.findAll(node => node.type === 'a' && node.props['data-top-session'] !== undefined);
    expect(rows.map(row => row.props['data-top-session'])).toEqual(['root', 'hadi', 'small-0', 'small-1', 'small-2']);
    expect(rows[0]?.props.href).toBe('/d/daemon-a/session/root');
    expect(output).toContain('+1 child');
    expect(renderer.root.findByProps({ 'aria-label': 'Global analytics' }).props['data-daemon']).toBe('daemon-a');
  });

  it('shows every session on request, and a period with nothing in it says so', async () => {
    const renderer = mount(
      <GlobalAnalyticsPage connection={daemonA} requestAnalytics={fleet()} now={NOW} initialQuery={null} />,
    );
    await settle();
    const seeAll = renderer.root.findByProps({
      'aria-expanded': false,
      className: 'min-h-[44px] text-meta text-accent hover:underline',
    });
    expect(seeAll.children.join('')).toBe(`See all 8`);
    run(() => seeAll.props.onClick());
    expect(
      renderer.root.findAll(node => node.type === 'a' && node.props['data-top-session'] !== undefined),
    ).toHaveLength(8);
    expect(TOP_SESSIONS_SHOWN).toBe(5);

    const empty = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        requestAnalytics={async () => rawResponse([])}
        now={NOW}
        initialQuery={null}
      />,
    );
    await settle();
    expect(text(empty)).toContain('No sessions in this period.');
    expect(text(empty)).toContain('None in this period');
    expect(text(empty)).toContain('Nothing was priced in this period.');
  });

  it('re-reads the window when the range changes, across two months', async () => {
    const calls: string[] = [];
    const renderer = mount(
      <GlobalAnalyticsPage connection={daemonA} requestAnalytics={fleet(calls)} now={NOW} initialQuery={null} />,
    );
    await settle();
    const thirty = renderer.root.findByProps({ 'data-analytics-range': 30 });
    await runAsync(async () => {
      thirty.props.onClick();
      await Promise.resolve();
    });
    await settle();
    expect(calls.slice(1).sort()).toEqual(['{day="2026-09-*"}', '{day="2026-10-*"}']);
    expect(renderer.root.findByProps({ 'data-analytics-range': 30 }).props['aria-pressed']).toBe(true);
    expect(text(renderer)).toContain('last 30 days');
  });

  it('says when busy days were only partly listed', async () => {
    const renderer = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        now={NOW}
        initialQuery={null}
        requestAnalytics={async (_daemon, query) => {
          if (query === '{day="2026-10-*"}') return rawResponse([], query, true);
          if (query?.startsWith('sum')) return dayAggregate('2026-10-13', 120, 120);
          return rawResponse(
            [rawRow({ id: query ?? 'x', day: query?.slice(6, 16) ?? null })],
            query,
            query === '{day="2026-10-13"}' || query === '{day="2026-10-14"}',
          );
        }}
      />,
    );
    await settle();
    expect(text(renderer)).toContain('2 busy days were only partly listed');
  });

  it('reports a failed read without inventing a zero, with the 503 explained', async () => {
    const renderer = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        now={NOW}
        initialQuery={null}
        requestAnalytics={async () => {
          throw new DaemonResponseError(503, 'busy');
        }}
      />,
    );
    await settle();
    expect(text(renderer)).toContain('Analytics index is unavailable while the daemon catches up (503).');
    expect(text(renderer)).toContain('Nothing was assumed to be zero.');
  });

  it('drops a late answer from the previous daemon', async () => {
    let resolveA: ((response: AnalyticsResponse) => void) | undefined;
    const requestAnalytics = (daemon: typeof daemonA, query?: string) =>
      new Promise<AnalyticsResponse>(resolve => {
        if (daemon.daemonId === 'daemon-a') resolveA = resolve;
        else resolve(rawResponse([rawRow({ id: 'b-only', agent: 'B only' })], query));
      });
    const renderer = mount(
      <GlobalAnalyticsPage connection={daemonA} requestAnalytics={requestAnalytics} now={NOW} initialQuery={null} />,
    );
    run(() =>
      renderer.update(
        <GlobalAnalyticsPage connection={daemonB} requestAnalytics={requestAnalytics} now={NOW} initialQuery={null} />,
      ),
    );
    await settle();
    await runAsync(async () => {
      resolveA?.(rawResponse([rawRow({ id: 'a-only', agent: 'A only' })]));
      await Promise.resolve();
    });
    expect(text(renderer)).toContain('B only');
    expect(text(renderer)).not.toContain('A only');
  });

  it('navigates in-app to a session when a router is mounted', async () => {
    window.history.replaceState({}, '', '/d/daemon-a/analytics');
    const renderer = mount(
      <RouterProvider>
        <GlobalAnalyticsPage connection={daemonA} requestAnalytics={fleet()} now={NOW} />
      </RouterProvider>,
    );
    await settle();
    const link = renderer.root.find(node => node.type === 'a' && node.props['data-top-session'] === 'hadi');
    run(() => link.props.onClick({ button: 0, preventDefault() {} }));
    expect(window.location.pathname).toBe('/d/daemon-a/session/hadi');
  });

  it('opens Custom query and runs a query a link brought', async () => {
    expect(analyticsLinkQuery('?q=sum+by+%28model%29')).toBe('sum by (model)');
    expect(analyticsLinkQuery('')).toBeNull();
    window.history.replaceState({}, '', '/d/daemon-a/analytics?q=count%20by%20(status)');
    const calls: string[] = [];
    const renderer = mount(<GlobalAnalyticsPage connection={daemonA} requestAnalytics={fleet(calls)} now={NOW} />);
    await settle();
    expect(calls).toContain('count by (status)');
    expect(renderer.root.findByProps({ role: 'combobox' }).props.value).toBe('count by (status)');
    window.history.replaceState({}, '', '/');
  });
});

describe('AnalyticsCustomQuery', () => {
  const open = (renderer: ReactTestRenderer) => {
    const toggle = renderer.root.findByProps({ 'aria-expanded': false });
    run(() => toggle.props.onClick());
  };

  it('stays closed and asks nothing until opened', () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsCustomQuery connection={daemonA} requestAnalytics={fleet(calls)} />);
    expect(calls).toEqual([]);
    expect(text(renderer)).toContain('Any grouping, in the analytics query language');
    expect(renderer.root.findAllByProps({ role: 'combobox' })).toHaveLength(0);
    open(renderer);
    expect(renderer.root.findByProps({ role: 'combobox' }).props.value).toBe(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    run(() => renderer.root.findByProps({ 'aria-expanded': true }).props.onClick());
    expect(renderer.root.findAllByProps({ role: 'combobox' })).toHaveLength(0);
  });

  it('keeps the diagnostic starters inside it, each running its own query', async () => {
    expect(GLOBAL_ANALYTICS_STARTERS.map(starter => starter.query)).toEqual([
      'sum by (day)',
      'sum by (week)',
      'sum by (model)',
      'sum by (token_data)',
      'count by (model, pricing_model)',
      'avg by (model)',
      'max by (model)',
      'count by (status)',
    ]);
    const calls: string[] = [];
    const renderer = mount(<AnalyticsCustomQuery connection={daemonA} requestAnalytics={fleet(calls)} />);
    open(renderer);
    const starters = renderer.root.findByProps({ role: 'toolbar' }).findAllByType('button');
    for (const [index, starter] of starters.entries()) {
      expect(starter.props.title).toBe(GLOBAL_ANALYTICS_STARTERS[index]?.hint);
      await runAsync(async () => {
        starter.props.onClick();
        await Promise.resolve();
      });
    }
    expect(calls).toEqual(GLOBAL_ANALYTICS_STARTERS.map(starter => starter.query));
    expect(text(renderer)).toContain('2 of 2 sessions matched');
  });

  it('submits blank input as the default, reports a failure, and loads autocomplete values', async () => {
    const calls: string[] = [];
    const renderer = mount(<AnalyticsCustomQuery connection={daemonA} requestAnalytics={fleet(calls)} />);
    open(renderer);
    const input = renderer.root.findByProps({ role: 'combobox' });
    run(() => input.props.onChange({ currentTarget: { value: '   ', selectionStart: 3 } }));
    await runAsync(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
    });
    expect(text(renderer)).toContain('The query failed: offline');
    run(() => {
      input.props.onFocus();
      input.props.onChange({ currentTarget: { value: '{day=', selectionStart: 5 } });
    });
    await settle();
    expect(calls).toContain('count by (day)');
    expect(text(renderer)).toContain('2026-10-13');
    run(() => input.props.onBlur());
    await runAsync(async () => {
      input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} });
      await Promise.resolve();
    });
    expect(calls.at(-1)).toBe('{day=');
  });

  it('offers no values for a label when the answer is not a ledger', async () => {
    const renderer = mount(
      <AnalyticsCustomQuery
        connection={daemonA}
        requestAnalytics={async (_daemon, query) => rawResponse([], query)}
        initialQuery="{status=done}"
      />,
    );
    await settle();
    const input = renderer.root.findByProps({ role: 'combobox' });
    run(() => {
      input.props.onFocus();
      input.props.onChange({ currentTarget: { value: '{status=', selectionStart: 8 } });
    });
    await settle();
    expect(text(renderer)).toContain('No indexed session matched this query.');
  });
});
