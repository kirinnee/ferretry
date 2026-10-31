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
import {
  MAX_TUNNEL_BODY_BYTES,
  OLDER_APP_SENTENCE,
  OLDER_DAEMON_SENTENCE,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
} from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import { HEARTBEAT_GRACE_SECONDS, RELAY_CLOSE_CODES, SESSION_PROTOCOL_ID } from '@ferretry/relay';
import should from 'should';
import { daemonConnection, type RelayCarrier } from '../../src/lib/daemon-connection.ts';
import { daemonRequest } from '../../src/lib/daemon-transport.ts';
import { DeviceKeyMissingError, DeviceKeyUnreadableError } from '../../src/lib/device-keys.ts';
import {
  AppOutdatedError,
  browserRelayDial,
  DaemonCarrierRouter,
  type DaemonCarrierRouterOptions,
  DaemonOutdatedError,
  DEVICE_NOT_ACCEPTED_SENTENCE,
  DeviceNotAcceptedError,
  DIRECT_SESSION_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  openRelaySession,
  relayResponse,
  relayTunnelRequest,
  requestLane,
} from '../../src/lib/relay-carrier.ts';
import { RelaySessionError, RelayStreamRefusedError } from '../../src/lib/relay-session.ts';
import type { PromptOrigin } from '../../src/lib/step-up-gate.ts';
import {
  autoDial,
  newDaemonIdentity,
  newerDaemonDial,
  olderDaemonDial,
  relayCrypto,
  ScriptedSocket,
  settle,
  testDevice,
} from '../support/relay.ts';

/** A browser that can decode a gzip body asks for one on every GET (§14, "A compressed answer"). */
const GZIP = { 'accept-encoding': 'gzip' } as const;

const DAEMON_URL = 'https://studio.example';
const RELAY: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };
const DEVICE_ID = 'fy_device_id_routerTestDevice00000001';
const device = await testDevice(DEVICE_ID);
const deviceKey: DaemonCarrierRouterOptions['deviceKey'] = async () => device.claim.key;

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

  it('should carry a relayed 304 through the typed client as the transcript it already holds', async () => {
    // Arrange
    const answers = [
      relayResponse({ kind: 'response', status: 200, headers: { etag: '"t1"' }, body: 'the transcript' }),
      relayResponse({ kind: 'response', status: 304, headers: { etag: '"t1"' }, body: '' }),
    ];
    const relayed: ReturnType<typeof relayTunnelRequest>[] = [];
    const client = await FyApiClient.connect({
      baseUrl: DAEMON_URL,
      token: 'carried-by-the-device-session',
      version: '0.0.0',
      transport: {
        send: async (url, init) => {
          relayed.push(relayTunnelRequest(url, init));
          return answers.shift() ?? new Response(null, { status: 500 });
        },
      },
    });

    // Act
    const first = await client.logs('s1');
    const second = await client.logs('s1');

    // Assert
    should(first).equal('the transcript');
    should(second).equal('the transcript');
    should(relayed[0]?.headers).not.have.property('if-none-match');
    should(relayed[1]?.headers).have.property('if-none-match', '"t1"');
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
  it('should say a connection never opened, rather than reporting a code of zero', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onerror?.();
      socket.onclose?.({ code: 1006, reason: '' });

      should(ends).have.length(1);
      should(ends[0]?.code).equal(1006);
      should(ends[0]?.reason).containEql('could not open a connection to wss://relay.example');
      // One sentence serves direct and relayed dials, so it names no carrier.
      should(ends[0]?.reason).not.containEql('relay protocol');
      should(ends[0]?.reason).not.containEql('rendezvous');
      // The fingerprint addresses the rendezvous and belongs on a pairing screen, not
      // in a sentence a reader may paste into an issue.
      should(ends[0]?.reason).not.containEql('fy_daemon_x');
    });
  });

  it('should name the configured rendezvous when the address it dialled cannot be parsed', () => {
    dialFake((socket, _adapted, ends) => {
      socket.onerror?.();
      socket.onclose?.({ code: 1006, reason: '' });

      should(ends).have.length(1);
      should(ends[0]?.code).equal(1006);
      should(ends[0]?.reason).containEql('could not open a connection to the configured rendezvous');
    }, 'not a url at all');
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
    should(captured[0]?.reason).containEql('could not open a connection');
  });
});

describe('opening one session', () => {
  const mode = { kind: 'auth', device: device.claim } as const;

  it('should refuse a fingerprint no session can be checked against', async () => {
    const daemon = daemonConnection({ daemonId: 'not-a-fingerprint', baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    await should(
      openRelaySession({ crypto: relayCrypto, dial: () => new ScriptedSocket(), daemon, method: RELAY, mode }),
    ).be.rejectedWith(/cannot address a session/u);
    await should(
      openRelaySession({
        crypto: relayCrypto,
        dial: () => new ScriptedSocket(),
        daemon,
        method: { kind: 'direct', daemonUrl: DAEMON_URL },
        mode,
      }),
    ).be.rejectedWith(/cannot address a session/u);
  });

  it('should dial the daemon its own session route for a direct carrier, upgrading the scheme', async () => {
    const identity = await newDaemonIdentity();
    const auto = autoDial(identity);
    const dialled: string[] = [];
    for (const daemonUrl of ['https://studio.example', 'http://127.0.0.1:7431']) {
      const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: daemonUrl, deviceId: DEVICE_ID });
      await openRelaySession({
        crypto: relayCrypto,
        dial: url => {
          dialled.push(url);
          return auto.dial();
        },
        daemon,
        method: { kind: 'direct', daemonUrl },
        heartbeat: () => () => undefined,
        mode,
      });
    }
    should(dialled).eql([
      `wss://studio.example/v1/rendezvous/${identity.daemonId}/client`,
      `ws://127.0.0.1:7431/v1/rendezvous/${identity.daemonId}/client`,
    ]);
  });

  it('should authenticate, then arm a heartbeat and disarm the opening deadline', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const heartbeat = idleHeartbeat();
    const auto = autoDial(identity, { devicePublicKey: device.publicKey });
    const session = await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: heartbeat.schedule,
      mode,
    });
    should(session.live()).be.true();
    // The opening deadline is §8's eviction window; the keepalive runs inside §8's interval.
    should(heartbeat.intervals).eql([HEARTBEAT_GRACE_SECONDS * 1_000, KEEPALIVE_INTERVAL_MS]);
  });

  it('should refuse a rendezvous that neither opens a session nor closes the socket', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
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
      mode,
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
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    let beat: (() => void) | undefined;
    const auto = autoDial(identity);
    await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: (tick, interval) => {
        if (interval === KEEPALIVE_INTERVAL_MS) beat = tick;
        return () => undefined;
      },
      mode,
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
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const auto = autoDial(identity);
    const session = await openRelaySession({ crypto: relayCrypto, dial: auto.dial, daemon, method: RELAY, mode });
    should(session.live()).be.true();
    // The heartbeat is a real interval, so the socket close is what stops it. Leaving
    // it armed would keep this process alive for thirty seconds after the session died.
    auto.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'done');
    should(session.live()).be.false();
  });

  it('should refuse when the daemon refuses the device proof', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    // The daemon holds a DIFFERENT public key for this grant, which is what a stolen device id is.
    const auto = autoDial(identity, { devicePublicKey: (await testDevice()).publicKey });
    const refusal = await openRelaySession({
      crypto: relayCrypto,
      dial: auto.dial,
      daemon,
      method: RELAY,
      heartbeat: () => () => undefined,
      mode,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.authRejected);
  });
});

/** Which addresses a scripted network of carriers answers on. */
type Reach = (url: URL) => 'live' | 'refuse' | 'silent';

/**
 * A dial that plays a correct daemon on the addresses `reach` calls live, and a refused socket on the
 * rest — the same failure a browser sees for an address it cannot reach, closed with `1006`.
 */
