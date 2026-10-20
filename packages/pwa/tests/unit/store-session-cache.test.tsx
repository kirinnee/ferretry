import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { ScrollMemory, type ScrollMemoryStorage } from '../../src/lib/scroll-memory.ts';
import { SessionCache, type SessionCacheBackend } from '../../src/lib/session-cache.ts';
import { createAppStore } from '../../src/lib/store.tsx';
import { schemaValidSessionView } from '../support/schema-valid-sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'beta-token',
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

class MemoryBackend implements SessionCacheBackend {
  readonly records = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.records.get(key);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.records.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.records.keys()];
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

const sessionsKey = (daemonId: string): string => JSON.stringify(['sessions', daemonId]);

/** Lets the store's chained, in-memory promises (cache read, fleet seed, backend write) all run. */
const drain = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

const clientListing = (list: () => Promise<readonly SessionView[]>): FyApiClient =>
  ({ list }) as unknown as FyApiClient;

/** A repository that already holds `daemons` paired, as a previous visit would have left it. */
const pairedRepository = async (...daemons: (typeof alpha)[]): Promise<MemoryRepository> => {
  const repository = new MemoryRepository();
  const previous = await createAppStore({
    repository,
    connectClient: async () => clientListing(async () => []),
    fetcher: async () => Response.json({}),
    sessionCacheBackend: null,
    scrollMemoryStorage: null,
  });
  for (const daemon of daemons) previous.connections.add(daemon);
  await drain();
  return repository;
};

describe('createAppStore session cache', () => {
  it('draws every paired machine cached list into the fleet before any live read answers', async () => {
    // Arrange
    const repository = await pairedRepository(alpha, beta);
    const backend = new MemoryBackend();
    const savedAt = Date.now() - 1_000;
    backend.records.set(sessionsKey('alpha'), {
      kind: 'sessions',
      daemonId: 'alpha',
      savedAt,
      sessions: [schemaValidSessionView('cached-alpha')],
    });
    backend.records.set(sessionsKey('beta'), {
      kind: 'sessions',
      daemonId: 'beta',
      savedAt,
      sessions: [schemaValidSessionView('cached-beta')],
    });

    // Act
    const store = await createAppStore({
      repository,
      connectClient: async () => clientListing(() => new Promise(() => undefined)),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: backend,
      scrollMemoryStorage: null,
    });
    await drain();

    // Assert
    const alphaSlice = store.fleet.fleet(alpha.daemonId);
    expect(alphaSlice.sessions?.map(view => view.config.id)).toEqual(['cached-alpha']);
    expect(alphaSlice.cachedAt).toBe(savedAt);
    expect(store.fleet.fleet(beta.daemonId).sessions?.map(view => view.config.id)).toEqual(['cached-beta']);
  });

  it('seeds nothing for a paired machine the cache never saw', async () => {
    // Arrange
    const repository = await pairedRepository(alpha);

    // Act
    const store = await createAppStore({
      repository,
      connectClient: async () => clientListing(() => new Promise(() => undefined)),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: new MemoryBackend(),
      scrollMemoryStorage: null,
    });
    await drain();

    // Assert
    expect(store.fleet.fleet(alpha.daemonId).sessions).toBeNull();
  });

  it('keeps every good list read for the next open, and replaces the cached copy on screen', async () => {
    // Arrange
    const backend = new MemoryBackend();
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => clientListing(async () => [schemaValidSessionView('live-1')]),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: backend,
      scrollMemoryStorage: null,
    });
    store.connections.add(alpha);

    // Act
    await store.fleet.hydrate(alpha);
    await drain();
    const reloaded = await new SessionCache(backend).sessions(alpha.daemonId);

    // Assert
    expect(reloaded?.sessions.map(view => view.config.id)).toEqual(['live-1']);
    expect(store.fleet.fleet(alpha.daemonId).cachedAt).toBeUndefined();
  });

  it('does not write back a list whose machine was unpaired while it was in flight', async () => {
    // Arrange
    const backend = new MemoryBackend();
    let release: (views: readonly SessionView[]) => void = () => undefined;
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () =>
        clientListing(
          () =>
            new Promise<readonly SessionView[]>(resolve => {
              release = resolve;
            }),
        ),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: backend,
      scrollMemoryStorage: null,
    });
    store.connections.add(alpha);

    // Act
    const reading = store.fleet.hydrate(alpha);
    await drain();
    store.connections.remove(alpha.daemonId);
    release([schemaValidSessionView('late')]);
    await reading.catch(() => undefined);
    await drain();

    // Assert
    expect([...backend.records.keys()]).toEqual([]);
  });

  it('clears a machine cached list when it is unpaired', async () => {
    // Arrange
    const backend = new MemoryBackend();
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => clientListing(async () => [schemaValidSessionView('live-1')]),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: backend,
      scrollMemoryStorage: null,
    });
    store.connections.add(alpha);
    await store.fleet.hydrate(alpha);
    await drain();

    // Act
    store.connections.remove(alpha.daemonId);
    await drain();

    // Assert
    expect([...backend.records.keys()]).toEqual([]);
  });

  it('exposes a scroll memory over the injected storage, and a silent one when given none', async () => {
    // Arrange
    const kept = new Map<string, string>();
    const storage: ScrollMemoryStorage = {
      getItem: key => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: key => void kept.delete(key),
    };

    // Act
    const remembering = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => clientListing(async () => []),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: null,
      scrollMemoryStorage: storage,
    });
    const silent = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => clientListing(async () => []),
      fetcher: async () => Response.json({}),
      sessionCacheBackend: null,
      scrollMemoryStorage: null,
    });

    // Assert
    remembering.scrollMemory.rememberChat('k', { top: 5, atLatest: false });
    silent.scrollMemory.rememberChat('k', { top: 9, atLatest: true });
    expect(remembering.scrollMemory).toBeInstanceOf(ScrollMemory);
    expect(remembering.scrollMemory.chat('k')).toEqual({ top: 5, atLatest: false });
    expect(kept.size).toBe(1);
    expect(silent.scrollMemory.chat('k')).toBeNull();
    expect(remembering.sessionCache).toBeInstanceOf(SessionCache);
  });
});
