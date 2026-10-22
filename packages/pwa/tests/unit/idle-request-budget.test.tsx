/**
 * THE IDLE APP'S REQUEST BUDGET, HELD IN CI.
 *
 * "It is always lagging" was, in part, an app that never stopped asking: measured over the relay with
 * the owner's fleet (2 machines, 36 sessions, 5 working) and nothing touched, the fleet page sent 14
 * requests a minute and a session page 53. Each is a metered round trip on a phone a relay away, and
 * most of them re-asked a question nothing had changed the answer to. This suite mounts the real shell
 * on that fleet and leaves it alone for ten simulated minutes, and fails if it asks more than:
 *
 *   fleet page    {@link FLEET_PAGE_BUDGET} requests a minute
 *   session page  {@link SESSION_PAGE_BUDGET} requests a minute
 *
 * printing what it did ask, route by route, so the failure says which poller came back.
 *
 * WHAT IS REAL. The store, the carrier router and its sealed sessions to two in-memory daemons, every
 * poller, store and hook the shell mounts, and their timers — Bun's fake timers, advanced a second at a
 * time, with the real event loop let run between steps so the sessions' WebCrypto settles. The typed
 * client is a fake that counts every call by route, like the shell suite's; every other daemon read
 * crosses the carrier and is counted where the in-memory daemon answers it. The session's live feed
 * proves itself every thirty seconds, as the daemon's does.
 *
 * WHAT IS COUNTED is the steady state: thirty seconds are let pass first, so the opening reads (one of
 * everything) and the feed's first proof are behind it. Opening a page is not idling on it.
 */

import { afterAll, beforeAll, describe, it, jest } from 'bun:test';
import type { FyEvent, FyEventStreamIdle, SessionView } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import { act } from 'react';
import should from 'should';
import { AppShell } from '../../src/App.tsx';
import { CARRIER_PREFERENCE_KEY, CarrierPreferenceStore } from '../../src/lib/carrier-preference.ts';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonId, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { routePattern } from '../../src/lib/performance/route-pattern.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { resetSidePaneTabsStates } from '../../src/shell/side-pane-tab-model.ts';
import { MemoryDeviceKeyStore } from '../support/device-keys.ts';
import { mount } from '../support/dom.ts';
import { fetcherDaemons, newDaemonIdentity, relayCrypto, testDevice } from '../support/relay.ts';
import { sessionView } from '../support/sessions.ts';

/** Requests a minute an idle fleet page may send. */
const FLEET_PAGE_BUDGET = 6;
/** Requests a minute an idle session page may send. */
const SESSION_PAGE_BUDGET = 10;

const WARM_UP_MS = 30_000;
const IDLE_MS = 10 * 60_000;
const STEP_MS = 1_000;
/** The daemon's quiet-feed proof (`EVENT_STREAM_IDLE_MS`). */
const FEED_IDLE_PROOF_MS = 30_000;

const ALPHA_IDENTITY = await newDaemonIdentity();
const BETA_IDENTITY = await newDaemonIdentity();
const DEVICE_KEY = (await testDevice()).privateKey;
const alpha = daemonConnection({
  daemonId: ALPHA_IDENTITY.daemonId,
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alphaDevice00000000001',
});
const beta = daemonConnection({
  daemonId: BETA_IDENTITY.daemonId,
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_betaDevice000000000001',
});

/** Eighteen sessions on a machine, the first `working` of them mid-turn and the rest at their prompt. */
const machineFleet = (prefix: string, working: number): readonly SessionView[] =>
  Array.from({ length: 18 }, (_, index) =>
    sessionView(`fy_s_${prefix}${String(index).padStart(16, '0')}`, {
      config: { name: `${prefix} agent ${String(index + 1)}` },
      state: { status: 'running', turnState: index < working ? 'working' : 'your-turn' },
      journalSequence: 100,
    }),
  );
const FLEETS = new Map([
  [alpha.daemonId, machineFleet('alpha', 3)],
  [beta.daemonId, machineFleet('beta', 2)],
]);

class MemoryRepository implements DaemonConnectionRepository {
  readonly #values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }
}