const carriersFor = (identity: Awaited<ReturnType<typeof newDaemonIdentity>>, reach: Reach, answer = {}) => {
  const live = autoDial(identity, { devicePublicKey: device.publicKey, ...answer });
  const dialled: string[] = [];
  const dial = (url: string): ScriptedSocket => {
    dialled.push(url);
    // An address whose packets are dropped: the socket neither opens nor closes.
    if (reach(new URL(url)) === 'silent') return new ScriptedSocket();
    if (reach(new URL(url)) === 'refuse') {
      const refused = new ScriptedSocket();
      queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
      return refused;
    }
    return live.dial();
  };
  const hosts = (): string[] => dialled.map(url => new URL(url).hostname);
  return { dial, dialled, hosts, live };
};

const DIRECT_HOST = new URL(DAEMON_URL).hostname;
const directOnly: Reach = url => (url.hostname === DIRECT_HOST ? 'live' : 'refuse');
const relayOnly: Reach = url => (url.hostname === DIRECT_HOST ? 'refuse' : 'live');
const unreachable = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

describe('the carrier router', () => {
  const routerFor = async (
    options: {
      relay?: RelayCarrier;
      reach?: Reach;
      answer?: Parameters<typeof autoDial>[1];
      network?: DaemonCarrierRouterOptions['network'];
      deviceKey?: DaemonCarrierRouterOptions['deviceKey'];
      presence?: DaemonCarrierRouterOptions['presence'];
    } = {},
  ) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      ...(options.relay === undefined
        ? {}
        : { carriers: [{ kind: 'direct' as const, daemonUrl: DAEMON_URL }, options.relay] }),
    });
    const carriers = carriersFor(identity, options.reach ?? directOnly, options.answer ?? {});
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey: options.deviceKey ?? deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: options.network ?? unreachable,
      ...(options.presence === undefined ? {} : { presence: options.presence }),
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, identity, carriers, auto: carriers.live };
  };

  it('should prefer direct and say so, carrying the request inside a session with no credential in it', async () => {
    const { router, daemon, carriers, auto } = await routerFor({ relay: RELAY, answer: { body: 'direct' } });
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects?page=2`)).text()).equal('direct');
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.choice(daemon.daemonId)?.reason).equal('Connected over direct.');
    should(auto.requests).eql([
      { t: 'req', id: 1, method: 'GET', path: '/v1/projects', query: [['page', '2']], headers: GZIP },
    ]);
  });

  it('should carry an upload on a session of its own, so the polls beside it never wait behind it', async () => {
    const { router, carriers } = await routerFor({ answer: { body: 'ok' } });
    const upload = JSON.stringify({ base64: 'a'.repeat(40_000) });
    await router.fetch(`${DAEMON_URL}/v1/projects`);
    await router.fetch(`${DAEMON_URL}/v1/sessions/s1/attachments`, { method: 'POST', body: upload });
    await router.fetch(`${DAEMON_URL}/v1/sessions/s1/attachments`, { method: 'POST', body: upload });
    await router.fetch(`${DAEMON_URL}/v1/projects`);
    // One request session and one upload session, each reused: two dials, not four.
    should(carriers.dialled).have.length(2);
  });

  it('should route by the daemon a request was built for, never by the address two machines share', async () => {
    // Arrange — a second machine paired at the very same address, listed first as the newest pairing is.
    const { router, daemon, auto } = await routerFor({ answer: { body: 'this machine' } });
    const other = daemonConnection({ daemonId: 'fy_daemon_otherMachine', baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    router.resolvePaired(() => [other, daemon]);

    // Act
    const mine = daemonRequest(daemon, '/v1/machine');
    const answer = await router.fetch(mine.url, mine.init);

    // Assert
    should(await answer.text()).equal('this machine');
    should(auto.requests).eql([{ t: 'req', id: 1, method: 'GET', path: '/v1/machine', headers: GZIP }]);
  });

  it('should never hand a request for an unpaired daemon to the paired one that shares its address', async () => {
    // Arrange
    let overNetwork = 0;
    const { router, daemon, carriers } = await routerFor({
      network: async () => {
        overNetwork += 1;
        return new Response('plain');
      },
    });
    const unpaired = daemonConnection({ daemonId: 'fy_daemon_unpairedOne', baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const stale = daemonRequest(unpaired, '/v1/machine');

    // Act
    const answer = await router.fetch(stale.url, stale.init);

    // Assert — the plain network, as any unpaired address; no session to the paired machine was opened.
    should(await answer.text()).equal('plain');
    should(overNetwork).equal(1);
    should(carriers.hosts()).eql([]);
    should(router.choice(daemon.daemonId)).be.undefined();
  });

  it('should refuse an unbound request when two paired machines share its address, and route it when one does', async () => {
    // Arrange
    let overNetwork = 0;
    const { router, daemon } = await routerFor({
      answer: { body: 'the one owner' },
      network: async () => {
        overNetwork += 1;
        return new Response('plain');
      },
    });
    const twin = daemonConnection({ daemonId: 'fy_daemon_twinMachine', baseUrl: DAEMON_URL, deviceId: DEVICE_ID });

    // Act + Assert — one owner: routed to it.
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('the one owner');
    // No owner: the plain network, as before.
    should(await (await router.fetch('https://nobody.example.test/v1/projects')).text()).equal('plain');
    // Two owners: refused rather than guessed.
    router.resolvePaired(() => [twin, daemon]);
    await should(router.fetch(`${DAEMON_URL}/v1/projects`)).be.rejectedWith(
      `2 paired machines share ${DAEMON_URL}, and this request does not say which one it is for`,
    );
    should(overNetwork).equal(1);
  });

  it('should mark a request presence only while a person is at the device', async () => {
    // The daemon counts only a marked request as use, so a tab renewing by itself never resets the idle
    // clock. The mark is read per request, not once per session.
    let present = true;
    const { router, auto } = await routerFor({ presence: () => present });
    await router.fetch(`${DAEMON_URL}/v1/projects`);
    present = false;
    await router.fetch(`${DAEMON_URL}/v1/projects`);
    should(auto.requests).eql([
      { t: 'req', id: 1, method: 'GET', path: '/v1/projects', presence: true, headers: GZIP },
      { t: 'req', id: 2, method: 'GET', path: '/v1/projects', headers: GZIP },
    ]);
  });

  it('should treat a status as an answer, not as a carrier failure', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, answer: { status: 503 } });
    should((await router.fetch(`${DAEMON_URL}/v1/projects`)).status).equal(503);
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should announce a fresh connection once, however many requests reach it at once', async () => {
    const connected: string[] = [];
    const { router, daemon, carriers } = await routerFor({ answer: { status: 503 } });
    const stop = router.onConnected(connection => connected.push(connection.daemonId));

    const answers = await Promise.all(
      ['/v1/projects', '/v1/usage', '/v1/sessions'].map(path => router.fetch(`${DAEMON_URL}${path}`)),
    );
    should(answers.map(answer => answer.status)).eql([503, 503, 503]);
    should((await router.fetch(`${DAEMON_URL}/v1/usage`)).status).equal(503);

    should(connected).eql([daemon.daemonId]);
    // One request session, shared: every call above rode the one socket.
    should(carriers.dialled).have.length(1);
    stop();
  });

  it('should still serve the request when a connection observer throws, and tell the observers after it', async () => {
    const connected: string[] = [];
    const { router, daemon } = await routerFor({ answer: { body: 'served' } });
    const stopThrowing = router.onConnected(() => {
      throw new Error('a disclosure observer broke');
    });
    const stopRecording = router.onConnected(connection => connected.push(connection.daemonId));

    const response = await router.fetch(`${DAEMON_URL}/v1/projects`);

    should(await response.text()).equal('served');
    should(connected).eql([daemon.daemonId]);
    stopThrowing();
    stopRecording();
  });

  it('should dial the published direct address rather than the address the pairing was made on', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: 'https://other-direct.example' }],
    });
    const carriers = carriersFor(identity, () => 'live');
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
    });
    router.resolvePaired(() => [daemon]);

    should((await router.fetch(`${DAEMON_URL}/v1/projects?page=2`)).status).equal(200);
    should(carriers.dialled).eql([`wss://other-direct.example/v1/rendezvous/${identity.daemonId}/client`]);
  });

  it('should fall back to the relay for a GET when direct cannot be reached, and say why', async () => {
    const changes: number[] = [];
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    const unsubscribe = router.subscribe(() => changes.push(1));
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('{}');
    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.true();
    should(choice?.reason).match(/^Connected over hosted relay because direct was not reachable/u);
    should(changes.length).be.greaterThan(0);
    unsubscribe();

    // The winner keeps the traffic: direct is not re-probed on every call.
    should((await router.fetch(`${DAEMON_URL}/v1/usage`)).status).equal(200);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    await settle(5);
  });

  it('should give a direct address that drops packets seconds, not the whole grace, before the relay', async () => {
    // From cellular a private direct address neither answers nor refuses. Waiting out the 45-second
    // heartbeat grace before trying the relay made every page load away from home that slow.
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, url => (url.hostname === DIRECT_HOST ? 'silent' : 'live'));
    const asked: number[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      // The direct deadline fires at once; nothing else ever does.
      heartbeat: (tick, interval) => {
        asked.push(interval);
        if (interval === DIRECT_SESSION_DEADLINE_MS) queueMicrotask(tick);
        return () => undefined;
      },
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);

    should((await router.fetch(`${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(asked.slice(0, 2)).eql([DIRECT_SESSION_DEADLINE_MS, HEARTBEAT_GRACE_SECONDS * 1_000]);
    should(DIRECT_SESSION_DEADLINE_MS).be.below(HEARTBEAT_GRACE_SECONDS * 1_000);
  });

  it('should walk on with a write whose direct session never opened, because nothing of it was sent', async () => {
    const { router, daemon, carriers, auto } = await routerFor({ relay: RELAY, reach: relayOnly });
    const mutation = { method: 'POST', body: JSON.stringify({ prompt: 'start one session' }) };

    should((await router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).status).equal(200);

    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(auto.requests).eql([{ t: 'req', id: 1, method: 'POST', path: '/v1/sessions', body: mutation.body }]);
  });

  it('should report a write whose session died after it left, without replaying it over a relay', async () => {
    const { router, daemon, carriers, auto } = await routerFor({
      relay: RELAY,
      answer: { closeOnRequest: () => ({ code: RELAY_CLOSE_CODES.heartbeatTimeout, reason: 'evicted' }) },
    });
    const mutation = { method: 'POST', body: JSON.stringify({ prompt: 'start one session' }) };

    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejected();

    should(auto.requests).have.length(1);
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.choice(daemon.daemonId)?.ok).be.false();
    // The session had opened and the daemon had the request: that carrier was reached, and the copy
    // says what actually failed rather than calling it unreachable.
    should(router.choice(daemon.daemonId)?.reason).match(
      /^No configured connection worked: direct connected, but the session on it failed \(/u,
    );
  });

  it('should walk multiple relays in published order until one carries an answer', async () => {
    const identity = await newDaemonIdentity();
    const first: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-one.example', operator: 'self' };
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, first, second],
    });
    const carriers = carriersFor(identity, url => (url.hostname === 'relay-two.example' ? 'live' : 'refuse'));
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      network: unreachable,
      dial: carriers.dial,
    });
    router.resolvePaired(() => [daemon]);

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay-one.example', 'relay-two.example']);
    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.true();
    if (choice?.ok) {
      should(choice.method).eql(second);
      // WebRTC sits between direct and the relays (§15, Auto); with no dialer it is named, not hidden.
      should(choice.passedOver.map(skip => skip.method)).eql([
        { kind: 'direct', daemonUrl: DAEMON_URL },
        { kind: 'webrtc' },
        first,
      ]);
    }
  });

  it('should refuse plainly when no carrier works, naming each one it tried', async () => {
    const { router, daemon } = await routerFor({ reach: () => 'refuse' });
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
    const { router, daemon } = await routerFor({ relay: RELAY, reach: () => 'refuse' });
    const attempts = ['/v1/projects', '/v1/usage', '/v1/sessions'].map(path =>
      router.fetch(`${DAEMON_URL}${path}`).then(
        () => undefined,
        () => undefined,
      ),
    );
    await Promise.all(attempts);

    const choice = router.choice(daemon.daemonId);
    should(choice?.ok).be.false();
    should(choice?.passedOver.map(skip => skip.method.kind)).eql(['direct', 'webrtc', 'relay']);
  });

  /**
   * A round in which nothing worked used to poison the entry for the life of the
   * pairing: every later request found both carriers already on the refused list,
   * skipped the loop entirely and threw without trying anything.
   */
  it('should try again after a round in which no carrier worked', async () => {
    let reachable = false;
    const { router, daemon } = await routerFor({
      reach: () => (reachable ? 'live' : 'refuse'),
      answer: { body: 'back' },
    });

    await should(router.fetch(`${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);
    should(router.choice(daemon.daemonId)?.ok).be.false();

    reachable = true;
    should(await (await router.fetch(`${DAEMON_URL}/v1/projects`)).text()).equal('back');
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should not try another carrier once the session itself has refused the request', async () => {
    const { router, carriers } = await routerFor({ relay: RELAY });
    // A body over the session limit is refused by the live session before any of it is sent — an
    // answer about THIS request, so another carrier would only be asked the same thing.
    const refusal = await router
      .fetch(`${DAEMON_URL}/v1/sessions`, { method: 'POST', body: 'x'.repeat(MAX_TUNNEL_BODY_BYTES + 1) })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    should((refusal as RelaySessionError).code).equal(RELAY_CLOSE_CODES.frameTooLarge);
    should(carriers.hosts()).eql([DIRECT_HOST]);
  });

  it('should send everything not bound to a paired daemon straight to the network', async () => {
    const seen: string[] = [];
    const { router, carriers } = await routerFor({
      network: async () => {
        seen.push('network');
        return new Response('elsewhere');
      },
    });
    should(await (await router.fetch('https://relay.example/v1/default-relay')).text()).equal('elsewhere');
    should(await (await router.fetch('not a url')).text()).equal('elsewhere');
    should(await (await router.fetch(new Request(`${DAEMON_URL}/v1/carriers`))).text()).equal('elsewhere');
    should(seen).have.length(3);
    should(carriers.dialled).be.empty();
  });

  it('should drop a daemon carrier when the pairing changes, and again when it is unpaired', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    should(carriers.live.sockets).have.length(1);

    // A re-pair: same daemon, new grant. Nothing live may survive it.
    const repaired = { ...daemon, deviceId: 'fy_device_id_rotatedDevice000000000001' };
    await router.send(repaired, `${DAEMON_URL}/v1/projects`);
    should(carriers.live.sockets).have.length(2);
    should(carriers.live.sockets[0]?.closed).be.ok();

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
   * it was sent. So the remembered choice is dropped and the caller told; the NEXT
   * request walks the set from the top, direct first.
   */
  it('should forget a winner that stopped carrying and walk from the top on the next request', async () => {
    let relayUp = true;
    const { router, daemon, carriers } = await routerFor({
      relay: RELAY,
      reach: url => (url.hostname === DIRECT_HOST || !relayUp ? 'refuse' : 'live'),
    });

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);

    // The session that won is evicted, so the remembered relay must re-dial — and the
    // rendezvous is gone by the time it does.
    relayUp = false;
    carriers.live.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');
    const mutation = { method: 'POST', body: JSON.stringify({ prompt: 'start one session' }) };
    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejected();

    // Reported, not routed around: direct was not dialled with that request.
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example', 'relay.example']);
    should(router.choice(daemon.daemonId)).be.undefined();

    // And the next request is the deterministic walk again, direct first.
    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, mutation)).be.rejected();
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example', 'relay.example', DIRECT_HOST, 'relay.example']);
    await settle(5);
  });

  it('should give up on a relayed request at its deadline and carry the next one on a fresh session', async () => {
    // Arrange — a relay whose daemon end has gone quiet: its first request is never answered, while the
    // rendezvous keeps the socket open. This is how a phone's send and ledger reads hung for good. The
    // deadline passes once the daemon HOLDS the request, which is the silence this case is about; a
    // wall-clock deadline could pass during the handshake instead, which is the next case.
    let asked = 0;
    const deadline = new AbortController();
    const { router, daemon, carriers } = await routerFor({
      relay: RELAY,
      reach: relayOnly,
      answer: {
        respond: () => {
          asked += 1;
          if (asked > 1) return { status: 200, body: 'fresh' };
          queueMicrotask(() => deadline.abort(new DOMException('the deadline passed', 'TimeoutError')));
          return new Promise<never>(() => undefined);
        },
      },
    });

    // Act
    const reason = await router.send(daemon, `${DAEMON_URL}/v1/sessions/one/sends`, { signal: deadline.signal }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const next = await router.send(daemon, `${DAEMON_URL}/v1/sessions/one/sends`);

    // Assert
    should((reason as Error).name).equal('TimeoutError');
    should(await next.text()).equal('fresh');
    // The silent session was retired, so the next request walked the set again and opened a new one.
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example', DIRECT_HOST, 'relay.example']);
  });

  it('should keep the session when the deadline passed before the request ever left', async () => {
    // Arrange — the walk and the handshake took the caller's whole budget, so the daemon was never asked.
    let asked = 0;
    const { router, daemon, carriers } = await routerFor({
      relay: RELAY,
      reach: relayOnly,
      answer: {
        respond: () => {
          asked += 1;
          return { status: 200, body: 'kept' };
        },
      },
    });

    // Act
    const reason = await router
      .send(daemon, `${DAEMON_URL}/v1/sessions/one/sends`, {
        signal: AbortSignal.abort(new DOMException('the deadline passed', 'TimeoutError')),
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    const next = await router.send(daemon, `${DAEMON_URL}/v1/sessions/one/sends`);

    // Assert — the caller is told its own deadline, and the session it opened carries the next request.
    should((reason as Error).name).equal('TimeoutError');
    should(await next.text()).equal('kept');
    should(asked).equal(1);
    // Nothing answered the first walk, so no winner was chosen and the next one tries direct again — but
    // the relay is not dialled a second time: the session it opened is still the one held for it.
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example', DIRECT_HOST]);
  });

  it('should keep the session when its caller cancels a request rather than running out of time', async () => {
    // Arrange
    let asked = 0;
    const { router, daemon, carriers } = await routerFor({
      relay: RELAY,
      reach: relayOnly,
      answer: {
        respond: () => {
          asked += 1;
          return asked === 1 ? { status: 200, body: 'first' } : { status: 200, body: 'later' };
        },
      },
    });
    should((await router.send(daemon, `${DAEMON_URL}/v1/a`)).status).equal(200);
    const controller = new AbortController();
    controller.abort(new DOMException('the reader left', 'AbortError'));

    // Act
    const reason = await router.send(daemon, `${DAEMON_URL}/v1/b`, { signal: controller.signal }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const next = await router.send(daemon, `${DAEMON_URL}/v1/c`);

    // Assert
    should((reason as Error).name).equal('AbortError');
    should(await next.text()).equal('later');
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
  });

  it('should keep the live session and its winner when a refresh republishes the winning carrier', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(carriers.live.sockets).have.length(1);
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

    should(carriers.live.sockets).have.length(1);
    should(router.choice(daemon.daemonId)).equal(winner);
    await settle(5);
  });

  it('should close a rendezvous the daemon withdrew and walk the set again', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const socket = carriers.live.sockets[0];
    const withdrawn = daemonConnection({ ...daemon, carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }] });

    await should(router.send(withdrawn, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(
      /No configured connection worked/u,
    );
    await settle(5);

    should(router.choice(daemon.daemonId)?.ok).be.false();
    should(socket?.closed).be.ok();
  });

  it('should let a rendezvous that was still opening fail quietly once the daemon withdrew it', async () => {
    // Arrange — the relay's socket is dialled and never answers, so its session is still opening.
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, url => (url.hostname === DIRECT_HOST ? 'refuse' : 'silent'));
    const sockets: ScriptedSocket[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: url => {
        const socket = carriers.dial(url);
        if (new URL(url).hostname !== DIRECT_HOST) sockets.push(socket);
        return socket;
      },
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);
    const opening = router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await settle(5);
    should(sockets).have.length(1);

    // Act — a republish withdraws the relay while it opens, then the dial fails.
    const withdrawn = daemonConnection({ ...daemon, carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }] });
    const walked = router.send(withdrawn, `${DAEMON_URL}/v1/usage`).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await settle(5);
    sockets[0]?.onClose?.(1006, 'the address did not answer');
    const reasons = await Promise.all([opening, walked]);
    await settle(5);

    // Assert — both requests ended with an error, and nothing was left unhandled by the withdrawn session.
    should(reasons.every(reason => reason instanceof Error)).be.true();
    should(router.choice(daemon.daemonId)?.ok).not.be.true();
  });

  it('should dial the current hosted address for a daemon that published no rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const carriers = carriersFor(identity, relayOnly);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
      hostedRelay: async () => {
        asked += 1;
        return RELAY.relayUrl;
      },
    });
    router.resolvePaired(() => [daemon]);

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    should(asked).equal(1);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the fallback did not carry the request');
    should(choice.method).eql(RELAY);
    // Dialled, not adopted: nothing a reload could inherit was written.
    should(daemon.carriers).eql([{ kind: 'direct', daemonUrl: DAEMON_URL }]);
    await settle(5);
  });

  it('should dial nothing for that daemon once the directory has no address to give', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const carriers = carriersFor(identity, relayOnly);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
      hostedRelay: async () => {
        asked += 1;
        return undefined;
      },
    });
    router.resolvePaired(() => [daemon]);

    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(/No configured connection worked/u);

    should(asked).equal(1);
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.choice(daemon.daemonId)?.ok).be.false();
  });

  it('should never ask the directory for a daemon that authored its own rendezvous', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, relayOnly);
    let asked = 0;
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
      hostedRelay: async () => {
        asked += 1;
        return RELAY.relayUrl;
      },
    });
    router.resolvePaired(() => [daemon]);

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    should(asked).equal(0);
    should(carriers.live.sockets).have.length(1);
    await settle(5);
  });

  it('should keep carrying over a direct winner the daemon can no longer name, and hand back to its set when that stops', async () => {
    let directWorks = true;
    const { router, daemon, carriers } = await routerFor({
      reach: url => (url.hostname === DIRECT_HOST ? (directWorks ? 'live' : 'refuse') : 'live'),
    });
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);

    // The refresh names only the rendezvous this daemon dials, over the very address it omits.
    const relayOnlySet = daemonConnection({ ...daemon, carriers: [RELAY] });
    should((await router.send(relayOnlySet, `${DAEMON_URL}/v1/usage`)).status).equal(200);
    should(carriers.hosts()).eql([DIRECT_HOST]);

    // The moment it stops carrying it is forgotten like any other winner — and a READ walks the
    // published set again inside the same call, so this one is answered over the rendezvous.
    directWorks = false;
    carriers.live.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'the laptop left the network');
    should((await router.send(relayOnlySet, `${DAEMON_URL}/v1/usage`)).status).equal(200);
    const choice = router.choice(daemon.daemonId);
    if (choice?.ok !== true) throw new Error('the published rendezvous did not take over');
    should(choice.method).eql(RELAY);
    should(carriers.hosts().filter(host => host === DIRECT_HOST)).have.length(2);
    await settle(5);
  });

  it('should abort the walk rather than reach the first relay when a pending direct attempt is unpaired', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, relayOnly);
    let refuseDirect = (): void => {};
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      network: unreachable,
      dial: url => {
        if (new URL(url).hostname !== DIRECT_HOST) return carriers.dial(url);
        carriers.dialled.push(url);
        const pending = new ScriptedSocket();
        refuseDirect = () => pending.onClose?.(1006, 'the address did not answer');
        return pending;
      },
    });
    router.resolvePaired(() => [daemon]);

    const inflight = router.send(daemon, `${DAEMON_URL}/v1/projects`);
    await settle(2);
    router.clearDaemon(daemon.daemonId);
    refuseDirect();

    await should(inflight).be.rejectedWith(/re-paired, unpaired or republished/u);
    await settle(5);
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.choice(daemon.daemonId)).be.undefined();
  });

  it('should close a session that opened into a cleared pairing and dial no further relay', async () => {
    const identity = await newDaemonIdentity();
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY, second],
    });
    const carriers = carriersFor(identity, relayOnly);
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      // The unpair lands while the FIRST rendezvous is still shaking hands.
      dial: url => {
        const socket = carriers.dial(url);
        if (new URL(url).hostname === 'relay.example') router.clearDaemon(daemon.daemonId);
        return socket;
      },
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);

    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(/session was opening/u);
    await settle(5);

    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(carriers.live.sockets).have.length(1);
    should(carriers.live.sockets[0]?.closed).be.ok();
  });

  it('should refuse a walk whose entry a carrier refresh replaced, while the refreshed one answers', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    const republished = daemonConnection({
      ...daemon,
      carriers: [
        { kind: 'direct', daemonUrl: DAEMON_URL },
        RELAY,
        { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' },
      ],
    });

    const stale = router.send(daemon, `${DAEMON_URL}/v1/projects`);
    const current = router.send(republished, `${DAEMON_URL}/v1/usage`);

    await should(stale).be.rejectedWith(/re-paired, unpaired or republished/u);
    should((await current).status).equal(200);
    await settle(5);

    should(carriers.live.sockets).have.length(1);
    should(carriers.live.sockets[0]?.closed).be.null();
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should re-dial rather than reuse a session the carrier has dropped', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, reach: relayOnly });
    await router.send(daemon, `${DAEMON_URL}/v1/projects`);
    carriers.live.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'evicted');

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(carriers.live.sockets).have.length(2);
  });

  it('should ask a read again on a fresh session when the access lease ended under it', async () => {
    const lease = { code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, reason: 'the access lease ended' };
    const { router, daemon, carriers, auto } = await routerFor({
      answer: { body: 'fresh', closeOnRequest: index => (index === 0 ? lease : undefined) },
    });

    should(await (await router.send(daemon, `${DAEMON_URL}/v1/projects`)).text()).equal('fresh');

    // Two sessions on the same carrier, the read asked once on each, and nothing else dialled.
    should(carriers.hosts()).eql([DIRECT_HOST, DIRECT_HOST]);
    should(auto.requests).have.length(2);
    should(router.choice(daemon.daemonId)?.ok).be.true();
  });

  it('should NOT re-send a write when the access lease ended under it', async () => {
    const lease = { code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, reason: 'the access lease ended' };
    const { router, daemon, auto } = await routerFor({ answer: { closeOnRequest: () => lease } });

    await should(router.send(daemon, `${DAEMON_URL}/v1/sessions`, { method: 'POST', body: '{}' })).be.rejectedWith(
      /access lease on this session ended/u,
    );
    should(auto.requests).have.length(1);
  });

  it('should refuse to open a session at all when this browser no longer holds the device key', async () => {
    const { router, daemon, carriers } = await routerFor({ relay: RELAY, deviceKey: async () => undefined });
    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(DeviceKeyMissingError);
    // Nothing a second carrier could do about a key that is not here, so none is tried.
    should(carriers.dialled).be.empty();
  });

  it('should stop at once, saying so, when this browser cannot read its key store at all', async () => {
    const { router, daemon, carriers } = await routerFor({
      relay: RELAY,
      deviceKey: async () => {
        throw new Error('storage is blocked');
      },
    });
    const refusal = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(DeviceKeyUnreadableError);
    should((refusal as Error).message).match(/storage is blocked.*normal window/u);
    should(carriers.dialled).be.empty();
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DeviceKeyUnreadableError,
    );
  });

  it('should sign every session with the app session it was given', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const credentials: unknown[] = [];
    const carriers = carriersFor(identity, () => 'live');
    const appSession = 'AAAAAAAAAAAAAAAAAAAAAA';
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      appSession,
      heartbeat: () => () => undefined,
      dial: url => {
        const socket = carriers.dial(url);
        const send = socket.send.bind(socket);
        socket.send = bytes => {
          credentials.push(bytes);
          send(bytes);
        };
        return socket;
      },
    });
    router.resolvePaired(() => [daemon]);
    // The scripted daemon checks the proof, and the proof covers the app session; a wrong one closes.
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(credentials.length).be.above(1);
  });
});

