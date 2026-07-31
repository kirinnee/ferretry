import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowserLoginAction, BrowserLoginStatus, IFyHttpTransport } from '@ferretry/protocol';
import type { BrowserLoginView } from '../../src/features/browser/browser-login-banner.tsx';
import { daemonApiClient } from '../../src/lib/api-client.ts';
import {
  BROWSER_LOGIN_CLOSED_POLL_MS,
  BROWSER_LOGIN_OPEN_POLL_MS,
  BROWSER_LOGIN_PATH,
  browserLoginPort,
  DaemonBrowserLoginStore,
  type BrowserLoginPort,
  type BrowserLoginPortFactory,
  type BrowserLoginSnapshot,
  type ScheduleBrowserLoginPoll,
} from '../../src/lib/browser-login.ts';
import { daemonConnection, type DaemonConnection } from '../../src/lib/daemon-connection.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });

const closed = { state: 'closed', profilePrimed: false } as const;

/** An open window is a live credential — every fixture carries its own. */
const openOn = (password: string): Record<string, unknown> => ({
  state: 'open',
  profilePrimed: true,
  openedAt: '2026-07-31T00:00:00.000Z',
  expiresAt: '2026-07-31T00:10:00.000Z',
  connection: { host: '127.0.0.1', port: 5951, password, sshTunnel: 'ssh -L 5951:127.0.0.1:5951 daemon' },
});

const statusOf = (snapshot: BrowserLoginSnapshot | null): BrowserLoginStatus | null =>
  snapshot !== null && snapshot.state !== 'unknown' ? snapshot : null;

const passwordOf = (snapshot: BrowserLoginSnapshot | null): string | undefined => {
  const status = statusOf(snapshot);
  // Narrowed by state, so this keeps compiling once the protocol status
  // becomes a union that carries `connection` on the open member alone.
  return status !== null && status.state === 'open' ? status.connection?.password : undefined;
};

interface Deferred {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

const deferred = (): Deferred => {
  const box: { release: () => void } = { release: () => undefined };
  const promise = new Promise<void>(resolve => {
    box.release = resolve;
  });
  return { promise, release: () => box.release() };
};

interface LoginCall {
  readonly kind: 'status' | 'act';
  readonly action?: BrowserLoginAction;
}

/** A daemon that answers exactly what one test tells it to, in call order. */
class FakeLoginPort implements BrowserLoginPort {
  readonly calls: LoginCall[] = [];
  readonly #answer: (call: LoginCall, index: number) => Promise<unknown>;

  constructor(answer: (call: LoginCall, index: number) => Promise<unknown>) {
    this.#answer = answer;
  }

  status(): Promise<unknown> {
    return this.#record({ kind: 'status' });
  }

  act(action: BrowserLoginAction): Promise<unknown> {
    return this.#record({ kind: 'act', action });
  }

  get kinds(): string[] {
    return this.calls.map(call => call.kind);
  }

  #record(call: LoginCall): Promise<unknown> {
    const index = this.calls.length;
    this.calls.push(call);
    return this.#answer(call, index);
  }
}

interface ScheduledPoll {
  readonly delayMs: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** Deterministic stand-in for setTimeout; the canceller is what it returns. */
class ManualScheduler {
  readonly scheduled: ScheduledPoll[] = [];

