import { describe, it } from 'bun:test';
import should from 'should';
import {
  CONNECTIONS_KEY,
  CONNECTIONS_VERSION,
  type DaemonConnectionRepository,
  DaemonConnectionStore,
  type DaemonConnectionsChanged,
  type DaemonScopedCache,
  parseDaemonConnections,
} from '../../src/lib/connections.ts';
import { type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';

const connection = (id: string, suffix = id) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${suffix}.example.test`, deviceId: `token-${suffix}` });

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
  deviceId: `token-${id}`,
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
      persisted([row('a', 1), row('a', 4, { deviceId: 'new-token' }), row('b', 5), row('c', 3)], 'c'),
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
    should(store.get(daemonId('a'))?.deviceId).equal('token-a-rotated');
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
    should(renamed.deviceId).equal(before?.deviceId);
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
    const changedToken = daemonConnection({ ...paired, deviceId: 'token-rotated' });
    const changedBaseUrl = daemonConnection({ ...paired, baseUrl: 'https://moved.example.test' });

    should(store.replaceCarriers(changedToken, replacement)).equal(paired);
    should(store.replaceCarriers(changedBaseUrl, replacement)).equal(paired);
    should(store.get(paired.daemonId)?.carriers).deepEqual([{ kind: 'direct', daemonUrl: paired.baseUrl }]);

    should(store.replaceCarriers(paired, replacement)?.carriers).deepEqual(replacement);
  });

  it('should read a published tunnel back from storage, so a reload does not lose it', async () => {
    // Arrange — the owner's defect: "Tunnel only" worked until the installed app was reloaded, then said
    // "this machine has no tunnel yet" for good. The tunnel was saved and never read back, and under
    // Tunnel only there was no other carrier left to learn it again over.
    const repository = new MemoryRepository();
    const store = new DaemonConnectionStore(undefined, { repository });
    const paired = store.add(connection('a'));
    const tunnel = { kind: 'tunnel' as const, tunnelUrl: 'https://ssxg3hqu5pkfmzjq.ferretry.stream' };
    store.replaceCarriers(paired, [{ kind: 'direct', daemonUrl: paired.baseUrl }, tunnel]);

    // Act
    await store.flush();
    const reloaded = parseDaemonConnections(repository.writes.at(-1)?.value ?? null);

    // Assert
    should(reloaded.connections[0]?.carriers).deepEqual([{ kind: 'direct', daemonUrl: paired.baseUrl }, tunnel]);
    should(
      parseDaemonConnections(
        persisted([
          row('b', 1, {
            carriers: [
              { kind: 'tunnel', tunnelUrl: 'http://plaintext.example.test' },
              { kind: 'tunnel', tunnelUrl: 'https://with-path.example.test/x' },
              { kind: 'tunnel' },
            ],
          }),
        ]),
      ).connections[0]?.carriers,
    ).deepEqual([{ kind: 'direct', daemonUrl: 'https://b.example.test' }]);
  });

  it('should drop a stored direct carrier whose address is not a daemon origin', () => {
    should(
      parseDaemonConnections(
        persisted([
          row('b', 1, {
            carriers: [
              { kind: 'direct', daemonUrl: 'not a url' },
              { kind: 'direct', daemonUrl: 'https://b.example.test/with/path' },
              { kind: 'direct', daemonUrl: 'ftp://b.example.test' },
            ],
          }),
        ]),
      ).connections[0]?.carriers,
    ).deepEqual([{ kind: 'direct', daemonUrl: 'https://b.example.test' }]);
  });

  it('should keep the last tunnel through a refresh that does not name one, and follow one that moved', () => {
    // Arrange — a set read while cloudflared reconnects says "not right now", not "gone".
    const store = new DaemonConnectionStore();
    const paired = store.add(connection('a'));
    const direct = { kind: 'direct' as const, daemonUrl: paired.baseUrl };
    const relay = { kind: 'relay' as const, relayUrl: 'https://relay.example.test', operator: 'self' as const };
    const tunnel = { kind: 'tunnel' as const, tunnelUrl: 'https://k3x9.tunnels.example.test' };
    const moved = { kind: 'tunnel' as const, tunnelUrl: 'https://n3w.tunnels.example.test' };
    store.replaceCarriers(paired, [direct, tunnel, relay]);

    // Act
    const withoutTunnel = store.replaceCarriers(paired, [direct, relay]);
    const unchanged = store.replaceCarriers(paired, [direct, relay]);
    const reprovisioned = store.replaceCarriers(paired, [direct, moved, relay]);

    // Assert
    should(withoutTunnel?.carriers).deepEqual([direct, tunnel, relay]);
    should(unchanged).equal(withoutTunnel);
    should(reprovisioned?.carriers).deepEqual([direct, moved, relay]);
  });

  it('should keep or forget the tunnel on the daemon’s own word, for the pairing that asked', () => {
    const store = new DaemonConnectionStore();
    const paired = store.add(connection('a'));
    const direct = { kind: 'direct' as const, daemonUrl: paired.baseUrl };
    const tunnel = { kind: 'tunnel' as const, tunnelUrl: 'https://k3x9.tunnels.example.test' };

    const on = store.replaceTunnel(paired, tunnel);
    should(on?.carriers).deepEqual([direct, tunnel]);
    should(store.replaceTunnel(paired, tunnel)).equal(on);
    // Another pairing's late answer changes nothing; an unknown daemon has nothing to change.
    should(store.replaceTunnel(daemonConnection({ ...paired, deviceId: 'token-rotated' }), undefined)).equal(on);
    should(store.replaceTunnel(connection('nobody'), undefined)).be.undefined();

    should(store.replaceTunnel(paired, undefined)?.carriers).deepEqual([direct]);
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

describe('the name a paired machine goes by', () => {
  const named = (id: string, daemonName?: string) =>
    daemonConnection({
      daemonId: id,
      baseUrl: `http://127.0.0.1:4024${id.length}`,
      deviceId: `token-${id}`,
      ...(daemonName === undefined ? {} : { daemonName }),
    });

  it('should keep the name the pairing response carried, and read it back from storage', async () => {
    // Arrange — the e2e defect: the daemon said its host name at pairing and nothing kept it, so every
    // screen called the machine "http://127.0.0.1:40245".
    const repository = new MemoryRepository();
    const store = new DaemonConnectionStore(undefined, { repository });

    // Act
    const record = store.add(named('a', '  workstation  '));
    await store.flush();
    const reloaded = parseDaemonConnections(repository.writes.at(-1)?.value ?? null);

    // Assert
    should(record.daemonName).equal('workstation');
    should(reloaded.connections[0]?.daemonName).equal('workstation');
    should(
      parseDaemonConnections(persisted([row('b', 1, { daemonName: '   ' })])).connections[0]?.daemonName,
    ).be.undefined();
  });

  it('should keep a learned name across a re-pair that carries none, and take a new one that does', () => {
    // Arrange
    const store = new DaemonConnectionStore(undefined, { repository: new MemoryRepository() });
    store.add(named('a', 'workstation'));

    // Act + Assert
    should(store.add(named('a')).daemonName).equal('workstation');
    should(store.add(named('a', 'renamed-host')).daemonName).equal('renamed-host');
  });

  it('should learn a name from an answer without touching the owner label', async () => {
    // Arrange — a pairing made before the name was kept.
    const repository = new MemoryRepository();
    const store = new DaemonConnectionStore(undefined, { repository });
    store.add(named('a'), { label: 'Desk' });
    store.add(named('b'));
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    // Act
    const learned = store.learnDaemonName(daemonId('a'), ' workstation ');
    const again = store.learnDaemonName(daemonId('a'), 'workstation');
    const blank = store.learnDaemonName(daemonId('b'), '   ');
    const missing = store.learnDaemonName(daemonId('missing'), 'nowhere');
    await store.flush();

    // Assert — one change, and only the one field.
    should(learned?.daemonName).equal('workstation');
    should(learned?.label).equal('Desk');
    should(again).equal(learned);
    should(blank?.daemonName).be.undefined();
    should(missing).be.undefined();
    should(notifications).equal(1);
    should(store.getSnapshot().selectedDaemonId).equal('b');
    const saved = parseDaemonConnections(repository.writes.at(-1)?.value ?? null);
    should(saved.connections.find(record => record.daemonId === daemonId('a'))?.daemonName).equal('workstation');
  });

  it('should keep the name when the daemon replaces its carriers', () => {
    // Arrange
    const store = new DaemonConnectionStore(undefined, { repository: new MemoryRepository() });
    const record = store.add(named('a', 'workstation'));

    // Act
    const replaced = store.replaceCarriers(record, [{ kind: 'direct', daemonUrl: 'http://127.0.0.1:40249' }]);

    // Assert
    should(replaced?.daemonName).equal('workstation');
  });
});

