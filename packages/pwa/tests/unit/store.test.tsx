import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
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

describe('StoreProvider', () => {
  it('invalidates notification preferences and push devices for only the removed daemon', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => client('unused'),
      fetcher: async () => Response.json({}),
    });
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

  it('publishes a daemon-scoped store and reacts to runtime pairing changes', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => client('unused'),
      fetcher: async () => Response.json({}),
    });
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
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => client('unused'),
      fetcher: async () => Response.json({}),
    });
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
    expect(view.container.textContent).toBe('unpaired');

    // The recovered store is the live one, not a snapshot taken before the retry.
    await interact(() => view.container.querySelector('button')?.click());
    expect(view.container.textContent).toBe('alpha');
    await view.unmount();
  });
});
