/**
 * The direct carrier: the same session a rendezvous carries, over one socket to the daemon itself.
 *
 * Driven by the real client half of the handshake and real WebCrypto, so "the LAN is encrypted end to
 * end and a device proves its key" is asserted against the code that does it — and the refusals that
 * make a direct socket no softer than a relayed one are each a case.
 */

import { beforeAll, describe, it } from 'bun:test';
import {
  OLDER_APP_SENTENCE,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
} from '@ferretry/protocol';
import {
  type ChannelState,
  completeClientHandshake,
  type DaemonIdentity,
  decodeControlMessage,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  openChannel,
  openRecord,
  type PrivateKeyHandle,
  RELAY_CLOSE_CODES,
  type RelayFrame,
  SESSION_PROTOCOL_ID,
  type SessionId,
  sealRecord,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import type { SocketDownstream, SocketHandler } from '../../../src/lib/api/socket.ts';
import {
  LiveDeviceConnections,
  type PairingCarrier,
  type SessionPairingAttempt,
} from '../../../src/lib/pairing/index.ts';
import {
  DIRECT_UPGRADE_WINDOW_MS,
  DIRECT_UPGRADES_PER_PEER,
  type DirectSession,
  type DirectSessionEnd,
  type DirectSessionLog,
  EVICTED_REASON,
  MAX_DIRECT_SESSIONS,
  MAX_DIRECT_UNPROVEN_PER_PEER,
  MAX_DIRECT_UNPROVEN_SESSIONS,
} from '../../../src/lib/relay/direct-carrier.ts';
import { transcriptKey } from '../../../src/lib/relay/link.ts';
import { directCarrierSocketRoute } from '../../../src/lib/runtime/mounts/direct-carrier.ts';
import { request } from '../api/support.ts';

const crypto_ = new WebCryptoRelayCrypto();
const DEVICE_ID = `fy_device_id_${'a'.repeat(22)}`;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(4));

let identity: DaemonIdentity;
let deviceKey: PrivateKeyHandle;
let deviceKeyText: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  identity = await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
  const device = await crypto_.generateDeviceKey();
  deviceKey = crypto_.deviceKeyHandle(device.privateKey);
  deviceKeyText = toBase64Url(device.publicKeySpki);
});

interface Downstream {
  readonly port: SocketDownstream;
  readonly binary: RelayFrame[];
  readonly texts: string[];
  readonly closes: Array<{ readonly code: number; readonly reason: string }>;
  /** Set to make every later binary send throw, as a transport that has lost its socket does. */
  readonly failing: { on: boolean };
  /**
   * Resolves once `ready` holds: at once, or at whichever later write first makes it true.
   *
   * The daemon answers off the event loop — its records are sealed with real WebCrypto behind an inbox
   * the socket port gives no receipt for — so a case waits for the write it asserts on, never a sleep.
   */
  readonly until: (ready: () => boolean) => Promise<void>;
}

