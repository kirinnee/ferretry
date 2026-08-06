/**
 * The carrier decision, the §14 translation, and the socket adapter.
 *
 * The question every case here answers is the same one: when something does not
 * work, does this code say so, or does it hand somebody a connection that looks
 * live? Direct-first ordering, a daemon that ANSWERED rather than failed, a
 * rendezvous that says nothing at all, an answer that does not fit — each has a
 * different right behaviour and each has been the wrong one somewhere.
 */

import { describe, it } from 'bun:test';
import { HEARTBEAT_GRACE_SECONDS, HEARTBEAT_SECONDS, RELAY_CLOSE_CODES } from '@ferretry/relay';
import should from 'should';
import { daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import {
  browserRelayDial,
  DaemonCarrierRouter,
  openRelaySession,
  RelayOversizeError,
  relayResponse,
  relayTunnelRequest,
} from '../../src/lib/relay-carrier.ts';
import { RelaySessionError } from '../../src/lib/relay-session.ts';
import { autoDial, newDaemonIdentity, relayCrypto, ScriptedSocket, settle } from '../support/relay.ts';

const DAEMON_URL = 'https://studio.example';
const RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };
const DEVICE_TOKEN = 'fy_device_secret';

/** A heartbeat schedule that fires nothing, and records what was asked for. */
const idleHeartbeat = (): { schedule: (tick: () => void, interval: number) => () => void; intervals: number[] } => {
  const intervals: number[] = [];
  return {
    intervals,
    schedule: (_tick, interval) => {
      intervals.push(interval);
      return () => undefined;
    },
  };
};

