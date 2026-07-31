import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../../src/lib/fleet-store.ts';

/**
 * A and B are two paired daemons that both own a session called `shared`.
 * That collision is the adversarial case this module exists for: session ids
 * are minted per daemon, so every isolation test below uses the SAME id on
 * both rather than two convenient distinct ones.
 */
const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
/** Same durable daemon, reached at a new address — a re-pair, not a new daemon. */
const daemonAMoved = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a2.example.test',
  deviceToken: 'token-a',
});
/** Same durable daemon and address, rotated credential — also a re-pair. */
const daemonARotated = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a-rotated',
});

const scopeA = daemonSessionScope(daemonA, 'shared');
const scopeB = daemonSessionScope(daemonB, 'shared');

const session = (id: string, state: Record<string, unknown> = {}): SessionView =>
  ({
    config: { id, name: id, agent: 'claude', mode: 'auto', cwd: '/work' },
    state: { id, status: 'running', turn: 1, ...state },
  }) as unknown as SessionView;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

/** Lets the microtask queue drain so a settled port promise reaches the store. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** Every read is a controllable promise; nothing here touches a network. */
class RecordingPort implements DaemonFleetPort {
  readonly listCalls: DaemonConnection[] = [];
  readonly getCalls: { readonly daemon: DaemonConnection; readonly sessionId: string }[] = [];
  readonly lists: Deferred<readonly SessionView[]>[] = [];
  readonly gets: Deferred<SessionView>[] = [];

  list(daemon: DaemonConnection): Promise<readonly SessionView[]> {
    this.listCalls.push(daemon);
    const pending = deferred<readonly SessionView[]>();
    this.lists.push(pending);
    return pending.promise;
  }

  get(daemon: DaemonConnection, sessionId: string): Promise<SessionView> {
    this.getCalls.push({ daemon, sessionId });
    const pending = deferred<SessionView>();
    this.gets.push(pending);
    return pending.promise;
  }
}

/** Swallows a rejection the test asserts on elsewhere, so bun sees no leak. */
const ignore = (promise: Promise<unknown>): void => {
  void promise.catch(() => undefined);
};

describe('DaemonFleetStore reads', () => {
  it('starts empty and reads an unknown daemon as unread rather than as empty', () => {
    const store = new DaemonFleetStore(new RecordingPort());
    should(store.getSnapshot().daemons.size).equal(0);
    const slice = store.fleet(daemonA.daemonId);
    should(slice.sessions).be.null();
    should(slice.status).equal('idle');
    should(slice.error).be.null();
    should(store.session(scopeA)).be.undefined();
  });

  it('publishes loading, then the daemon rows, and notifies its listeners', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const request = store.hydrate(daemonA);
    should(store.fleet(daemonA.daemonId).status).equal('loading');
    should(notifications).equal(1);

    port.lists[0]?.resolve([session('shared')]);
    await request;

    const slice = store.fleet(daemonA.daemonId);
    should(slice.status).equal('ready');
    should(slice.sessions?.length).equal(1);
    should(slice.byId.get('shared')?.config.id).equal('shared');
    should(notifications).equal(2);

    unsubscribe();
    store.upsertSession(daemonA.daemonId, session('other'));
    should(notifications).equal(2);
  });

  it('keeps two daemons apart when both own the same session id, whatever the completion order', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    const second = store.hydrate(daemonB);
    should(port.listCalls.length).equal(2);

    // B answers first: a store that keyed by session id alone would let this
    // land on A as well, because both lists carry a session called `shared`.
    port.lists[1]?.resolve([session('shared', { turn: 9 })]);
    await second;
    port.lists[0]?.resolve([session('shared', { turn: 1 })]);
    await first;

    should(store.session(scopeA)?.state.turn).equal(1);
    should(store.session(scopeB)?.state.turn).equal(9);
  });

  it('coalesces concurrent list reads for one daemon and never across daemons', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    const second = store.hydrate(daemonA);
    should(second).equal(first);
    should(port.listCalls.length).equal(1);

    store.hydrate(daemonB);
    should(port.listCalls.length).equal(2);

    port.lists[0]?.resolve([]);
    port.lists[1]?.resolve([]);
    await first;
    await settle();

    // The shared request is released once it settles, so a later read is new.
    store.hydrate(daemonA);
    should(port.listCalls.length).equal(3);
  });

  it('reports a failed refresh without blanking rows that were correct a moment ago', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared')]);
    await first;

    const second = store.hydrate(daemonA);
    port.lists[1]?.reject(new Error('daemon unreachable'));
    await second.then(
      () => {
        throw new Error('the refresh must reject');
      },
      () => undefined,
    );

    const slice = store.fleet(daemonA.daemonId);
    should(slice.status).equal('error');
    should(slice.error).equal('daemon unreachable');
    should(slice.sessions?.length).equal(1);
  });

  it('renders a non-Error rejection as a sentence rather than dropping it', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const request = store.hydrate(daemonA);
    port.lists[0]?.reject('the daemon closed the connection');
    await request.then(
      () => {
        throw new Error('the read must reject');
      },
      () => undefined,
    );

    should(store.fleet(daemonA.daemonId).error).equal('the daemon closed the connection');
  });

  it('reuses the object of a structurally unchanged session across a whole-list reconcile', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared'), session('other')]);
    await first;
    const before = store.session(scopeA);
    const otherBefore = store.session(daemonSessionScope(daemonA, 'other'));

    const second = store.hydrate(daemonA);
    port.lists[1]?.resolve([session('shared'), session('other', { turn: 4 })]);
    await second;

    should(store.session(scopeA)).equal(before);
    should(store.session(daemonSessionScope(daemonA, 'other'))).not.equal(otherBefore);
    should(store.session(daemonSessionScope(daemonA, 'other'))?.state.turn).equal(4);
  });

  it('treats a view it cannot serialize as changed instead of throwing out of the read', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared')]);
    await first;

    const cyclic = session('shared') as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    const second = store.hydrate(daemonA);
    port.lists[1]?.resolve([cyclic as unknown as SessionView]);
    await second;

    should(store.session(scopeA)).equal(cyclic as unknown as SessionView);
  });
});

