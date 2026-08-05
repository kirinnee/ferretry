import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import { useState } from 'react';
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
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const connection = await exchangePairing(
      { daemonUrl: 'https://daemon.example.test', daemonId: 'fingerprint', code: 'one-time-code' },
      async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ daemonId: 'fingerprint', deviceToken: 'device-token' });
      },
    );

    expect(String(connection.daemonId)).toBe('fingerprint');
    expect(connection.baseUrl).toBe('https://daemon.example.test');
    expect(connection.deviceToken).toBe('device-token');
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
    const seed = { daemonUrl: 'https://daemon.example.test', daemonId: 'fingerprint', code: 'code' };

    await expect(
      exchangePairing(seed, async () => Response.json({ error: 'expired' }, { status: 410 })),
    ).rejects.toThrow('expired');
    await expect(exchangePairing(seed, async () => Response.json({ daemonId: 3 }))).rejects.toThrow(
      'invalid pairing response',
    );
    await expect(
      exchangePairing(seed, async () => Response.json({ daemonId: 'other', deviceToken: 'token' })),
    ).rejects.toThrow('does not match its fingerprint');
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
        return Response.json([]);
      },
    });
    store.connections.add(alpha);

    await (await store.clients.client(alpha)).list();

    expect(requests).toEqual(['https://alpha.example.test/v1/sessions']);
    // And the router recorded it as a measurement, which is the whole point: the
    // probe and the Carrier panel are now reading one answer.
    expect(store.carrier.choice(alpha.daemonId)?.ok).toBe(true);
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