describe('turning a daemon request into a §14 record', () => {
  it('should carry the path, repeated query parameters, headers and a text body', () => {
    const record = relayTunnelRequest(`${DAEMON_URL}/v1/sessions?sessionId=a&sessionId=b`, {
      method: 'post',
      headers: { 'content-type': 'application/json', authorization: 'Bearer leaked' },
      body: '{"ok":true}',
    });
    should(record).eql({
      method: 'POST',
      path: '/v1/sessions',
      query: [
        ['sessionId', 'a'],
        ['sessionId', 'b'],
      ],
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
  });

  it('should default to GET and omit every field §14 makes optional', () => {
    should(relayTunnelRequest(`${DAEMON_URL}/v1/projects`)).eql({ method: 'GET', path: '/v1/projects' });
    should(relayTunnelRequest(`${DAEMON_URL}/v1/projects`, { body: null })).eql({
      method: 'GET',
      path: '/v1/projects',
    });
  });

  it('should refuse a body this envelope cannot carry rather than drop it', () => {
    should(() => relayTunnelRequest(`${DAEMON_URL}/v1/upload`, { body: new Blob(['bytes']) })).throw(/must be text/u);
  });
});

describe('turning a §14 answer into a Response', () => {
  it('should carry the status, headers and body', async () => {
    const response = relayResponse({ kind: 'response', status: 201, headers: { etag: 'w/1' }, body: 'made' });
    should(response.status).equal(201);
    should(response.headers.get('etag')).equal('w/1');
    should(await response.text()).equal('made');
  });

  it('should give a bodyless status no body, because the constructor refuses one', async () => {
    should(await relayResponse({ kind: 'response', status: 204, headers: {}, body: '' }).text()).equal('');
  });

  it('should refuse an oversize answer rather than invent a status for it', () => {
    const thrown = should(() => relayResponse({ kind: 'oversize', status: 200, byteLength: 402_641 })).throw(
      /402641 bytes/u,
    );
    should(thrown).be.ok();
    let caught: unknown;
    try {
      relayResponse({ kind: 'oversize', status: 200, byteLength: 9 });
    } catch (reason) {
      caught = reason;
    }
    should(caught).be.instanceof(RelayOversizeError);
    should((caught as RelayOversizeError).byteLength).equal(9);
    should((caught as RelayOversizeError).status).equal(200);
  });
});

interface RelayEnd {
  readonly code: number;
  readonly reason: string;
}

describe('the browser WebSocket adapter', () => {
  class FakeWebSocket {
    static last: FakeWebSocket | undefined;
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    readonly sent: unknown[] = [];
    closed: { code: number; reason: string } | null = null;
    constructor(readonly url: string) {
      FakeWebSocket.last = this;
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    close(code: number, reason: string): void {
      this.closed = { code, reason };
    }
  }

  const withFakeSocket = <T>(body: () => T): T => {
    const original = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    try {
      return body();
    } finally {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    }
  };

  /** The four things the adapter does with one socket, plus what it forwards back. */
  const dialFake = (
    body: (socket: FakeWebSocket, adapted: ReturnType<typeof browserRelayDial>, ends: RelayEnd[]) => void,
    url = 'wss://relay.example/v1/rendezvous/fy_daemon_x/client',
  ): void => {
    withFakeSocket(() => {
      const adapted = browserRelayDial(url);
      const socket = FakeWebSocket.last;
      if (socket === undefined) throw new Error('no socket was constructed');
      const ends: RelayEnd[] = [];
      adapted.onClose = (code, reason) => ends.push({ code, reason });
      body(socket, adapted, ends);
    });
  };

  it('should read binary frames as bytes and pass exactly two text messages through', () => {
    dialFake((socket, adapted) => {
      // Blob is the browser default and its read is asynchronous, so a frame would
      // arrive out of order — which §7 turns into a torn-down session.
      should(socket.binaryType).equal('arraybuffer');

      const opened: string[] = [];
      const texts: string[] = [];
      const binaries: Uint8Array[] = [];
      adapted.onOpen = () => opened.push('open');
      adapted.onText = text => texts.push(text);
      adapted.onBinary = bytes => binaries.push(bytes);

      socket.onopen?.();
      socket.onmessage?.({ data: 'fy-ping' });
      socket.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });

      should(opened).eql(['open']);
      should(texts).eql(['fy-ping']);
      should(binaries).have.length(1);
      should([...(binaries[0] ?? [])]).eql([1, 2, 3]);

      adapted.send(new Uint8Array([9]));
      adapted.sendText('fy-pong');
      adapted.close(1000, 'done');
      should(socket.sent).have.length(2);
      should(socket.closed).eql({ code: 1000, reason: 'done' });
    });
  });

  it('should refuse a message of an unknown type and stop listening to that carrier', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onopen?.();
      socket.onmessage?.({ data: 42 });
      should(ends).have.length(1);
      should(ends[0]?.code).equal(RELAY_CLOSE_CODES.protocolError);
      should(ends[0]?.reason).containEql('unknown type');
      // Reporting it and then going on reading would keep a carrier that is
      // improvising on this channel.
      should(socket.closed?.code).equal(RELAY_CLOSE_CODES.protocolError);
    });
  });

  /**
   * `failed (0)` was the whole complaint, and `0` is not a close code — it is the
   * absence of one, invented by the old adapter's `onerror` handler, which then
   * latched first and threw away the real code in the `close` event behind it.
   *
   * What a browser genuinely knows about a failed rendezvous socket is whether the
   * HANDSHAKE COMPLETED, and these two cases are the two different failures that
   * distinction separates.
   */
  it('should say a handshake never completed, rather than reporting a code of zero', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onerror?.();
      socket.onclose?.({ code: 1006, reason: '' });

      should(ends).have.length(1);
      should(ends[0]?.code).equal(1006);
      should(ends[0]?.reason).containEql('could not open a socket to wss://relay.example');
      should(ends[0]?.reason).containEql('the handshake never completed');
      // The fingerprint addresses the rendezvous and belongs on a pairing screen, not
      // in a sentence a reader may paste into an issue.
      should(ends[0]?.reason).not.containEql('fy_daemon_x');
    });
  });

  it('should distinguish a socket that died mid-session from one that never opened', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onopen?.();
      socket.onclose?.({ code: 1006, reason: '' });

      should(ends[0]?.code).equal(1006);
      should(ends[0]?.reason).containEql('was carrying this session');
    });
  });

  it('should pass a close frame the rendezvous actually sent through untouched', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onopen?.();
      socket.onclose?.({ code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'no daemon holds this rendezvous' });

      should(ends).eql([{ code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'no daemon holds this rendezvous' }]);
    });
  });

  /**
   * The spec fires `close` after `error`, so this timer normally reports nothing. It
   * exists because the alternative to a close that never arrives is the 45-second
   * handshake deadline, and a reader owed an answer the browser already had should
   * not wait three quarters of a minute for it.
   */
  it('should still answer when the close event the spec promises never arrives', async () => {
    let captured: RelayEnd[] = [];
    dialFake((socket, _adapted, ends) => {
      socket.onerror?.();
      captured = ends;
      should(ends).be.empty();
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    should(captured).have.length(1);
    should(captured[0]?.code).equal(1006);
    should(captured[0]?.reason).containEql('the handshake never completed');
  });
});

