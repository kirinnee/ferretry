/**
 * The browser carrier router (`app/carriers/router.ts`) as the shell's carrier, through the production path: the
 * shell's `connector` and sealed sessions, Connections' socket walk, and the REAL kernel session layer, with a paired
 * device the kernel admits. Only the network and the timers are scripted.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONTROL_UNREACHABLE,
  type ConnectPorts,
  HEARTBEAT_RESPONSE,
  type PairedDaemon,
  RELAY_CLOSE_CODES,
} from '@ferretry/app';
import { connector, fakeDeviceClaims, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import connections from '../../../app/index.ts';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';
import {
  CarrierRouter,
  daemonCarriers,
  PAIRING_CLEARED_REASON,
  PREFERENCE_CHANGED_REASON,
  WITHDRAWN_CARRIER_REASON,
} from '../../../app/carriers/router.ts';
import { documentRelayDiscovery } from '../../../app/discovery/hosted-relay.ts';
import type { CarrierPreference } from '../../../app/lib/carrier-preference.ts';
import { BrowserNetwork, HandTimers, type ScriptedHost } from '../../support/browser-network.ts';
import { type KernelFixture, kernelFixture } from '../../support/kernel-session.ts';

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';
const TUNNEL = 'https://abc.tunnel.example';
const RELAY = 'wss://relay.example';

interface Rig {
  readonly fx: KernelFixture;
  readonly network: BrowserNetwork;
  readonly timers: HandTimers;
  readonly router: CarrierRouter;
  readonly daemon: PairedDaemon;
  readonly connect: (target?: PairedDaemon) => ReturnType<ReturnType<typeof connector>>;
}

async function rig(
  hosts: Record<string, ScriptedHost>,
  carriers: readonly unknown[],
  preference: CarrierPreference | (() => CarrierPreference) = 'auto',
  hosted: string | null = null,
  openSocket?: (network: BrowserNetwork, fx: KernelFixture) => (url: string) => BrowserSocket,
): Promise<Rig> {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const network = new BrowserNetwork(fx, hosts);
  const timers = new HandTimers();
  const router = new CarrierRouter({
    openSocket: openSocket?.(network, fx) ?? network.openSocket,
    after: timers.after,
    now: () => 0,
    preference: typeof preference === 'function' ? preference : () => preference,
    hostedRelay: async () => hosted ?? undefined,
  });
  const daemon: PairedDaemon = {
    daemon: fx.daemonId,
    machine: 'laptop',
    deviceId: device.deviceId,
    address: DIRECT,
    carriers: [...carriers],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const claims = fakeDeviceClaims({
    claims: {
      [fx.daemonId]: {
        deviceId: device.deviceId,
        key: shellCrypto.deviceKeyHandle(device.privateKey),
        appSession: device.appSession,
      },
    },
  });
  const connect = (target: PairedDaemon = daemon) =>
    connector({
      crypto: shellCrypto,
      claims,
      carriers: [router.dialer()],
      direct: () => {
        throw new Error('the shell’s own direct dial is not used once Connections registered a carrier');
      },
    })(target);
  return { fx, network, timers, router, daemon, connect };
}

const carriedOver = (fx: KernelFixture): readonly string[] =>
  fx.requests.map(
    request => `${request.path} ${request.arrival.kind === 'carried' ? request.arrival.carrier : 'local'}`,
  );

describe('carrier control (R634)', () => {
  test('R634 GET and PUT /v1/tunnel ride the direct address even under "Tunnel only", and remember no winner', async () => {
    // Arrange — the daemon publishes a tunnel, its own address and a relay; this device chose "Tunnel only".
    const r = await rig(
      {
        [new URL(TUNNEL).host]: { kind: 'carries', carrier: 'tunnel' },
        [new URL(DIRECT).host]: { kind: 'carries', carrier: 'direct' },
        [new URL(RELAY).host]: { kind: 'carries', carrier: 'relay' },
      },
      [
        { kind: 'tunnel', url: TUNNEL },
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY },
      ],
      'tunnel',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    // Act — carrier control first, then an ordinary read.
    await transport.request({ method: 'GET', path: '/v1/tunnel' });
    await transport.request({ method: 'PUT', path: '/v1/tunnel', body: { enabled: true } });
    const winnerAfterControl = r.router.choice(r.fx.daemonId);
    await transport.request({ method: 'GET', path: '/v1/carriers' });

    // Assert — control rode direct (an introducer), never the tunnel; it decided nothing; the read rode the tunnel.
    expect(carriedOver(r.fx)).toEqual(['/v1/tunnel direct', '/v1/tunnel direct', '/v1/carriers tunnel']);
    expect(winnerAfterControl).toBeUndefined();
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'tunnel' } });
    r.fx.layer.close();
  });

  test('R634 with neither a direct address nor a relay that answers, control is refused with today’s sentence', async () => {
    const r = await rig(
      { [new URL(TUNNEL).host]: { kind: 'carries', carrier: 'tunnel' } },
      [{ kind: 'tunnel', url: TUNNEL }],
      'tunnel',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    // A published set with only a tunnel has no introducer at all: control is refused before anything is dialled.
    const failure = await transport.request({ method: 'GET', path: '/v1/tunnel' }).catch((error: unknown) => error);
    expect((failure as Error).message).toContain(CONTROL_UNREACHABLE);
    expect(r.fx.requests).toEqual([]);
    expect(r.network.dialled.some(url => url.startsWith('wss://abc.tunnel.example'))).toBe(false);
    r.fx.layer.close();
  });
});

describe('the walk', () => {
  test('a carrier that never opened sent nothing, so the next one is tried and becomes the remembered winner', async () => {
    const r = await rig(
      {
        [new URL(DIRECT).host]: { kind: 'dead' },
        [new URL(RELAY).host]: { kind: 'carries', carrier: 'relay' },
      },
      [
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY },
      ],
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers relay']);
    const choice = r.router.choice(r.fx.daemonId);
    expect(choice).toMatchObject({ ok: true, method: { kind: 'relay' } });
    expect(choice?.reason).toContain('was not reachable');
    // A second session starts from the winner: the dead direct address is not dialled again.
    const before = r.network.dialled.length;
    await transport.request({ method: 'GET', path: '/v1/carriers', headers: {} });
    expect(r.network.dialled.length).toBe(before);
    r.fx.layer.close();
  });

  test('"Relay only" (the default) walks only relays, and the hosted relay only when the daemon published none', async () => {
    const r = await rig(
      {
        [new URL(DIRECT).host]: { kind: 'carries', carrier: 'direct' },
        'hosted.example': { kind: 'carries', carrier: 'relay' },
      },
      [{ kind: 'direct', url: DIRECT }],
      'relay',
      'wss://hosted.example',
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/carriers' });
    expect(carriedOver(r.fx)).toEqual(['/v1/carriers relay']);
    expect(r.network.dialled.map(url => new URL(url).host)).toEqual(['hosted.example']);
    r.fx.layer.close();
  });

  test('a daemon that published nothing is reached at the address it was paired over; an odd fingerprint, direct only', () => {
    const daemon = {
      daemon: 'fy_daemon_x',
      machine: 'm',
      deviceId: 'd',
      address: DIRECT,
      carriers: [],
      pairedAt: 1,
      lastSelectedAt: 1,
    } as PairedDaemon;
    expect(daemonCarriers(daemon)).toEqual([{ kind: 'direct', daemonUrl: DIRECT }]);
    const odd = {
      ...daemon,
      carriers: [
        { kind: 'relay', url: RELAY },
        { kind: 'direct', url: DIRECT },
      ],
    };
    expect(daemonCarriers(odd).map(method => method.kind)).toEqual(['direct']);
  });
});

describe('hosted relay discovery (R580)', () => {
  test('R580 the relay is found from the build-time directory origin, read ONCE per document, never from the link', async () => {
    const asked: string[] = [];
    const directory: ConnectPorts['directory'] = async url => {
      asked.push(url);
      return new Response(JSON.stringify({ version: 1, relayUrl: 'wss://hosted.example' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const ports = {
      openSocket: () => {
        throw new Error('nothing dials here');
      },
      after: () => {},
      now: () => 0,
      daemons: { registerCache: () => () => {} },
      directory,
    } as unknown as ConnectPorts;
    // The shell builds both of Connections' parts from the same ports: one read serves the router and the walk.
    const shell = (connections as unknown as { shell: Required<import('@ferretry/app').ShellProvides> }).shell;
    // The build-time define `vite.config.ts` stamps in; the link itself carries no rendezvous to read.
    const host = globalThis as { __FY_RELAY_DIRECTORY__?: string };
    host.__FY_RELAY_DIRECTORY__ = 'https://directory.example';
    try {
      shell.carriers(ports);
      shell.pairing(ports);
      shell.carriers(ports);
      await new Promise(resolve => setTimeout(resolve, 5));
    } finally {
      delete host.__FY_RELAY_DIRECTORY__;
    }
    expect(asked).toEqual(['https://directory.example/v1/default-relay']);
  });

  test('R580 a build with no directory (or a withdrawn relay) offers nothing and dials nothing', async () => {
    expect(await documentRelayDiscovery(undefined, 'https://directory.example').hostedRelay()).toBeUndefined();
    const withdrawn = documentRelayDiscovery(
      async () => new Response(JSON.stringify({ version: 1, relayUrl: null })),
      'https://directory.example',
    );
    expect(await withdrawn.hostedRelay()).toBeUndefined();
    expect((await withdrawn.fallback()).kind).toBe('disabled');
  });
});

const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15));
const DIRECT_HOST = new URL(DIRECT).host;
const RELAY_HOST = new URL(RELAY).host;
const DIRECT_AND_RELAY = [
  { kind: 'direct', url: DIRECT },
  { kind: 'relay', url: RELAY },
] as const;

/** A socket that opens and then only ever answers heartbeats: a carrier, but no session. */
const heartbeatsOnly = (): BrowserSocket => {
  const socket: BrowserSocket = {
    binaryType: 'blob',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: () => undefined,
    close: (code, reason) => {
      void Promise.resolve().then(() => socket.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
    },
  };
  setTimeout(() => {
    socket.onopen?.();
    socket.onmessage?.({ data: HEARTBEAT_RESPONSE });
  }, 0);
  return socket;
};

describe('acceptance decides, not the first frame (connections-app R1 finding 1)', () => {
  test('a carrier that only answers heartbeats keeps its acceptance deadline; the unsent PUT then walks to the relay', async () => {
    // Arrange — direct opens and answers heartbeats but never carries a session; the relay carries the real daemon.
    const r = await rig(
      { [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
      'auto',
      null,
      network => url => {
        if (new URL(url).host !== DIRECT_HOST) return network.openSocket(url);
        network.dialled.push(url);
        return heartbeatsOnly();
      },
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    // Act — a write while direct holds the session; then direct's 4 s acceptance deadline passes.
    const put = transport.request({ method: 'PUT', path: '/v1/example', body: { enabled: true } });
    await pause();
    const choiceBeforeDeadline = r.router.choice(r.fx.daemonId);
    r.timers.fireExactly(4_000);
    const answer = await put;

    // Assert — a heartbeat was not a winner; the write was never sent over direct, and it crossed the relay once.
    expect(choiceBeforeDeadline).toBeUndefined();
    expect(answer.status).toBe(200);
    expect(carriedOver(r.fx)).toEqual(['/v1/example relay']);
    expect(r.network.dialled.map(url => new URL(url).host)).toEqual([DIRECT_HOST, RELAY_HOST]);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    r.fx.layer.close();
  });

  test('a different daemon on direct refuses the opening hello: nothing was sent, so the PUT walks to the relay on a fresh session', async () => {
    // Arrange — direct reaches a REAL daemon with another identity; the relay reaches the paired one.
    const wrong = await kernelFixture();
    const r = await rig(
      { [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
      'auto',
      null,
      network => {
        const impostor = new BrowserNetwork(wrong, { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' } });
        return url => {
          if (new URL(url).host !== DIRECT_HOST) return network.openSocket(url);
          network.dialled.push(url);
          return impostor.openSocket(url);
        };
      },
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');

    // Act
    const answer = await transport.request({ method: 'PUT', path: '/v1/example', body: { enabled: true } });

    // Assert — the impostor got no credential or request record and handled nothing; the write rode the relay once,
    // and the relay — the carrier a session was ACCEPTED over — is the winner.
    expect(answer.status).toBe(200);
    expect(wrong.requests).toEqual([]);
    expect(carriedOver(r.fx)).toEqual(['/v1/example relay']);
    expect(r.network.dialled.map(url => new URL(url).host)).toEqual([DIRECT_HOST, RELAY_HOST]);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    wrong.layer.close();
    r.fx.layer.close();
  });
});

describe('retired generations (connections-app R1 finding 2)', () => {
  test('an unpair while the walk waits on discovery stops it: the relay is never dialled and no winner is recreated', async () => {
    // Arrange — direct is dead and the walk then waits on the hosted relay directory.
    let release: (url: string) => void = () => undefined;
    const fx = await kernelFixture();
    const network = new BrowserNetwork(fx, { 'hosted.example': { kind: 'carries', carrier: 'relay' } });
    const router = new CarrierRouter({
      openSocket: network.openSocket,
      after: () => undefined,
      now: () => 0,
      preference: () => 'auto',
      hostedRelay: () =>
        new Promise<string>(resolve => {
          release = resolve;
        }),
    });
    const daemon: PairedDaemon = {
      daemon: fx.daemonId,
      machine: 'laptop',
      deviceId: 'fy_device_x',
      address: DIRECT,
      carriers: [{ kind: 'direct', url: DIRECT }],
      pairedAt: 1,
      lastSelectedAt: 1,
    };
    const closes: string[] = [];
    router.dial(daemon)({
      onBinary: () => undefined,
      onText: () => undefined,
      onClose: (_code, reason) => closes.push(reason),
    });
    await pause();

    // Act — the pairing goes away, then the directory answers.
    router.clearDaemon(fx.daemonId);
    release('wss://hosted.example');
    await pause();

    // Assert — the session was ended saying why; the discovered relay was never dialled; nothing was remembered.
    expect(closes).toEqual([PAIRING_CLEARED_REASON]);
    expect(network.dialled.map(url => new URL(url).host)).toEqual([DIRECT_HOST]);
    expect(router.choice(fx.daemonId)).toBeUndefined();
    fx.layer.close();
  });

  test('a new preference closes the session on the excluded carrier: the next request walks the new order', async () => {
    // Arrange — Auto, with direct and the relay both working: the first request crosses direct.
    let preference: CarrierPreference = 'auto';
    const r = await rig(
      {
        [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
      },
      DIRECT_AND_RELAY,
      () => preference,
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/first' });

    // Act — the person picks "Relay only".
    preference = 'relay';
    r.router.rewalk(r.fx.daemonId);
    await pause();
    await transport.request({ method: 'GET', path: '/v1/second' });

    // Assert — the request after the change crossed the relay, not the session already open over direct.
    expect(carriedOver(r.fx)).toEqual(['/v1/first direct', '/v1/second relay']);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    expect(PREFERENCE_CHANGED_REASON).toBe('the connection preference for this machine changed');
    r.fx.layer.close();
  });
});

describe('a winner that fails under a write is forgotten (connections-app R1 finding 3)', () => {
  test('the relay winner closes under a pending PUT: the PUT fails unresent, the winner is cleared and announced, and the recovered direct is tried next', async () => {
    // Arrange — direct is dead, so the relay wins the first read.
    const hosts: Record<string, ScriptedHost> = {
      [DIRECT_HOST]: { kind: 'dead' },
      [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
    };
    const sockets = new Map<string, BrowserSocket>();
    const r = await rig(hosts, DIRECT_AND_RELAY, 'auto', null, network => url => {
      const socket = network.openSocket(url);
      sockets.set(new URL(url).host, socket);
      return socket;
    });
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/first' });
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    let announced = 0;
    r.router.subscribe(() => {
      announced += 1;
    });
    const route = r.fx.route;
    r.fx.route = request => (request.method === 'PUT' ? new Promise(() => undefined) : route(request));

    // Act — the relay fails while the PUT waits for its answer; then direct comes back.
    const put = transport
      .request({ method: 'PUT', path: '/v1/example', body: { enabled: true } })
      .catch(error => error);
    await pause();
    sockets.get(RELAY_HOST)?.close(1011, 'carrier failed');
    const failure = await put;
    const choiceAfterLoss = r.router.choice(r.fx.daemonId);
    hosts[DIRECT_HOST] = { kind: 'carries', carrier: 'direct' };
    r.fx.route = route;
    await transport.request({ method: 'GET', path: '/v1/second' });

    // Assert — the write failed and was never re-sent; the stopped winner was forgotten and said so; the next read
    // walked from the top and crossed the recovered direct address.
    expect(failure).toBeInstanceOf(Error);
    expect(r.fx.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(choiceAfterLoss?.ok).not.toBe(true);
    expect(announced).toBeGreaterThan(0);
    expect(carriedOver(r.fx)).toEqual(['/v1/first relay', '/v1/example relay', '/v1/second direct']);
    r.fx.layer.close();
  });
});

const RELAY_TWO = 'wss://relay-two.example';
const RELAY_TWO_HOST = new URL(RELAY_TWO).host;
const hostsOf = (dialled: readonly string[]): readonly string[] => dialled.map(url => new URL(url).host);
const sleep = (ms: number): Promise<'pending'> => new Promise(resolve => setTimeout(() => resolve('pending'), ms));

/** Every socket the browser opened, per host, and every close this side asked of one. */
const recording =
  (closes: string[], sockets: Map<string, BrowserSocket>) => (network: BrowserNetwork) => (url: string) => {
    const socket = network.openSocket(url);
    const host = new URL(url).host;
    sockets.set(host, socket);
    const close = socket.close.bind(socket);
    socket.close = (code, reason) => {
      closes.push(`${host} ${reason ?? ''}`);
      close(code, reason);
    };
    return socket;
  };

describe('a republish fences by entry and keeps only still-published sessions (connections-app R2 finding 1)', () => {
  test('a walk whose entry a carrier refresh replaced is refused, while the refreshed one answers (today relay-carrier.test.ts:1291)', async () => {
    // Arrange — only the relay reaches the daemon; the daemon then republishes a second relay.
    const r = await rig(
      { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
    );
    const republished: PairedDaemon = {
      ...r.daemon,
      carriers: [...DIRECT_AND_RELAY, { kind: 'relay', url: RELAY_TWO }],
    };
    const before = await r.connect();
    const after = await r.connect(republished);
    if (before === undefined || after === undefined) throw new Error('no transport');

    // Act — a request walks the old set, and a request on the republished set replaces its entry.
    const stale = before.request({ method: 'GET', path: '/v1/projects' }).catch((error: unknown) => error);
    const current = after.request({ method: 'GET', path: '/v1/usage' });

    // Assert — the stale walk dialled nothing more and said why; the current one answered over the relay.
    expect(String(await stale)).toMatch(/re-paired, unpaired or republished/u);
    expect((await current).status).toBe(200);
    expect(carriedOver(r.fx)).toEqual(['/v1/usage relay']);
    expect(hostsOf(r.network.dialled)).toEqual([DIRECT_HOST, RELAY_HOST]);
    expect(r.router.choice(r.fx.daemonId)?.ok).toBe(true);
    r.fx.layer.close();
  });

  test('a stale PUT walk never dials the withdrawn relay, and its observer never makes it the winner', async () => {
    // Arrange — direct is silent; relay-A and relay-B both reach the daemon.
    const r = await rig(
      {
        [DIRECT_HOST]: { kind: 'silent' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
        [RELAY_TWO_HOST]: { kind: 'carries', carrier: 'relay' },
      },
      DIRECT_AND_RELAY,
    );
    const republished: PairedDaemon = {
      ...r.daemon,
      carriers: [
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY_TWO },
      ],
    };
    const before = await r.connect();
    const after = await r.connect(republished);
    if (before === undefined || after === undefined) throw new Error('no transport');

    // Act — a PUT holds direct with relay-A next; a walk over direct + relay-B starts; then direct's deadline passes.
    const put = before
      .request({ method: 'PUT', path: '/v1/example', body: { enabled: true } })
      .catch((error: unknown) => error);
    await pause();
    const read = after.request({ method: 'GET', path: '/v1/usage' });
    await pause();
    r.timers.fireExactly(4_000);

    // Assert — the PUT was refused unsent and relay-A was never dialled; the read crossed relay-B, the winner now.
    expect(String(await put)).toMatch(/republished/u);
    expect((await read).status).toBe(200);
    expect(r.fx.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(hostsOf(r.network.dialled)).toEqual([DIRECT_HOST, DIRECT_HOST, RELAY_TWO_HOST]);
    expect(JSON.stringify(r.router.choice(r.fx.daemonId))).toContain(RELAY_TWO_HOST);
    r.fx.layer.close();
  });

  test('a rendezvous the daemon withdrew is closed under its accepted session, and the set is walked again (today relay-carrier.test.ts:1047)', async () => {
    // Arrange — relay-A wins and holds an accepted session; the daemon then publishes relay-B instead.
    const closes: string[] = [];
    const sockets = new Map<string, BrowserSocket>();
    const r = await rig(
      {
        [DIRECT_HOST]: { kind: 'dead' },
        [RELAY_HOST]: { kind: 'carries', carrier: 'relay' },
        [RELAY_TWO_HOST]: { kind: 'carries', carrier: 'relay' },
      },
      DIRECT_AND_RELAY,
      'auto',
      null,
      recording(closes, sockets),
    );
    const before = await r.connect();
    if (before === undefined) throw new Error('no transport');
    await before.request({ method: 'GET', path: '/v1/first' });
    const republished: PairedDaemon = {
      ...r.daemon,
      carriers: [
        { kind: 'direct', url: DIRECT },
        { kind: 'relay', url: RELAY_TWO },
      ],
    };
    const after = await r.connect(republished);
    if (after === undefined) throw new Error('no transport');

    // Act
    const answer = await after.request({ method: 'PUT', path: '/v1/example', body: { enabled: true } });

    // Assert — relay-A's session was closed saying why; the PUT walked the new set and crossed relay-B only.
    expect(answer.status).toBe(200);
    expect(closes).toContain(`${RELAY_HOST} ${WITHDRAWN_CARRIER_REASON}`);
    expect(hostsOf(r.network.dialled)).toEqual([DIRECT_HOST, RELAY_HOST, DIRECT_HOST, RELAY_TWO_HOST]);
    expect(r.network.records(RELAY_HOST).length).toBeGreaterThan(0);
    expect(JSON.stringify(r.router.choice(r.fx.daemonId))).toContain(RELAY_TWO_HOST);
    r.fx.layer.close();
  });

  test('a direct winner the republished set cannot name keeps its session open (today’s one exception)', async () => {
    // Arrange — direct wins; the daemon then publishes only its relay (a wildcard bind names no address).
    const closes: string[] = [];
    const sockets = new Map<string, BrowserSocket>();
    const r = await rig(
      { [DIRECT_HOST]: { kind: 'carries', carrier: 'direct' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
      'auto',
      null,
      recording(closes, sockets),
    );
    const before = await r.connect();
    if (before === undefined) throw new Error('no transport');
    await before.request({ method: 'GET', path: '/v1/first' });

    // Act — the republish reaches the router through a new dial.
    const after = await r.connect({ ...r.daemon, carriers: [{ kind: 'relay', url: RELAY }] });
    if (after === undefined) throw new Error('no transport');
    await after.request({ method: 'GET', path: '/v1/second' });
    await before.request({ method: 'GET', path: '/v1/third' });

    // Assert — nothing was closed, the first session carried its next request, and direct is still the winner.
    expect(closes).toEqual([]);
    expect(carriedOver(r.fx)).toEqual(['/v1/first direct', '/v1/second direct', '/v1/third direct']);
    expect(hostsOf(r.network.dialled)).toEqual([DIRECT_HOST, DIRECT_HOST]);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'direct' } });
    r.fx.layer.close();
  });
});

describe('an idle drop keeps the winner (connections-app R2 finding 2)', () => {
  test('the relay winner’s idle session is evicted: the choice stays, and the next GET redials the relay at once', async () => {
    // Arrange — direct is silent, so the relay wins the first read after direct's deadline.
    const closes: string[] = [];
    const sockets = new Map<string, BrowserSocket>();
    const r = await rig(
      { [DIRECT_HOST]: { kind: 'silent' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
      'auto',
      null,
      recording(closes, sockets),
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    const first = transport.request({ method: 'GET', path: '/v1/first' });
    await pause();
    r.timers.fireExactly(4_000);
    await first;
    let announced = 0;
    r.router.subscribe(() => {
      announced += 1;
    });

    // Act — the relay evicts the idle socket while it stays available; then the next read.
    sockets.get(RELAY_HOST)?.close(1011, 'evicted');
    await pause();
    const choiceAfterDrop = r.router.choice(r.fx.daemonId);
    const second = await Promise.race([transport.request({ method: 'GET', path: '/v1/second' }), sleep(500)]);

    // Assert — the drop forgot nothing; the read crossed the same relay without waiting out direct's deadline.
    expect(choiceAfterDrop).toMatchObject({ ok: true, method: { kind: 'relay' } });
    expect(announced).toBe(0);
    expect(second).not.toBe('pending');
    expect(carriedOver(r.fx)).toEqual(['/v1/first relay', '/v1/second relay']);
    expect(hostsOf(r.network.dialled)).toEqual([DIRECT_HOST, RELAY_HOST, RELAY_HOST]);
    r.fx.layer.close();
  });
});

describe('a request lost under a session forgets the winner only when the carrier failed it (connections-app R3 nit)', () => {
  /** Direct is dead, so the relay wins the first read; later reads of `/v1/slow` are never answered by the daemon. */
  const relayWinner = async () => {
    const closes: string[] = [];
    const sockets = new Map<string, BrowserSocket>();
    const r = await rig(
      { [DIRECT_HOST]: { kind: 'dead' }, [RELAY_HOST]: { kind: 'carries', carrier: 'relay' } },
      DIRECT_AND_RELAY,
      'auto',
      null,
      recording(closes, sockets),
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    await transport.request({ method: 'GET', path: '/v1/first' });
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    const route = r.fx.route;
    r.fx.route = request => (request.path === '/v1/slow' ? new Promise(() => undefined) : route(request));
    return { r, transport, sockets };
  };

  test('an accepted relay winner closed with the daemon’s refusal of the device under a GET keeps its choice', async () => {
    // Arrange
    const { r, transport, sockets } = await relayWinner();

    // Act — the relay session ends with `authRejected` while the read waits: the daemon's answer, not the carrier's.
    const read = transport.request({ method: 'GET', path: '/v1/slow' }).catch((error: unknown) => error);
    await pause();
    sockets.get(RELAY_HOST)?.close(RELAY_CLOSE_CODES.authRejected, 'unknown device');
    const failure = await read;

    // Assert — the read failed, and the winner was not forgotten for a refusal the carrier did not cause.
    expect(failure).toBeInstanceOf(Error);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    r.fx.layer.close();
  });

  test('an aborted GET whose carrier then drops keeps the choice: the caller gave up, the carrier lost nothing', async () => {
    // Arrange
    const { r, transport, sockets } = await relayWinner();
    const controller = new AbortController();
    const gaveUp = new Error('the caller gave up');

    // Act — the caller aborts and the carrier drops in the same turn, before the abort's rejection is observed.
    const read = transport
      .request({ method: 'GET', path: '/v1/slow', signal: controller.signal })
      .catch((error: unknown) => error);
    await pause();
    controller.abort(gaveUp);
    sockets.get(RELAY_HOST)?.onclose?.({ code: 1011, reason: 'carrier dropped' });
    const failure = await read;
    await pause();

    // Assert — the read failed with the caller's own reason, and the winner stands.
    expect(failure).toBe(gaveUp);
    expect(r.router.choice(r.fx.daemonId)).toMatchObject({ ok: true, method: { kind: 'relay' } });
    r.fx.layer.close();
  });
});

/** Opens like the real rendezvous and says `ready`, then refuses the session for its ceiling (4429) at the hello. */
const refusesAtHello = (real: BrowserSocket): BrowserSocket => {
  let refused = false;
  const socket: BrowserSocket = {
    binaryType: 'blob',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: () => {
      if (refused) return;
      refused = true;
      real.close(1000, '');
      setTimeout(
        () => socket.onclose?.({ code: RELAY_CLOSE_CODES.rendezvousBusy, reason: 'session limit reached' }),
        0,
      );
    },
    close: (code, reason) => real.close(code, reason),
  };
  real.onopen = () => socket.onopen?.();
  real.onmessage = event => socket.onmessage?.(event);
  real.onclose = event => {
    if (!refused) socket.onclose?.(event);
  };
  return socket;
};

describe('a stream the rendezvous refuses for its ceiling is not walked onward (connections-app R2 finding 3)', () => {
  const streamOver = async (hostA: ScriptedHost, wrap: (network: BrowserNetwork) => (url: string) => BrowserSocket) => {
    const r = await rig(
      { [RELAY_HOST]: hostA, [RELAY_TWO_HOST]: { kind: 'carries', carrier: 'relay' } },
      [
        { kind: 'relay', url: RELAY },
        { kind: 'relay', url: RELAY_TWO },
      ],
      'relay',
      null,
      wrap,
    );
    const transport = await r.connect();
    if (transport === undefined) throw new Error('no transport');
    const ended = new Promise<string>(resolve => {
      transport.socket('/v1/example/stream', { onFrame: () => undefined, onClose: resolve });
    });
    return { r, ended: await Promise.race([ended, sleep(1_000)]) };
  };

  test('4429 before any frame: the refusal is the stream’s answer, and the next relay is never dialled', async () => {
    const { r, ended } = await streamOver(
      { kind: 'absent', code: RELAY_CLOSE_CODES.rendezvousBusy },
      network => network.openSocket,
    );

    expect(ended).toBe('no daemon holds this rendezvous');
    expect(hostsOf(r.network.dialled)).toEqual([RELAY_HOST]);
    r.fx.layer.close();
  });

  test('4429 after the rendezvous said ready, before acceptance: the refusal reaches the stream, nothing walks on', async () => {
    const { r, ended } = await streamOver({ kind: 'carries', carrier: 'relay' }, network => url => {
      const real = network.openSocket(url);
      return new URL(url).host === RELAY_HOST ? refusesAtHello(real) : real;
    });

    expect(ended).toBe('session limit reached');
    expect(hostsOf(r.network.dialled)).toEqual([RELAY_HOST]);
    r.fx.layer.close();
  });

  test('an ordinary unreachable stream session still falls through to the next relay', async () => {
    const { r } = await streamOver({ kind: 'dead' }, network => network.openSocket);

    expect(hostsOf(r.network.dialled)).toEqual([RELAY_HOST, RELAY_TWO_HOST]);
    r.fx.layer.close();
  });
});
