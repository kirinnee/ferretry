/**
 * The carrier, over a real WebSocket, against a rendezvous that behaves like the deployed one.
 *
 * The first test is the whole claim of this unit: a daemon that nothing can connect inward to dials
 * out, proves it owns the fingerprint in the path, keys a session with a client it has never met, and
 * answers that client's request out of its own route table — with every byte after the handshake
 * sealed under keys the carrier in the middle cannot derive. The server in this test is deliberately
 * both the rendezvous and the client, so the frames on the socket are the frames a Cloudflare
 * deployment would forward, and the assertion at the end is made on plaintext the server could only
 * read because it is also the client.
 *
 * The rest is what a socket does that a protocol does not: redial after a drop, drop a socket that
 * stopped answering, refuse a message that is neither text nor bytes, and — the one that matters for
 * disclosure — never report a carrier it does not have.
 */

import { beforeAll, describe, it } from 'bun:test';
import {
  type ChannelState,
  type ControlMessage,
  completeClientHandshake,
  type DaemonIdentity,
  decodeClaim,
  decodeControlMessage,
  decodeDaemonHello,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HANDSHAKE_FRAME_SEQUENCE,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  verifyRendezvousClaim,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import { NodePairingCryptography } from '../../../src/adapters/pairing/node-pairing-cryptography.ts';
import { BunRelayCarrier, type RelayWebSocket } from '../../../src/adapters/relay/bun-relay-carrier.ts';
import { WebCryptoRelayIdentityKeys } from '../../../src/adapters/relay/web-crypto-relay-identity.ts';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import { DaemonRelayConfigSchema } from '../../../src/lib/runtime/config.ts';

const relayCrypto = new WebCryptoRelayCrypto();
const DEVICE_TOKEN = 'fy_device_known';
const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';

let identity: DaemonIdentity;

beforeAll(async () => {
  identity = await new WebCryptoRelayIdentityKeys().load(new NodePairingCryptography().newIdentity().privateKeyPem);
});

const config = (patch: Record<string, unknown>) => DaemonRelayConfigSchema.parse(patch);

const ok = (body: unknown): ApiResponse => ({
  status: 200,
  headers: new Map([['content-type', 'application/json']]),
  body: JSON.stringify(body),
});

const devices = { identifyDevice: (token: string) => (token === DEVICE_TOKEN ? DEVICE_ID : undefined) };

const session = (): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]));
  if (id === null) throw new Error('unreachable: 16 bytes');
  return id;
};

