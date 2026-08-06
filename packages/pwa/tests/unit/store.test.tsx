import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import { useState } from 'react';
import { HOSTED_RELAY_PATH } from '../../src/features/onboarding/hosted-relay.ts';
import type { DaemonConnectionRepository, DaemonConnectionStore } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  type AppStore,
  browserConnectionRepository,
  createAppStore,
  DaemonApiPool,
  exchangePairing,
  IndexedDbConnectionRepository,
  StoreProvider,
  useAppStore,
  useConnectionSnapshot,
} from '../../src/lib/store.tsx';
import { interact, mount, must } from '../support/dom.ts';
import { autoDial, newDaemonIdentity, relayCrypto, settle as settleTasks } from '../support/relay.ts';

const RELAY_DIRECTORY = 'https://directory.example.test';
const HOSTED_RELAY_URL = 'https://hosted-relay.example.test';

/**
 * The relay directory is a BUILD constant, replaced by `vite.config.ts` from
 * `FY_RELAY_DIRECTORY_ORIGIN`, so a case that needs one supplies it as a global for as long as the
 * store is being opened — which is when the one read per document happens.
 */
const withRelayDirectory = async <T,>(value: string, body: () => Promise<T>): Promise<T> => {
  const host = globalThis as Record<string, unknown>;
  const had = '__FY_RELAY_DIRECTORY__' in host;
  const previous = host.__FY_RELAY_DIRECTORY__;
  host.__FY_RELAY_DIRECTORY__ = value;
  try {
    return await body();
  } finally {
    if (had) host.__FY_RELAY_DIRECTORY__ = previous;
    else delete host.__FY_RELAY_DIRECTORY__;
  }
};

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const client = (name: string): FyApiClient => ({ name }) as unknown as FyApiClient;

describe('DaemonApiPool', () => {
  it('shares one client only for the exact live pairing', async () => {
    const calls: string[] = [];
    const pool = new DaemonApiPool(async daemon => {
      calls.push(`${daemon.daemonId}:${daemon.baseUrl}`);
      return client(daemon.baseUrl);
    });

    const first = pool.client(alpha);
    expect(pool.client({ ...alpha })).toBe(first);
    expect(pool.client(beta)).not.toBe(first);

    const moved = daemonConnection({ ...alpha, baseUrl: 'https://alpha-moved.example.test' });
    expect(pool.client(moved)).not.toBe(first);
    await Promise.all([first, pool.client(beta), pool.client(moved)]);
    expect(calls).toEqual([
      'alpha:https://alpha.example.test',
      'beta:https://beta.example.test',
      'alpha:https://alpha-moved.example.test',
    ]);
  });

  it('retries a failed connection and forgets only the cleared daemon', async () => {
    let attempts = 0;
    const pool = new DaemonApiPool(async daemon => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return client(daemon.daemonId);
    });

    await expect(pool.client(alpha)).rejects.toThrow('offline');
    const recovered = pool.client(alpha);
    await recovered;
    pool.client(beta);
    pool.clearDaemon(alpha.daemonId);

    expect(pool.client(alpha)).not.toBe(recovered);
    expect(attempts).toBe(4);
  });
});

