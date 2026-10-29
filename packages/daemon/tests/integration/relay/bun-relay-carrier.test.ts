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
  deviceAuthMessage,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HANDSHAKE_FRAME_SEQUENCE,
  HOSTED_RELAY_BANDWIDTH_REASONS,
  hostedBandwidthReason,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  SESSION_PROTOCOL_ID,
  type SessionId,
  sealRecord,
  sessionIdFromBytes,
  signDeviceProof,
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
import type { SocketUpgradeDecision } from '../../../src/lib/api/socket.ts';
import { LiveDeviceConnections, type PairingRedemption } from '../../../src/lib/pairing/index.ts';
import { DaemonRelayConfigSchema } from '../../../src/lib/runtime/config.ts';

const relayCrypto = new WebCryptoRelayCrypto();
const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';

let identity: DaemonIdentity;
let deviceKey: Awaited<ReturnType<WebCryptoRelayCrypto['generateDeviceKey']>>;
let deviceKeyText: string;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(2));

beforeAll(async () => {
  identity = await new WebCryptoRelayIdentityKeys().load(new NodePairingCryptography().newIdentity().privateKeyPem);
  deviceKey = await relayCrypto.generateDeviceKey();
  deviceKeyText = toBase64Url(deviceKey.publicKeySpki);
});

/** The device's claim to one session, signed over that session's transcript — what a browser sends. */
async function claim(t: 'auth' | 'stream', transcript: Uint8Array): Promise<Record<string, string>> {
  const proof = await signDeviceProof(
    relayCrypto,
    relayCrypto.deviceKeyHandle(deviceKey.privateKey),
    deviceAuthMessage(transcript, t, DEVICE_ID, APP_SESSION),
  );
  return { t, protocol: SESSION_PROTOCOL_ID, deviceId: DEVICE_ID, appSession: APP_SESSION, proof };
}

const config = (patch: Record<string, unknown>) => DaemonRelayConfigSchema.parse(patch);

const ok = (body: unknown): ApiResponse => ({
  status: 200,
  headers: new Map([['content-type', 'application/json']]),
  body: JSON.stringify(body),
});

const devices = {
  deviceKey: async (deviceId: string) => (deviceId === DEVICE_ID ? deviceKeyText : undefined),
  seen: () => undefined,
};

/** This tier proves the SOCKET — its order, liveness, patience and teardown — so the two ports the
 *  link uses for streams and pairing answer nothing here. What they carry is the unit tier's subject. */
