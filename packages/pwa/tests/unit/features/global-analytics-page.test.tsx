import { afterEach, describe, expect, it } from 'bun:test';
import type { AnalyticsResponse } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import type { AnalyticsRequest } from '../../../src/features/analytics/analytics-custom-query.tsx';
import {
  machinesSummary,
  readEveryMachine,
  requestAcrossMachines,
  stampMachine,
} from '../../../src/features/analytics/analytics-fanout.ts';
import {
  AnalyticsOverviewPage,
  overviewChartPoints,
  TOP_SESSIONS_SHOWN,
} from '../../../src/features/analytics/analytics-overview-page.tsx';
import { analyticsLinkQuery, GlobalAnalyticsPage } from '../../../src/features/analytics/global-analytics-page.tsx';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
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
const choose = async (renderer: ReactTestRenderer, group: string, segment: string): Promise<void> => {
  const button = renderer.root
    .findByProps({ 'data-segmented': group })
    .find(node => node.type === 'button' && node.props['data-segment'] === segment);
  await runAsync(async () => {
    button.props.onClick();
    await Promise.resolve();
  });
  await settle();
};

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
const MACHINES = [
  { connection: daemonA, name: 'studio-mac' },
  { connection: daemonB, name: 'kirin-box' },
];
const NOW = () => new Date('2026-10-16T12:00:00Z');

const FLEET_A = [
  rawRow({ id: 'root', tree: 'root', agent: 'claude-auto-loge', label: 'Flaky test fix', equivalentApiCostUsdMicros: 43_510_000 }),
  rawRow({ id: 'kid', tree: 'root', parent: 'root', equivalentApiCostUsdMicros: 40_690_000 }),
  rawRow({
    id: 'free',
    agent: null,
    cwd: null,
    label: null,
    model: null,
    day: '2026-10-15',
    equivalentApiCostUsdMicros: null,
    activeDurationMs: null,
  }),
  ...Array.from({ length: 5 }, (_, index) =>
    rawRow({ id: `small-${index}`, label: `Small ${index}`, day: '2026-10-10', equivalentApiCostUsdMicros: 100_000 }),
  ),
];
const FLEET_B = [
  rawRow({ id: 'hadi', agent: 'codex-sol', label: null, day: '2026-10-14', equivalentApiCostUsdMicros: 61_700_000 }),
];

/** Two daemons over their fleets; window reads get rows. */
const fleet =
  (calls: string[] = []): AnalyticsRequest =>
  async (daemon, query) => {
    calls.push(`${daemon.daemonId} ${query ?? ''}`);
    return rawResponse(daemon.daemonId === 'daemon-a' ? FLEET_A : FLEET_B, query);
  };

const overview = (requestAnalytics: AnalyticsRequest, machines = MACHINES) =>
  mount(<AnalyticsOverviewPage machines={machines} requestAnalytics={requestAnalytics} now={NOW} />);