describe('exchangePairing', () => {
  it('posts the single-use code only to the reader-supplied daemon and validates its identity', async () => {
    const daemonId = `fy_daemon_${'d'.repeat(43)}`;
    const deviceToken = `fy_device_${'t'.repeat(43)}`;
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const connection = await exchangePairing(
      { daemonUrl: 'https://daemon.example.test', daemonId, code: 'one-time-code' },
      async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({
          daemonId,
          deviceToken,
          daemonName: 'workstation',
          capabilities: [],
          carriers: [
            { kind: 'relay', url: 'https://relay.example.test' },
            { kind: 'direct', url: 'https://daemon.example.test' },
          ],
        });
      },
    );

    expect(String(connection.daemonId)).toBe(daemonId);
    expect(connection.baseUrl).toBe('https://daemon.example.test');
    expect(connection.deviceToken).toBe(deviceToken);
    expect(connection.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
      { kind: 'relay', relayUrl: 'https://relay.example.test', operator: 'self' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://daemon.example.test/v1/pair');
    expect(requests[0]?.init?.credentials).toBe('omit');
    expect(requests[0]?.init?.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      code: 'one-time-code',
      deviceName: 'Ferretry PWA',
    });
  });

  it('fails closed on a daemon error, malformed response, or fingerprint mismatch', async () => {
    const daemonId = `fy_daemon_${'d'.repeat(43)}`;
    const seed = { daemonUrl: 'https://daemon.example.test', daemonId, code: 'code' };

    await expect(
      exchangePairing(seed, async () => Response.json({ error: 'expired' }, { status: 410 })),
    ).rejects.toThrow('expired');
    await expect(exchangePairing(seed, async () => Response.json({ daemonId: 3 }))).rejects.toThrow(
      'invalid pairing response',
    );
    await expect(
      exchangePairing(seed, async () =>
        Response.json({
          daemonId: `fy_daemon_${'o'.repeat(43)}`,
          deviceToken: `fy_device_${'t'.repeat(43)}`,
          daemonName: 'other',
          capabilities: [],
          carriers: [],
        }),
      ),
    ).rejects.toThrow('does not match its fingerprint');
  });

  /*
   * A RUNTIME WITHOUT `AbortSignal.timeout` USED TO PAIR WITH NOTHING. The unguarded static call
   * threw a `TypeError` before `fetcher` was reached, the catch read it as direct-unreachable, and a
   * v1/direct-only link — which has no rendezvous to fall back to — reported that programming error
   * as the transport verdict. The fallback controller path must still contact a reachable direct
   * daemon, and the static is restored in `finally` so a thrown assertion cannot leak the absence
   * into a later case.
   */
  it('pairs directly even when the runtime omits AbortSignal.timeout', async () => {
    const daemonId = `fy_daemon_${'d'.repeat(43)}`;
    const nativeTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    const requests: string[] = [];
    try {
      const connection = await exchangePairing(
        { daemonUrl: 'https://daemon.example.test', daemonId, code: 'one-time-code' },
        async input => {
          requests.push(String(input));
          return Response.json({
            daemonId,
            deviceToken: `fy_device_${'t'.repeat(43)}`,
            daemonName: 'workstation',
            capabilities: [],
            carriers: [{ kind: 'direct', url: 'https://daemon.example.test' }],
          });
        },
      );

      // THE DIRECT DAEMON WAS CALLED — the missing static no longer prevents the fetch — and the
      // walk's first leg paired, so no rendezvous was spent.
      expect(requests).toEqual(['https://daemon.example.test/v1/pair']);
      expect(String(connection.daemonId)).toBe(daemonId);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        value: nativeTimeout,
        configurable: true,
        writable: true,
      });
    }
    expect(typeof AbortSignal.timeout).toBe('function');
  });

  /*
   * THE FALLBACK TIMER, NOT THE NATIVE STATIC, IS WHAT HAS TO DEADLINE A HUNG DIRECT FETCH. A
   * blackholed address never rejects on its own, so the fallback controller's timer firing at the
   * injected short deadline is what classifies direct as unreachable and hands the same single-use
   * code to the rendezvous. The static is removed to force the controller path; the relay leg is a
   * scripted daemon that seals a real redemption, so the case proves the whole walk rather than a
   * mock of it.
   */
  it('aborts a hung direct fetch at the injected deadline over the fallback timer and pairs over the relay', async () => {
    const identity = await newDaemonIdentity();
    const RELAY = 'wss://relay.mine.test';
    const response = {
      deviceToken: `fy_device_${'t'.repeat(43)}`,
      daemonId: identity.daemonId,
      daemonName: 'Studio',
      capabilities: [],
      carriers: [{ kind: 'relay', url: RELAY }],
    };
    const auto = autoDial(identity, { paired: response });
    const nativeTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    const directStarted = Date.now();
    let abortedAt: number | undefined;
    try {
      const connection = await exchangePairing(
        {
          daemonUrl: 'https://studio.example',
          daemonId: identity.daemonId,
          code: '7F3K-Q2ND',
          relay: { kind: 'relay', relayUrl: RELAY },
        },
        {
          fetcher: async (_input, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  abortedAt = Date.now() - directStarted;
                  reject(new DOMException('the direct fetch was aborted', 'AbortError'));
                },
                { once: true },
              );
            }),
          relayCrypto,
          relayDial: auto.dial,
          directTimeoutMs: 20,
        },
      );

      // The walk moved past the aborted direct leg and redeemed the same code over the rendezvous,
      // which is §1's direct-first walk when direct does not answer.
      expect(String(connection.daemonId)).toBe(identity.daemonId);
      const pairRequest = auto.requests[0] as { t: string; code: string; deviceName: string };
      expect(pairRequest.t).toBe('pair');
      expect(pairRequest.code).toBe('7F3K-Q2ND');
      expect(pairRequest.deviceName).toBe('Ferretry PWA');
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        value: nativeTimeout,
        configurable: true,
        writable: true,
      });
    }

    // THE TIMER FIRED AT THE INJECTED ~20ms, not the four-second default, so the hung fetch was
    // classified unreachable and the relay leg ran well inside the code's two-minute life.
    expect(abortedAt).toBeGreaterThanOrEqual(10);
    expect(abortedAt).toBeLessThan(1000);
  });

  /*
   * NO TIMER SURVIVES A SETTLED DIRECT FETCH. The native static owns an internal timer no `clear()`
   * reaches, so this case forces the controller path and then reads the signal the fetcher received:
   * had the fallback timer not been cleared in the direct fetch's `finally`, it would have aborted
   * that signal well inside the wait below. An un-aborted signal past the deadline is the proof, not
   * an assertion against a mock. The static is restored in `finally` — the same shape every
   * monkeypatch in this file follows — which is the guarantee that a thrown assertion restores it.
   */
  it('clears the fallback timer once a direct fetch settles, and restores the static it stubbed', async () => {
    const daemonId = `fy_daemon_${'d'.repeat(43)}`;
    const success = Response.json({
      daemonId,
      deviceToken: `fy_device_${'t'.repeat(43)}`,
      daemonName: 'workstation',
      capabilities: [],
      carriers: [{ kind: 'direct', url: 'https://daemon.example.test' }],
    });
    const nativeTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    let directSignal: AbortSignal | undefined;
    try {
      const connection = await exchangePairing(
        { daemonUrl: 'https://daemon.example.test', daemonId, code: 'code' },
        {
          fetcher: async (_input, init) => {
            directSignal = init?.signal ?? undefined;
            return success;
          },
          directTimeoutMs: 30,
        },
      );
      expect(String(connection.daemonId)).toBe(daemonId);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        value: nativeTimeout,
        configurable: true,
        writable: true,
      });
    }

    // Had `clear()` not run, the 30ms fallback timer would have aborted this signal inside the wait.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(directSignal?.aborted).toBe(false);
    expect(typeof AbortSignal.timeout).toBe('function');
  });
});