describe('opening one relayed session', () => {
  it('should refuse a fingerprint no rendezvous can address', async () => {
    const daemon = daemonConnection({ daemonId: 'not-a-fingerprint', baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    await should(
      openRelaySession({ crypto: relayCrypto, dial: () => new ScriptedSocket(), daemon, method: RELAY }),
    ).be.rejectedWith(/cannot address a rendezvous/u);
  });

  it('should authenticate, then arm a heartbeat and disarm the opening deadline', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const heartbeat = idleHeartbeat();
    const auto = autoDial(identity);
    const session = await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: heartbeat.schedule,
    });
    should(session.live()).be.true();
    // The opening deadline is §8's eviction window; the heartbeat is §8's interval.
    should(heartbeat.intervals).eql([HEARTBEAT_GRACE_SECONDS * 1_000, HEARTBEAT_SECONDS * 1_000]);
  });

  it('should refuse a rendezvous that neither opens a session nor closes the socket', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    let fire: (() => void) | undefined;
    const socket = new ScriptedSocket();
    const opening = openRelaySession({
      crypto: relayCrypto,
      dial: () => socket,
      daemon,
      method: RELAY,
      heartbeat: tick => {
        fire ??= tick;
        return () => undefined;
      },
    });
    fire?.();
    const refusal = await opening.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(RelaySessionError);
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
    should(socket.closed?.code).equal(RELAY_CLOSE_CODES.heartbeatTimeout);
  });

  it('should surface the heartbeat and text the carrier sends through the live session', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    let beat: (() => void) | undefined;
    const auto = autoDial(identity);
    await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: (tick, interval) => {
        if (interval === HEARTBEAT_SECONDS * 1_000) beat = tick;
        return () => undefined;
      },
    });
    const socket = auto.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.onText?.('fy-ping');
    beat?.();
    should(socket.texts).eql(['fy-pong', 'fy-ping']);
    socket.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');
  });

  it('should arm real timers when no schedule is injected, and cancel them on close', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const auto = autoDial(identity);
    const session = await openRelaySession({ crypto: relayCrypto, dial: auto.dial, daemon, method: RELAY });
    should(session.live()).be.true();
    // The heartbeat is a real interval, so the socket close is what stops it. Leaving
    // it armed would keep this process alive for thirty seconds after the session died.
    auto.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'done');
    should(session.live()).be.false();
  });

  it('should refuse when the daemon rejects the device grant inside the channel', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const auto = autoDial(identity, { rejectDevice: true });
    const refusal = await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: () => () => undefined,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.authRejected);
  });
});