describe('the carrier router meeting a daemon from before device keys', () => {
  const outdated = async (healthz: () => Promise<Response>, reach: Reach = relayOnly) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, reach);
    const asked: string[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: async input => {
        asked.push(String(input));
        return await healthz();
      },
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, carriers, asked };
  };

  /*
   * THE SIGNAL IS NOT A VERDICT. The liveness read is plaintext and unauthenticated: anybody on the
   * direct path — or an older daemon at the same private address on another network — can answer it.
   * So a working rendezvous still carries the request, and the sentence is only for a walk that
   * reached nothing at all.
   */
  it('should keep walking past a liveness answer that looks old, and carry the request over a relay that works', async () => {
    const { router, daemon, carriers, asked } = await outdated(
      async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(asked).eql([`${DAEMON_URL}/healthz`]);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
  });

  it('should name the daemon as the side to update when nothing worked and it looked old', async () => {
    const { router, daemon, carriers } = await outdated(
      async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
      () => 'refuse',
    );
    const refusal = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(DaemonOutdatedError);
    should((refusal as Error).message).equal(OLDER_DAEMON_SENTENCE);
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
  });

  it('should say the same for a stream, which walks the same set', async () => {
    const { router, daemon } = await outdated(
      async () => new Response(JSON.stringify({ status: 'ok', sessionProtocol: 'ferretry-relay/1' }), { status: 200 }),
      () => 'refuse',
    );
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DaemonOutdatedError,
    );
  });

  it('should name the daemon as old when every rendezvous meets the previous dialect', async () => {
    const identity = await newDaemonIdentity();
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY, second],
    });
    const older = olderDaemonDial();
    const dialled: string[] = [];
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      // Direct does not answer and its liveness read says nothing, so only the rendezvous can tell.
      network: unreachable,
      dial: url => {
        dialled.push(new URL(url).hostname);
        if (new URL(url).hostname === DIRECT_HOST) {
          const refused = new ScriptedSocket();
          queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
          return refused;
        }
        return older.dial();
      },
    });
    router.resolvePaired(() => [daemon]);

    const request = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(request).be.instanceof(DaemonOutdatedError);
    should((request as Error).message).equal(OLDER_DAEMON_SENTENCE);
    // Every carrier is still tried: an unauthenticated refusal stops nothing.
    should(dialled).eql([DIRECT_HOST, 'relay.example', 'relay-two.example']);

    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DaemonOutdatedError,
    );
  });

  it('should carry on past a spoofed old-daemon refusal on one rendezvous to another that works', async () => {
    const identity = await newDaemonIdentity();
    const second: RelayCarrier = { kind: 'relay', relayUrl: 'https://relay-two.example', operator: 'self' };
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY, second],
    });
    const older = olderDaemonDial();
    const live = carriersFor(identity, url => (url.hostname === 'relay-two.example' ? 'live' : 'refuse'));
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      network: unreachable,
      // The first rendezvous — or anybody on it — sends the words an old daemon uses, before any key.
      dial: url => (new URL(url).hostname === 'relay.example' ? older.dial() : live.dial(url)),
    });
    router.resolvePaired(() => [daemon]);

    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    should(older.sockets).have.length(1);
  });

  it('should carry on to the relay when the liveness route names this session, fails, or says nothing usable', async () => {
    const answers = [
      async () => new Response(JSON.stringify({ status: 'ok', sessionProtocol: SESSION_PROTOCOL_ID }), { status: 200 }),
      async () => new Response('busy', { status: 503 }),
      async () => new Response('not json', { status: 200 }),
      unreachable,
    ];
    for (const healthz of answers) {
      const { router, daemon, carriers } = await outdated(healthz);
      should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
      should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example']);
    }
    await settle(5);
  });
});