const controlFrame = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID): Uint8Array =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a daemon reachable through a rendezvous it dialled', () => {
  it('should claim the rendezvous and answer a relayed request the carrier cannot read', async () => {
    // Arrange — a rendezvous that is also the client, so the socket carries real relayed frames.
    const sessionId = session();
    const host = { value: '' };
    let channel: ChannelState | undefined;
    let pending: Awaited<ReturnType<typeof startClientHandshake>> | undefined;
    let answer: unknown;
    let claimVerified = false;
    const opaque: Uint8Array[] = [];

    const server = Bun.serve({
      port: 0,
      fetch: (request, host_) => (host_.upgrade(request) ? undefined : new Response('not a socket', { status: 400 })),
      websocket: {
        open: socket => {
          const challenge = relayCrypto.randomBytes(NONCE_BYTES);
          host.value = toBase64Url(challenge);
          socket.data = undefined;
          socket.send(
            controlFrame({
              t: 'challenge',
              protocol: RELAY_PROTOCOL_ID,
              nonce: toBase64Url(challenge),
              host: `127.0.0.1:${server.port}`,
              deadlineSeconds: 10,
            }),
          );
        },
        message: async (socket, message) => {
          if (typeof message === 'string') {
            // The heartbeat, answered exactly as Cloudflare's auto-responder would.
            socket.send('fy-pong');
            return;
          }
          const decoded = decodeFrame(new Uint8Array(message));
          if (!decoded.ok) throw new Error(decoded.reason);
          const frame: RelayFrame = decoded.frame;

          if (frame.kind === FRAME_KINDS.control) {
            const control = decodeControlMessage(frame.payload);
            if (control?.t !== 'claim') return;
            const challenge = fromBase64UrlFixed(host.value, NONCE_BYTES);
            const claim = decodeClaim(control.publicKey, control.signature);
            if (challenge === null || claim === null) throw new Error('malformed claim');
            // The rendezvous accepts only a key that hashes to the fingerprint in the path AND
            // signs this challenge for this host.
            const verdict = await verifyRendezvousClaim(
              relayCrypto,
              { daemonId: identity.daemonId, relayHost: `127.0.0.1:${server.port}`, challenge },
              claim,
            );
            claimVerified = verdict.ok;
            socket.send(
              controlFrame({
                t: 'claimed',
                protocol: RELAY_PROTOCOL_ID,
                limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
              }),
            );
            // A client arrives, and the daemon is told which session it belongs to.
            socket.send(controlFrame({ t: 'open' }, sessionId));
            pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
            socket.send(
              encodeFrame({
                kind: FRAME_KINDS.handshake,
                sessionId,
                sequence: HANDSHAKE_FRAME_SEQUENCE,
                payload: encodeHandshakeMessage(pending.hello),
              }),
            );
            return;
          }

          // Everything from here is end-to-end. A real rendezvous copies these payloads without
          // decoding them, which is exactly what makes the last assertion meaningful.
          opaque.push(frame.payload);

          if (frame.kind === FRAME_KINDS.handshake) {
            const hello = decodeDaemonHello(frame.payload);
            if (hello === undefined || hello === null || pending === undefined) throw new Error('no daemon hello');
            const completed = await completeClientHandshake(relayCrypto, pending, hello);
            if (!completed.ok) throw new Error(completed.reason);
            channel = openChannel(sessionId, completed.keys, 'client');
            const sealed = await sealRecord(
              relayCrypto,
              channel,
              utf8Bytes(JSON.stringify({ t: 'auth', protocol: RELAY_PROTOCOL_ID, deviceToken: DEVICE_TOKEN })),
            );
            if (!sealed.ok) throw new Error(sealed.reason);
            channel = sealed.state;
            socket.send(encodeFrame(sealed.frame));
            return;
          }

          if (frame.kind !== FRAME_KINDS.data || channel === undefined) return;
          const opened = await openRecord(relayCrypto, channel, frame);
          if (!opened.ok) throw new Error(opened.reason);
          channel = opened.state;
          const text = utf8Text(opened.plaintext);
          const message_ = text === null ? undefined : JSON.parse(text);
          if (message_?.t === 'authenticated') {
            const sealed = await sealRecord(
              relayCrypto,
              channel,
              utf8Bytes(JSON.stringify({ t: 'req', id: 11, method: 'GET', path: '/v1/sessions' })),
            );
            if (!sealed.ok) throw new Error(sealed.reason);
            channel = sealed.state;
            socket.send(encodeFrame(sealed.frame));
            return;
          }
          if (message_?.t === 'res') answer = message_;
        },
      },
    });

    const carrier = new BunRelayCarrier({
      // The default socket factory: this test dials a real WebSocket, which is the point.
      config: config({ url: `http://127.0.0.1:${server.port}` }),
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async request =>
        request.path === '/v1/sessions' && request.headers.get('authorization') === `Bearer ${DEVICE_TOKEN}`
          ? ok({ sessions: ['one'] })
          : ok({ error: 'the relayed request did not arrive as itself' }),
    });

    try {
      // Act
      carrier.start();
      const received = await until(() => answer, 'the relayed answer');

      // Assert — the daemon proved its identity, and the answer came from its own route table.
      should(claimVerified).be.true();
      should(received).deepEqual({
        t: 'res',
        id: 11,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: ['one'] }),
      });
      should(carrier.status()).containDeep({ phase: 'carrying', sessions: 1 });
      should(carrier.status().relayUrl).equal(
        `ws://127.0.0.1:${server.port}/v1/rendezvous/${identity.daemonId}/daemon`,
      );

      // Assert — and the carrier never saw any of it. Every end-to-end payload the rendezvous
      // forwarded is either the handshake JSON or ciphertext; none of them contains the body, the
      // path or the device token.
      const carried = opaque.map(payload => utf8Text(payload) ?? '');
      should(carried.some(text => text.includes('sessions'))).be.false();
      should(carried.some(text => text.includes(DEVICE_TOKEN))).be.false();
    } finally {
      carrier.stop();
      server.stop(true);
    }
  });

  it('should report no carrier, and dial nothing, when none is configured', () => {
    // Arrange
    const dialled: string[] = [];
    const carrier = new BunRelayCarrier({
      config: undefined,
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async () => ok({}),
      socketFactory: url => {
        dialled.push(url);
        throw new Error('a daemon with no relay must not dial');
      },
    });

    // Act
    carrier.start();

    // Assert — the phase and the sentence, because "no relay" and "broken relay" look identical
    // without one.
    should(carrier.status()).containDeep({ phase: 'none', sessions: 0 });
    should(carrier.status().detail).match(/only directly/u);
    should(carrier.status().relayUrl).be.undefined();
    should(dialled).be.empty();
    carrier.stop();
  });
});

interface FakeSocket extends RelayWebSocket {
  readonly sent: Array<Uint8Array | string>;
  readonly closes: Array<{ code?: number; reason?: string }>;
}