function downstream(): Downstream {
  const binary: RelayFrame[] = [];
  const texts: string[] = [];
  const closes: Array<{ readonly code: number; readonly reason: string }> = [];
  const failing = { on: false };
  const waiting: Array<{ readonly ready: () => boolean; readonly resolve: () => void }> = [];
  const wrote = (): void => {
    for (const waiter of waiting.filter(candidate => candidate.ready())) {
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  return {
    binary,
    texts,
    closes,
    failing,
    until: ready => (ready() ? Promise.resolve() : new Promise<void>(resolve => waiting.push({ ready, resolve }))),
    port: {
      send: frame => {
        if (typeof frame === 'string') texts.push(frame);
        else {
          if (failing.on) throw new Error('the socket is gone');
          const decoded = decodeFrame(frame);
          if (!decoded.ok) throw new Error(decoded.reason);
          binary.push(decoded.frame);
        }
        wrote();
        return 0;
      },
      close: (code, reason) => {
        closes.push({ code, reason });
        wrote();
      },
      bufferedBytes: () => 0,
    },
  };
}

interface FakeTimer {
  readonly milliseconds: number;
  readonly fire: () => void;
  cancelled: boolean;
}

function carrier(
  options: {
    readonly answer?: (request: ApiRequest) => Promise<ApiResponse>;
    readonly now?: () => number;
    readonly timers?: FakeTimer[];
    readonly connections?: LiveDeviceConnections;
    readonly sessionLog?: DirectSessionLog;
  } = {},
) {
  const connections = options.connections ?? new LiveDeviceConnections();
  const requests: ApiRequest[] = [];
  const pairings: Array<{ readonly attempt: SessionPairingAttempt; readonly carrier: PairingCarrier }> = [];
  const route = directCarrierSocketRoute({
    crypto: crypto_,
    identity,
    dispatch: async request => {
      requests.push(request);
      return (await options.answer?.(request)) ?? { status: 200, headers: new Map(), body: '{"ok":true}' };
    },
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    devices: {
      deviceKey: async deviceId => (deviceId === DEVICE_ID ? deviceKeyText : undefined),
      seen: () => undefined,
    },
    pairing: {
      redeemInSession: async (attempt, how) => {
        pairings.push({ attempt, carrier: how });
        return { kind: 'refused' };
      },
    },
    scheduler: {
      after: (milliseconds, fire) => {
        const timer: FakeTimer = { milliseconds, fire, cancelled: false };
        options.timers?.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    clock: { now: options.now ?? (() => 0) },
    connections,
    ...(options.sessionLog === undefined ? {} : { sessionLog: options.sessionLog }),
  });
  return { route, requests, pairings, connections };
}

/** Upgrade one socket the way the transport would, and open the handler. */
async function connect(
  route: ReturnType<typeof carrier>['route'],
  arrival: {
    readonly loopback?: boolean;
    readonly privilegedLoopback?: boolean;
    readonly clientAddress?: string;
    readonly carrier?: 'tunnel';
  } = {},
): Promise<{ readonly handler: SocketHandler; readonly wire: Downstream; readonly sessionId: SessionId }> {
  const attach = await route.accept({
    request: request({ path: `/v1/rendezvous/${identity.daemonId}/client`, ...arrival }),
    params: new Map([['daemonId', identity.daemonId]]),
  });
  const wire = downstream();
  const handler = await attach(wire.port);
  await handler.open();
  const ready = wire.binary[0];
  if (ready === undefined) throw new Error('the daemon announced no session');
  return { handler, wire, sessionId: ready.sessionId };
}

/** Run the client half of the handshake over the socket and return the keyed channel. */
async function handshake(
  handler: SocketHandler,
  wire: Downstream,
  sessionId: SessionId,
): Promise<{ readonly channel: ChannelState; readonly transcript: Uint8Array }> {
  const pending = await startClientHandshake(crypto_, sessionId, identity.daemonId);
  handler.fromClient(
    encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(pending.hello),
    }),
  );
  await arrived(wire, FRAME_KINDS.handshake);
  const answer = wire.binary.find(frame => frame.kind === FRAME_KINDS.handshake);
  const hello = answer === undefined ? null : decodeDaemonHello(answer.payload);
  if (hello === null) throw new Error('no daemon hello');
  const completed = await completeClientHandshake(crypto_, pending, hello);
  if (!completed.ok) throw new Error(completed.reason);
  return { channel: openChannel(sessionId, completed.keys, 'client'), transcript: completed.keys.transcriptHash };
}

/**
 * Seal one record as the client, hand it over, and wait for what it causes: the daemon's next record by
 * default, or the socket closing for a record whose answer ends the session.
 */
async function send(
  handler: SocketHandler,
  wire: Downstream,
  channel: ChannelState,
  message: unknown,
  until: 'record' | 'closed' = 'record',
): Promise<ChannelState> {
  const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(message)));
  if (!sealed.ok) throw new Error(sealed.reason);
  const before = dataFrames(wire);
  handler.fromClient(encodeFrame(sealed.frame));
  await (until === 'closed' ? socketClosed(wire) : wire.until(() => dataFrames(wire) > before));
  return sealed.state;
}