describe('the carrier router meeting a daemon NEWER than this app', () => {
  const newer = async (healthz: () => Promise<Response>) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, () => 'refuse');
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: healthz,
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon };
  };

  it('should tell the person to update the APP when the daemon names a higher dialect', async () => {
    // Arrange — a machine updated before this copy of the app was.
    const { router, daemon } = await newer(
      async () => new Response(JSON.stringify({ status: 'ok', sessionProtocol: 'ferretry-relay/3' }), { status: 200 }),
    );

    // Act
    const request = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // Assert — never "update the machine", which is the side already current.
    should(request).be.instanceof(AppOutdatedError);
    should((request as Error).message).equal(OLDER_APP_SENTENCE);
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      AppOutdatedError,
    );
  });

  it('should still name the daemon as old for a lower dialect, or a dialect it cannot parse', async () => {
    for (const sessionProtocol of ['ferretry-relay/1', 'something-else', 7]) {
      const { router, daemon } = await newer(
        async () => new Response(JSON.stringify({ status: 'ok', sessionProtocol }), { status: 200 }),
      );
      await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(DaemonOutdatedError);
    }
  });

  it('should name the app as old when a rendezvous carries the newer daemon refusing this hello', async () => {
    // Arrange — direct does not answer and its liveness read says nothing, so only the refusal can tell.
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const newerDaemon = newerDaemonDial();
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      heartbeat: () => () => undefined,
      network: unreachable,
      dial: url => {
        if (new URL(url).hostname !== DIRECT_HOST) return newerDaemon.dial();
        const refused = new ScriptedSocket();
        queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
        return refused;
      },
    });
    router.resolvePaired(() => [daemon]);

    // Act
    const request = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // Assert
    should(request).be.instanceof(AppOutdatedError);
    should((request as Error).message).equal(OLDER_APP_SENTENCE);
  });
});

