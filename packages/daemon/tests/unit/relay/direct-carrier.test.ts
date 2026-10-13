/**
 * The direct carrier: the same session a rendezvous carries, over one socket to the daemon itself.
 *
 * Driven by the real client half of the handshake and real WebCrypto, so "the LAN is encrypted end to
 * end and a device proves its key" is asserted against the code that does it — and the refusals that
 * make a direct socket no softer than a relayed one are each a case.
 */

import { beforeAll, describe, it } from 'bun:test';
import { OLDER_APP_SENTENCE, RELAY_SESSION_CONCLUDED_CLOSE_CODE } from '@ferretry/protocol';
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
import { LiveDeviceConnections, type PairingCarrier, type SessionPairingAttempt } from '../../../src/lib/pairing/index.ts';
import { MAX_DIRECT_SESSIONS } from '../../../src/lib/relay/direct-carrier.ts';
import { directCarrierSocketRoute } from '../../../src/lib/runtime/mounts/direct-carrier.ts';
import { request } from '../api/support.ts';

const crypto_ = new WebCryptoRelayCrypto();
const DEVICE_ID = `fy_device_id_${'a'.repeat(22)}`;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(4));

let identity: DaemonIdentity;
let deviceKey: PrivateKeyHandle;
let deviceKeyText: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
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
}

function downstream(): Downstream {
  const binary: RelayFrame[] = [];
  const texts: string[] = [];
  const closes: Array<{ readonly code: number; readonly reason: string }> = [];
  return {
    binary,
    texts,
    closes,
    port: {
      send: frame => {
        if (typeof frame === 'string') texts.push(frame);
        else {
          const decoded = decodeFrame(frame);
          if (!decoded.ok) throw new Error(decoded.reason);
          binary.push(decoded.frame);
        }
        return 0;
      },
      close: (code, reason) => closes.push({ code, reason }),
      bufferedBytes: () => 0,
    },
  };
}

function carrier(options: { readonly answer?: (request: ApiRequest) => Promise<ApiResponse> } = {}) {
  const requests: ApiRequest[] = [];
  const pairings: Array<{ readonly attempt: SessionPairingAttempt; readonly carrier: PairingCarrier }> = [];
  const route = directCarrierSocketRoute({
    crypto: crypto_,
    identity,
    dispatch: async request => {
      requests.push(request);
      return (await options.answer?.(request)) ?? { status: 200, headers: new Map(), body: '{"ok":true}' };
    },
    sockets: async () => ({ outcome: 'unclaimed' }),
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
    scheduler: { after: () => ({ cancel: () => undefined }) },
    clock: { now: () => 0 },
    connections: new LiveDeviceConnections(),
  });
  return { route, requests, pairings };
}

/** Upgrade one socket the way the transport would, and open the handler. */
async function connect(
  route: ReturnType<typeof carrier>['route'],
  arrival: { readonly loopback?: boolean; readonly privilegedLoopback?: boolean; readonly clientAddress?: string } = {},
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
  await settled();
  const answer = wire.binary.find(frame => frame.kind === FRAME_KINDS.handshake);
  const hello = answer === undefined ? null : decodeDaemonHello(answer.payload);
  if (hello === null) throw new Error('no daemon hello');
  const completed = await completeClientHandshake(crypto_, pending, hello);
  if (!completed.ok) throw new Error(completed.reason);
  return { channel: openChannel(sessionId, completed.keys, 'client'), transcript: completed.keys.transcriptHash };
}

async function send(handler: SocketHandler, channel: ChannelState, message: unknown): Promise<ChannelState> {
  const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(message)));
  if (!sealed.ok) throw new Error(sealed.reason);
  handler.fromClient(encodeFrame(sealed.frame));
  await settled();
  return sealed.state;
}

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

const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 20));

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

    // Act
    const { channel, transcript } = await handshake(handler, wire, sessionId);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );
    let next = await send(handler, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });
    next = await send(handler, next, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

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

  it('should redeem a pairing on the DIRECT budget, keyed by the socket’s own peer', async () => {
    const { route, pairings } = carrier();
    const { handler, wire, sessionId } = await connect(route, { clientAddress: '192.0.2.4' });
    const { channel } = await handshake(handler, wire, sessionId);

    await send(handler, channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'phone',
      deviceKey: deviceKeyText,
      proof: toBase64Url(new Uint8Array(64)),
    });

    should(pairings).have.length(1);
    should(pairings[0]?.carrier).deepEqual({ kind: 'direct', rateLimitKey: '192.0.2.4' });
    // A proof that does not cover this transcript is the session's verdict, handed on as one more way
    // to be wrong — never a different answer.
    should(pairings[0]?.attempt.proven).be.false();
    should(lastControl(wire)).containDeep({ t: 'closed', code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });
    should(wire.closes.at(-1)?.code).equal(RELAY_SESSION_CONCLUDED_CLOSE_CODE);
  });

  it('should key a peer it cannot name by its own session, never by a shared placeholder', async () => {
    const { route, pairings } = carrier();
    const { handler, wire, sessionId } = await connect(route);
    const { channel } = await handshake(handler, wire, sessionId);
    await send(handler, channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'phone',
      deviceKey: deviceKeyText,
      proof: toBase64Url(new Uint8Array(64)),
    });
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
    await settled();

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
      encodeFrame({ kind: FRAME_KINDS.control, sessionId: spoken.sessionId, sequence: 0, payload: encodeControlMessage({ t: 'open' }) }),
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
    await settled();
    should(wire.binary.some(candidate => candidate.kind === FRAME_KINDS.handshake)).be.true();
    handler.close();
  });

  it('should refuse a nested session, another daemon’s fingerprint, and a socket past the ceiling', async () => {
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

    const held: SocketHandler[] = [];
    for (let index = 0; index < MAX_DIRECT_SESSIONS; index += 1) held.push((await connect(route)).handler);
    await route
      .accept({ request: request({ path }), params: new Map([['daemonId', identity.daemonId]]) })
      .should.be.rejectedWith({ status: 429 });
    // A socket that ends gives its place back, once.
    held[0]?.close();
    held[0]?.close();
    const next = await connect(route);
    should(next.wire.binary).have.length(1);
    for (const handler of [...held, next.handler]) handler.close();
  });
});

