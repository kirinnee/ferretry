import { describe, it } from 'bun:test';
import should from 'should';
import {
  CONNECTIONS_KEY,
  CONNECTIONS_VERSION,
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonScopedCache,
  parseDaemonConnections,
} from '../../src/lib/connections.ts';
import { type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';

const connection = (id: string, suffix = id) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${suffix}.example.test`, deviceToken: `token-${suffix}` });

class MemoryRepository implements DaemonConnectionRepository {
  readonly writes: Array<{ key: string; value: string }> = [];

  constructor(
    readonly value: string | null = null,
    readonly failLoad = false,
    readonly failFirstSave = false,
  ) {}

  async load(key: string): Promise<string | null> {
    should(key).equal(CONNECTIONS_KEY);
    if (this.failLoad) throw new Error('load failed');
    return this.value;
  }

  async save(key: string, value: string): Promise<void> {
    this.writes.push({ key, value });
    if (this.failFirstSave && this.writes.length === 1) throw new Error('save failed');
  }
}

class RecordingCache implements DaemonScopedCache {
  readonly cleared: DaemonId[] = [];

  constructor(readonly throws = false) {}

  clearDaemon(id: DaemonId): boolean {
    this.cleared.push(id);
    if (this.throws) throw new Error('cache failed');
    return true;
  }
}

const persisted = (connections: unknown[], selectedDaemonId: unknown = null) =>
  JSON.stringify({ v: CONNECTIONS_VERSION, connections, selectedDaemonId });

const row = (id: string, lastSelectedAt: number, extra: Record<string, unknown> = {}) => ({
  daemonId: id,
  baseUrl: `https://${id}.example.test`,
  deviceToken: `token-${id}`,
  pairedAt: 1,
  lastSelectedAt,
  ...extra,
});

describe('paired daemon record parsing', () => {
  it('discards invalid documents and malformed rows without inventing a daemon', () => {
    should(parseDaemonConnections(null)).deepEqual({ connections: [], selectedDaemonId: null });
    should(parseDaemonConnections('{')).deepEqual({ connections: [], selectedDaemonId: null });
    should(parseDaemonConnections('[]')).deepEqual({ connections: [], selectedDaemonId: null });
    should(parseDaemonConnections(JSON.stringify({ v: 2, connections: [] }))).deepEqual({
      connections: [],
      selectedDaemonId: null,
    });
    should(parseDaemonConnections(persisted([], null), 0)).deepEqual({ connections: [], selectedDaemonId: null });
    const parsed = parseDaemonConnections(
      persisted([
        null,
        { daemonId: 'missing' },
        row('bad-path', 2, { baseUrl: 'https://bad.example.test/prefix' }),
        row('bad-time', 2, { pairedAt: -1 }),
        row('good', 3, { label: '  My daemon  ' }),
      ]),
    );
    should(parsed.connections).deepEqual([
      { ...connection('good'), label: 'My daemon', pairedAt: 1, lastSelectedAt: 3 },
    ]);
    should(parsed.selectedDaemonId).equal('good');
  });

  it('deduplicates by daemon id, honors a valid selection, and bounds by recency', () => {
    const parsed = parseDaemonConnections(
      persisted([row('a', 1), row('a', 4, { deviceToken: 'new-token' }), row('b', 5), row('c', 3)], 'c'),
      2,
    );
    should(parsed.connections.map(record => record.daemonId)).deepEqual(['c', 'b']);
    should(parsed.selectedDaemonId).equal('c');
    should(parseDaemonConnections(persisted([row('a', 1)], 'missing')).selectedDaemonId).equal('a');
    should(parseDaemonConnections(persisted([row('a', 1)], ' ')).selectedDaemonId).equal('a');
  });
});