/** Every request a daemon was asked, by `METHOD route`. */
class RouteCounter {
  readonly counts = new Map<string, number>();
  add(route: string): void {
    this.counts.set(route, (this.counts.get(route) ?? 0) + 1);
  }
  reset(): void {
    this.counts.clear();
  }
  total(): number {
    return [...this.counts].filter(([route]) => !route.startsWith('STREAM')).reduce((sum, [, n]) => sum + n, 0);
  }
  table(minutes: number): string {
    return [...this.counts]
      .sort((left, right) => right[1] - left[1])
      .map(([route, n]) => `  ${route.padEnd(56)} ${String(n).padStart(4)}  (${(n / minutes).toFixed(1)}/min)`)
      .join('\n');
  }
}

/** The typed client a machine is read through: a fake that counts each call by the route it stands for. */
const countingClient = (daemonId: DaemonId, counter: RouteCounter): FyApiClient => {
  const fleet = FLEETS.get(daemonId) ?? [];
  const known: Record<string, unknown> = {
    list: async () => {
      counter.add('GET /v1/sessions');
      return fleet;
    },
    get: async (sessionId: string) => {
      counter.add('GET /v1/sessions/:id');
      return fleet.find(view => view.config.id === sessionId) ?? sessionView(sessionId);
    },
    logs: async () => {
      counter.add('GET /v1/sessions/:id/logs');
      return '';
    },
    wardenStatus: async () => {
      counter.add('GET /v1/warden/status');
      throw new Error('no warden in this fixture');
    },
    configChanges: async (_onFrame: unknown, signal?: AbortSignal) => {
      counter.add('STREAM /v1/events?topic=config');
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    },
    // The session's live feed: open until cancelled, proving itself every thirty seconds like the daemon.
    stream: async (
      sessionId: string | undefined,
      _after: number,
      _onEvent: (event: FyEvent) => void,
      signal?: AbortSignal,
      onIdle?: (frame: FyEventStreamIdle) => void,
    ) => {
      counter.add('STREAM /v1/events');
      const proof = setInterval(
        () =>
          onIdle?.({
            kind: 'idle',
            idleSeconds: FEED_IDLE_PROOF_MS / 1_000,
            scope: { kind: 'session', sessionId: sessionId ?? '', after: 100 },
          }),
        FEED_IDLE_PROOF_MS,
      );
      await new Promise<void>(resolve =>
        signal?.addEventListener(
          'abort',
          () => {
            clearInterval(proof);
            resolve();
          },
          { once: true },
        ),
      );
    },
    request: async (path: string, _schema: unknown, init?: RequestInit) => {
      counter.add(routePattern(init?.method ?? 'GET', path));
      return {};
    },
  };
  // A call to anything else is a request this fixture does not answer: counted, so it cannot hide.
  return new Proxy(known, {
    get: (target, property) =>
      property in target || typeof property !== 'string' || property === 'then'
        ? target[property as string]
        : async () => {
            counter.add(`client.${property}`);
            throw new Error(`the fixture does not answer ${property}`);
          },
  }) as unknown as FyApiClient;
};