const dataFrames = (wire: Downstream): number => wire.binary.filter(frame => frame.kind === FRAME_KINDS.data).length;

async function records(wire: Downstream, channel: ChannelState): Promise<unknown[]> {
  let state = channel;
  const out: unknown[] = [];
  for (const frame of wire.binary.filter(candidate => candidate.kind === FRAME_KINDS.data)) {
    const opened = await openRecord(crypto_, state, frame);
    if (!opened.ok) throw new Error(opened.reason);
    state = opened.state;
    out.push(JSON.parse(utf8Text(opened.plaintext) ?? 'null'));
  }
  return out;
}

/** Waits for the daemon to answer with a frame of this kind. */
const arrived = async (wire: Downstream, kind: number): Promise<void> =>
  await wire.until(() => wire.binary.some(frame => frame.kind === kind));

/** Waits for the daemon to close the socket. */
const socketClosed = async (wire: Downstream): Promise<void> => await wire.until(() => wire.closes.length > 0);

const lastControl = (wire: Downstream) => {
  const frame = wire.binary.filter(candidate => candidate.kind === FRAME_KINDS.control).at(-1);
  return frame === undefined ? null : decodeControlMessage(frame.payload);
};

describe('the direct carrier', () => {
  it('should announce one session per socket and carry a proven device to the route table, stamped where it arrived', async () => {
    // Arrange
    const { route, requests } = carrier();
    const { handler, wire, sessionId } = await connect(route, {
      loopback: true,
      privilegedLoopback: true,
      clientAddress: '127.0.0.1',
    });
    should(decodeControlMessage(wire.binary[0]?.payload ?? new Uint8Array())).containDeep({ t: 'ready' });
    // The session names the identifier it announced, which a carrier with no close codes addresses its `closed` to.
    should((handler as DirectSession).sessionId).eql(sessionId);

    // Act
    const { channel, transcript } = await handshake(handler, wire, sessionId);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );
    let next = await send(handler, wire, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });
    next = await send(handler, wire, next, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

    // Assert — the answer crossed sealed, and the route table saw the device and the LISTENER's verdict.
    // Sending advances only the send counter, so the channel the handshake produced still reads.
    const messages = await records(wire, channel);
    should(messages[0]).containDeep({ t: 'authenticated' });
    should(messages[1]).containDeep({ t: 'res', id: 1, status: 200 });
    should(requests[0]).containDeep({
      device: { deviceId: DEVICE_ID, appSession: APP_SESSION },
      loopback: true,
      privilegedLoopback: true,
      clientAddress: '127.0.0.1',
    });
    handler.close();
  });

  it('should end the socket as an internal fault when writing an answer fails after the frame was handled', async () => {
    // Arrange — an answer is written after its frame's handling has finished, so a failure there is
    // the receipt's to report rather than the inbox chain's, and must not go unobserved.
    const { route } = carrier();
    const { handler, wire, sessionId } = await connect(route);
    const { channel, transcript } = await handshake(handler, wire, sessionId);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );
    const next = await send(handler, wire, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });

    // Act
    wire.failing.on = true;
    await send(handler, wire, next, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' }, 'closed');

    // Assert
    should(wire.closes).deepEqual([
      { code: RELAY_CLOSE_CODES.relayInternal, reason: 'the daemon could not carry this frame' },
    ]);
  });

  it('should redeem a pairing on the DIRECT budget, keyed by the socket’s own peer', async () => {
    const { route, pairings } = carrier();
    const { handler, wire, sessionId } = await connect(route, { clientAddress: '192.0.2.4' });
    const { channel } = await handshake(handler, wire, sessionId);

    await send(
      handler,
      wire,
      channel,
      {
        t: 'pair',
        protocol: SESSION_PROTOCOL_ID,
        code: 'ABCD-2345',
        deviceName: 'phone',
        deviceKey: deviceKeyText,
        proof: toBase64Url(new Uint8Array(64)),
      },
      'closed',
    );

    should(pairings).have.length(1);
    should(pairings[0]?.carrier).deepEqual({ kind: 'direct', rateLimitKey: '192.0.2.4' });
    // A proof that does not cover this transcript is the session's verdict, handed on as one more way
    // to be wrong — never a different answer.
    should(await pairings[0]?.attempt.prove()).be.false();
    should(lastControl(wire)).containDeep({ t: 'closed', code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });
    should(wire.closes.at(-1)?.code).equal(RELAY_SESSION_CONCLUDED_CLOSE_CODE);
  });

  it('should refuse first-contact pairing on a TUNNEL session exactly as it refuses a wrong code', async () => {
    // §15: pairing is never carried by a tunnel. Counted as direct, an internet caller would spend the
    // code's direct budget and the grant would be announced as "paired on the local network".
    // Arrange — the same pair record, once over a direct socket and once over the tunnel listener's.
    const pair = {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'phone',
      deviceKey: deviceKeyText,
      proof: toBase64Url(new Uint8Array(64)),
    };
    const direct = carrier();
    const tunnel = carrier();
    const overDirect = await connect(direct.route, { clientAddress: '192.0.2.4' });
    const overTunnel = await connect(tunnel.route, { clientAddress: '203.0.113.9', carrier: 'tunnel' });
    const directKeys = await handshake(overDirect.handler, overDirect.wire, overDirect.sessionId);
    const tunnelKeys = await handshake(overTunnel.handler, overTunnel.wire, overTunnel.sessionId);

    // Act
    await send(overDirect.handler, overDirect.wire, directKeys.channel, pair, 'closed');
    await send(overTunnel.handler, overTunnel.wire, tunnelKeys.channel, pair, 'closed');

    // Assert — the pairing service is never asked, so no guess is spent; the outcome a client sees,
    // records and close alike, is the one a wrong code gets, so the refusal is no oracle.
    should(tunnel.pairings).have.length(0);
    should(direct.pairings).have.length(1);
    should(await records(overTunnel.wire, tunnelKeys.channel)).deepEqual(
      await records(overDirect.wire, directKeys.channel),
    );
    should(lastControl(overTunnel.wire)).containDeep({ t: 'closed', code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });
    should(overTunnel.wire.closes.at(-1)?.code).equal(overDirect.wire.closes.at(-1)?.code);
  });

  it('should key a peer it cannot name by its own session, never by a shared placeholder', async () => {
    const { route, pairings } = carrier();
    const { handler, wire, sessionId } = await connect(route);
    const { channel } = await handshake(handler, wire, sessionId);
    await send(
      handler,
      wire,
      channel,
      {
        t: 'pair',
        protocol: SESSION_PROTOCOL_ID,
        code: 'ABCD-2345',
        deviceName: 'phone',
        deviceKey: deviceKeyText,
        proof: toBase64Url(new Uint8Array(64)),
      },
      'closed',
    );
    should(pairings[0]?.carrier).deepEqual({ kind: 'direct', rateLimitKey: `direct-session:${sessionId.text}` });
  });

  it('should close the socket with the session’s own close, the full reason crossing sealed in the control frame first', async () => {
    // An app from before device keys: the reason is longer than a WebSocket close frame can hold.
    const { route } = carrier();
    const { handler, wire, sessionId } = await connect(route);
    const pending = await startClientHandshake(crypto_, sessionId, identity.daemonId);
    handler.fromClient(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: utf8Bytes(JSON.stringify({ ...pending.hello, protocol: 'ferretry-relay/1' })),
      }),
    );
    await socketClosed(wire);

    should(lastControl(wire)).containDeep({ t: 'closed', reason: OLDER_APP_SENTENCE });
    const closed = wire.closes.at(-1);
    should(closed?.code).equal(RELAY_CLOSE_CODES.versionUnsupported);
    should(new TextEncoder().encode(closed?.reason ?? '').byteLength).not.be.greaterThan(123);
    should(OLDER_APP_SENTENCE.startsWith(closed?.reason ?? 'x')).be.true();
    // Ended means ended: nothing more reaches the wire, and a second close is a no-op.
    const before = wire.binary.length;
    handler.fromClient(HEARTBEAT_REQUEST);
    handler.close();
    should(wire.binary.length).equal(before);
  });

  it('should refuse a client that speaks for the rendezvous, and a frame that is not a frame', async () => {
    const { route } = carrier();
    const spoken = await connect(route);
    spoken.handler.fromClient(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: spoken.sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'open' }),
      }),
    );
    should(spoken.wire.closes.at(-1)).containDeep({ code: RELAY_CLOSE_CODES.protocolError });

    const garbled = await connect(route);
    garbled.handler.fromClient(new Uint8Array([1, 2, 3]).buffer);
    should(garbled.wire.closes.at(-1)).containDeep({ code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should answer a heartbeat and read a frame handed to it as a view into a larger buffer', async () => {
    const { route } = carrier();
    const { handler, wire, sessionId } = await connect(route);
    handler.fromClient(HEARTBEAT_REQUEST);
    should(wire.texts).deepEqual([HEARTBEAT_RESPONSE]);

    const pending = await startClientHandshake(crypto_, sessionId, identity.daemonId);
    const frame = encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(pending.hello),
    });
    const padded = new Uint8Array(frame.byteLength + 8);
    padded.set(frame, 4);
    handler.fromClient(padded.subarray(4, 4 + frame.byteLength));
    await arrived(wire, FRAME_KINDS.handshake);
    should(wire.binary.some(candidate => candidate.kind === FRAME_KINDS.handshake)).be.true();
    handler.close();
  });

  it('should refuse a nested session and another daemon’s fingerprint', async () => {
    const { route } = carrier();
    const path = `/v1/rendezvous/${identity.daemonId}/client`;
    await route
      .accept({
        request: request({ path, device: { deviceId: DEVICE_ID, appSession: APP_SESSION } }),
        params: new Map([['daemonId', identity.daemonId]]),
      })
      .should.be.rejectedWith({ status: 404 });
    await route
      .accept({ request: request({ path }), params: new Map([['daemonId', 'fy_daemon_other']]) })
      .should.be.rejectedWith({ status: 404 });
  });

  /*
   * UNPROVEN SOCKETS ARE THE CHEAP ONES, so they have their own cap — and a full cap EVICTS the oldest
   * rather than refusing the newcomer, so a squatter must out-race honest arrivals instead of merely
   * arriving first.
   */
  it('should evict the oldest unproven socket for a newcomer, and give a slot back once when one ends', async () => {
    const { route } = carrier();
    const held: Array<Awaited<ReturnType<typeof connect>>> = [];
    for (let index = 0; index < MAX_DIRECT_UNPROVEN_SESSIONS; index += 1)
      held.push(await connect(route, { clientAddress: `192.0.2.${index + 1}` }));
    const newcomer = await connect(route, { clientAddress: '192.0.2.200' });
    should(held[0]?.wire.closes).eql([{ code: 4429, reason: EVICTED_REASON }]);
    should(held[1]?.wire.closes).be.empty();
    // A close counted twice would free two slots, and the next arrival would evict nobody.
    held[1]?.handler.close();
    held[1]?.handler.close();
    await connect(route, { clientAddress: '192.0.2.201' });
    should(held[2]?.wire.closes).be.empty();
    await connect(route, { clientAddress: '192.0.2.202' });
    should(held[2]?.wire.closes).eql([{ code: 4429, reason: EVICTED_REASON }]);
    for (const { handler } of [...held, newcomer]) handler.close();
  });

  it('should hold only two unproven sockets per remote address, never charge a refusal, and exempt the host', async () => {
    const { route } = carrier();
    const first = await connect(route, { clientAddress: '192.0.2.7' });
    await connect(route, { clientAddress: '192.0.2.7' });
    // Far more refusals than the minute's budget: none of them is spent.
    for (let index = 0; index < DIRECT_UPGRADES_PER_PEER + 5; index += 1)
      await connect(route, { clientAddress: '192.0.2.7' }).should.be.rejectedWith({ status: 429 });
    first.handler.close();
    await connect(route, { clientAddress: '192.0.2.7' });
    // Every tab on the host shares one address, so the per-address bound would refuse the host itself —
    // but only on a host-proven carrier. A bare loopback peer is a proxy's remote caller, and bounded.
    for (let index = 0; index < MAX_DIRECT_UNPROVEN_PER_PEER + 2; index += 1)
      await connect(route, { clientAddress: '127.0.0.1', loopback: true, privilegedLoopback: true });
    await connect(route, { clientAddress: '127.0.0.2', loopback: true });
    await connect(route, { clientAddress: '127.0.0.2', loopback: true });
    await connect(route, { clientAddress: '127.0.0.2', loopback: true }).should.be.rejectedWith({ status: 429 });
  });

  it('should stop counting a socket as unproven once its device has proved itself, and still cap the total', async () => {
    const { route } = carrier();
    const held: SocketHandler[] = [];
    const proven = async (address: string): Promise<SocketHandler> => {
      const { handler, wire, sessionId } = await connect(route, { clientAddress: address });
      const { channel, transcript } = await handshake(handler, wire, sessionId);
      await send(handler, wire, channel, {
        t: 'auth',
        protocol: SESSION_PROTOCOL_ID,
        deviceId: DEVICE_ID,
        appSession: APP_SESSION,
        proof: await signDeviceProof(crypto_, deviceKey, deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION)),
      });
      // Proven only once the daemon has said so: until then the socket still holds an unproven slot.
      await arrived(wire, FRAME_KINDS.data);
      return handler;
    };
    // Every proven session frees its unproven slot, so many more than the unproven cap can be open.
    for (let index = 0; index < MAX_DIRECT_SESSIONS - 1; index += 1) held.push(await proven(`198.51.100.${index}`));
    const waiting = await connect(route, { clientAddress: '203.0.113.1' });
    // The total is full, but one socket is unproven: it is evicted for the newcomer.
    const newcomer = await connect(route, { clientAddress: '203.0.113.2' });
    should(waiting.wire.closes).eql([{ code: 4429, reason: EVICTED_REASON }]);
    // Now the newcomer proves itself too: sixty-four proven, nothing to evict, and the next is refused.
    newcomer.handler.close();
    held.push(await proven('203.0.113.3'));
    await connect(route, { clientAddress: '203.0.113.4' }).should.be.rejectedWith({ status: 429 });
    for (const handler of held) handler.close();
  });

  it('should admit only so many upgrades a minute from one address, and every other address as usual', async () => {
    let now = 1_000;
    const { route } = carrier({ now: () => now });
    for (let index = 0; index < DIRECT_UPGRADES_PER_PEER; index += 1)
      (await connect(route, { clientAddress: '192.0.2.9' })).handler.close();
    // Refused BEFORE any key agreement: the cheap check comes first.
    await connect(route, { clientAddress: '192.0.2.9' }).should.be.rejectedWith({ status: 429 });
    (await connect(route, { clientAddress: '192.0.2.10' })).handler.close();
    // A peer with no address shares one window rather than being waved through as nobody.
    for (let index = 0; index < DIRECT_UPGRADES_PER_PEER; index += 1) (await connect(route)).handler.close();
    await connect(route).should.be.rejectedWith({ status: 429 });
    now += DIRECT_UPGRADE_WINDOW_MS;
    (await connect(route, { clientAddress: '192.0.2.9' })).handler.close();
  });

  /*
   * THE SLOT IS TAKEN WHEN THE UPGRADE IS ADMITTED. Counting only at attach let a burst of concurrent
   * upgrades all pass the check; a reservation whose socket never attaches is handed back at its deadline.
   */
  it('should count an admitted upgrade at once, and hand its slot back if the socket never attaches', async () => {
    const timers: FakeTimer[] = [];
    const { route } = carrier({ timers });
    const path = `/v1/rendezvous/${identity.daemonId}/client`;
    const accept = async (address: string) =>
      await route.accept({
        request: request({ path, clientAddress: address }),
        params: new Map([['daemonId', identity.daemonId]]),
      });
    const admitted = await Promise.all(
      Array.from(
        { length: MAX_DIRECT_UNPROVEN_SESSIONS },
        async (_unused, index) => await accept(`192.0.2.${index + 40}`),
      ),
    );
    // Counted at admission: the next one, before any of them attached, already evicts the oldest.
    await accept('192.0.2.99');
    const late = downstream();
    const evicted = await admitted[0]?.(late.port);
    await evicted?.open();
    should(late.closes).eql([{ code: 4429, reason: EVICTED_REASON }]);
    evicted?.fromClient(new Uint8Array());
    evicted?.close();
    // None of the rest attached. Each reservation's deadline hands its slot back, once.
    for (const timer of timers.filter(candidate => candidate.milliseconds === 10_000)) {
      timer.fire();
      timer.fire();
    }
    (await connect(route, { clientAddress: '192.0.2.98' })).handler.close();
  });
});