describe('DaemonConnectionStore', () => {
  it('adds, selects, lists, and removes paired daemons with stable no-op reads', async () => {
    const repository = new MemoryRepository();
    let now = 10;
    const store = new DaemonConnectionStore(undefined, { repository, now: () => now++ });
    let notifications = 0;
    should(store.getSnapshot()).deepEqual({ connections: [], selectedDaemonId: null });
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const a = store.add(connection('a'), { label: ' Box A ', pairedAt: 2 });
    const same = store.add(connection('a'));
    store.add(connection('b'));
    should(store.selected()?.daemonId).equal('b');
    should(store.select(daemonId('a')).daemonId).equal('a');
    should(store.select(daemonId('a'))).equal(store.get(daemonId('a')));
    should(a.label).equal('Box A');
    should(same).equal(a);
    should(store.list().map(record => record.daemonId)).deepEqual(['a', 'b']);
    should(store.remove(daemonId('missing'))).be.false();
    should(store.remove(daemonId('a'))).be.true();
    should(store.selected()?.daemonId).equal('b');
    store.remove(daemonId('b'));
    should(store.selected()).be.undefined();
    should(notifications).equal(5);
    unsubscribe();
    store.add(connection('c'));
    should(notifications).equal(5);
    await store.flush();
    should(repository.writes.length).equal(6);
    should(repository.writes.every(write => write.key === CONNECTIONS_KEY)).be.true();
  });

  it('clears every registered cache on re-pair, unpair, and bounded eviction', () => {
    const healthy = new RecordingCache();
    const faulty = new RecordingCache(true);
    const store = new DaemonConnectionStore(undefined, {
      caches: [faulty, healthy],
      maxConnections: 2,
      now: (() => {
        let value = 1;
        return () => value++;
      })(),
    });
    const unregister = store.registerCache({
      clearDaemon: id => {
        healthy.cleared.push(id);
      },
    });
    store.add(connection('a'));
    store.add(connection('b'));
    store.add(connection('a', 'a-rotated'));
    should(store.get(daemonId('a'))?.deviceToken).equal('token-a-rotated');
    store.add(connection('c'));
    unregister();
    store.remove(daemonId('a'));

    should(faulty.cleared.map(String)).deepEqual(['a', 'b', 'a']);
    should(healthy.cleared.map(String)).deepEqual(['a', 'a', 'b', 'b', 'a']);
    should(store.list().map(record => record.daemonId)).deepEqual(['c']);
  });

  it('renames one pairing persistently without changing selection, recency, credentials, or caches', async () => {
    const repository = new MemoryRepository();
    const cache = new RecordingCache();
    const store = new DaemonConnectionStore(undefined, { repository, caches: [cache], now: () => 40 });
    store.add(connection('a'), { label: 'Old name', pairedAt: 3 });
    store.add(connection('b'), { pairedAt: 4 });
    await store.flush();
    const before = store.get(daemonId('a'));
    const selected = store.getSnapshot().selectedDaemonId;
    const order = store.list().map(record => record.daemonId);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const renamed = store.rename(daemonId('a'), '  Work box  ');
    const noOp = store.rename(daemonId('a'), 'Work box');
    await store.flush();

    should(renamed.label).equal('Work box');
    should(renamed.daemonId).equal(before?.daemonId);
    should(renamed.baseUrl).equal(before?.baseUrl);
    should(renamed.deviceToken).equal(before?.deviceToken);
    should(renamed.pairedAt).equal(before?.pairedAt);
    should(renamed.lastSelectedAt).equal(before?.lastSelectedAt);
    should(noOp).equal(renamed);
    should(store.getSnapshot().selectedDaemonId).equal(selected);
    should(store.list().map(record => record.daemonId)).deepEqual(order);
    should(cache.cleared).deepEqual([]);
    should(notifications).equal(1);

    const savedRename = parseDaemonConnections(repository.writes.at(-1)?.value ?? null);
    should(savedRename.connections.find(record => record.daemonId === daemonId('a'))?.label).equal('Work box');

    const cleared = store.rename(daemonId('a'), '   ');
    await store.flush();
    should(cleared.label).be.undefined();
    should(store.get(daemonId('a'))?.label).be.undefined();
    const savedClear = parseDaemonConnections(repository.writes.at(-1)?.value ?? null);
    should(savedClear.connections.find(record => record.daemonId === daemonId('a'))?.label).be.undefined();
    should(store.getSnapshot().selectedDaemonId).equal(selected);
    should(cache.cleared).deepEqual([]);
    should(notifications).equal(2);

    unsubscribe();
  });

  it('replaces carriers only for the pairing that authenticated the refresh', () => {
    const store = new DaemonConnectionStore();
    const paired = store.add(connection('a'));
    const replacement = [
      { kind: 'direct' as const, daemonUrl: paired.baseUrl },
      { kind: 'relay' as const, relayUrl: 'https://new-relay.example.test', operator: 'self' as const },
    ];
    const changedToken = daemonConnection({ ...paired, deviceToken: 'token-rotated' });
    const changedBaseUrl = daemonConnection({ ...paired, baseUrl: 'https://moved.example.test' });

    should(store.replaceCarriers(changedToken, replacement)).equal(paired);
    should(store.replaceCarriers(changedBaseUrl, replacement)).equal(paired);
    should(store.get(paired.daemonId)?.carriers).deepEqual([{ kind: 'direct', daemonUrl: paired.baseUrl }]);

    should(store.replaceCarriers(paired, replacement)?.carriers).deepEqual(replacement);
  });

  it('loads tolerantly and keeps saving after a repository failure', async () => {
    const repository = new MemoryRepository(persisted([row('saved', 4)], 'saved'), false, true);
    const store = await DaemonConnectionStore.open({ repository, now: () => 9 });
    should(store.selected()?.daemonId).equal('saved');
    store.add(connection('new'));
    store.select(daemonId('saved'));
    await store.flush();
    should(repository.writes).have.length(2);

    const unavailable = await DaemonConnectionStore.open({ repository: new MemoryRepository(null, true) });
    should(unavailable.list()).have.length(0);
  });

  it('rejects invalid capacity and an unpaired selection', () => {
    should(() => new DaemonConnectionStore(undefined, { maxConnections: 0 })).throw(
      'maxConnections must be a positive integer',
    );
    const store = new DaemonConnectionStore();
    should(() => store.select(daemonId('missing'))).throw('daemon missing is not paired');
    should(() => store.rename(daemonId('missing'), 'name')).throw('daemon missing is not paired');
  });
});