const openShell = async (path: string, counter: RouteCounter) => {
  const deviceKeys = new MemoryDeviceKeyStore();
  for (const id of [alpha.daemonId, beta.daemonId]) await deviceKeys.save(id, DEVICE_KEY);
  // Everything that is not the typed client crosses the carrier and lands here, once per request.
  const daemonFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    counter.add(routePattern(init?.method ?? 'GET', url.toString()));
    const attention = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attention$/u)?.[1];
    if (attention !== undefined)
      return Response.json({
        v: 1,
        sessionId: decodeURIComponent(attention),
        items: [],
        resolved: [],
        count: 0,
        parseErrors: 0,
        updatedAt: '2026-10-21T00:00:00.000Z',
      });
    if (url.pathname === '/v1/usage') return Response.json({ stale: false, accounts: [] });
    if (url.pathname === '/v1/learning/sessions') return Response.json([]);
    if (url.pathname.endsWith('/terminals')) return Response.json({ sessionId: 'shared', terminals: [] });
    return Response.json({});
  };
  const network = fetcherDaemons(
    [
      { host: 'alpha.example.test', identity: ALPHA_IDENTITY, answersHeartbeats: true },
      { host: 'beta.example.test', identity: BETA_IDENTITY, answersHeartbeats: true },
    ],
    daemonFetch,
  );
  const stored = new Map([
    [CARRIER_PREFERENCE_KEY, JSON.stringify({ [alpha.daemonId]: 'auto', [beta.daemonId]: 'auto' })],
  ]);
  const store = await createAppStore({
    repository: new MemoryRepository(),
    carrierPreferences: new CarrierPreferenceStore({
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
    }),
    sessionCacheBackend: null,
    scrollMemoryStorage: null,
    connectionSignals: { listen: () => () => undefined },
    connectClient: async connection => countingClient(connection.daemonId, counter),
    deviceKeys,
    relayCrypto,
    relayDial: network.dial,
    fetcher: daemonFetch,
    longTasks: { supported: false, observe: () => () => undefined },
  });
  store.controls.setDeviceControls({ sessionsMode: 'all' });
  store.connections.add(alpha, { pairedAt: 1 });
  store.connections.add(beta, { pairedAt: 2 });
  window.history.replaceState({}, '', path);
  return await mount(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
};

/** Real event-loop turns, which fake timers leave alone: what a sealed session's WebCrypto settles on. */
const turns = async (count: number): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1) await new Promise(resolve => setImmediate(resolve));
};

/** Moves the fake clock by `milliseconds`, a second at a time, letting the app's work land after each. */
const idle = async (milliseconds: number): Promise<void> => {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += STEP_MS)
    await act(async () => {
      jest.advanceTimersByTime(STEP_MS);
      await turns(8);
    });
};

/** Opens `path`, lets it settle, idles ten minutes and answers the counter and the rate. */
const measure = async (path: string): Promise<{ readonly counter: RouteCounter; readonly perMinute: number }> => {
  const counter = new RouteCounter();
  const view = await openShell(path, counter);
  try {
    await act(async () => {
      await turns(40);
    });
    await idle(WARM_UP_MS);
    counter.reset();
    await idle(IDLE_MS);
    return { counter, perMinute: counter.total() / (IDLE_MS / 60_000) };
  } finally {
    await view.unmount();
  }
};

const verdict = (page: string, measured: { readonly counter: RouteCounter; readonly perMinute: number }): string =>
  `${page}: ${measured.perMinute.toFixed(1)} requests/min over ${String(IDLE_MS / 60_000)} idle minutes\n` +
  measured.counter.table(IDLE_MS / 60_000);

describe('the idle request budget', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });
  afterAll(() => {
    jest.useRealTimers();
    window.history.replaceState({}, '', '/');
    localStorage.clear();
    resetSidePaneTabsStates();
  });

  it(`should keep an idle fleet page to ${String(FLEET_PAGE_BUDGET)} requests a minute`, async () => {
    // Act
    const measured = await measure(`/d/${alpha.daemonId}`);

    // Assert
    console.info(verdict('fleet page', measured));
    should(measured.perMinute).be.belowOrEqual(FLEET_PAGE_BUDGET, verdict('fleet page', measured));
    should(measured.counter.counts.get('GET /v1/sessions') ?? 0).be.above(0);
  }, 120_000);

  it(`should keep an idle session page to ${String(SESSION_PAGE_BUDGET)} requests a minute`, async () => {
    // Arrange — a session at its prompt, on the machine on screen.
    const session = FLEETS.get(alpha.daemonId)?.[5]?.config.id ?? '';

    // Act
    const measured = await measure(`/d/${alpha.daemonId}/session/${session}`);

    // Assert — the feed was opened and stayed open: one subscription, never a reconnection storm.
    console.info(verdict('session page', measured));
    should(measured.perMinute).be.belowOrEqual(SESSION_PAGE_BUDGET, verdict('session page', measured));
    should(measured.counter.counts.get('GET /v1/sessions/:id/logs') ?? 0).be.above(0);
  }, 120_000);
});
