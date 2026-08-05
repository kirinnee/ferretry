/**
 * The carrier decision, the §14 translation, and the socket adapter.
 *
 * The question every case here answers is the same one: when something does not
 * work, does this code say so, or does it hand somebody a connection that looks
 * live? Direct-first ordering, a daemon that ANSWERED rather than failed, a
 * rendezvous that says nothing at all, an answer that does not fit — each has a
 * different right behaviour and each has been the wrong one somewhere.
 */

import { HEARTBEAT_GRACE_SECONDS, HEARTBEAT_SECONDS, RELAY_CLOSE_CODES } from '@ferretry/relay';
import { describe, it } from 'bun:test';
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
      ...(options.relay === undefined ? {} : { relay: options.relay }),
    });
    const auto = autoDial(identity, options.answer ?? {});
    const router = new DaemonCarrierRouter({
      crypto: relayCrypto,
      dial: auto.dial,
      heartbeat: () => () => undefined,
      ...(options.network === undefined ? {} : { network: async () => await options.network!() }),
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

  it('should fall back to the relay when direct cannot be reached, and say why', async () => {
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

  it('should refuse plainly when no carrier works, naming each one it tried', async () => {
    const { router, daemon } = await routerFor({
      network: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await should(router.fetch(`${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);
    should(router.choice(daemon.daemonId)?.ok).be.false();
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