describe('the carrier router meeting a daemon that no longer accepts this device', () => {
  /** A daemon that holds a DIFFERENT key for this grant: what a revoked or idle-expired device meets. */
  const refusing = async (reach: Reach, carriers: readonly ('direct' | 'relay')[] = ['direct']) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: carriers.map(kind => (kind === 'direct' ? { kind: 'direct' as const, daemonUrl: DAEMON_URL } : RELAY)),
    });
    const network = carriersFor(identity, reach, { devicePublicKey: (await testDevice()).publicKey });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: network.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, network };
  };

  it('should say ONE plain sentence on a direct-only daemon, and remember it', async () => {
    // Arrange
    const { router, daemon } = await refusing(directOnly);
    let announced = 0;
    router.subscribe(() => {
      announced += 1;
    });

    // Act
    const refusal = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // Assert — not "could not reach", not "the rendezvous ended this session": the machine said no.
    should(refusal).be.instanceof(DeviceNotAcceptedError);
    should((refusal as Error).message).equal(DEVICE_NOT_ACCEPTED_SENTENCE);
    should((refusal as Error).message).not.match(/rendezvous|reach|4403/u);
    should(router.deviceRefused(daemon.daemonId)).be.true();
    should(announced).be.above(0);
  });

  it('should dial nothing more for a refused device, so a page full of panels cannot spend the upgrade budget', async () => {
    // Arrange
    const { router, daemon, network } = await refusing(directOnly);
    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(DeviceNotAcceptedError);
    const dialled = network.dialled.length;

    // Act — every panel of the open page retries its own read, and a stream reconnects.
    for (let index = 0; index < 10; index += 1)
      await should(router.send(daemon, `${DAEMON_URL}/v1/usage`)).be.rejectedWith(DeviceNotAcceptedError);
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DeviceNotAcceptedError,
    );

    // Assert
    should(network.dialled).have.length(dialled);
  });

  it('should say the same on the relay, after trying every carrier', async () => {
    const { router, daemon, network } = await refusing(() => 'live', ['direct', 'relay']);
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DeviceNotAcceptedError,
    );
    should(network.hosts()).eql([DIRECT_HOST, 'relay.example']);
    should(router.deviceRefused(daemon.daemonId)).be.true();
  });

  it('should forget the refusal when the pairing is replaced, and keep it across a carrier refresh', async () => {
    // Arrange
    const { router, daemon } = await refusing(directOnly);
    await should(router.send(daemon, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(DeviceNotAcceptedError);

    // Act — the daemon republished its carriers: the same pairing, still refused.
    const republished = { ...daemon, carriers: [{ kind: 'direct' as const, daemonUrl: DAEMON_URL }, RELAY] };
    await should(router.send(republished, `${DAEMON_URL}/v1/projects`)).be.rejectedWith(DeviceNotAcceptedError);
    should(router.deviceRefused(daemon.daemonId)).be.true();

    // Act — re-paired or unpaired: the entry goes, and the refusal with it.
    router.clearDaemon(daemon.daemonId);

    // Assert
    should(router.deviceRefused(daemon.daemonId)).be.false();
  });

  it('should learn the refusal on a carrier that was already carrying, for a request and for a stream', async () => {
    // Arrange — a working pairing, then the device is revoked: the daemon stops accepting its key.
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    let accepted = device.publicKey;
    const live = autoDial(identity, {
      get devicePublicKey() {
        return accepted;
      },
    });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: () => live.dial(),
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    accepted = (await testDevice()).publicKey;

    // Act — a stream opens a NEW session on the remembered carrier, and is refused.
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DeviceNotAcceptedError,
    );

    // Assert
    should(router.deviceRefused(daemon.daemonId)).be.true();
  });

  it('should learn it when a remembered carrier’s next request session is refused', async () => {
    // Arrange
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    let accepted = device.publicKey;
    const live = autoDial(identity, {
      get devicePublicKey() {
        return accepted;
      },
    });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: () => live.dial(),
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);
    should((await router.send(daemon, `${DAEMON_URL}/v1/projects`)).status).equal(200);
    accepted = (await testDevice()).publicKey;
    // The request session ends (a lease, a network change), so the next request opens a new one.
    live.sockets[0]?.onClose?.(RELAY_CLOSE_CODES.heartbeatTimeout, 'gone');

    // Act
    const refusal = await router.send(daemon, `${DAEMON_URL}/v1/projects`).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // Assert
    should(refusal).be.instanceof(DeviceNotAcceptedError);
    should(router.deviceRefused(daemon.daemonId)).be.true();
  });
});