function fakeSockets(): { readonly sockets: FakeSocket[]; readonly factory: (url: string) => RelayWebSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: () => {
      const socket: FakeSocket = {
        binaryType: '',
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent: [],
        closes: [],
        send: data => socket.sent.push(data),
        close: (code, reason) => socket.closes.push({ code, reason }),
      };
      sockets.push(socket);
      return socket;
    },
  };
}

describe('what a socket does that a protocol does not', () => {
  it('should redial after a drop, and stop for good when the daemon is going away', async () => {
    // Arrange
    const fake = fakeSockets();
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example', reconnectSeconds: 1 }),
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async () => ok({}),
      socketFactory: fake.factory,
    });

    // Act
    carrier.start();
    should(carrier.status().phase).equal('dialling');
    fake.sockets[0]?.onopen?.(undefined);
    fake.sockets[0]?.onclose?.(undefined);
    const second = await until(() => fake.sockets[1], 'the redial');

    // Assert — a fresh socket, and the rendezvous slot it will claim is a fresh one too: there is no
    // resumption in this protocol.
    should(second.binaryType).equal('arraybuffer');
    // Act + Assert — an error on the wire is the same event as a close, and a stopped carrier never
    // dials again.
    second.onerror?.(undefined);
    carrier.stop();
    should(carrier.status().phase).equal('stopped');
    await Bun.sleep(30);
    should(fake.sockets.length).be.lessThanOrEqual(3);
    // A stopped carrier ignores a late close from the socket it already gave up.
    second.onclose?.(undefined);
    should(carrier.status().phase).equal('stopped');
  });

  it('should drop a socket that stopped answering rather than believe it still holds the slot', async () => {
    // Arrange — a clock the test moves past the grace window.
    const fake = fakeSockets();
    const clock = { value: 1_000 };
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example' }),
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async () => ok({}),
      socketFactory: fake.factory,
      now: () => clock.value,
      heartbeatMs: 5,
    });
    carrier.start();
    const socket = fake.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.onopen?.(undefined);

    // Act + Assert — while the socket is fresh, the tick pings.
    socket.onmessage?.({ data: 'fy-ping' });
    should(socket.sent).containEql('fy-pong');
    await until(() => (socket.sent.includes('fy-ping') ? true : undefined), 'the heartbeat this side owes');

    // Act — the socket goes quiet for longer than the grace window.
    clock.value += 60_000;

    // Assert — no evidence of life means dropped, not means fine: the alternative is a daemon that
    // believes it holds a rendezvous slot every arriving client is being told is empty.
    const closed = await until(() => socket.closes[0], 'the socket to be dropped');
    should(closed.code).equal(4408);
    should(carrier.status().detail).match(/stopped answering/u);
    carrier.stop();
  });

  it('should refuse a message that is neither text nor bytes, and survive a link that throws', async () => {
    // Arrange
    const fake = fakeSockets();
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example' }),
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async () => {
        throw new Error('the route table exploded');
      },
      socketFactory: fake.factory,
    });
    carrier.start();
    const socket = fake.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.onopen?.(undefined);

    // Act + Assert — a carrier sending a number is not speaking this protocol.
    socket.onmessage?.({ data: 42 });
    should(socket.closes.length).be.greaterThan(0);
    should(carrier.status().detail).match(/neither text nor bytes/u);

    // Act + Assert — bytes that are not a frame are refused by the link itself.
    socket.onmessage?.({ data: new Uint8Array([0, 1, 2]).buffer });
    await Bun.sleep(10);
    should(socket.closes.length).be.greaterThan(1);
    carrier.stop();
  });

  it('should drop a socket whose own writes fail rather than carry on in a state nobody can describe', async () => {
    // Arrange — a socket that cannot be written to. Handing a frame to the link therefore throws
    // where nothing in the protocol can recover, which is the one case the carrier has to absorb.
    const broken: FakeSocket = {
      binaryType: '',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      sent: [],
      closes: [],
      send: () => {
        throw new Error('the socket is already gone');
      },
      close: (code, reason) => broken.closes.push({ code, reason }),
    };
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example' }),
      crypto: relayCrypto,
      identity,
      devices,
      dispatch: async () => ok({}),
      socketFactory: () => broken,
    });
    carrier.start();
    broken.onopen?.(undefined);

    // Act — a perfectly good challenge, which the daemon answers by writing a claim.
    broken.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }).buffer,
    });

    // Assert — the redial that follows gets a fresh rendezvous slot and fresh keys, which is the only
    // honest recovery: this protocol has no resumption.
    const closed = await until(() => broken.closes[0], 'the socket to be given up');
    should(closed.code).equal(4500);
    should(carrier.status().detail).match(/the relay link failed/u);
    carrier.stop();
  });
});