const relayStreams = {
  upgrade: async (): Promise<SocketUpgradeDecision> => ({ outcome: 'unclaimed' }),
  reauthorize: () => true,
};
const relayPairing = { redeemInSession: async (): Promise<PairingRedemption> => ({ kind: 'refused' }) };

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
              utf8Bytes(JSON.stringify(await claim('auth', completed.keys.transcriptHash))),
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
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
      dispatch: async request =>
        request.path === '/v1/sessions' && request.device?.deviceId === DEVICE_ID
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
      // path, the device's identity or its proof.
      const carried = opaque.map(payload => utf8Text(payload) ?? '');
      should(carried.some(text => text.includes('sessions'))).be.false();
      should(carried.some(text => text.includes(DEVICE_ID))).be.false();
      should(carried.some(text => text.includes(APP_SESSION))).be.false();
    } finally {
      carrier.stop();
      server.stop(true);
    }
  });

  it('should answer a fast relayed request while a slow one on the same link is still running', async () => {
    // Arrange — THE DEFECT: the carrier's inbound chain waited for each request's ROUTE HANDLER, so one
    // slow route held up every request and every keystroke behind it on the link. Here the slow route
    // does not answer until the fast answer has crossed; a carrier that serialised would never get it.
    const sessionId = session();
    const host = { value: '' };
    let channel: ChannelState | undefined;
    let pending: Awaited<ReturnType<typeof startClientHandshake>> | undefined;
    const answered: number[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowStarted = Promise.withResolvers<void>();

    const server = Bun.serve({
      port: 0,
      fetch: (request, host_) => (host_.upgrade(request) ? undefined : new Response('not a socket', { status: 400 })),
      websocket: {
        open: socket => {
          const challenge = relayCrypto.randomBytes(NONCE_BYTES);
          host.value = toBase64Url(challenge);
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
          if (typeof message === 'string') return;
          const decoded = decodeFrame(new Uint8Array(message));
          if (!decoded.ok) throw new Error(decoded.reason);
          const frame: RelayFrame = decoded.frame;
          if (frame.kind === FRAME_KINDS.control) {
            if (decodeControlMessage(frame.payload)?.t !== 'claim') return;
            socket.send(
              controlFrame({
                t: 'claimed',
                protocol: RELAY_PROTOCOL_ID,
                limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
              }),
            );
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
          const seal = async (body: unknown): Promise<Uint8Array> => {
            if (channel === undefined) throw new Error('no channel');
            const sealed = await sealRecord(relayCrypto, channel, utf8Bytes(JSON.stringify(body)));
            if (!sealed.ok) throw new Error(sealed.reason);
            channel = sealed.state;
            return encodeFrame(sealed.frame);
          };
          if (frame.kind === FRAME_KINDS.handshake) {
            const hello = decodeDaemonHello(frame.payload);
            if (hello === null || pending === undefined) throw new Error('no daemon hello');
            const completed = await completeClientHandshake(relayCrypto, pending, hello);
            if (!completed.ok) throw new Error(completed.reason);
            channel = openChannel(sessionId, completed.keys, 'client');
            socket.send(await seal(await claim('auth', completed.keys.transcriptHash)));
            return;
          }
          if (frame.kind !== FRAME_KINDS.data || channel === undefined) return;
          const opened = await openRecord(relayCrypto, channel, frame);
          if (!opened.ok) throw new Error(opened.reason);
          channel = opened.state;
          const read = JSON.parse(utf8Text(opened.plaintext) ?? 'null') as { t?: string; id?: number } | null;
          if (read?.t === 'authenticated') {
            // Both sealed before either is sent, so the two frames leave back to back.
            const slow = await seal({ t: 'req', id: 1, method: 'GET', path: '/slow' });
            const fast = await seal({ t: 'req', id: 2, method: 'GET', path: '/fast' });
            socket.send(slow);
            socket.send(fast);
            return;
          }
          if (read?.t === 'res' && read.id !== undefined) answered.push(read.id);
        },
      },
    });

    const carrier = new BunRelayCarrier({
      config: config({ url: `http://127.0.0.1:${server.port}` }),
      crypto: relayCrypto,
      identity,
      devices,
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
      dispatch: async request => {
        if (request.path === '/slow') {
          slowStarted.resolve();
          await new Promise<void>(resolve => {
            releaseSlow = resolve;
          });
        }
        return ok({ path: request.path });
      },
    });

    try {
      // Act
      carrier.start();
      await slowStarted.promise;
      const fastFirst = await until(() => (answered.length > 0 ? [...answered] : undefined), 'the fast answer');

      // Assert — the fast answer crossed while the slow route was still running.
      should(fastFirst).deepEqual([2]);

      // Act + Assert — the slow one answers when its route does, under its own id.
      releaseSlow?.();
      await until(() => (answered.length > 1 ? true : undefined), 'the slow answer');
      should(answered).deepEqual([2, 1]);
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
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
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
  readonly url: string;
  readonly sent: Array<Uint8Array | string>;
  readonly closes: Array<{ code?: number; reason?: string }>;
}

function fakeSockets(): { readonly sockets: FakeSocket[]; readonly factory: (url: string) => RelayWebSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: url => {
      const socket: FakeSocket = {
        url,
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
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
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

  it('should not let an in-flight frame resurrect a carrier after shutdown', async () => {
    // Arrange — capture the close callback because a real socket may already have queued it when
    // stop detaches the handlers. The claimed control is deliberately handed over immediately
    // before stop, leaving its ordered inbox continuation pending across the shutdown boundary.
    const fake = fakeSockets();
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example', reconnectSeconds: 1 }),
      crypto: relayCrypto,
      identity,
      devices,
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
      dispatch: async () => ok({}),
      socketFactory: fake.factory,
    });
    carrier.start();
    const socket = fake.sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.onopen?.(undefined);
    const closing = socket.onclose;

    try {
      // Act — the inbox used to complete after stop, rewrite `stopped` to `carrying`, and make this
      // already-queued close schedule a redial that kept the daemon process alive after shutdown.
      socket.onmessage?.({
        data: controlFrame({
          t: 'claimed',
          protocol: RELAY_PROTOCOL_ID,
          limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
        }),
      });
      carrier.stop();
      await Bun.sleep(0);
      closing?.(undefined);

      // Assert — stopped is monotonic, every handler is detached, and no queued callback can turn
      // shutdown into a new dial.
      should(carrier.status().phase).equal('stopped');
      should(socket.onopen).be.null();
      should(socket.onmessage).be.null();
      should(socket.onclose).be.null();
      should(socket.onerror).be.null();
      should(fake.sockets).have.length(1);
    } finally {
      // Also clears a redial timer on the unfixed source, so the deliberately red regression cannot
      // itself leave the focused test process alive.
      carrier.stop();
    }
  });

  it('should refuse a message that is neither text nor bytes, and survive a link that throws', async () => {
    // Arrange
    const fake = fakeSockets();
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example' }),
      crypto: relayCrypto,
      identity,
      devices,
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
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
      url: 'wss://relay.example',
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
      connections: new LiveDeviceConnections(),
      sockets: relayStreams,
      pairing: relayPairing,
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

describe('what a stopped carrier owes a live stream', () => {
  it('should release a relayed stream handler before dropping the socket it was armed against', async () => {
    // THE DEFECT THIS EXISTS TO PREVENT. A stream handler owns a redraw timer and a viewer slot armed
    // against this link, and the API host's own `closeSockets` reaches only the sockets it accepted —
    // never a relayed one. A carrier that dropped its socket without telling the link would leave both
    // firing at a peer that is already gone, which is exactly the failure the transport's own two-step
    // shutdown exists to prevent, reproduced on the carrier the daemon dialled.
    //
    // Arrange — one real session, handshaken with real crypto, carrying one stream.
    const fake = fakeSockets();
    const closed: string[] = [];
    let attached = false;
    const carrier = new BunRelayCarrier({
      config: config({ url: 'https://relay.example' }),
      crypto: relayCrypto,
      identity,
      devices,
      connections: new LiveDeviceConnections(),
      sockets: {
        upgrade: async () => ({
          outcome: 'accepted',
          attach: async () => ({
            open: async () => {
              attached = true;
            },
            fromClient: () => undefined,
            close: () => closed.push('released'),
          }),
        }),
        reauthorize: () => true,
      },
      pairing: relayPairing,
      dispatch: async () => ok({}),
      socketFactory: fake.factory,
    });
    carrier.start();
    const socket = await until(() => fake.sockets[0], 'the dialled socket');
    socket.onopen?.(undefined);

    // Arrange — the rendezvous half: challenge, claim, open, and the client's hello.
    const challenge = relayCrypto.randomBytes(NONCE_BYTES);
    socket.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(challenge),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    });
    await until(() => socket.sent.at(-1), 'the claim');
    socket.onmessage?.({
      data: controlFrame({
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
      }),
    });
    const sessionId = session();
    socket.onmessage?.({ data: controlFrame({ t: 'open' }, sessionId) });
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
    socket.onmessage?.({
      data: encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    });
    const answered = await until(() => {
      const frame = socket.sent
        .map(bytes => decodeFrame(bytes as Uint8Array))
        .filter(decoded => decoded.ok && decoded.frame.kind === FRAME_KINDS.handshake)
        .at(-1);
      return frame?.ok === true ? frame.frame : undefined;
    }, 'the handshake answer');
    const hello = decodeDaemonHello(answered.payload);
    if (hello === null) throw new Error('the daemon hello did not parse');
    const completed = await completeClientHandshake(relayCrypto, pending, hello);
    if (!completed.ok) throw new Error(completed.reason);

    // Act — open a stream, then take the daemon away.
    const sealed = await sealRecord(
      relayCrypto,
      openChannel(sessionId, completed.keys, 'client'),
      utf8Bytes(JSON.stringify({ ...(await claim('stream', completed.keys.transcriptHash)), path: '/v1/events' })),
    );
    if (!sealed.ok) throw new Error(sealed.reason);
    socket.onmessage?.({ data: encodeFrame(sealed.frame) });
    await until(() => (attached ? true : undefined), 'the stream to attach');
    carrier.stop();

    // Assert — the handler was told before the socket went, and the socket went afterwards.
    should(closed).deepEqual(['released']);
    should(socket.closes.at(-1)).containDeep({ code: 1000 });
    should(carrier.status().phase).equal('stopped');
  });
});

/** A clock and a scheduler that only move when the test says so: no test here waits on a wall clock. */
function fakeClock() {
  let current = 1_000;
  let nextId = 0;
  const pending = new Map<number, { readonly at: number; readonly action: () => void }>();
  const delays: number[] = [];
  return {
    now: () => current,
    delays,
    pending: () => pending.size,
    scheduler: {
      after: (milliseconds: number, action: () => void) => {
        nextId += 1;
        const id = nextId;
        delays.push(milliseconds);
        pending.set(id, { at: current + milliseconds, action });
        return { cancel: () => void pending.delete(id) };
      },
    },
    /** Time passes AND every timer that falls due runs, earliest first. */
    advance: (milliseconds: number) => {
      const target = current + milliseconds;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        current = Math.max(current, due[1].at);
        pending.delete(due[0]);
        due[1].action();
      }
      current = target;
    },
    /** Time passes and NO timer runs — a laptop asleep through its own ping. */
    jump: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

const CLAIMED = {
  t: 'claimed',
  protocol: RELAY_PROTOCOL_ID,
  limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
} as const;

function redialingCarrier(patch: Record<string, unknown> = {}, random = 1) {
  const fake = fakeSockets();
  const clock = fakeClock();
  const lines: string[] = [];
  const carrier = new BunRelayCarrier({
    config: config({ url: 'https://relay.example', ...patch }),
    crypto: relayCrypto,
    identity,
    devices,
    connections: new LiveDeviceConnections(),
    sockets: relayStreams,
    pairing: relayPairing,
    dispatch: async () => ok({}),
    socketFactory: fake.factory,
    scheduler: clock.scheduler,
    now: clock.now,
    random: () => random,
    log: line => lines.push(line),
  });
  const socketAt = (index: number): FakeSocket => {
    const socket = fake.sockets[index];
    if (socket === undefined) throw new Error(`no socket ${index}`);
    return socket;
  };
  /** The rendezvous half of a successful claim: challenge, the daemon's claim, then the acceptance. */
  const claimOn = async (socket: FakeSocket, claimed: ControlMessage = CLAIMED): Promise<void> => {
    socket.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    });
    await until(() => socket.sent.at(-1), 'the claim');
    socket.onmessage?.({ data: controlFrame(claimed) });
    await until(() => (carrier.status().phase === 'carrying' ? true : undefined), 'the carrier to carry');
  };
  return { carrier, fake, clock, lines, socketAt, claimOn };
}

describe('a carrier that survives a dropped rendezvous', () => {
  it('should redial at once after a drop and say what happened, naming the origin and never the path', () => {
    // Arrange — a configured address WITH a path, which is exactly what must not reach a log line.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier({ url: 'wss://relay.example/hosted/path' });
    carrier.start();
    socketAt(0).onopen?.(undefined);

    // Act — the rendezvous goes away (a Worker redeploy).
    socketAt(0).onclose?.({ code: 1006, reason: 'gone' });

    // Assert — phase and detail stay honest while the redial is pending.
    should(carrier.status()).containDeep({ phase: 'dialling' });
    should(carrier.status().detail).match(/connection ended \(1006 gone\)/u);
    should(fake.sockets).have.length(1);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    should(lines).deepEqual(['relay wss://relay.example: disconnected (1006 gone) — redial attempt 1 in 0ms']);
    should(lines.join('\n')).not.match(/hosted|rendezvous|fy_daemon/u);
    carrier.stop();
  });

  it('should back off with each failed redial, never above the ceiling, and keep trying', () => {
    // Arrange — the top of the jitter range, so the windows themselves are read off the delays.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier({ reconnectSeconds: 5 });
    carrier.start();
    const delays: string[] = [];

    // Act — seven consecutive failed dials, each waited out exactly.
    const expected = [0, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
    for (const [index, delay] of expected.entries()) {
      socketAt(index).onclose?.({ code: 1006, reason: '' });
      const said = lines.at(-1) ?? '';
      delays.push(said.replace(/^.* in /u, ''));
      if (delay > 0) {
        clock.advance(delay - 1);
        should(fake.sockets).have.length(index + 1);
      }
      clock.advance(delay > 0 ? 1 : 0);
      should(fake.sockets).have.length(index + 2);
    }

    // Assert
    should(delays).deepEqual(['0ms', '500ms', '1.0s', '2.0s', '4.0s', '5.0s', '5.0s']);
    should(lines.at(-1)).match(/redial attempt 7 in 5\.0s/u);
    carrier.stop();
  });

  it('should treat a huge configured wait as the ten-second ceiling', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier({ reconnectSeconds: 3_600 });
    carrier.start();

    // Act — drop twelve dials in a row.
    for (let index = 0; index < 12; index += 1) {
      socketAt(index).onclose?.({ code: 1006, reason: '' });
      clock.advance(10_000);
    }

    // Assert — no wait was ever longer than ten seconds.
    should(Math.max(...clock.delays.filter(delay => delay < 15_000))).be.belowOrEqual(10_000);
    carrier.stop();
  });

  it('should reset the backoff once the rendezvous accepts the claim, and say how long it was away', async () => {
    // Arrange — two failed dials, then a good one.
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onclose?.({ code: 1006, reason: '' });
    clock.advance(500);
    socketAt(2).onopen?.(undefined);

    // Act
    await claimOn(socketAt(2));

    // Assert — a recovery line, and a status with nothing left to explain.
    should(lines.at(-1)).equal('relay https://relay.example: reconnected after 2 attempts (0.5s offline)');
    should(carrier.status()).containDeep({ phase: 'carrying' });
    should(carrier.status().detail).be.undefined();

    // Act — the next drop starts from the top of the schedule again, not from where it left off.
    socketAt(2).onclose?.({ code: 1001, reason: 'going away' });

    // Assert
    should(lines.at(-1)).equal('relay https://relay.example: disconnected (1001 going away) — redial attempt 1 in 0ms');
    carrier.stop();
  });

  it('should say when the rendezvous accepts the claim, and how long after dialling, even on the first connect', async () => {
    // Arrange
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    clock.advance(1_200);

    // Act
    await claimOn(socketAt(0));

    // Assert — one line, no "reconnected" because nothing was lost.
    should(lines).deepEqual([
      'relay https://relay.example: connected — the rendezvous accepted the claim 1.2s after dialling',
    ]);
    carrier.stop();
  });

  it("should log the relay's own in-band words alongside the close that follows them", async () => {
    // Arrange — the Worker explains a refusal in-band and then closes the socket.
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({
      data: controlFrame({ t: 'error', code: 4500, reason: 'hosted relay accounting is unavailable\nforged: line' }),
    });
    clock.advance(1_000);

    // Act
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — both the close and the relay's words, on ONE printable line.
    should(lines).deepEqual([
      'relay https://relay.example: disconnected (1006; the relay said: error 4500 hosted relay accounting is unavailable forged: line) — redial attempt 1 in 0ms',
    ]);
    should(carrier.status().detail).match(/hosted relay accounting is unavailable/u);
    carrier.stop();
  });

  it('should report an in-band session close, but not blame a close that happened long before the drop', () => {
    // Arrange
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({ data: controlFrame({ t: 'closed', code: 4410, reason: 'client left' }, session()) });

    // Act — soon after: blamed. Then a second socket: the old message is long gone.
    clock.advance(2_000);
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onopen?.(undefined);
    clock.advance(6_000);
    socketAt(1).onclose?.({ code: 1006, reason: '' });

    // Assert
    should(lines[0]).match(/the relay said: closed 4410 client left/u);
    should(lines[1]).not.match(/the relay said/u);
    carrier.stop();
  });

  it('should not claim a recovery for a rendezvous that only opened the socket', async () => {
    // Arrange — a socket that opens and is then refused (a 4409 against a slot not yet swept).
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    clock.advance(0);
    socketAt(1).onopen?.(undefined);

    // Act
    socketAt(1).onclose?.({ code: 4409, reason: 'a daemon is already connected' });

    // Assert — attempt 2, and no "reconnected" line anywhere.
    should(lines.at(-1)).match(/disconnected \(4409 a daemon is already connected\) — redial attempt 2 in 500ms/u);
    should(lines.some(line => line.includes('reconnected'))).be.false();
    carrier.stop();
  });

  it('should back off for minutes on a hosted connection ceiling, never redialling it within a minute', async () => {
    // Arrange — the bottom of the jitter range, so every capacity wait is half its window.
    const { carrier, clock, lines, socketAt, claimOn } = redialingCarrier({}, 0);
    carrier.start();
    socketAt(0).onopen?.(undefined);
    socketAt(0).onmessage?.({
      data: controlFrame({ t: 'error', code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' }),
    });

    // Act — the Worker explains and closes; the close itself carries no code, only the in-band words do.
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — minutes, not the immediate redial a dropped path gets, and a status that says what it is.
    should(clock.delays.at(-1)).equal(60_000);
    should(lines.at(-1)).match(
      /refused: the relay's per-daemon or account connection ceiling is full .* redial attempt 1 in 60\.0s/u,
    );
    should(carrier.status().detail).match(/refused this daemon a connection slot/u);

    // Act — a refusal by close code doubles the window; a path drop between refusals restarts the run.
    clock.advance(60_000);
    socketAt(1).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(120_000);
    clock.advance(120_000);
    socketAt(2).onclose?.({ code: 1006, reason: '' });
    clock.advance(clock.delays.at(-1) ?? 0);
    socketAt(3).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(60_000);
    // One line per refusal, each a minute or more after the last: never the per-attempt flood.
    should(lines.filter(line => line.includes('refused:'))).have.length(3);

    // Act — a second refusal in the run, then the ceiling clears; the next refusal starts over.
    clock.advance(60_000);
    socketAt(4).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(120_000);
    clock.advance(120_000);
    socketAt(5).onopen?.(undefined);
    await claimOn(socketAt(5));
    socketAt(5).onclose?.({ code: 4432, reason: 'hosted relay per-daemon connection ceiling is reached' });
    should(clock.delays.at(-1)).equal(60_000);
    carrier.stop();
  });

  it('should wait for a spent relay data allowance to reset instead of redialling it', () => {
    // Arrange — the bottom of the jitter range, so every wait is exactly the schedule's.
    const { carrier, clock, lines, socketAt } = redialingCarrier({}, 0);
    carrier.start();
    socketAt(0).onopen?.(undefined);
    const resetsAt = 1_000 + 600_000;
    socketAt(0).onmessage?.({
      data: controlFrame({
        t: 'error',
        code: 4433,
        reason: hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, resetsAt),
      }),
    });

    // Act — explained in-band, then a close that carries nothing.
    socketAt(0).onclose?.({ code: 1006, reason: '' });

    // Assert — until the reset the relay named, and a status that says what ran out and when.
    should(clock.delays.at(-1)).equal(600_000);
    should(lines.at(-1)).match(
      /refused: the hosted relay's data allowance for this machine is used up for today, resetting at 1970-01-01T00:10:01\.000Z — redial attempt 1 in 600\.0s/u,
    );
    should(carrier.status().detail).match(/data allowance for this machine is used up for today .* resets at/u);

    // Act — an older relay names no reset: the UTC day is hours away, so it rechecks in half an hour.
    clock.advance(600_000);
    socketAt(1).onclose?.({ code: 4433, reason: HOSTED_RELAY_BANDWIDTH_REASONS.global.day });
    should(clock.delays.at(-1)).equal(1_800_000);
    should(lines.at(-1)).match(/allowance for the whole relay is used up for today/u);

    // Act — a minute window is never redialled sooner than a minute.
    clock.advance(1_800_000);
    socketAt(2).onclose?.({ code: 4433, reason: HOSTED_RELAY_BANDWIDTH_REASONS.daemon.minute });
    should(clock.delays.at(-1)).equal(60_000);
    should(lines.at(-1)).match(/used up for this minute/u);

    // Act — a 4433 whose words this build does not know is an ordinary drop.
    clock.advance(60_000);
    socketAt(3).onclose?.({ code: 4433, reason: 'something else' });
    should(lines.at(-1)).match(/^relay https:\/\/relay\.example: disconnected \(4433 something else\)/u);
    carrier.stop();
  });

  it('should report a transport error as a disconnect too', () => {
    // Arrange
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();

    // Act
    socketAt(0).onerror?.(undefined);

    // Assert
    should(lines).deepEqual(['relay https://relay.example: disconnected (connection error) — redial attempt 1 in 0ms']);
    should(clock.pending()).equal(1);
    carrier.stop();
  });

  it('should cancel a pending redial when the daemon stops', () => {
    // Arrange — a drop leaves a redial pending.
    const { carrier, fake, clock, socketAt } = redialingCarrier();
    carrier.start();
    socketAt(0).onclose?.({ code: 1006, reason: '' });
    should(clock.pending()).equal(1);

    // Act
    carrier.stop();
    clock.advance(600_000);

    // Assert — nothing is armed and nothing dials again.
    should(clock.pending()).equal(0);
    should(fake.sockets).have.length(1);
    should(carrier.status().phase).equal('stopped');
  });

  it('should abandon a dial that never opens and redial', () => {
    // Arrange — a black-holed route: the socket neither opens nor fails.
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier();
    carrier.start();

    // Act
    clock.advance(14_999);
    should(socketAt(0).closes).be.empty();
    clock.advance(1);

    // Assert
    should(socketAt(0).closes[0]?.code).equal(4408);
    should(lines.at(-2)).equal(
      'relay https://relay.example: liveness: the socket did not open within 15.0s — dropping it',
    );
    should(lines.at(-1)).match(/disconnected \(4408 no answer to the connection/u);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });
});

describe('a carrier that notices a dead path in seconds', () => {
  it('should drop a socket that stays silent after a ping, and redial', () => {
    // Arrange
    const { carrier, fake, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);

    // Act + Assert — nothing is sent before the keepalive interval.
    clock.advance(19_999);
    should(socket.sent).be.empty();
    clock.advance(1);
    should(socket.sent).deepEqual(['fy-ping']);

    // Act + Assert — and nothing answers: the deadline is ten seconds after the ping.
    clock.advance(9_999);
    should(socket.closes).be.empty();
    clock.advance(1);

    // Assert — closed with the heartbeat code, abandoned without waiting for a close handshake,
    // and the redial is already pending.
    should(socket.closes).deepEqual([{ code: 4408, reason: 'no answer within the heartbeat deadline' }]);
    should(carrier.status().detail).match(/stopped answering/u);
    should(lines).deepEqual([
      'relay https://relay.example: liveness: no reply within 10.0s of the ping — dropping the socket',
      'relay https://relay.example: disconnected (4408 no answer within the heartbeat deadline) — redial attempt 1 in 0ms',
    ]);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });

  it('should keep a socket whose pong arrives in time, and keep pinging', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);

    // Act — three keepalive rounds, each answered a second after its ping.
    for (let round = 0; round < 3; round += 1) {
      clock.advance(20_000 - (round === 0 ? 0 : 1_000));
      socket.onmessage?.({ data: 'fy-pong' });
      clock.advance(1_000);
    }
    clock.advance(10_000);

    // Assert — never closed, three pings sent.
    should(socket.closes).be.empty();
    should(socket.sent.filter(sent => sent === 'fy-ping')).have.length(3);
    should(carrier.status().phase).equal('dialling');
    carrier.stop();
  });

  it('should count any inbound message as the answer, not only a pong', () => {
    // Arrange
    const { carrier, clock, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    clock.advance(20_000);

    // Act — the peer's own ping arrives inside the window; that is evidence of life.
    socket.onmessage?.({ data: 'fy-ping' });
    clock.advance(10_000);

    // Assert
    should(socket.closes).be.empty();
    carrier.stop();
  });

  it('should drop a socket at its first tick when the clock shows it was silent past the grace window', () => {
    // Arrange — the process was asleep: the clock moved, no timer ran.
    const { carrier, clock, lines, socketAt } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    clock.jump(60_000);

    // Act — the first tick after waking is already overdue, so it runs the moment time is next observed.
    clock.advance(0);

    // Assert — dropped immediately, with no ping sent into a corpse and no further ten-second wait.
    should(socket.sent).be.empty();
    should(socket.closes[0]?.code).equal(4408);
    should(carrier.status().detail).match(/stopped answering/u);
    should(lines).deepEqual([
      'relay https://relay.example: liveness: nothing received for 60.0s (limit 45.0s) — dropping the socket',
      'relay https://relay.example: disconnected (4408 no answer within the heartbeat deadline) — redial attempt 1 in 0ms',
    ]);
    carrier.stop();
  });
});

describe('a carrier that asks the rendezvous itself whether it still holds the claim', () => {
  const PROBING = { ...CLAIMED, features: ['claim-probe'] } as const;
  const probesIn = (socket: FakeSocket): number =>
    socket.sent.filter(data => {
      if (typeof data === 'string') return false;
      const decoded = decodeFrame(data);
      return decoded.ok && decodeControlMessage(decoded.frame.payload)?.t === 'probe';
    }).length;

  it('should ask for the probe in the query, never the path, and keep the logged origin clean', () => {
    const { carrier, socketAt, lines } = redialingCarrier({ url: 'wss://relay.example/hosted/path' });
    carrier.start();
    const url = new URL(socketAt(0).url);
    should(url.searchParams.get('features')).equal('claim-probe,claim-handover');
    should(url.pathname).match(/^\/hosted\/path\/v1\/rendezvous\/fy_daemon_[A-Za-z0-9_-]{43}\/daemon$/u);
    should(carrier.status().relayUrl).not.match(/features/u);
    should(lines.join('\n')).not.match(/features/u);
    carrier.stop();
  });

  it('should probe on every keepalive once the rendezvous agreed, and keep a socket whose claim is held', async () => {
    const { carrier, clock, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);

    for (let round = 0; round < 3; round += 1) {
      clock.advance(20_000 - (round === 0 ? 0 : 1_000));
      socket.onmessage?.({ data: 'fy-pong' });
      socket.onmessage?.({ data: controlFrame({ t: 'held' }) });
      // Binary frames are handled on the carrier's inbox chain; let it run before the deadline is read.
      await Bun.sleep(1);
      clock.advance(1_000);
    }
    clock.advance(10_000);

    should(probesIn(socket)).equal(3);
    should(socket.closes).be.empty();
    should(carrier.status().phase).equal('carrying');
    carrier.stop();
  });

  it('should never probe a rendezvous that did not offer it', async () => {
    const { carrier, clock, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket);

    clock.advance(20_000);
    socket.onmessage?.({ data: 'fy-pong' });
    clock.advance(10_000);

    should(probesIn(socket)).equal(0);
    should(socket.closes).be.empty();
    carrier.stop();
  });

  it('should drop and re-claim when the edge answers the ping but the rendezvous never confirms the claim', async () => {
    // The incident, from the daemon's side: fy-pong kept arriving, so nothing looked wrong for 16 minutes.
    const { carrier, fake, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);
    lines.length = 0;

    clock.advance(20_000);
    socket.onmessage?.({ data: 'fy-pong' });
    clock.advance(10_000);

    should(socket.closes).deepEqual([{ code: 4408, reason: 'the rendezvous did not confirm the claim' }]);
    should(carrier.status().detail).match(/stopped confirming the claim/u);
    should(lines[0]).equal(
      'relay https://relay.example: liveness: the edge answered but the rendezvous did not confirm the claim within 10.0s — dropping the socket to claim again',
    );
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });

  it('should say so plainly, and redial at once, when the rendezvous reports the claim lost', async () => {
    const { carrier, fake, clock, lines, socketAt, claimOn } = redialingCarrier();
    carrier.start();
    const socket = socketAt(0);
    socket.onopen?.(undefined);
    await claimOn(socket, PROBING);
    lines.length = 0;

    socket.onmessage?.({
      data: controlFrame({ t: 'error', code: 4410, reason: 'this rendezvous no longer holds the claim' }),
    });
    socket.onclose?.({ code: 4410, reason: 'this rendezvous no longer holds the claim' });

    should(lines).deepEqual([
      'relay https://relay.example: liveness: the rendezvous no longer held this daemon’s claim — claiming again',
      'relay https://relay.example: disconnected (4410 this rendezvous no longer holds the claim; the relay said: error 4410 this rendezvous no longer holds the claim) — redial attempt 1 in 0ms',
    ]);
    clock.advance(0);
    should(fake.sockets).have.length(2);
    carrier.stop();
  });
});

describe('a carrier that offers its last handover token to reclaim its own rendezvous', () => {
  const TOKEN = 'A'.repeat(43);
  const NEXT_TOKEN = 'B'.repeat(43);
  const HANDING = { ...CLAIMED, features: ['claim-probe', 'claim-handover'], handover: TOKEN } as const;
  const replacesOf = (socket: FakeSocket): (string | undefined)[] =>
    socket.sent.flatMap(data => {
      if (typeof data === 'string') return [];
      const decoded = decodeFrame(data);
      const message = decoded.ok ? decodeControlMessage(decoded.frame.payload) : null;
      return message?.t === 'claim' ? [message.replaces] : [];
    });
  const redial = (harness: ReturnType<typeof redialingCarrier>): FakeSocket => {
    const before = harness.fake.sockets.length;
    harness.clock.advance(harness.clock.delays.at(-1) ?? 0);
    should(harness.fake.sockets).have.length(before + 1);
    return harness.socketAt(before);
  };
  const challenge = async (socket: FakeSocket): Promise<void> => {
    socket.onopen?.(undefined);
    socket.onmessage?.({
      data: controlFrame({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
        host: 'relay.example',
        deadlineSeconds: 10,
      }),
    });
    await until(() => (replacesOf(socket).length > 0 ? true : undefined), 'the claim');
  };

  it('should claim without a token the first time, and offer the issued one only from the next socket', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);

    // The holding socket is live: nothing has dialled, so nothing has offered the token.
    should(harness.fake.sockets).have.length(1);
    should(replacesOf(first)).deepEqual([undefined]);

    first.onclose?.({ code: 1006, reason: '' });
    const second = redial(harness);
    await challenge(second);

    should(replacesOf(second)).deepEqual([TOKEN]);
    harness.carrier.stop();
  });

  it('should not remember a token the rendezvous did not echo the feature for', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, { ...CLAIMED, features: ['claim-probe'], handover: TOKEN });

    first.onclose?.({ code: 1006, reason: '' });
    const second = redial(harness);
    await challenge(second);

    should(replacesOf(second)).deepEqual([undefined]);
    harness.carrier.stop();
  });

  it('should keep the token through a refusal of 4409 and through a transport failure', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    await challenge(second);
    second.onclose?.({ code: 4409, reason: 'another daemon already holds this rendezvous' });
    const third = redial(harness);
    await challenge(third);
    third.onerror?.(undefined);
    const fourth = redial(harness);
    await challenge(fourth);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([TOKEN]);
    should(replacesOf(fourth)).deepEqual([TOKEN]);
    harness.carrier.stop();
  });

  it('should drop the token once the rendezvous refuses a claim for any other reason', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    await challenge(second);
    second.onclose?.({ code: 4401, reason: 'the claim was rejected' });
    const third = redial(harness);
    await challenge(third);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([undefined]);
    harness.carrier.stop();
  });

  it('should replace the token with the one a successful reclaim issues, and use each only once', async () => {
    const harness = redialingCarrier();
    harness.carrier.start();
    const first = harness.socketAt(0);
    first.onopen?.(undefined);
    await harness.claimOn(first, HANDING);
    first.onclose?.({ code: 1006, reason: '' });

    const second = redial(harness);
    second.onopen?.(undefined);
    await harness.claimOn(second, { ...HANDING, handover: NEXT_TOKEN });
    second.onclose?.({ code: 1006, reason: '' });
    const third = redial(harness);
    await challenge(third);

    should(replacesOf(second)).deepEqual([TOKEN]);
    should(replacesOf(third)).deepEqual([NEXT_TOKEN]);
    harness.carrier.stop();
  });
});