describe('DaemonFleetStore.fetchSession', () => {
  it('refuses a scope belonging to another daemon', () => {
    const store = new DaemonFleetStore(new RecordingPort());
    should(() => store.fetchSession(daemonA, scopeB)).throw('session scope must belong to the requested daemon');
  });

  it('coalesces the exact scope only, so the same id on two daemons is two reads', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.fetchSession(daemonA, scopeA);
    should(store.fetchSession(daemonA, scopeA)).equal(first);
    should(port.getCalls.length).equal(1);

    const other = store.fetchSession(daemonA, daemonSessionScope(daemonA, 'other'));
    should(other).not.equal(first);
    const onB = store.fetchSession(daemonB, scopeB);
    should(onB).not.equal(first);
    should(port.getCalls.length).equal(3);

    port.gets[0]?.resolve(session('shared', { turn: 2 }));
    port.gets[1]?.resolve(session('other'));
    port.gets[2]?.resolve(session('shared', { turn: 7 }));
    await Promise.all([first, other, onB]);

    should(store.session(scopeA)?.state.turn).equal(2);
    should(store.session(scopeB)?.state.turn).equal(7);

    // Released once settled, so a later read of the same scope is a new request.
    ignore(store.fetchSession(daemonA, scopeA));
    should(port.getCalls.length).equal(4);
  });

  it('refuses an answer for a different session than the one asked for', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const request = store.fetchSession(daemonA, scopeA);
    port.gets[0]?.resolve(session('someone-else'));
    await request.then(
      () => {
        throw new Error('a mismatched session must reject');
      },
      (cause: unknown) => should((cause as Error).message).equal('daemon returned another session'),
    );

    should(store.session(scopeA)).be.undefined();
  });

  it('propagates a read failure without inventing a row', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const request = store.fetchSession(daemonA, scopeA);
    port.gets[0]?.reject(new Error('nope'));
    await request.then(
      () => {
        throw new Error('the read must reject');
      },
      () => undefined,
    );

    should(store.session(scopeA)).be.undefined();
  });
});

describe('DaemonFleetStore mutations', () => {
  const readyStore = async (): Promise<{ port: RecordingPort; store: DaemonFleetStore }> => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);
    const request = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared')]);
    await request;
    return { port, store };
  };

  it('ignores an upsert for a daemon it holds no connection for', () => {
    const store = new DaemonFleetStore(new RecordingPort());
    should(store.upsertSession(daemonA.daemonId, session('shared'))).be.false();
    should(store.getSnapshot().daemons.size).equal(0);
  });

  it('seeds an unread slice, prepends a new session, replaces a known one, and ignores a repeat', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);
    // An entry with no rows yet: the list read is still in flight.
    store.hydrate(daemonA);

    const first = session('shared');
    should(store.upsertSession(daemonA.daemonId, first)).be.true();
    should(store.fleet(daemonA.daemonId).sessions?.length).equal(1);
    should(store.upsertSession(daemonA.daemonId, first)).be.false();

    should(store.upsertSession(daemonA.daemonId, session('other'))).be.true();
    should(store.fleet(daemonA.daemonId).sessions?.[0]?.config.id).equal('other');

    should(store.upsertSession(daemonA.daemonId, session('shared', { turn: 5 }))).be.true();
    should(store.fleet(daemonA.daemonId).sessions?.length).equal(2);
    should(store.session(scopeA)?.state.turn).equal(5);

    port.lists[0]?.resolve([]);
    await settle();
  });

  it('removes only the named session, and only from its own daemon', async () => {
    const { store } = await readyStore();

    should(store.removeSession(daemonSessionScope(daemonA, 'absent'))).be.false();
    // B never read anything, so it has no list to remove from.
    should(store.removeSession(scopeB)).be.false();
    should(store.removeSession(scopeA)).be.true();
    should(store.session(scopeA)).be.undefined();
    should(store.fleet(daemonA.daemonId).sessions?.length).equal(0);
  });

  it('applies a real state delta and refuses to notify for one that changes nothing', async () => {
    const { store } = await readyStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    should(store.patchSessionState(daemonSessionScope(daemonA, 'absent'), { turn: 2 })).be.false();
    should(store.patchSessionState(scopeA, {})).be.false();
    should(store.patchSessionState(scopeA, { status: 'running', turn: 1 })).be.false();
    should(notifications).equal(0);

    const before = store.session(scopeA);
    should(store.patchSessionState(scopeA, { activity: 'reading files' })).be.true();
    should(notifications).equal(1);
    should(store.session(scopeA)?.state.activity).equal('reading files');
    should(store.session(scopeA)).not.equal(before);
    // The patch is narrow: everything it did not name survives.
    should(store.session(scopeA)?.state.turn).equal(1);
  });
});