describe('the carrier router opening a stream', () => {
  const streamRouter = async (reach: Reach, answer: Parameters<typeof autoDial>[1] = {}) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({
      daemonId: identity.daemonId,
      baseUrl: DAEMON_URL,
      deviceId: DEVICE_ID,
      carriers: [{ kind: 'direct', daemonUrl: DAEMON_URL }, RELAY],
    });
    const carriers = carriersFor(identity, reach, answer);
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, carriers };
  };

  it('should open a stream on direct first when nothing has been measured, and decide the carrier', async () => {
    const { router, daemon, carriers } = await streamRouter(() => 'live');
    const session = await router.openStream(daemon, {
      path: '/v1/events',
      query: [['after', '1']],
      onData: () => undefined,
    });
    should(session.streaming()).be.true();
    should(carriers.hosts()).eql([DIRECT_HOST]);
    should(router.activeMethod(daemon.daemonId)).eql({ kind: 'direct', daemonUrl: DAEMON_URL });
    should(carriers.live.requests).eql([
      {
        t: 'stream',
        protocol: SESSION_PROTOCOL_ID,
        deviceId: DEVICE_ID,
        appSession: (carriers.live.requests[0] as { appSession: string }).appSession,
        proof: (carriers.live.requests[0] as { proof: string }).proof,
        path: '/v1/events',
        query: [['after', '1']],
      },
    ]);
  });

  it('should walk to the relay when direct cannot be reached, and open later streams on the winner', async () => {
    const { router, daemon, carriers } = await streamRouter(relayOnly);
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    await router.openStream(daemon, { path: '/v1/events', onData: () => undefined });
    should(carriers.hosts()).eql([DIRECT_HOST, 'relay.example', 'relay.example']);
    should(router.activeMethod(daemon.daemonId)).eql(RELAY);
  });

  it('should hand back the daemon refusing a stream as a refusal, never as a carrier to replace', async () => {
    const { router, daemon, carriers } = await streamRouter(() => 'live', {
      streamRefused: { status: 403, body: '{"error":"no"}' },
    });
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      RelayStreamRefusedError,
    );
    should(carriers.hosts()).eql([DIRECT_HOST]);
  });

  it('should say so plainly when no carrier opens the stream', async () => {
    const { router, daemon } = await streamRouter(() => 'refuse');
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      /No configured connection worked/u,
    );
    should(router.choice(daemon.daemonId)?.ok).be.false();
  });

  it('should refuse a stream when this browser no longer holds the device key', async () => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const carriers = carriersFor(identity, () => 'live');
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey: async () => undefined,
      dial: carriers.dial,
    });
    router.resolvePaired(() => [daemon]);
    await should(router.openStream(daemon, { path: '/v1/events', onData: () => undefined })).be.rejectedWith(
      DeviceKeyMissingError,
    );
    should(carriers.dialled).be.empty();
  });
});