describe('the carrier router', () => {
  const routerFor = async (
    options: { relay?: RelayCarrier; network?: () => Promise<Response>; answer?: Parameters<typeof autoDial>[1] } = {},
  ) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      ...(options.relay === undefined
        ? {}
        : {
            carriers: [{ kind: 'direct' as const, daemonUrl: DAEMON_URL }, options.relay],
          }),
    });
    const auto = autoDial(identity, options.answer ?? {});
    const network = options.network;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      ...(network === undefined ? {} : { network: async () => await network() }),
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));
    return { router, daemon, auto };
  };

  it('should prefer direct and say so, without dialling a relay at all', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => new Response('direct', { status: 200 }),
    });
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('direct');
    should(auto.sockets).be.empty();
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over direct.');
  });

  it('should treat a status as an answer, not as a carrier failure', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => new Response('unhappy', { status: 503 }),
    });
    should((await router.fetch(`${DAEMON_URL}/v1/projects`)).status).equal(503);
    should(auto.sockets).be.empty();
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should announce a fresh connection once even when several requests reuse its winner', async () => {
    const connected: string[] = [];
    const { router, daemon } = await routerFor({ network: async () => new Response('busy', { status: 503 }) });
    const stop = router.onConnected(connection => connected.push(connection.daemonId));

    should((await router.fetch(`${DAEMON_URL}/v1/projects`)).status).equal(503);
    should((await router.fetch(`${DAEMON_URL}/v1/usage`)).status).equal(503);

    should(connected).eql([daemon.daemonId]);
    stop();
  });

  it('should send a direct request to the published carrier while preserving its path and query', async () => {
    const seen: string[] = [];
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: 'https://other-direct.example' }],
    });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      network: async input => {
        seen.push(String(input));
        return new Response('direct');
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    should(await (await router.fetch(`${DAEMON_URL}/v1/projects?page=2`)).text()).equal('direct');
    should(seen).eql(['https://other-direct.example/v1/projects?page=2']);
  });

  it('should fall back to the relay for a replay-safe GET when direct cannot be reached, and say why', async () => {
    const changes: number[] = [];
    const { router, daemon } = await routerFor({
      relay: RELAY,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const unsubscribe = router.subscribe(() => changes.push(1));
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('{}');
    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.true();
    should(choice?.reason).match(/^Connected over hosted relay because direct was not reachable/u);
    should(changes.length).be.greaterThan(0);
    unsubscribe();

    // The winner keeps the traffic: direct is not re-probed on every call.
    should((await router.fetch(`${DAEMON_URL}/v1/usage`)).status).equal(200);
    await settle(5);
  });

  it('should report a failed fresh mutation without replaying it over a relay', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const bodies: string[] = [];
    let dials = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      heartbeat: () => () => undefined,
      network: async (_input, init) => {
        bodies.push(String(init?.body));
        throw new TypeError('the daemon accepted the request but its response was lost');
      },
      dial: () => {
        dials += 1;
        return autoDial(identity).dial();
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));
    const mutation = { method: 'POST', body: JSON.stringify({ prompt: 'start one session' }) };

    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejectedWith(
      'the daemon accepted the request but its response was lost',
    );

    should(bodies).eql([mutation.body]);
    should(dials).equal(0);
    should(router.choice(daemon.daemonId)?.ok).be.false();
  });

  it('should walk multiple relays in published order until one transports an answer', async () => {
    const identity = await newDaemonIdentity();
    const first: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-one.example', operator: 'self' };
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, first, second],
    });
    const live = autoDial(identity);
    const dialled: string[] = [];
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('direct refused');
      },
      dial: url => {
        const hostname = new URL(url).hostname;
        dialled.push(hostname);
        if (hostname === 'relay-one.example') {
          const refused = new ScriptedSocket();
          queueMicrotask(() => refused.onClose?.(1006, 'first rendezvous did not answer'));
          return refused;
        }
        return live.dial();
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(dialled).eql(['relay-one.example', 'relay-two.example']);
    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.true();
    if (choice?.ok) {
      should(choice.method).eql(second);
      should(choice.passedOver.map(skip => skip.method)).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }, first]);
    }
  });

  it('should refuse plainly when no carrier works, naming each one it tried', async () => {
    const { router, daemon } = await routerFor({
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await should(router.fetch(`${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);
    should(router.choice(daemon.daemonId)?.ok).be.false();
  });

  /**
   * The disclosure a reader actually saw named `Direct` twice and `Hosted relay`
   * twice for one daemon. Refused carriers were accumulated on the shared entry
   * rather than kept to the attempt that made them, and an app load issues several
   * daemon-bound requests at once — so each one appended its own copy.
   */
  it('should name each carrier once when several requests fail at the same time', async () => {
    const { router, daemon } = await routerFor({
      relay: RELAY,
      answer: { rejectDevice: true },
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const attempts = ['/v1/projects', '/v1/usage', '/v1/sessions'].map(path =>
      router.fetch(`${DAEMON_URL}${path}`).then(
        () => undefined,
        () => undefined,
      ),
    );
    await Promise.all(attempts);

    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.false();
    should(choice?.passedOver.map(skip => skip.method.kind)).eql(['direct', 'relay']);
  });

  it('should keep the first successful direct winner when a concurrent walk later reaches a relay', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    let releaseFirstDirect = (): void => {};
    const firstDirect = new Promise<void>(resolve => {
      releaseFirstDirect = resolve;
    });
    let releaseSecondDirect = (): void => {};
    const secondDirect = new Promise<void>(resolve => {
      releaseSecondDirect = resolve;
    });
    let secondStarted = (): void => {};
    const secondAttemptStarted = new Promise<void>(resolve => {
      secondStarted = resolve;
    });
    let directAttempts = 0;
    let dials = 0;
    const auto = autoDial(identity);
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      heartbeat: () => () => undefined,
      network: async () => {
        directAttempts += 1;
        if (directAttempts === 1) {
          await firstDirect;
          return new Response('direct first');
        }
        if (directAttempts === 2) {
          secondStarted();
          await secondDirect;
          throw new TypeError('the second direct request lost its transport');
        }
        return new Response('direct later');
      },
      dial: () => {
        dials += 1;
        return auto.dial();
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    const first = router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const second = router.send(daemon, `${DAEMON_URL}/v1/usage`);
    await secondAttemptStarted;

    releaseFirstDirect();
    should(await (await first).text()).equal('direct first');
    releaseSecondDirect();
    should((await second).status).equal(200);

    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the first direct answer was not retained as the winner');
    should(choice.method).eql({ kind: 'direct', daemonUrl: DAEMON_URL });
    should(await (await router.send(daemon, `${DAEMON_URL}/v1/sessions`)).text()).equal('direct later');
    should(dials).equal(1);
  });

  /**
   * A round in which nothing worked used to poison the entry for the life of the
   * pairing: every later request found both carriers already on the refused list,
   * skipped the loop entirely and threw without trying anything. Coming back onto
   * the network the daemon is on changed nothing, and neither did the relay coming
   * back up — the reader had to re-pair to recover from a transient failure.
   */
  it('should try again after a round in which no carrier worked', async () => {
    let reachable = false;
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
    });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: autoDial(identity, {}).dial,
      heartbeat: () => () => undefined,
      network: async () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return new Response('back', { status: 200 });
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    await should(router.fetch(`${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);
    should(router.choice(daemon.daemonId)?.ok).be.false();

    reachable = true;
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('back');
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should not try another carrier once the daemon itself has answered', async () => {
    const { router } = await routerFor({
      relay: RELAY,
      answer: { oversize: true },
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await should(router.fetch(`${DAEMON_URL}/v1/sessions`)).be.rejectedWith(RelayOversizeError);
  });

  it('should send everything not bound to a paired daemon straight to the network', async () => {
    const seen: string[] = [];
    const { router } = await routerFor({
      network: async () => {
        seen.push('network');
        return new Response('elsewhere');
      },
    });
    should(await (await router.fetch('https://relay.example/v1/default-relay')).text()).equal('elsewhere');
    should(await (await router.fetch('not a url')).text()).equal('elsewhere');
    should(await (await router.fetch(new Request(`${DAEMON_URL}/v1/pair`, { method: 'POST' }))).text()).equal(
      'elsewhere',
    );
    should(seen).have.length(3);
  });

  it('should drop a daemon carrier when the pairing changes, and again when it is unpaired', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    should(auto.sockets).have.length(1);

    // A re-pair: same daemon, new grant. Nothing live may survive it.
    const repaired = { ...daemon, deviceToken: 'fy_device_rotated' };
    await router.send(repaired, `${DAEMON_URL}/v1/projects`);
    should(auto.sockets).have.length(2);

    router.clearDaemon(daemon.daemonId);
    should(router.choice(daemon.daemonId)).be.undefined();
    // Clearing a daemon nobody routed is not an error, it is nothing to do.
    router.clearDaemon(daemon.daemonId);
    await settle(5);
  });

  /**
   * A WINNER THAT STOPS CARRYING MUST NOT TAKE THE REQUEST WITH IT TO THE NEXT ADDRESS.
   *
   * The remembered carrier failing says nothing about whether the daemon applied what
   * it was sent — §9 says frames in flight are gone, and a direct transport failure
   * does not say when it happened either. Walking on to the relay inside the same call
   * would re-send the body, and the request in this case is the one that costs: a
   * second `POST /v1/sessions` is a second session on a daemon that took the first.
   *
   * The recovery is the NEXT request, which finds nothing remembered and walks the
   * set from the top.
   */
  it('should forget a winner that stopped carrying and refuse to replay the request over another carrier', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const live = autoDial(identity);
    let dials = 0;
    let directAttempts = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      heartbeat: () => () => undefined,
      network: async () => {
        directAttempts += 1;
        throw new TypeError('Failed to fetch');
      },
      dial: () => {
        dials += 1;
        if (dials === 1) return live.dial();
        const refused = new ScriptedSocket();
        queueMicrotask(() => refused.onClose?.(1006, 'the rendezvous went away'));
        return refused;
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(directAttempts).equal(1);

    // The session that won is evicted, so the remembered relay must re-dial — and the
    // rendezvous is gone by the time it does.
    live.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');
    const mutation = { method: 'POST', body: JSON.stringify({ prompt: 'start one session' }) };
    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejected();

    // Direct was not tried with that body: the failure is reported, not routed around.
    should(directAttempts).equal(1);
    should(router.choice(daemon.daemonId)).be.undefined();

    // And the next request is the deterministic walk again, direct first.
    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejected();
    should(directAttempts).equal(2);
    await settle(5);
  });

  /**
   * `/v1/carriers` is read as soon as a carrier answers, so the FIRST successful
   * connection is routinely followed by a new connection object for the same daemon,
   * the same address and the same grant. Treated as a re-pair, it tore down the very
   * session that had just carried that read — and on the network the relay exists for,
   * the replacement costs a second handshake to arrive back where it started.
   */
  it('should keep the live session and its winner when a refresh republishes the winning carrier', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(auto.sockets).have.length(1);
    const winner = router.choice(daemon.daemonId);

    const refreshed = daemonConnection({
      ...daemon,
      carriers: [
        { kind: 'direct', daemonUrl: DAEMON_URL },
        RELAY,
        { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' },
      ],
    });
    should((await router.send(refreshed, `${DAEMON_URL}/v1/usage`)).status).equal(200);

    should(auto.sockets).have.length(1);
    should(router.choice(daemon.daemonId)).equal(winner);
    await settle(5);
  });

  it('should close a rendezvous the daemon withdrew and walk the set again', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const socket = auto.sockets[0];
    const withdrawn = daemonConnection({ ...daemon, carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }] });

    await should(router.send(withdrawn, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(
      /No configured connection worked/u,
    );
    await settle(5);

    // The winner is not in the published set any more, so nothing is remembered and
    // the session on the withdrawn rendezvous is not left holding the device grant.
    should(router.choice(daemon.daemonId)?.ok).be.false();
    should(socket?.closed).be.ok();
  });

  /**
   * A DAEMON THAT PUBLISHES NO RENDEZVOUS IS NOT A DAEMON THAT IS DIRECT-ONLY.
   *
   * A pairing stored before the carrier set existed names one address: the direct one it arrived
   * over. The relay it was actually reached over, away from that network, came from the hosted
   * advertisement and was never written down — so a browser that offered such a record only its
   * direct address would take that path away, and the refresh that would teach it back needs a
   * connection it can no longer make. The address is therefore tried at DIAL time, last, and never
   * enters the cache: withdraw it and the next load offers nothing.
   */
  it('should dial the current hosted address for a daemon that published no rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const auto = autoDial(identity);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
      hostedRelay: async () => {
        asked += 1;
        return RELAY.relayUrl;
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    should(asked).equal(1);
    should(auto.sockets).have.length(1);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the fallback did not carry the request');
    should(choice.method).eql(RELAY);
    // Dialled, not adopted: the connection this router was handed still names one carrier, so
    // nothing a reload could inherit was written and the kill switch stays immediate.
    should(daemon.carriers).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }]);
    await settle(5);
  });

  it('should dial nothing for that daemon once the directory has no address to give', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const auto = autoDial(identity);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
      // `relayUrl: null`, an unreachable directory and a build carrying none arrive as one answer.
      hostedRelay: async () => {
        asked += 1;
        return undefined;
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);

    // Asked and answered "nothing", which is the boundary being enforced rather than skipped.
    should(asked).equal(1);
    should(auto.sockets).have.length(0);
    should(router.choice(daemon.daemonId)?.ok).be.false();
  });

  it('should never ask the directory for a daemon that authored its own rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const auto = autoDial(identity);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
      hostedRelay: async () => {
        asked += 1;
        return RELAY.relayUrl;
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    // The daemon SAID where it can be reached, so its answer is the whole answer — and a walk that
    // waited on the directory anyway would put a network read in front of every failed direct
    // attempt for a daemon that never needed one.
    should(asked).equal(0);
    should(auto.sockets).have.length(1);
    await settle(5);
  });

  /**
   * THE TWO OMISSIONS ARE NOT THE SAME FACT, which is why only one of them is retained.
   *
   * A daemon publishes no direct entry when it cannot EXPRESS one — a wildcard bind names no
   * address, a `publicUrl` with a proxy path is not an origin a device may store — and it is still
   * answering on the address this browser is talking to. Dropping that would put a reachable daemon
   * behind a rendezvous, and a rendezvous that later goes away would strand a device that could
   * have reached it all along. It is live state only: nothing is written, and it survives exactly
   * as long as it keeps carrying.
   */
  it('should keep carrying over a direct winner the daemon can no longer name, and hand back to its set when that stops', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceToken: DEVICE_TOKEN });
    const auto = autoDial(identity);
    let directWorks = true;
    let directCalls = 0;
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        directCalls += 1;
        if (!directWorks) throw new TypeError('Failed to fetch');
        return new Response('direct');
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));
    should(await (await router.send(daemon, `${DAEMON_URL}/v1/projects`)).text()).equal('direct');

    // The refresh names only the rendezvous this daemon dials, over the very address it omits.
    const relayOnly = daemonConnection({ ...daemon, carriers: [RELAY] });
    should(await (await router.send(relayOnly, `${DAEMON_URL}/v1/usage`)).text()).equal('direct');
    should(auto.sockets).have.length(0);

    // And the moment it stops carrying it is forgotten like any other winner: the next walk is the
    // daemon's own set and nothing re-offers the address it did not publish.
    directWorks = false;
    await should(router.send(relayOnly, `${DAEMON_URL}/v1/usage`)).be.rejected();
    should((await router.send(relayOnly, `${DAEMON_URL}/v1/usage`)).status).equal(200);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the published rendezvous did not take over');
    should(choice.method).eql(RELAY);
    const settled = directCalls;
    should((await router.send(relayOnly, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(directCalls).equal(settled);
    await settle(5);
  });

  /**
   * A WALK OUTLIVES THE PAIRING IT WAS ISSUED AGAINST, and it must not keep dialling on its behalf.
   *
   * A walk takes as long as its failures do, and an unpair, a re-pair or a republish can land between
   * any two attempts. Every address after that point would be dialled with the connection this walk
   * captured — the old base URL, the OLD DEVICE TOKEN, a rendezvous the daemon has since withdrawn —
   * which is precisely what a cleared pairing exists to stop. So the walk is refused rather than
   * advanced: a stale entry says nothing about whether an address works, and reading it as a transport
   * failure is what let a replay-safe request carry a revoked credential to every remaining carrier
   * and then to the hosted fallback.
   */
  it('should abort the walk rather than reach the first relay when a pending direct attempt is unpaired', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const auto = autoDial(identity);
    let releaseDirect = (): void => {};
    const directPending = new Promise<void>(resolve => {
      releaseDirect = resolve;
    });
    let directStarted = (): void => {};
    const directAttempted = new Promise<void>(resolve => {
      directStarted = resolve;
    });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        directStarted();
        await directPending;
        throw new TypeError('Failed to fetch');
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    const inflight = router.send(daemon, `${DAEMON_URL}/v1/projects`);
    await directAttempted;
    router.clearDaemon(daemon.daemonId);
    releaseDirect();

    await should(inflight).be.rejectedWith(/re-paired, unpaired or republished/u);
    await settle(5);
    // The direct attempt failed for real, and the relay was still never dialled: advancing is what a
    // transport failure earns, and this walk had lost the right to it.
    should(auto.sockets).have.length(0);
    should(router.choice(daemon.daemonId)).be.undefined();
  });

  /**
   * THE SAME INVARIANT ONE LAYER DOWN: the session that was already opening.
   *
   * The pre-attempt check cannot see this one — the entry was current when the dial began — so the
   * fence after the handshake is what closes the socket, and the marked refusal is what stops the walk
   * from treating a live-but-orphaned session as one address that did not work. With a second relay
   * published, "does the walk continue" is a question with a visible answer: a second dial.
   */
  it('should close a session that opened into a cleared pairing and dial no further relay', async () => {
    const identity = await newDaemonIdentity();
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY, second],
    });
    const auto = autoDial(identity);
    const dialled: string[] = [];
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      // The unpair lands while the FIRST rendezvous is still shaking hands, which is the window the
      // pre-attempt check is blind to by construction.
      dial: url => {
        dialled.push(url);
        const socket = auto.dial();
        if (dialled.length === 1) router.clearDaemon(daemon.daemonId);
        return socket;
      },
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    // The caller is told what actually happened — a session was opening and has been ended — rather
    // than "no carrier worked", which is what an unmarked failure would have degraded into once the
    // walk had swept the remaining addresses and found nothing to report.
    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(/rendezvous session was opening/u);
    await settle(5);

    // One dial, its session closed, and the second published rendezvous never touched.
    should(dialled).have.length(1);
    should(auto.sockets).have.length(1);
    should(auto.sockets[0]?.closed).be.ok();
    should(dialled).not.containEql(second.relayUrl);
  });

  it('should refuse a walk whose entry a carrier refresh replaced, while the refreshed one answers', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const republished = daemonConnection({
      ...daemon,
      carriers: [
        { kind: 'direct', daemonUrl: DAEMON_URL },
        RELAY,
        { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' },
      ],
    });
    const auto = autoDial(identity);
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    const stale = router.send(daemon, `${DAEMON_URL}/v1/projects`);
    // The republish installs a new entry, so the walk above is now describing a set the daemon has
    // already corrected — it stops, and this one carries the traffic.
    const current = router.send(republished, `${DAEMON_URL}/v1/usage`);

    await should(stale).be.rejectedWith(/re-paired, unpaired or republished/u);
    should((await current).status).equal(200);
    await settle(5);

    // One socket, the refreshed walk's own, and it is still live.
    should(auto.sockets).have.length(1);
    should(auto.sockets[0]?.closed).be.null();
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should re-dial rather than reuse a session the carrier has dropped', async () => {
    const { router, daemon, auto } = await routerFor({
      relay: RELAY,
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const socket = auto.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(auto.sockets).have.length(2);
  });

  it('should default its network and its dial to the browser when neither is injected', async () => {
    const router = new DaemonCarrierRouter({ crypto: relayCrypto });
    // No lookup has been supplied, so nothing is a paired daemon and this reaches the
    // default network — which is the real `fetch`, refused here by an unroutable host.
    await should(router.fetch('http://127.0.0.1:1/v1/projects')).be.rejected();
  });

  /**
   * THE ONE PROPERTY AN INJECTED FETCHER CANNOT PROVE ABOUT ITSELF.
   *
   * Every other case in this file hands the router an arrow function, and an arrow
   * has no receiver to be wrong about — so the suite stayed green while a real
   * browser answered `Failed to execute 'fetch' on 'Window': Illegal invocation` to
   * every daemon-bound request. `fetch` is a WebIDL operation and WebIDL refuses a
   * call whose receiver is neither the global nor absent; `this.#network(url, init)`
   * makes the router the receiver.
   *
   * So the fetcher here is deliberately NOT an arrow: it records its own `this`, and
   * the assertion is that the router never appears there. On main this fails with the
   * receiver set to the `DaemonCarrierRouter` instance — which is exactly the browser
   * failure, reproduced without a browser.
   */
  it('should never invoke an injected network with the router as its receiver', async () => {
    const receivers: unknown[] = [];
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceToken: DEVICE_TOKEN,
    });
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: autoDial(identity, {}).dial,
      heartbeat: () => () => undefined,
      network: function (this: unknown): Promise<Response> {
        receivers.push(this);
        return Promise.resolve(new Response('ok'));
      },
    });
    router.resolveByOrigin(origin => (origin === DAEMON_URL ? daemon : undefined));

    // Both ways in: an origin no paired daemon owns goes straight to the network, and
    // a paired daemon's direct carrier goes through the same field.
    await router.fetch('https://unpaired.example/v1/anything');
    await router.fetch(`${DAEMON_URL}/v1/projects`);

    should(receivers).have.length(2);
    for (const receiver of receivers) {
      should(receiver).not.equal(router);
      // ES modules are strict, so a call with no receiver has `undefined`, not the global.
      should(receiver).be.undefined();
    }
  });
});