describe('DaemonFleetStore generations', () => {
  it('forgets one daemon only, and reports whether anything was there', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    should(store.clearDaemon(daemonB.daemonId)).be.false();

    const request = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared')]);
    await request;
    const onB = store.hydrate(daemonB);
    port.lists[1]?.resolve([session('shared')]);
    await onB;

    should(store.clearDaemon(daemonA.daemonId)).be.true();
    should(store.fleet(daemonA.daemonId).sessions).be.null();
    should(store.session(scopeB)?.config.id).equal('shared');
  });

  it('forgets a connection that has a read in flight but no rows yet', () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);
    ignore(store.fetchSession(daemonA, scopeA));
    should(store.getSnapshot().daemons.has(daemonA.daemonId)).be.false();
    should(store.clearDaemon(daemonA.daemonId)).be.true();
  });

  it('never lets a list read from before a clear repopulate the cache or satisfy a fresh read', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const stale = store.hydrate(daemonA);
    store.clearDaemon(daemonA.daemonId);

    const fresh = store.hydrate(daemonA);
    should(fresh).not.equal(stale);
    should(port.listCalls.length).equal(2);

    port.lists[0]?.resolve([session('shared', { turn: 99 })]);
    // The stale read still answers ITS OWN caller — it just publishes nothing.
    should((await stale).length).equal(1);
    should(store.session(scopeA)).be.undefined();

    port.lists[1]?.resolve([session('shared', { turn: 1 })]);
    await fresh;
    should(store.session(scopeA)?.state.turn).equal(1);
  });

  it('never lets a session read from before a clear repopulate the cache', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const stale = store.fetchSession(daemonA, scopeA);
    store.clearDaemon(daemonA.daemonId);

    const fresh = store.fetchSession(daemonA, scopeA);
    should(fresh).not.equal(stale);

    port.gets[0]?.resolve(session('shared', { turn: 99 }));
    await stale;
    should(store.session(scopeA)).be.undefined();

    port.gets[1]?.resolve(session('shared', { turn: 1 }));
    await fresh;
    should(store.session(scopeA)?.state.turn).equal(1);
  });

  it('treats a new base URL for the same daemon as a re-pair and drops the old read', async () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    port.lists[0]?.resolve([session('shared', { turn: 3 })]);
    await first;

    const stale = store.hydrate(daemonA);
    const moved = store.hydrate(daemonAMoved);
    should(moved).not.equal(stale);
    should(port.listCalls.length).equal(3);
    // The rows read through the replaced connection do not survive the re-pair.
    should(store.fleet(daemonA.daemonId).sessions).be.null();

    port.lists[1]?.resolve([session('shared', { turn: 99 })]);
    await stale;
    should(store.session(scopeA)).be.undefined();

    port.lists[2]?.resolve([session('shared', { turn: 7 })]);
    await moved;
    should(store.session(scopeA)?.state.turn).equal(7);
  });

  it('treats a rotated device token as a re-pair, and an identical connection as the same one', () => {
    const port = new RecordingPort();
    const store = new DaemonFleetStore(port);

    const first = store.hydrate(daemonA);
    should(store.hydrate(daemonA)).equal(first);
    should(port.listCalls.length).equal(1);

    const rotated = store.hydrate(daemonARotated);
    should(rotated).not.equal(first);
    should(port.listCalls.length).equal(2);

    port.lists[0]?.resolve([]);
    port.lists[1]?.resolve([]);
    ignore(first);
    ignore(rotated);
  });
});