  readonly schedule: ScheduleBrowserLoginPoll = (run, delayMs) => {
    const entry: ScheduledPoll = { run, delayMs, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  get live(): ScheduledPoll[] {
    return this.scheduled.filter(entry => !entry.cancelled);
  }
}

const only =
  (port: BrowserLoginPort): BrowserLoginPortFactory =>
  () =>
    port;

const byDaemon =
  (ports: Readonly<Record<string, BrowserLoginPort>>): BrowserLoginPortFactory =>
  daemon => {
    const port = ports[daemon.daemonId];
    if (port === undefined) throw new Error(`no fake port for ${daemon.daemonId}`);
    return port;
  };

class RecordingTransport implements IFyHttpTransport {
  readonly calls: Array<{ url: string; init: RequestInit }> = [];
  readonly #body: unknown;

  constructor(body: unknown) {
    this.#body = body;
  }

  send(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(this.#body), { headers: { 'content-type': 'application/json' } }),
    );
  }
}

describe('browserLoginPort', () => {
  it('reads with a bare GET and closes with an explicit, protocol-validated intent', async () => {
    const transport = new RecordingTransport(closed);
    const port = browserLoginPort(await daemonApiClient(daemonA, { transport }));

    should(await port.status()).deepEqual(closed);
    await port.act({ action: 'stop', primed: true });
    await port.act({ action: 'start', minutes: 5 });

    const [read, stop, start] = transport.calls;
    // The route belongs to the runtime-paired daemon, never to the page origin
    // this public bundle happens to be served from.
    should(read?.url).equal(`https://a.example.test${BROWSER_LOGIN_PATH}`);
    should(read?.init.method).be.undefined();
    should(read?.init.body).be.undefined();

    // Closing says which of the two human answers was given; the daemon is
    // never left to infer "I signed in" from the state it can see.
    should(stop?.init.method).equal('POST');
    should(stop?.init.body).equal(JSON.stringify({ action: 'stop', primed: true }));
    should(start?.init.body).equal(JSON.stringify({ action: 'start', minutes: 5 }));

    const headers = new Headers(stop?.init.headers);
    should(headers.get('content-type')).equal('application/json');
    should(headers.get('authorization')).equal('Bearer token-a');
    // Authentication and the mutation request id stay protocol-owned: no
    // ambient token, and none of kteam's hand-rolled `x-kteam-request-id`.
    should(headers.get('x-fy-request-id')).not.be.empty();
    should(headers.get('x-kteam-request-id')).be.null();
  });
});

describe('DaemonBrowserLoginStore', () => {
  it('reports a daemon it has never read as not-read rather than closed', () => {
    const store = new DaemonBrowserLoginStore(only(new FakeLoginPort(() => Promise.resolve(closed))));

    // null is the banner's "render nothing" case. Answering `closed` here
    // would claim a window is shut before anyone has asked the daemon.
    should(store.getSnapshot(daemonA.daemonId)).be.null();
  });

  it('immediately refetches authoritative state after an action', async () => {
    const port = new FakeLoginPort(() => Promise.resolve(openOn('secret-a')));
    const store = new DaemonBrowserLoginStore(only(port));

    const view = await store.act(daemonA, { action: 'start' });

    // The POST's own status is not the last word: teardown and startup keep
    // running after it answers, so the GET is what the banner renders.
    should(port.kinds).deepEqual(['act', 'status']);
    should(port.calls[0]?.action).deepEqual({ action: 'start' });
    should(view).deepEqual(openOn('secret-a'));
    should(store.getSnapshot(daemonA.daemonId)).deepEqual(openOn('secret-a'));
  });

  it('turns a failed read into unknown rather than pretending the window closed', async () => {
    const store = new DaemonBrowserLoginStore(only(new FakeLoginPort(() => Promise.reject(new Error('offline')))));

    // It resolves. A rejection would leave the banner rendering nothing, which
    // is indistinguishable from a login window that is actually shut.
    should(await store.refresh(daemonA)).deepEqual({ state: 'unknown', error: 'offline' });
    should(store.getSnapshot(daemonA.daemonId)).deepEqual({ state: 'unknown', error: 'offline' });
  });

  it('describes a non-Error failure of both a read and an action', async () => {
    const reader = new DaemonBrowserLoginStore(only(new FakeLoginPort(() => Promise.reject('nope'))));
    should(await reader.refresh(daemonA)).deepEqual({
      state: 'unknown',
      error: 'Cannot reach the browser-login window.',
    });

    const actor = new DaemonBrowserLoginStore(
      only(new FakeLoginPort(call => (call.kind === 'act' ? Promise.reject('nope') : Promise.resolve(closed)))),
    );
    should(await actor.act(daemonA, { action: 'confirm' })).deepEqual({
      state: 'unknown',
      error: 'Browser-login action failed.',
    });
  });

  it('rejects a status the protocol schema does not recognise, for a read and an action', async () => {
    const unreadable = { state: 'ajar', profilePrimed: 'yes' };
    const message = 'The daemon returned an unreadable browser-login status.';
    const store = new DaemonBrowserLoginStore(only(new FakeLoginPort(() => Promise.resolve(unreadable))));

    should(await store.refresh(daemonA)).deepEqual({ state: 'unknown', error: message });
    should(await store.act(daemonA, { action: 'stop', primed: false })).deepEqual({ state: 'unknown', error: message });
    // Nothing unvalidated ever became the snapshot.
    should(store.getSnapshot(daemonA.daemonId)).deepEqual({ state: 'unknown', error: message });
  });

  it('never lets a stale pre-action poll hide an open login window', async () => {
    const gate = deferred();
    const port = new FakeLoginPort(async (_call, index) => {
      if (index === 0) {
        await gate.promise;
        return closed;
      }
      return openOn('secret-a');
    });
    const store = new DaemonBrowserLoginStore(only(port));

    const stalePoll = store.refresh(daemonA);
    await store.act(daemonA, { action: 'start' });
    should(statusOf(store.getSnapshot(daemonA.daemonId))?.state).equal('open');

    gate.release();
    // The stale read still answers its own caller...
    should(await stalePoll).deepEqual(closed);
    // ...but it may not publish over the action that overtook it.
    should(statusOf(store.getSnapshot(daemonA.daemonId))?.state).equal('open');
  });

  it('keeps two daemons reading at once apart, down to the promise and the password', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const portA = new FakeLoginPort(async () => {
      await gateA.promise;
      return openOn('secret-a');
    });
    const portB = new FakeLoginPort(async () => {
      await gateB.promise;
      return openOn('secret-b');
    });
    const store = new DaemonBrowserLoginStore(byDaemon({ 'daemon-a': portA, 'daemon-b': portB }));

    const readA = store.refresh(daemonA);
    const readB = store.refresh(daemonB);
    // The two reads are identically shaped. Coalescing them would hand one
    // daemon's VNC password to a reader looking at the other.
    should(readA === readB).be.false();

    gateA.release();
    gateB.release();
    await Promise.all([readA, readB]);

    should(portA.calls).have.length(1);
    should(portB.calls).have.length(1);
    should(passwordOf(store.getSnapshot(daemonA.daemonId))).equal('secret-a');
    should(passwordOf(store.getSnapshot(daemonB.daemonId))).equal('secret-b');
  });

  it('shares one in-flight read within a daemon and starts a fresh one afterwards', async () => {
    const gate = deferred();
    const port = new FakeLoginPort(async () => {
      await gate.promise;
      return closed;
    });
    const store = new DaemonBrowserLoginStore(only(port));

    const first = store.refresh(daemonA);
    const second = store.refresh(daemonA);
    should(first === second).be.true();

    gate.release();
    await first;
    should(port.calls).have.length(1);

    await store.refresh(daemonA);
    should(port.calls).have.length(2);
  });

  it('polls every 30s while closed and every 2s while something is happening', async () => {
    const scheduler = new ManualScheduler();
    const port = new FakeLoginPort((_call, index) => Promise.resolve(index === 0 ? closed : openOn('secret-a')));
    const store = new DaemonBrowserLoginStore(only(port), { schedule: scheduler.schedule });

    let notified = 0;
    const unsubscribe = store.subscribe(daemonA, () => {
      notified += 1;
    });
    // The first listener kicks the read; asking again joins that same one.
    should(await store.refresh(daemonA)).deepEqual(closed);
    should(port.calls).have.length(1);
    should(scheduler.live).have.length(1);
    should(scheduler.live[0]?.delayMs).equal(BROWSER_LOGIN_CLOSED_POLL_MS);

    scheduler.scheduled[0]?.run();
    should(passwordOf(await store.refresh(daemonA))).equal('secret-a');
    should(port.calls).have.length(2);
    should(scheduler.scheduled[0]?.cancelled).be.true();
    should(scheduler.live).have.length(1);
    should(scheduler.live[0]?.delayMs).equal(BROWSER_LOGIN_OPEN_POLL_MS);
    should(notified).equal(2);

    // An unmounted banner must not keep the daemon busy.
    unsubscribe();
    should(scheduler.live).be.empty();
  });

  it('does not poll a daemon nobody is listening to', async () => {
    const scheduler = new ManualScheduler();
    const port = new FakeLoginPort(() => Promise.resolve(openOn('secret-a')));
    const store = new DaemonBrowserLoginStore(only(port), { schedule: scheduler.schedule });

    await store.refresh(daemonA);
    await store.act(daemonA, { action: 'stop', primed: true });

    should(scheduler.scheduled).be.empty();
  });

  it('schedules on real timers when no scheduler is injected', async () => {
    const port = new FakeLoginPort(() => Promise.resolve(closed));
    const store = new DaemonBrowserLoginStore(only(port));

    const unsubscribe = store.subscribe(daemonA, () => undefined);
    should(await store.refresh(daemonA)).deepEqual(closed);
    // Unsubscribing must clear the real timeout, not merely forget it.
    unsubscribe();

    should(port.calls).have.length(1);
  });

  it('drops an answer from a connection that has since been replaced', async () => {
    const gate = deferred();
    const seen: DaemonConnection[] = [];
    const stalePort = new FakeLoginPort(async () => {
      await gate.promise;
      return openOn('old-secret');
    });
    const freshPort = new FakeLoginPort(() => Promise.resolve(closed));
    const store = new DaemonBrowserLoginStore(daemon => {
      seen.push(daemon);
      return seen.length === 1 ? stalePort : freshPort;
    });

    let notified = 0;
    store.subscribe(daemonA, () => {
      notified += 1;
    });
    const staleRead = store.refresh(daemonA);

    // Same daemon, re-paired: a rotated device token, so the answer still in
    // flight was authorised by a connection that no longer exists.
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'token-a-rotated',
    });
    should(await store.refresh(rotated)).deepEqual(closed);
    should(seen).have.length(2);
    should(seen[1]?.deviceToken).equal('token-a-rotated');
    // The replacement itself told the banner the old credential is gone.
    should(notified).be.aboveOrEqual(2);

    gate.release();
    should(passwordOf(await staleRead)).equal('old-secret');
    should(store.getSnapshot(daemonA.daemonId)).deepEqual(closed);
    should(passwordOf(store.getSnapshot(daemonA.daemonId))).be.undefined();
  });