describe('a direct session ending for the reasons a relayed one does', () => {
  /** A direct socket whose device has proved itself, and the client's view of it. */
  async function provenDirect(options: Parameters<typeof carrier>[0] = {}) {
    const harnessed = carrier(options);
    const { handler, wire, sessionId } = await connect(harnessed.route, { clientAddress: '192.0.2.77' });
    const { channel, transcript } = await handshake(handler, wire, sessionId);
    await send(handler, wire, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof: await signDeviceProof(crypto_, deviceKey, deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION)),
    });
    return { ...harnessed, handler, wire, transcript };
  }

  it('should close the socket when its device is revoked, with the same 4403 an unknown device gets', async () => {
    const { connections, wire } = await provenDirect();
    should(connections.endDevice(DEVICE_ID)).equal(1);
    should(wire.closes.at(-1)?.code).equal(RELAY_CLOSE_CODES.authRejected);
  });

  it('should end the direct and the relayed sessions of one device in the same revocation', async () => {
    const shared = new LiveDeviceConnections();
    let relayedEnded = 0;
    // A relayed session registers with the same registry the direct one does.
    shared.track(DEVICE_ID, () => {
      relayedEnded += 1;
    });
    const { wire } = await provenDirect({ connections: shared });
    should(shared.endDevice(DEVICE_ID)).equal(2);
    should(relayedEnded).equal(1);
    should(wire.closes.at(-1)?.code).equal(RELAY_CLOSE_CODES.authRejected);
  });

  it('should hand the lapse through to the registry, so a key replacement ends a direct session too', async () => {
    const { connections, wire } = await provenDirect();

    should(connections.lapseDevice(DEVICE_ID, '')).equal(1);

    should(wire.closes.at(-1)?.code).equal(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE);
  });

  it('should spare the direct session that carried the replacement, and keep it open', async () => {
    const { connections, wire, transcript } = await provenDirect();

    // The carrying session is named by its own transcript hash, hex.
    should(connections.lapseDevice(DEVICE_ID, transcriptKey(transcript))).equal(0);

    should(wire.closes).be.empty();
  });

  it('should close the socket with the lease code when nobody renews', async () => {
    const timers: FakeTimer[] = [];
    const { wire } = await provenDirect({ timers });
    const lease = timers.filter(timer => timer.milliseconds === 900_000 && !timer.cancelled).at(-1);
    if (lease === undefined) throw new Error('no lease was armed');
    lease.fire();
    should(wire.closes.at(-1)?.code).equal(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE);
  });
});