/** One browser: a repository and a channel that every tab shares, and that never echoes to its sender. */
class SharedBrowser {
  value: string | null = null;
  failLoad = false;
  readonly saves: string[] = [];
  readonly announcements: unknown[] = [];
  readonly #listeners = new Set<{ tab: number; listener: () => void }>();

  #held: Promise<string | null> | undefined;

  /** The next load is read at once but answers only when released, with the value given then. */
  holdNextLoad(): (value: string | null) => void {
    let release: (value: string | null) => void = () => undefined;
    this.#held = new Promise(resolve => {
      release = resolve;
    });
    return release;
  }

  repository(): DaemonConnectionRepository {
    return {
      load: async () => {
        if (this.failLoad) throw new Error('load failed');
        const held = this.#held;
        if (held !== undefined) {
          this.#held = undefined;
          return await held;
        }
        return this.value;
      },
      save: async (_key, value) => {
        this.value = value;
        this.saves.push(value);
      },
    };
  }

  channel(tab: number): DaemonConnectionsChanged {
    return {
      announce: () => {
        this.announcements.push('changed');
        for (const heard of this.#listeners) if (heard.tab !== tab) heard.listener();
      },
      subscribe: listener => {
        const heard = { tab, listener };
        this.#listeners.add(heard);
        return () => this.#listeners.delete(heard);
      },
    };
  }
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('two tabs of one browser', () => {
  const open = async (browser: SharedBrowser, tab: number, caches: DaemonScopedCache[] = []) =>
    await DaemonConnectionStore.open({ repository: browser.repository(), changed: browser.channel(tab), caches });

  it('shows the original tab a pairing made in another tab, and tells its listeners', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    const other = await open(browser, 2);
    let notified = 0;
    original.subscribe(() => {
      notified += 1;
    });
    should(original.list()).deepEqual([]);

    other.add(connection('a'));
    await other.flush();
    await settle();

    should(original.list().map(record => record.daemonId)).deepEqual(['a']);
    should(original.selected()?.daemonId).equal('a');
    should(notified).equal(1);
  });

  it('keeps this tab’s own selected machine when another tab selects a different one', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    original.add(connection('a'));
    original.add(connection('b'));
    await original.flush();
    const other = await open(browser, 2);
    should(original.selected()?.daemonId).equal('b');

    other.select(daemonId('a'));
    await other.flush();
    await settle();

    should(original.selected()?.daemonId).equal('b');
    should(other.selected()?.daemonId).equal('a');
    should(
      original
        .list()
        .map(record => record.daemonId)
        .sort(),
    ).deepEqual(['a', 'b']);
  });

  it('still adopts the other tab’s selection when this tab’s machine was removed there', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    original.add(connection('a'));
    original.add(connection('b'));
    await original.flush();
    const other = await open(browser, 2);
    original.select(daemonId('a'));
    await original.flush();

    other.remove(daemonId('a'));
    await other.flush();
    await settle();

    should(original.selected()?.daemonId).equal('b');
  });

  it('does not echo: adopting another tab’s registry saves and announces nothing', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    const other = await open(browser, 2);

    other.add(connection('a'));
    await other.flush();
    await settle();
    await original.flush();

    should(browser.saves.length).equal(1);
    should(browser.announcements.length).equal(1);
  });

  it('clears the caches of a pairing another tab removed or re-paired', async () => {
    const browser = new SharedBrowser();
    const first = await open(browser, 2);
    first.add(connection('a'));
    first.add(connection('b'));
    await first.flush();
    const cache = new RecordingCache();
    const original = await open(browser, 1, [cache]);
    should(original.list().length).equal(2);

    first.remove(daemonId('a'));
    first.add(connection('b', 'b2'));
    await first.flush();
    await settle();

    should(original.list().map(record => record.daemonId)).deepEqual(['b']);
    should(original.get(daemonId('b'))?.baseUrl).equal('https://b2.example.test');
    should(cache.cleared.map(String).sort()).deepEqual(['a', 'b']);
  });

  it('keeps its registry when the repository cannot be re-read', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    original.add(connection('a'));
    await original.flush();
    const other = await open(browser, 2);
    other.add(connection('b'));
    browser.failLoad = true;
    await other.flush();
    await settle();

    should(original.list().map(record => record.daemonId)).deepEqual(['a']);
  });

  it('does not let a slow read of the old registry overwrite a newer local add', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    original.add(connection('a'));
    await original.flush();
    const stale = browser.value;
    const release = browser.holdNextLoad();

    browser.channel(2).announce();
    await settle();
    original.add(connection('b'));
    await original.flush();
    release(stale);
    await settle();
    await original.flush();

    should(
      original
        .list()
        .map(record => record.daemonId)
        .sort(),
    ).deepEqual(['a', 'b']);
    should(parseDaemonConnections(browser.value).connections.length).equal(2);
  });

  it('lets only the newest reload adopt what it read', async () => {
    const browser = new SharedBrowser();
    const original = await open(browser, 1);
    browser.value = persisted([row('a', 1)], 'a');
    const releaseOld = browser.holdNextLoad();

    browser.channel(2).announce();
    await settle();
    const stale = browser.value;
    browser.value = persisted([row('a', 1), row('b', 2)], 'b');
    browser.channel(2).announce();
    await settle();
    releaseOld(stale);
    await settle();

    should(
      original
        .list()
        .map(record => record.daemonId)
        .sort(),
    ).deepEqual(['a', 'b']);
  });

  it('carries no record, id or token in the signal', () => {
    const browser = new SharedBrowser();
    const channel = browser.channel(1);
    const heard: unknown[] = [];
    browser.channel(2).subscribe((...args: unknown[]) => heard.push(args));
    channel.announce();
    should(heard).deepEqual([[]]);
    should(browser.announcements).deepEqual(['changed']);
  });
});