describe('the carrier router defaults', () => {
  it('should default its network and its dial to the browser when neither is injected', async () => {
    let browserFetchCalls = 0;
    const originalFetch = globalThis.fetch;
    const browserFetch = (async () => {
      browserFetchCalls += 1;
      throw new TypeError('browser fetch fixture refused the request');
    }) as unknown as typeof fetch;
    globalThis.fetch = browserFetch;
    try {
      const router = new DaemonCarrierRouter({ crypto: relayCrypto, deviceKey });
      // No lookup has been supplied, so nothing is a paired daemon and this reaches the
      // browser default. A browser-shaped fixture proves the route without opening a socket.
      await should(router.fetch('http://127.0.0.1:1/v1/projects')).be.rejectedWith(/fixture refused/u);
      should(browserFetchCalls).equal(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * THE ONE PROPERTY AN INJECTED FETCHER CANNOT PROVE ABOUT ITSELF.
   *
   * `fetch` is a WebIDL operation and WebIDL refuses a call whose receiver is neither the global nor
   * absent; `this.#network(url, init)` would make the router the receiver. So the fetcher here records
   * its own `this`, through both ways the router reaches the network: an origin no paired daemon owns,
   * and the liveness read after a direct session did not open.
   */
  it('should never invoke an injected network with the router as its receiver', async () => {
    const receivers: unknown[] = [];
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriersFor(identity, () => 'refuse').dial,
      heartbeat: () => () => undefined,
      network: function (this: unknown): Promise<Response> {
        receivers.push(this);
        return Promise.resolve(new Response('ok'));
      },
    });
    router.resolvePaired(() => [daemon]);

    await router.fetch('https://unpaired.example/v1/anything');
    await router.fetch(`${DAEMON_URL}/v1/projects`).catch(() => undefined);

    should(receivers).have.length(2);
    for (const receiver of receivers) {
      should(receiver).not.equal(router);
      should(receiver).be.undefined();
    }
  });
});

describe('the carrier router meeting a passkey step-up', () => {
  const REQUIRED = { code: 'grant_step_up_required', message: 'Confirm with your passkey.' };

  /** A router whose daemon answers by `respond`, with `stepUp` as the only thing that can ask a person. */
  const steppedRouter = async (
    respond: (attempt: number) => { status: number; body: unknown } | { status: number; body: string },
    stepUp?: (
      daemon: ReturnType<typeof daemonConnection>,
      act?: string,
      origin?: unknown,
      actId?: string,
    ) => Promise<boolean>,
  ) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    let attempts = 0;
    const carriers = carriersFor(identity, directOnly, {
      respond: () => {
        attempts += 1;
        return respond(attempts);
      },
    });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
      ...(stepUp === undefined ? {} : { stepUp }),
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, attempts: () => attempts };
  };

  it('should send the same request again exactly once after the person confirms', async () => {
    // Arrange — refused the first time, accepted the second.
    const asked: string[] = [];
    const { router, daemon, attempts } = await steppedRouter(
      attempt => (attempt === 1 ? { status: 403, body: REQUIRED } : { status: 200, body: { ok: true } }),
      async connection => {
        asked.push(connection.daemonId);
        return true;
      },
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`, { method: 'POST', body: '{"a":1}' });

    // Assert
    should(response.status).equal(200);
    should(await response.json()).eql({ ok: true });
    should(asked).eql([daemon.daemonId]);
    should(attempts()).equal(2);
  });

  it('should hand the act the daemon named to the prompt, for a use demand and a configure demand', async () => {
    // Arrange
    const acts: (string | undefined)[] = [];
    const named = (capability: string, axis: string) => ({
      status: 403,
      body: { error: 'Confirm with your passkey.', code: REQUIRED.code, demand: { capability, axis } },
    });
    const use = await steppedRouter(
      attempt => (attempt === 1 ? named('terminal', 'use') : { status: 200, body: {} }),
      async (_daemon, act) => {
        acts.push(act);
        return true;
      },
    );
    const configure = await steppedRouter(
      attempt => (attempt === 1 ? named('secrets', 'configure') : { status: 200, body: {} }),
      async (_daemon, act) => {
        acts.push(act);
        return true;
      },
    );

    // Act
    await use.router.fetch(`${DAEMON_URL}/v1/terminals`, { method: 'POST', body: '{}' });
    await configure.router.fetch(`${DAEMON_URL}/v1/secrets`, { method: 'POST', body: '{}' });

    // Assert
    should(acts).eql(['open a terminal', 'change the settings for the secret store']);
  });

  it('should hand the prompt the id of the act the daemon named, so the proof is stamped for it', async () => {
    // Arrange
    const ids: (string | undefined)[] = [];
    const stepUp = async (_daemon: unknown, _act?: string, _origin?: unknown, actId?: string): Promise<boolean> => {
      ids.push(actId);
      return true;
    };
    const named = await steppedRouter(
      attempt =>
        attempt === 1
          ? {
              status: 403,
              body: {
                error: 'Confirm with your passkey.',
                code: REQUIRED.code,
                demand: { capability: 'fleet', axis: 'configure', act: 'catalog-install' },
              },
            }
          : { status: 200, body: {} },
      stepUp,
    );
    const plain = await steppedRouter(
      attempt => (attempt === 1 ? { status: 403, body: REQUIRED } : { status: 200, body: {} }),
      stepUp,
    );

    // Act
    await named.router.fetch(`${DAEMON_URL}/v1/catalog-installs/runtime`, { method: 'POST', body: '{}' });
    await plain.router.fetch(`${DAEMON_URL}/v1/fleet/import`, { method: 'POST', body: '{}' });

    // Assert
    should(ids).eql(['catalog-install', undefined]);
  });

  it('should still ask, with no act, when the demand is missing or does not parse', async () => {
    // Arrange — an older daemon names none; a newer one may name a capability this app has never heard of.
    const asked: (string | undefined)[] = [];
    const stepUp = async (_daemon: unknown, act?: string): Promise<boolean> => {
      asked.push(act);
      return false;
    };
    const missing = await steppedRouter(() => ({ status: 403, body: REQUIRED }), stepUp);
    const unknown = await steppedRouter(
      () => ({ status: 403, body: { ...REQUIRED, demand: { capability: 'teleporter', axis: 'use' } } }),
      stepUp,
    );
    const array = await steppedRouter(() => ({ status: 403, body: [REQUIRED] }), stepUp);

    // Act
    await missing.router.fetch(`${DAEMON_URL}/v1/fleet/import`);
    await unknown.router.fetch(`${DAEMON_URL}/v1/fleet/import`);
    const refused = await array.router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert — two ask with no act; a JSON array is not a step-up refusal at all.
    should(asked).eql([undefined, undefined]);
    should(refused.status).equal(403);
  });

  it('should not send a third time when the retry is refused again', async () => {
    // Arrange — a step-up the daemon still does not accept.
    const { router, attempts } = await steppedRouter(
      () => ({ status: 403, body: REQUIRED }),
      async () => true,
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`, { method: 'POST', body: '{}' });

    // Assert — the second refusal goes to the caller; nothing loops.
    should(response.status).equal(403);
    should(attempts()).equal(2);
  });

  it('should return the original refusal, body still readable, when the prompt is dismissed', async () => {
    // Arrange
    const { router, attempts } = await steppedRouter(
      () => ({ status: 403, body: REQUIRED }),
      async () => false,
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert — the daemon's refusal, unchanged, and the request was not repeated.
    should(response.status).equal(403);
    should(await response.json()).eql(REQUIRED);
    should(attempts()).equal(1);
  });

  it('should not ask when the 403 carries any other code', async () => {
    // Arrange
    let asked = 0;
    const { router, attempts } = await steppedRouter(
      () => ({ status: 403, body: { code: 'grant_denied', message: 'No.' } }),
      async () => {
        asked += 1;
        return true;
      },
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert
    should(response.status).equal(403);
    should(await response.json()).eql({ code: 'grant_denied', message: 'No.' });
    should(asked).equal(0);
    should(attempts()).equal(1);
  });

  it('should not ask for a 403 whose body is not JSON', async () => {
    // Arrange
    let asked = 0;
    const { router, attempts } = await steppedRouter(
      () => ({ status: 403, body: 'Forbidden, plain text' }),
      async () => {
        asked += 1;
        return true;
      },
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert
    should(response.status).equal(403);
    should(await response.text()).equal('Forbidden, plain text');
    should(asked).equal(0);
    should(attempts()).equal(1);
  });

  it('should not ask for a JSON null body, or for any status but 403', async () => {
    // Arrange
    let asked = 0;
    const stepUp = async (): Promise<boolean> => {
      asked += 1;
      return true;
    };
    const nullBody = await steppedRouter(() => ({ status: 403, body: 'null' }), stepUp);
    const notForbidden = await steppedRouter(() => ({ status: 401, body: REQUIRED }), stepUp);

    // Act
    const first = await nullBody.router.fetch(`${DAEMON_URL}/v1/fleet/import`);
    const second = await notForbidden.router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert
    should([first.status, second.status]).eql([403, 401]);
    should(asked).equal(0);
    should(nullBody.attempts() + notForbidden.attempts()).equal(2);
  });

  it('should hand the refusal back unchanged when nothing is able to ask', async () => {
    // Arrange — no stepUp option at all.
    const { router, attempts } = await steppedRouter(() => ({ status: 403, body: REQUIRED }));

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`);

    // Assert
    should(response.status).equal(403);
    should(await response.json()).eql(REQUIRED);
    should(attempts()).equal(1);
  });
});

describe('the carrier router meeting a presence requirement', () => {
  const PRESENCE = { code: 'unlock_required', message: 'Confirm it is you.' };
  const STEP_UP = { code: 'grant_step_up_required', message: 'Confirm with your passkey.' };

  const unlockRouter = async (
    respond: (attempt: number) => { status: number; body: unknown },
    handlers: {
      readonly unlockRequired?: (
        daemon: ReturnType<typeof daemonConnection>,
        origin?: PromptOrigin,
      ) => Promise<boolean>;
      readonly stepUp?: (
        daemon: ReturnType<typeof daemonConnection>,
        act?: string,
        origin?: PromptOrigin,
      ) => Promise<boolean>;
    } = {},
  ) => {
    const identity = await newDaemonIdentity();
    const daemon = daemonConnection({ daemonId: identity.daemonId, baseUrl: DAEMON_URL, deviceId: DEVICE_ID });
    let attempts = 0;
    const carriers = carriersFor(identity, directOnly, {
      respond: () => {
        attempts += 1;
        return respond(attempts);
      },
    });
    const router = new DaemonCarrierRouter({
      preference: () => 'auto',
      crypto: relayCrypto,
      deviceKey,
      dial: carriers.dial,
      heartbeat: () => () => undefined,
      network: unreachable,
      ...handlers,
    });
    router.resolvePaired(() => [daemon]);
    return { router, daemon, attempts: () => attempts };
  };

  it('should ask once and send the request again after the person confirms', async () => {
    // Arrange
    const asked: string[] = [];
    const { router, daemon, attempts } = await unlockRouter(
      attempt => (attempt === 1 ? { status: 401, body: PRESENCE } : { status: 200, body: { ok: true } }),
      {
        unlockRequired: async connection => {
          asked.push(connection.daemonId);
          return true;
        },
      },
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet`);

    // Assert
    should(response.status).equal(200);
    should(asked).eql([daemon.daemonId]);
    should(attempts()).equal(2);
  });

  it('should return the refusal unchanged when the prompt is dismissed', async () => {
    // Arrange
    const { router, attempts } = await unlockRouter(() => ({ status: 401, body: PRESENCE }), {
      unlockRequired: async () => false,
    });

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet`);

    // Assert
    should(response.status).equal(401);
    should(await response.json()).eql(PRESENCE);
    should(attempts()).equal(1);
  });

  it('should not ask for an unlock when the 401 body is not JSON', async () => {
    // Arrange
    let asked = 0;
    const { router, attempts } = await unlockRouter(() => ({ status: 401, body: 'Unauthorized, plain text' }), {
      unlockRequired: async () => {
        asked += 1;
        return true;
      },
    });

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet`);

    // Assert
    should(response.status).equal(401);
    should(await response.text()).equal('Unauthorized, plain text');
    should(asked).equal(0);
    should(attempts()).equal(1);
  });

  it('should hand the refusal back when nothing is able to ask, or when it is some other 401', async () => {
    // Arrange
    let asked = 0;
    const silent = await unlockRouter(() => ({ status: 401, body: PRESENCE }));
    const other = await unlockRouter(() => ({ status: 401, body: { code: 'something_else' } }), {
      unlockRequired: async () => {
        asked += 1;
        return true;
      },
    });

    // Act
    const first = await silent.router.fetch(`${DAEMON_URL}/v1/fleet`);
    const second = await other.router.fetch(`${DAEMON_URL}/v1/fleet`);

    // Assert
    should([first.status, second.status]).eql([401, 401]);
    should(asked).equal(0);
    should(silent.attempts() + other.attempts()).equal(2);
  });

  it('should still ask for a step-up on the resent request, after the unlock', async () => {
    // Arrange — the unlock first, then the resent request needs a step-up, then it succeeds.
    const order: string[] = [];
    const { router, attempts } = await unlockRouter(
      attempt =>
        attempt === 1
          ? { status: 401, body: PRESENCE }
          : attempt === 2
            ? { status: 403, body: STEP_UP }
            : { status: 200, body: { ok: true } },
      {
        unlockRequired: async () => {
          order.push('unlock');
          return true;
        },
        stepUp: async () => {
          order.push('step-up');
          return true;
        },
      },
    );

    // Act
    const response = await router.fetch(`${DAEMON_URL}/v1/fleet/import`, { method: 'POST', body: '{}' });

    // Assert
    should(response.status).equal(200);
    should(order).eql(['unlock', 'step-up']);
    should(attempts()).equal(3);
  });

  it('should tell the prompt a read is background work and anything else is a press', async () => {
    // Arrange — B19: a read is how a page polls every paired machine, so it must not raise a prompt for a
    // machine that is not on screen; a write is something a person pressed.
    const origins: (PromptOrigin | undefined)[] = [];
    const { router } = await unlockRouter(
      attempt => (attempt % 2 === 1 ? { status: 401, body: PRESENCE } : { status: 403, body: STEP_UP }),
      {
        unlockRequired: async (_, origin) => {
          origins.push(origin);
          return true;
        },
        stepUp: async (_daemon, _act, origin) => {
          origins.push(origin);
          return false;
        },
      },
    );

    // Act
    await router.fetch(`${DAEMON_URL}/v1/fleet`);
    await router.fetch(`${DAEMON_URL}/v1/fleet/import`, { method: 'post', body: '{}' });

    // Assert
    should(origins).eql(['background', 'background', 'explicit', 'explicit']);
  });
});

describe('which session a relayed request rides', () => {
  it('should send a body that needs parts on its own lane, so polls never wait behind an upload', () => {
    should(requestLane(undefined)).equal('request');
    should(requestLane('{"message":"hi"}')).equal('request');
    should(requestLane(JSON.stringify({ base64: 'a'.repeat(4 * 1024 * 1024) }))).equal('bulk');
  });
});