describe('AnalyticsOverviewPage', () => {
  it('leads with four figures across every machine, then the chart, the splits and top sessions', async () => {
    const calls: string[] = [];
    const renderer = overview(fleet(calls));
    expect(text(renderer)).toContain("Reading this period's sessions");
    await settle();
    expect(calls.sort()).toEqual(['daemon-a {day="2026-10-*"}', 'daemon-b {day="2026-10-*"}']);
    const output = text(renderer);
    expect(output).toContain('Last 14 days · all 2 machines');
    expect(output).toContain('$146.40');
    expect(output).toContain('1 of 9 sessions unpriced, not included');
    expect(output).toContain('% of input from cache');
    expect(output).toContain('per session');
    expect(output).toContain('Busiest day');
    expect(output).toContain('Equivalent API cost per day');
    for (const split of ['By model', 'By runtime', 'By machine', 'By project']) expect(output).toContain(split);
    expect(output).toContain('kirin-box');
    const rows = renderer.root.findAll(node => node.type === 'a' && node.props['data-top-session'] !== undefined);
    expect(rows.map(row => row.props['data-top-session'])).toEqual(['root', 'free', 'hadi', 'small-0', 'small-1']);
    expect(rows[0]?.props.href).toBe('/d/daemon-a/session/root');
    expect(rows[2]?.props.href).toBe('/d/daemon-b/session/hadi');
    expect(output).toContain('+1 child');
  });

  it('switches the measure, the bucketing and the ranking of top sessions', async () => {
    const renderer = overview(fleet());
    await settle();
    await choose(renderer, 'analytics-metric', 'tokens');
    expect(renderer.root.findAll(node => node.props['data-chart-legend'] !== undefined).length).toBe(4);
    expect(text(renderer)).toContain('Tokens per day');
    await choose(renderer, 'analytics-metric', 'turns');
    expect(text(renderer)).toContain('Turns per day');
    await choose(renderer, 'analytics-metric', 'active');
    expect(text(renderer)).toContain('Active time per day');
    expect(text(renderer)).toContain('not timed');
    await choose(renderer, 'analytics-bucketing', 'week');
    expect(text(renderer)).toContain('Active time per week');
    expect(text(renderer)).toContain('wk 12 Oct');

    await choose(renderer, 'analytics-top-order', 'cost');
    const byCost = renderer.root.findAll(node => node.type === 'a' && node.props['data-top-session'] !== undefined);
    expect(byCost.map(row => row.props['data-top-session'])).toEqual(['root', 'hadi', 'small-0', 'small-1', 'small-2']);
    await choose(renderer, 'analytics-top-order', 'duration');
    expect(renderer.root.findByProps({ 'aria-label': 'Sessions by duration' })).toBeDefined();

    const seeAll = renderer.root.find(node => node.type === 'button' && node.props['aria-expanded'] === false);
    expect(seeAll.children.join('')).toBe('See all 8');
    run(() => seeAll.props.onClick());
    expect(
      renderer.root.findAll(node => node.type === 'a' && node.props['data-top-session'] !== undefined),
    ).toHaveLength(8);
    expect(text(renderer)).toContain('not timed');
    run(() => renderer.root.find(node => node.type === 'button' && node.props['aria-expanded'] === true).props.onClick());
    expect(TOP_SESSIONS_SHOWN).toBe(5);
  });

  it('shows a lower bound and a word for a session tree with a gap, and a fully unknown ranking last', async () => {
    const renderer = overview(
      async (_daemon, query) =>
        rawResponse(
          [
            rawRow({ id: 'p', tree: 'p', equivalentApiCostUsdMicros: 1_000_000 }),
            rawRow({ id: 'q', tree: 'p', parent: 'p', equivalentApiCostUsdMicros: null }),
            rawRow({ id: 'r', equivalentApiCostUsdMicros: null }),
          ],
          query,
        ),
      [MACHINES[0]!],
    );
    await settle();
    await choose(renderer, 'analytics-top-order', 'cost');
    const output = text(renderer);
    expect(output).toContain('≥ $1.00');
    expect(output).toContain('unpriced');
    expect(output).toContain('Last 14 days · this machine');
  });

  it('re-reads the window when the range changes, across two months', async () => {
    const calls: string[] = [];
    const renderer = overview(fleet(calls), [MACHINES[0]!]);
    await settle();
    await choose(renderer, 'analytics-range', '30');
    expect(calls.slice(1).sort()).toEqual(['daemon-a {day="2026-09-*"}', 'daemon-a {day="2026-10-*"}']);
    expect(text(renderer)).toContain('Last 30 days');
  });

  it('says a period with nothing in it is empty, every figure without a fake zero', async () => {
    const renderer = overview(async () => rawResponse([]), [MACHINES[0]!]);
    await settle();
    const output = text(renderer);
    expect(output).toContain('No sessions in this period.');
    expect(output).toContain('No sessions');
    expect(output).toContain('At API rates; not what a plan bills');
    expect(output).toContain('Input and output');
    expect(output).not.toContain('Busiest day');
  });

  it('reads Unpriced and Not recorded rather than zeroes when nothing could be priced or timed', async () => {
    const renderer = overview(
      async () =>
        rawResponse([
          rawRow({ id: 'a', equivalentApiCostUsdMicros: null, activeDurationMs: null, durationMs: null, inputTokens: 0, cachedInputTokens: 0 }),
        ]),
      [MACHINES[0]!],
    );
    await settle();
    const output = text(renderer);
    expect(output).toContain('Unpriced');
    expect(output).toContain('Not recorded for these sessions');
    expect(output).toContain('—');
  });

  it('says when busy days were only partly listed', async () => {
    const renderer = overview(
      async (_daemon, query) => {
        if (query === '{day="2026-10-*"}') return rawResponse([], query, true);
        if (query?.startsWith('sum')) return dayAggregate('2026-10-13', 120, 120);
        return rawResponse(
          [rawRow({ id: query ?? 'x', day: query?.slice(6, 16) ?? null })],
          query,
          query === '{day="2026-10-13"}' || query === '{day="2026-10-14"}',
        );
      },
      [MACHINES[0]!],
    );
    await settle();
    expect(text(renderer)).toContain('2 busy days were only partly listed');
    const one = overview(
      async (_daemon, query) => {
        if (query === '{day="2026-10-*"}') return rawResponse([], query, true);
        if (query?.startsWith('sum')) return dayAggregate('2026-10-13', 120, 120);
        return rawResponse([], query, query === '{day="2026-10-13"}');
      },
      [MACHINES[0]!],
    );
    await settle();
    expect(text(one)).toContain('1 busy day was only partly listed, so the figures for it are a lower bound.');
  });

  it('names a machine that did not answer, and shows the ones that did while a slow one is out', async () => {
    let releaseB: ((response: AnalyticsResponse) => void) | undefined;
    const renderer = overview(async (daemon, query) => {
      if (daemon.daemonId === 'daemon-a') return rawResponse(FLEET_A, query);
      return await new Promise<AnalyticsResponse>(resolve => {
        releaseB = resolve;
      });
    });
    await settle();
    expect(text(renderer)).toContain('1 of 2 machines · waiting for 1 machine');
    await runAsync(async () => {
      releaseB?.(rawResponse(FLEET_B));
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).toContain('all 2 machines');

    const failing = overview(async (daemon, query) => {
      if (daemon.daemonId === 'daemon-b') throw new DaemonResponseError(503, 'busy');
      return rawResponse(FLEET_A, query);
    });
    await settle();
    expect(text(failing)).toContain(
      'kirin-box did not answer: Analytics index is unavailable while the daemon catches up (503). Its sessions are not included.',
    );
    expect(text(failing)).toContain('1 of 2 machines');
  });

  it('says nothing was assumed when no machine answered', async () => {
    const renderer = overview(async () => {
      throw new Error('offline');
    });
    await settle();
    expect(text(renderer)).toContain('No machine answered, so there is nothing to show. Nothing was assumed to be zero.');
  });

  it('drops a late answer from the previous range', async () => {
    const releases: ((response: AnalyticsResponse) => void)[] = [];
    const renderer = overview(
      async () =>
        await new Promise<AnalyticsResponse>(resolve => {
          releases.push(resolve);
        }),
      [MACHINES[0]!],
    );
    await choose(renderer, 'analytics-range', '7');
    await runAsync(async () => {
      releases[0]?.(rawResponse([rawRow({ id: 'stale', label: 'Stale answer', day: '2026-10-14' })]));
      releases[1]?.(rawResponse([rawRow({ id: 'fresh', label: 'Fresh answer', day: '2026-10-14' })]));
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).toContain('Fresh answer');
    expect(text(renderer)).not.toContain('Stale answer');
    expect(text(renderer)).toContain('Last 7 days');
  });

  it('navigates in-app to a session on its own machine when a router is mounted', async () => {
    window.history.replaceState({}, '', '/d/daemon-a/analytics');
    const renderer = mount(
      <RouterProvider>
        <AnalyticsOverviewPage machines={MACHINES} requestAnalytics={fleet()} now={NOW} />
      </RouterProvider>,
    );
    await settle();
    const link = renderer.root.find(node => node.type === 'a' && node.props['data-top-session'] === 'hadi');
    run(() => link.props.onClick({ button: 0, preventDefault() {} }));
    expect(window.location.pathname).toBe('/d/daemon-b/session/hadi');
    window.history.replaceState({}, '', '/');
  });
});

describe('overviewChartPoints', () => {
  it('flags a bucket with an unknown value or a partial read, and marks an empty one', () => {
    const totals = {
      sessions: 0,
      costMicros: 0,
      unpriced: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tokensUnknown: 0,
      turns: 0,
      turnsUnknown: 0,
      activeMs: 0,
      activeUnknown: 0,
      activeTurns: 0,
      wallMs: 0,
      wallUnknown: 0,
    };
    const points = overviewChartPoints(
      [
        { key: '2026-10-12', totals, partial: true, countedSessions: 3 },
        { key: '2026-10-13', totals: { ...totals, sessions: 1, unpriced: 1 }, partial: false, countedSessions: 1 },
        { key: '2026-10-14', totals, partial: false, countedSessions: 0 },
      ],
      'cost',
      'day',
    );
    expect(points.map(point => [point.flagged, point.empty])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(points[0]!.readout).toBe('12 Oct · $0.00 · 3 sessions · only partly listed');
    expect(points[1]!.readout).toBe('13 Oct · $0.00 · 1 session · 1 unpriced');
  });
});

describe('fan-out', () => {
  it('settles every machine on its own and summarises who answered', async () => {
    const heard: string[] = [];
    const outcomes = await readEveryMachine(
      MACHINES,
      async connection => {
        if (connection.daemonId === 'daemon-b') throw new Error('gone');
        return String(connection.daemonId);
      },
      outcome => heard.push(outcome.status),
    );
    expect(outcomes).toEqual([
      { machine: MACHINES[0]!, status: 'answered', value: 'daemon-a' },
      { machine: MACHINES[1]!, status: 'failed', error: 'gone' },
    ]);
    expect(heard.sort()).toEqual(['answered', 'failed']);
    expect(await readEveryMachine([], async () => 1)).toEqual([]);
    expect(machinesSummary(outcomes, 2)).toBe('1 of 2 machines');
    expect(machinesSummary(outcomes.slice(0, 1), 1)).toBeNull();
    expect(machinesSummary(outcomes.slice(0, 1), 3)).toBe('1 of 3 machines');
    expect(machinesSummary([outcomes[0]!, outcomes[0]!], 2)).toBe('all 2 machines');
  });
});

describe('one query across every machine', () => {
  const byMachine = (machine: string | null) => ({
    ...dayAggregate('2026-10-13', 2, 2),
    query: 'sum by (machine)',
    parsed: { aggregation: 'sum' as const, groupBy: ['machine' as const], matchers: [] },
    results: dayAggregate('2026-10-13', 2, 2).kind === 'aggregate'
      ? (dayAggregate('2026-10-13', 2, 2) as Extract<AnalyticsResponse, { kind: 'aggregate' }>).results.map(result => ({
          ...result,
          labels: { machine },
        }))
      : [],
  });

  it('names each machine’s rows and groups as the app does', () => {
    const raw = stampMachine(rawResponse([rawRow({ id: 'a', machine: 'host' })]), 'kirin-box');
    expect(raw.kind === 'raw' && raw.results[0]!.machine).toBe('kirin-box');
    const grouped = stampMachine(byMachine('host') as AnalyticsResponse, 'kirin-box');
    expect(grouped.kind === 'aggregate' && grouped.results[0]!.labels).toEqual({ machine: 'kirin-box' });
    const other = stampMachine(dayAggregate('2026-10-13', 1, 1), 'kirin-box');
    expect(other.kind === 'aggregate' && other.results[0]!.labels).toEqual({ day: '2026-10-13' });
  });

  it('merges every answer, says who did not answer, and fails only when nobody did', async () => {
    const failures: string[][] = [];
    const request = requestAcrossMachines(
      MACHINES,
      async (daemon, query) => {
        if (query === 'broken' && daemon.daemonId === 'daemon-b') throw new Error('gone');
        if (query === 'dead') throw new Error(`${daemon.daemonId} down`);
        return rawResponse([rawRow({ id: `${daemon.daemonId}-row` })], query);
      },
      failed => failures.push(failed.map(outcome => `${outcome.machine.name}: ${outcome.error}`)),
    );
    const merged = await request(daemonA, '{}');
    expect(merged.kind === 'raw' && merged.results.map(row => [row.id, row.machine]).sort()).toEqual([
      ['daemon-a-row', 'studio-mac'],
      ['daemon-b-row', 'kirin-box'],
    ]);
    const partial = await request(daemonA, 'broken');
    expect(partial.kind === 'raw' && partial.results).toHaveLength(1);
    await expect(request(daemonA, 'dead')).rejects.toThrow('daemon-a down');
    await expect(requestAcrossMachines([], request, () => {})(daemonA, '{}')).rejects.toThrow('no machine to ask');
    expect(failures).toEqual([[], ['kirin-box: gone'], ['studio-mac: daemon-a down', 'kirin-box: daemon-b down']]);
  });
});

describe('GlobalAnalyticsPage', () => {
  const QueryStub = (props: {
    readonly connection: DaemonConnection;
    readonly connections?: readonly DaemonConnection[];
    readonly initialQuery?: string | null;
    readonly now?: () => Date;
    readonly onQueryChange?: (query: string) => void;
  }) => (
    <p data-query-stub="">
      {props.connection.daemonId} {props.connections?.length} {props.initialQuery ?? 'none'}{' '}
      {props.now === undefined ? 'no-clock' : 'clock'}
      <button type="button" data-run="" onClick={() => props.onQueryChange?.('sum(turns) by (runtime)')}>
        run
      </button>
    </p>
  );

  it('switches between Overview and Query by address', async () => {
    const went: string[] = [];
    const renderer = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        machines={MACHINES}
        onNavigate={to => went.push(to)}
        requestAnalytics={fleet()}
        now={NOW}
        initialQuery={null}
        QueryPage={QueryStub}
      />,
    );
    await settle();
    expect(renderer.root.findByProps({ 'aria-label': 'Global analytics' }).props['data-daemon']).toBe('daemon-a');
    await choose(renderer, 'analytics-view', 'query');
    await choose(renderer, 'analytics-view', 'overview');
    expect(went).toEqual(['/d/daemon-a/analytics/query', '/d/daemon-a/analytics']);
  });

  it('mounts the Query page with every machine and the query a link brought', () => {
    window.history.replaceState({}, '', '/d/daemon-a/analytics/query?q=sum(cost_usd)%20by%20(model)');
    const renderer = mount(
      <GlobalAnalyticsPage connection={daemonA} view="query" onNavigate={() => {}} QueryPage={QueryStub} />,
    );
    expect(textOf(renderer.root.findByProps({ 'data-query-stub': '' }).children)).toStartWith(
      'daemon-a 1 sum(cost_usd) by (model) no-clock',
    );
    // A run is mirrored into the address, replacing rather than adding history.
    const depth = window.history.length;
    run(() => renderer.root.findByProps({ 'data-run': '' }).props.onClick());
    expect(window.location.pathname + window.location.search).toBe(
      '/d/daemon-a/analytics/query?q=sum(turns)%20by%20(runtime)',
    );
    expect(window.history.length).toBe(depth);
    const heard: string[] = [];
    const injected = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        machines={MACHINES}
        view="query"
        onNavigate={() => {}}
        now={NOW}
        initialQuery={null}
        onQueryChange={query => heard.push(query)}
        QueryPage={QueryStub}
      />,
    );
    expect(textOf(injected.root.findByProps({ 'data-query-stub': '' }).children)).toStartWith('daemon-a 2 none clock');
    run(() => injected.root.findByProps({ 'data-run': '' }).props.onClick());
    expect(heard).toEqual(['sum(turns) by (runtime)']);
    window.history.replaceState({}, '', '/');
  });

  it('reads this machine alone by default, through the plain network outside a store', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(rawResponse([])), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const renderer = mount(<GlobalAnalyticsPage connection={daemonA} onNavigate={() => {}} now={NOW} initialQuery={null} />);
      await settle();
      expect(seen.length).toBeGreaterThan(0);
      expect(text(renderer)).toContain('this machine');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('replaces a query link to the Overview address with the Query address', () => {
    window.history.replaceState({}, '', '/d/daemon-a/analytics?q=count%20by%20(status)');
    let popped = 0;
    const onPop = () => {
      popped += 1;
    };
    window.addEventListener('popstate', onPop);
    try {
      const renderer = mount(<GlobalAnalyticsPage connection={daemonA} onNavigate={() => {}} QueryPage={QueryStub} />);
      expect(renderer.toJSON()).toBeNull();
      expect(window.location.pathname + window.location.search).toBe('/d/daemon-a/analytics/query?q=count%20by%20(status)');
      expect(popped).toBe(1);
    } finally {
      window.removeEventListener('popstate', onPop);
      window.history.replaceState({}, '', '/');
    }
  });

  it('asks every machine for a query, names who did not answer and links rows to their machine', async () => {
    let href: ((row: { readonly id: string; readonly machine: string | null }) => string) | undefined;
    const FleetQuery = (props: {
      readonly connection: DaemonConnection;
      readonly requestAnalytics?: AnalyticsRequest;
      readonly sessionHref?: (row: { readonly id: string; readonly machine: string | null }) => string;
    }) => {
      href = props.sessionHref;
      return (
        <button
          type="button"
          data-ask=""
          onClick={() => void props.requestAnalytics?.(props.connection, '{}').catch(() => {})}
        >
          ask
        </button>
      );
    };
    const renderer = mount(
      <GlobalAnalyticsPage
        connection={daemonA}
        machines={MACHINES}
        view="query"
        onNavigate={() => {}}
        initialQuery={null}
        requestAnalytics={async (daemon, query) => {
          if (daemon.daemonId === 'daemon-b') throw new Error('asleep');
          return rawResponse(FLEET_A, query);
        }}
        QueryPage={FleetQuery as never}
      />,
    );
    await runAsync(async () => {
      renderer.root.findByProps({ 'data-ask': '' }).props.onClick();
      await Promise.resolve();
    });
    await settle();
    expect(text(renderer)).toContain('kirin-box did not answer: asleep Its sessions are not in this result.');
    expect(href?.({ id: 'x', machine: 'kirin-box' })).toBe('/d/daemon-b/session/x');
    expect(href?.({ id: 'y', machine: null })).toBe('/d/daemon-a/session/y');
  });

  it('reads the query a link brought', () => {
    expect(analyticsLinkQuery('?q=sum+by+%28model%29')).toBe('sum by (model)');
    expect(analyticsLinkQuery('')).toBeNull();
  });
});