interface FakeRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
}

const fakeRequest = <T,>(result: T): FakeRequest<T> => ({
  result,
  error: null,
  onsuccess: null,
  onerror: null,
  onblocked: null,
  onupgradeneeded: null,
});

const fakeIndexedDb = (): IDBFactory => {
  const values = new Map<IDBValidKey, unknown>();
  const stores = new Set<string>();
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.add(name),
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({
          get: (key: IDBValidKey) => {
            const request = fakeRequest(values.get(key));
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put: (value: unknown, key: IDBValidKey) => {
            values.set(key, value);
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
      };
      return transaction;
    },
  };
  return {
    open: () => {
      const request = fakeRequest(database);
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
};

describe('IndexedDbConnectionRepository', () => {
  it('stores and reloads the versioned registry value', async () => {
    const repository = new IndexedDbConnectionRepository(fakeIndexedDb(), 'test-pairings');
    expect(await repository.load('missing')).toBeNull();

    await repository.save('connections', '{"v":1}');

    expect(await repository.load('connections')).toBe('{"v":1}');
  });

  it('degrades to document-lifetime storage when IndexedDB is unavailable', () => {
    expect(browserConnectionRepository(undefined)).toBeUndefined();
  });
});

function StoreProbe() {
  const store = useAppStore();
  const snapshot = useConnectionSnapshot();
  return (
    <button type="button" onClick={() => store.connections.add(alpha)}>
      {snapshot.selectedDaemonId ?? 'unpaired'}
    </button>
  );
}

/** Re-renders itself on demand without touching the connection store. */
function RenderCountProbe() {
  const snapshot = useConnectionSnapshot();
  const [renders, setRenders] = useState(0);
  return (
    <button type="button" onClick={() => setRenders(count => count + 1)}>
      {snapshot.selectedDaemonId ?? 'unpaired'}:{renders}
    </button>
  );
}

interface Gate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

/** An open the test finishes by hand, so the opening state can be observed. */
const gate = <T,>(): Gate<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

/** Flushes the promise hops between settling an open and its committed render. */
const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

interface SubscriptionLog {
  subscribes: number;
  unsubscribes: number;
}

/** Counts real subscriptions by shadowing the instance's prototype method. */
const countSubscriptions = (connections: DaemonConnectionStore): SubscriptionLog => {
  const log: SubscriptionLog = { subscribes: 0, unsubscribes: 0 };
  const subscribe = connections.subscribe.bind(connections);
  Object.defineProperty(connections, 'subscribe', {
    configurable: true,
    value: (listener: () => void) => {
      log.subscribes += 1;
      const unsubscribe = subscribe(listener);
      return () => {
        log.unsubscribes += 1;
        unsubscribe();
      };
    },
  });
  return log;
};

const memoryStore = async (): Promise<AppStore> =>
  await createAppStore({
    repository: new MemoryRepository(),
    connectClient: async () => client('unused'),
    fetcher: async () => Response.json({}),
  });

describe('StoreProvider', () => {
  it('invalidates notification preferences and push devices for only the removed daemon', async () => {
    const store = await memoryStore();
    store.connections.add(alpha);
    store.connections.add(beta);
    store.notificationPreferences.set(alpha.daemonId, { enabled: true });
    store.notificationPreferences.set(beta.daemonId, { enabled: true });
    store.pushDevices.remember(alpha.daemonId, 'alpha-device');
    store.pushDevices.remember(beta.daemonId, 'beta-device');

    store.connections.remove(alpha.daemonId);

    expect(store.notificationPreferences.get(alpha.daemonId).enabled).toBe(false);
    expect(store.pushDevices.get(alpha.daemonId)).toBeNull();
    expect(store.notificationPreferences.get(beta.daemonId).enabled).toBe(true);
    expect(store.pushDevices.get(beta.daemonId)).toBe('beta-device');
  });

  it('reaches the daemon push API through the injected fetcher, never the global one', async () => {
    const requests: string[] = [];
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('the store reached the global fetch');
    }) as unknown as typeof fetch;

    try {
      const store = await createAppStore({
        repository: new MemoryRepository(),
        connectClient: async () => client('unused'),
        fetcher: async input => {
          requests.push(String(input));
          return Response.json({ devices: [] });
        },
      });

      expect(await store.pushService.list(alpha)).toEqual([]);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(requests).toEqual(['https://alpha.example.test/v1/push/subscriptions']);
  });

  /**
   * THE CASE EVERY OTHER TEST IN THIS FILE IS BLIND TO, BECAUSE THEY ALL INJECT.
   *
   * `createAppStore` is where the shipped `Illegal invocation` came from: the root
   * wrote `options.fetcher ?? fetch` and handed that bare builtin to the carrier
   * router, which stores it and invokes it as a member. A suite that passes its own
   * `fetcher` never runs that line, and an injected plain function does not care what
   * its receiver is — so the whole product could not connect while this file was
   * green.
   *
   * This test therefore injects NOTHING and makes the global itself
   * receiver-sensitive. The router must reach it as the global's own method, never
   * with the router as the receiver. On main the recorded receiver is the
   * `DaemonCarrierRouter` instance, which is precisely what a real browser refuses.
   */
  it('reaches the real network without making the carrier router its receiver', async () => {
    const receivers: unknown[] = [];
    const globalFetch = globalThis.fetch;
    // Deliberately not an arrow: an arrow has no receiver to be wrong about, which is
    // exactly why the existing injected-fetcher cases could not see this.
    globalThis.fetch = function (this: unknown): Promise<Response> {
      receivers.push(this);
      return Promise.resolve(Response.json({}));
    } as unknown as typeof fetch;

    try {
      const store = await createAppStore({
        repository: new MemoryRepository(),
        connectClient: async () => client('unused'),
      });
      store.connections.add(alpha);
      await store.carrier.fetch(`${alpha.baseUrl}/v1/projects`);
    } finally {
      globalThis.fetch = globalFetch;
    }

    expect(receivers.length).toBeGreaterThan(0);
    for (const receiver of receivers) expect(receiver).toBe(globalThis);
  });

  /**
   * TWO ANSWERS TO ONE QUESTION IS ONE ANSWER TOO MANY.
   *
   * The typed client used to build its own transport, which dialled the daemon's own
   * address directly and knew nothing about the carrier router. So Settings could
   * show a green "Reachable" pill — a typed-client health request — beside a Carrier
   * panel saying no connection worked, and both were telling the truth about
   * different code. The probe also could not see a daemon that was only reachable
   * through the relay, and reported it down.
   *
   * There is one path now, so the request the typed client makes is a request the
   * carrier router carried.
   */
  it('sends the typed client over the carrier rather than its own direct transport', async () => {
    const requests: string[] = [];
    const store = await createAppStore({
      repository: new MemoryRepository(),
      fetcher: async input => {
        requests.push(String(input));
        return String(input).endsWith('/v1/carriers')
          ? Response.json({ carriers: [{ kind: 'direct', url: 'https://alpha.example.test' }] })
          : Response.json([]);
      },
    });
    store.connections.add(alpha);

    await (await store.clients.client(alpha)).list();

    expect(requests).toEqual(['https://alpha.example.test/v1/sessions', 'https://alpha.example.test/v1/carriers']);
    // And the router recorded it as a measurement, which is the whole point: the
    // probe and the Carrier panel are now reading one answer.
    expect(store.carrier.choice(alpha.daemonId)?.ok).toBe(true);
  });

  it('replaces the cached carrier set from the authenticated daemon view after connecting', async () => {
    const daemon = daemonConnection({
      daemonId: `fy_daemon_${'d'.repeat(43)}`,
      baseUrl: 'https://daemon.example.test',
      deviceToken: `fy_device_${'t'.repeat(43)}`,
      carriers: [
        { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
        { kind: 'relay', relayUrl: 'https://stale.example.test' },
      ],
    });
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const store = await createAppStore({
      repository: new MemoryRepository(),
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (String(input).endsWith('/v1/carriers')) {
          return Response.json({
            carriers: [
              { kind: 'direct', url: 'https://daemon.example.test' },
              { kind: 'relay', url: 'https://relay-one.example.test' },
              { kind: 'relay', url: 'https://relay-two.example.test' },
            ],
          });
        }
        return Response.json({ ok: true });
      },
    });
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(requests.map(request => request.url)).toEqual([
      'https://daemon.example.test/v1/projects',
      'https://daemon.example.test/v1/carriers',
    ]);
    expect(requests[1]?.authorization).toBe(`Bearer ${daemon.deviceToken}`);
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
      { kind: 'relay', relayUrl: 'https://relay-one.example.test', operator: 'self' },
      { kind: 'relay', relayUrl: 'https://relay-two.example.test', operator: 'self' },
    ]);
  });

  it('does not let an old pairing refresh replace a re-paired daemon cache', async () => {
    const daemon = daemonConnection({
      daemonId: `fy_daemon_${'d'.repeat(43)}`,
      baseUrl: 'https://daemon.example.test',
      deviceToken: `fy_device_${'o'.repeat(43)}`,
      carriers: [
        { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
        { kind: 'relay', relayUrl: 'https://old-relay.example.test' },
      ],
    });
    const repaired = daemonConnection({
      ...daemon,
      deviceToken: `fy_device_${'n'.repeat(43)}`,
      carriers: [
        { kind: 'direct', daemonUrl: 'https://daemon.example.test' },
        { kind: 'relay', relayUrl: 'https://new-relay.example.test' },
      ],
    });
    let refreshRequested!: () => void;
    const requested = new Promise<void>(resolve => {
      refreshRequested = resolve;
    });
    let releaseRefresh!: (response: Response) => void;
    const delayedRefresh = new Promise<Response>(resolve => {
      releaseRefresh = resolve;
    });
    const store = await createAppStore({
      repository: new MemoryRepository(),
      fetcher: async input => {
        if (String(input).endsWith('/v1/carriers')) {
          refreshRequested();
          return await delayedRefresh;
        }
        return Response.json({ ok: true });
      },
    });
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await requested;
    store.connections.remove(daemon.daemonId);
    store.connections.add(repaired);
    releaseRefresh(
      Response.json({
        carriers: [
          { kind: 'direct', url: 'https://daemon.example.test' },
          { kind: 'relay', url: 'https://stale-relay.example.test' },
        ],
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual(repaired.carriers);
  });

  /**
   * THE PAIRING THAT PREDATES THE CARRIER SET, THROUGH THE REAL COMPOSITION ROOT.
   *
   * Such a record names one address — the direct one it was paired over — because the relay it was
   * actually reached over away from that network came from the hosted advertisement and was never
   * stored. A daemon too old to answer `GET /v1/carriers` cannot replace that, so the browser has to
   * be able to DIAL the current advertised address without ever adopting it: adopted, it would
   * outlive the advertisement that produced it, which is the kill switch not working.
   *
   * What this case owns is the WIRING — that the one advertisement read this document performs is the
   * address the router dials, for the right daemon, at the right rendezvous path, and that nothing
   * about it is written down. The dial refuses on purpose: whether a session then works is
   * `relay-carrier`'s subject and is covered there.
   */
  it('dials the advertised rendezvous for a daemon that published none, and stores nothing about it', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: 'https://old.example.test',
      deviceToken: `fy_device_${'t'.repeat(43)}`,
    });
    const repository = new MemoryRepository();
    const dialled: string[] = [];
    const direct: string[] = [];
    const fetcher = (relayUrl: string | null) => async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${RELAY_DIRECTORY}${HOSTED_RELAY_PATH}`) return Response.json({ version: 1, relayUrl });
      direct.push(url);
      throw new TypeError('Failed to fetch');
    };
    const refusingDial = (url: string): never => {
      dialled.push(url);
      throw new Error('this rendezvous refused the socket');
    };
    const store = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({ repository, relayCrypto, relayDial: refusingDial, fetcher: fetcher(HOSTED_RELAY_URL) }),
    );
    store.connections.add(daemon);

    await expect(store.carrier.fetch(`${daemon.baseUrl}/v1/projects`)).rejects.toThrow(
      /No configured connection worked/u,
    );
    await settleTasks();

    // Direct was tried first and the advertised rendezvous second — for this daemon's fingerprint,
    // which is what a rendezvous is addressed by.
    expect(direct).toEqual(['https://old.example.test/v1/projects']);
    expect(dialled).toEqual([`wss://hosted-relay.example.test/v1/rendezvous/${identity.daemonId}/client`]);
    // Nothing was adopted: neither the live record nor the bytes on disk name a rendezvous, so a
    // withdrawn address is gone on the next load rather than remembered.
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://old.example.test' },
    ]);
    expect([...repository.values.values()].join('')).not.toContain(HOSTED_RELAY_URL);

    // THE KILL SWITCH, on the next document: `relayUrl: null` is an answer, not a failure, and it
    // leaves that same daemon with nothing but its own address to try.
    const withdrawn = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({ repository, relayCrypto, relayDial: refusingDial, fetcher: fetcher(null) }),
    );
    await expect(withdrawn.carrier.fetch(`${daemon.baseUrl}/v1/projects`)).rejects.toThrow(
      /No configured connection worked/u,
    );
    await settleTasks();

    expect(dialled).toHaveLength(1);
  });

  /**
   * A REFRESH THE DAEMON CANNOT ANSWER CHANGES NOTHING, AND ITS FIRST REAL ANSWER CHANGES EVERYTHING.
   *
   * `404` is what an older daemon says to `GET /v1/carriers`, and it must leave the known-working
   * cache exactly as it was — a refusal is not a published set. Once that daemon can answer, its
   * answer REPLACES the cache whole, which is the disagreement rule the route exists for.
   */
  it('leaves the cache alone when a refresh is refused and replaces it whole once the daemon answers', async () => {
    const daemonId = `fy_daemon_${'r'.repeat(43)}`;
    const daemon = daemonConnection({
      daemonId,
      baseUrl: 'https://box.example.test',
      deviceToken: `fy_device_${'t'.repeat(43)}`,
    });
    const repository = new MemoryRepository();
    const paths: string[] = [];
    // Mutable on purpose: one document watches the daemon it is paired to gain the route.
    let published: unknown = null;
    const store = await withRelayDirectory(RELAY_DIRECTORY, async () =>
      createAppStore({
        repository,
        fetcher: async input => {
          const url = String(input);
          if (url === `${RELAY_DIRECTORY}${HOSTED_RELAY_PATH}`) {
            return Response.json({ version: 1, relayUrl: HOSTED_RELAY_URL });
          }
          paths.push(new URL(url).pathname);
          if (!url.endsWith('/v1/carriers')) return Response.json({ ok: true });
          return published === null ? new Response('', { status: 404 }) : Response.json(published);
        },
      }),
    );
    store.connections.add(daemon);

    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await settleTasks();

    // The refresh really was attempted and really was refused, so what follows is a statement about
    // a 404 rather than about a request that had not happened yet.
    expect(paths).toEqual(['/v1/projects', '/v1/carriers']);
    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://box.example.test' },
    ]);
    expect([...repository.values.values()].join('')).not.toContain(HOSTED_RELAY_URL);

    // The daemon gains the route. Its own answer is adopted whole, and the rendezvous it names is
    // labelled hosted because it is the address this document discovered for itself.
    published = {
      carriers: [
        { kind: 'direct', url: 'https://box.example.test' },
        { kind: 'relay', url: HOSTED_RELAY_URL },
      ],
    };
    store.connections.remove(daemon.daemonId);
    store.connections.add(daemon);
    await store.carrier.fetch(`${daemon.baseUrl}/v1/projects`);
    await settleTasks();

    expect(store.connections.get(daemon.daemonId)?.carriers).toEqual([
      { kind: 'direct', daemonUrl: 'https://box.example.test' },
      { kind: 'relay', relayUrl: HOSTED_RELAY_URL, operator: 'hosted' },
    ]);
    expect([...repository.values.values()].join('')).toContain(HOSTED_RELAY_URL);
  });

  it('publishes a daemon-scoped store and reacts to runtime pairing changes', async () => {
    const store = await memoryStore();
    const view = await mount(
      <StoreProvider store={store}>
        <StoreProbe />
      </StoreProvider>,
    );

    expect(view.container.textContent).toBe('unpaired');
    await interact(() => view.container.querySelector('button')?.click());
    expect(view.container.textContent).toBe('alpha');
    await view.unmount();
  });

  it('keeps the public landing marker content-free and in sync with pairing changes', async () => {
    const values = new Map<string, string>();
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => client('unused'),
      fetcher: async () => Response.json({}),
      landingMarkerStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      },
    });

    store.connections.add(alpha);
    expect([...values.entries()]).toEqual([['fy-has-pairings-v1', '1']]);

    store.connections.remove(alpha.daemonId);
    expect([...values.entries()]).toEqual([]);
  });

  it('shows an honest local-state failure and rejects consumers outside the provider', async () => {
    const failure = await mount(
      <StoreProvider createStore={async () => Promise.reject(new Error('database denied'))}>
        <StoreProbe />
      </StoreProvider>,
    );
    await interact(async () => await Promise.resolve());
    expect(failure.container.textContent).toContain('database denied');
    await failure.unmount();

    await expect(mount(<StoreProbe />)).rejects.toThrow('useAppStore must be rendered inside StoreProvider');
  });

  it('recovers from a rejected open when the reader retries, without replaying the failure', async () => {
    const store = await memoryStore();
    let attempts = 0;
    const createStore = async (): Promise<AppStore> => {
      attempts += 1;
      if (attempts === 1) throw new Error('database denied');
      return store;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    await interact(async () => await Promise.resolve());
    expect(view.container.textContent).toContain('database denied');

    await interact(() => must(view.container.querySelector('button'), 'the retry button').click());
    await interact(async () => await Promise.resolve());

    expect(attempts).toBe(2);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');

    // The recovered store is the live one, not a snapshot taken before the retry.
    await interact(() => view.container.querySelector('button')?.click());
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('alpha');
    await view.unmount();
  });

  it('keeps one lifecycle surface, its sentences, and the reader focus across a failed retry', async () => {
    const store = await memoryStore();
    const attempts: Gate<AppStore>[] = [];
    const createStore = async (): Promise<AppStore> => {
      const opening = gate<AppStore>();
      attempts.push(opening);
      return await opening.promise;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    const status = must(view.container.querySelector('[role="status"]'), 'the status region');
    const alert = must(view.container.querySelector('[role="alert"]'), 'the alert region');

    expect(status.textContent).toBe('Opening Ferretry…');
    expect(alert.textContent).toBe('');

    must(attempts[0], 'the first open').reject(new Error('database denied'));
    await settle();

    // Same live regions: neither was remounted under the reader.
    expect(view.container.querySelector('[role="status"]')).toBe(status);
    expect(view.container.querySelector('[role="alert"]')).toBe(alert);
    expect(status.textContent).toBe('');
    expect(alert.textContent).toBe('Could not open local PWA state: database denied');

    const retry = must(view.container.querySelector('button'), 'the retry control');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    retry.focus();

    await interact(() => retry.click());

    // The control the reader pressed survived its own press, so the focus did.
    expect(attempts).toHaveLength(2);
    expect(view.container.querySelector('button')).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(status.textContent).toBe('Retrying: opening Ferretry…');
    expect(alert.textContent).toBe('');
    expect(retry.getAttribute('aria-disabled')).toBe('true');

    // Pressing a control the reader has been told is disabled starts nothing.
    await interact(() => retry.click());
    expect(attempts).toHaveLength(2);

    must(attempts[1], 'the second open').resolve(store);
    await settle();

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');
    await view.unmount();
  });

  it('offers no retry control until an open has actually failed', async () => {
    const attempts: Gate<AppStore>[] = [];
    const createStore = async (): Promise<AppStore> => {
      const opening = gate<AppStore>();
      attempts.push(opening);
      return await opening.promise;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );

    // An ordinary boot: a progress sentence, a silent alert region waiting in
    // the document, and nothing a reader can tab to, press or be told is
    // unavailable. Offering "Try again" here would claim a failure that has
    // not happened.
    expect(must(view.container.querySelector('[role="status"]'), 'the status region').textContent).toBe(
      'Opening Ferretry…',
    );
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.container.querySelector('button')).toBeNull();
    expect(view.container.textContent).toBe('Opening Ferretry…');

    must(attempts[0], 'the first open').reject(new Error('database denied'));
    await settle();

    // It exists from the moment there is something to try again.
    const retry = must(view.container.querySelector('button'), 'the retry control');
    expect(retry.textContent).toBe('Try again');
    expect(retry.getAttribute('aria-disabled')).toBe('false');
    await view.unmount();
  });

  it('hands a recovered boot back to the reader instead of dropping focus to the body', async () => {
    const store = await memoryStore();
    let attempts = 0;
    const createStore = async (): Promise<AppStore> => {
      attempts += 1;
      if (attempts === 1) throw new Error('database denied');
      return store;
    };

    const view = await mount(
      <StoreProvider createStore={createStore}>
        <StoreProbe />
      </StoreProvider>,
    );
    await settle();

    const retry = must(view.container.querySelector('button'), 'the retry control');
    retry.focus();
    await interact(() => retry.click());
    await settle();

    // The surface the reader was standing on is destroyed by the open, so the
    // reader is moved to a sentence that closes out the failure rather than
    // being dropped at the top of the document with nothing said.
    const opened = must(
      view.container.querySelector<HTMLParagraphElement>('[role="status"]'),
      'the opened announcement',
    );
    expect(opened.textContent).toBe('Ferretry is open.');
    expect(opened.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(opened);
    // First in document order, ahead of everything the app itself renders.
    expect(view.container.firstElementChild).toBe(opened);
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('unpaired');

    // Moved once. A later render of the opened app leaves the reader wherever
    // they have since gone.
    opened.blur();
    await interact(() => must(view.container.querySelector('button'), 'the probe').click());
    expect(must(view.container.querySelector('button'), 'the probe').textContent).toBe('alpha');
    expect(document.activeElement).not.toBe(opened);
    await view.unmount();
  });

  it('neither announces nor moves the reader when the first open succeeds', async () => {
    const store = await memoryStore();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    const view = await mount(
      <StoreProvider createStore={async () => store}>
        <StoreProbe />
      </StoreProvider>,
    );
    await settle();

    // Nothing failed, so there is nothing to close out: the browser's own
    // focus placement stands and the app renders alone.
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    expect(view.container.textContent).toBe('unpaired');
    expect(document.activeElement).toBe(document.body);
    await view.unmount();
  });

  it('subscribes to the connection store once per store, not once per render', async () => {
    const first = await memoryStore();
    const second = await memoryStore();
    const firstLog = countSubscriptions(first.connections);
    const secondLog = countSubscriptions(second.connections);

    const view = await mount(
      <StoreProvider store={first}>
        <RenderCountProbe />
      </StoreProvider>,
    );
    const probe = must(view.container.querySelector('button'), 'the render probe');
    await interact(() => probe.click());
    await interact(() => probe.click());

    expect(view.container.textContent).toBe('unpaired:2');
    expect(firstLog).toEqual({ subscribes: 1, unsubscribes: 0 });

    // Scoped to the store: a different one is subscribed, the old one released.
    await view.render(
      <StoreProvider store={second}>
        <RenderCountProbe />
      </StoreProvider>,
    );

    expect(firstLog).toEqual({ subscribes: 1, unsubscribes: 1 });
    expect(secondLog).toEqual({ subscribes: 1, unsubscribes: 0 });

    await view.unmount();
    expect(secondLog).toEqual({ subscribes: 1, unsubscribes: 1 });
  });
});