  it('clears exactly one daemon on unpair, cancelling only its poll and its reads', async () => {
    const scheduler = new ManualScheduler();
    const gate = deferred();
    const portA = new FakeLoginPort(async (_call, index) => {
      if (index === 1) await gate.promise;
      return openOn('secret-a');
    });
    const portB = new FakeLoginPort(() => Promise.resolve(openOn('secret-b')));
    const store = new DaemonBrowserLoginStore(byDaemon({ 'daemon-a': portA, 'daemon-b': portB }), {
      schedule: scheduler.schedule,
    });

    store.subscribe(daemonA, () => undefined);
    store.subscribe(daemonB, () => undefined);
    await store.refresh(daemonA);
    await store.refresh(daemonB);
    should(scheduler.live).have.length(2);

    const readAcrossUnpair = store.refresh(daemonA);
    should(store.clearDaemon(daemonA.daemonId)).be.true();

    should(store.getSnapshot(daemonA.daemonId)).be.null();
    should(passwordOf(store.getSnapshot(daemonB.daemonId))).equal('secret-b');
    should(scheduler.live).have.length(1);
    should(scheduler.live[0]?.delayMs).equal(BROWSER_LOGIN_OPEN_POLL_MS);

    gate.release();
    // The unpaired daemon's own read still answers, and still cannot publish.
    should(passwordOf(await readAcrossUnpair)).equal('secret-a');
    should(store.getSnapshot(daemonA.daemonId)).be.null();

    // Clearing a daemon that is already gone is not an error, and a re-paired
    // daemon starts from not-read rather than from its old credential.
    should(store.clearDaemon(daemonA.daemonId)).be.false();
  });

  it('produces exactly the view the ported banner renders', async () => {
    const store = new DaemonBrowserLoginStore(only(new FakeLoginPort(() => Promise.resolve(openOn('secret-a')))));

    // A compile-time assertion: the store's snapshot IS the banner's contract,
    // including the null that makes it render nothing.
    const unread: BrowserLoginView | null = store.getSnapshot(daemonA.daemonId);
    should(unread).be.null();
    const view: BrowserLoginView = await store.refresh(daemonA);
    should(view.state).equal('open');
  });
});