describe('what a tunnel session reports about its own life', () => {
  /** A log that keeps what it was told, and a clock a case moves by hand. */
  const recorder = () => {
    const opened: number[] = [];
    const ends: DirectSessionEnd[] = [];
    const clock = { at: 1_000 };
    const log: DirectSessionLog = { opened: () => opened.push(clock.at), closed: end => ends.push(end) };
    return { opened, ends, clock, log };
  };

  it('should report a proved tunnel session the browser side cut, with the code, its age, the last frame and the bytes', async () => {
    // Arrange
    const seen = recorder();
    const { route } = carrier({ sessionLog: seen.log, now: () => seen.clock.at });
    const { handler, wire, sessionId } = await connect(route, { clientAddress: '203.0.113.9', carrier: 'tunnel' });
    const { channel, transcript } = await handshake(handler, wire, sessionId);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );
    await send(handler, wire, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });
    seen.clock.at = 61_000;
    handler.fromClient(HEARTBEAT_REQUEST);

    // Act — ninety seconds after the last ping, the network drops the socket without a close frame.
    seen.clock.at = 151_000;
    handler.close({ code: 1006, reason: '' });

    // Assert
    should(seen.opened).eql([1_000]);
    should(seen.ends).have.length(1);
    const end = seen.ends[0] as DirectSessionEnd;
    should(end).containDeep({
      by: 'peer',
      code: 1006,
      reason: '',
      durationMs: 150_000,
      lastFrameAgeMs: 90_000,
      proved: true,
    });
    should(end.bytesIn).be.above(0);
    should(end.bytesOut).be.above(0);
  });

  it('should name this daemon as the end that closed it, with the code it sent, and not report twice when the transport echoes it', async () => {
    // Arrange
    const seen = recorder();
    const { route } = carrier({ sessionLog: seen.log, now: () => seen.clock.at });
    const { handler, wire } = await connect(route, { carrier: 'tunnel' });

    // Act — a client that speaks for the rendezvous is refused, then the runtime reports that close back.
    handler.fromClient(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: (wire.binary[0] as RelayFrame).sessionId,
        sequence: 1,
        payload: encodeControlMessage({ t: 'open' }),
      }),
    );
    handler.close({ code: RELAY_CLOSE_CODES.protocolError, reason: 'echo' });

    // Assert
    should(seen.ends).have.length(1);
    should(seen.ends[0]).containDeep({ by: 'daemon', code: RELAY_CLOSE_CODES.protocolError, proved: false });
  });

  it('should say the daemon released a socket the transport reported no close for', async () => {
    // Arrange
    const seen = recorder();
    const { route } = carrier({ sessionLog: seen.log });
    const { handler } = await connect(route, { carrier: 'tunnel' });

    // Act — daemon shutdown ends every handler with no close report.
    handler.close();

    // Assert
    should(seen.ends[0]).containDeep({ by: 'daemon', code: undefined, reason: 'the daemon released this socket' });
  });

  it('should report nothing for a session that did not arrive through the tunnel', async () => {
    // Arrange
    const seen = recorder();
    const { route } = carrier({ sessionLog: seen.log });
    const { handler } = await connect(route, { loopback: true, privilegedLoopback: true, clientAddress: '127.0.0.1' });

    // Act
    handler.close({ code: 1001, reason: 'tab closed' });

    // Assert
    should(seen.opened).eql([]);
    should(seen.ends).eql([]);
  });
});
