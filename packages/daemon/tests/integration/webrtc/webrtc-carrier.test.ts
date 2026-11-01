/**
 * TWO PEERS IN ONE PROCESS: a real WebRTC data channel carrying a real end-to-end session.
 *
 * The daemon half is production code throughout — the carrier, libdatachannel answering through the
 * engine adapter, and the direct session's own link (handshake against the pinned fingerprint, device
 * proof, sealed records). The browser half is a second libdatachannel peer driven by the protocol's own
 * client functions, so what crosses the channel is exactly what a browser would send. The network is
 * loopback and there is no STUN server: what is proved is the carrier, not a NAT.
 *
 * Asserted, because each is contract (`docs/relay-protocol.md` §16): one channel is one session; a
 * request on it reaches the route table as a REMOTE caller keyed by its peer connection, never loopback,
 * though both peers are on this machine; the heartbeat crosses as text; and a refused device proof
 * reaches the client as the session's `closed` with its code, because a data channel has none.
 */

import { afterEach, beforeAll, describe, it } from 'bun:test';
import { WEBRTC_SESSION_CHANNEL_LABEL } from '@ferretry/protocol';
import {
  type ChannelState,
  completeClientHandshake,
  type DaemonIdentity,
  decodeControlMessage,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  openChannel,
  openRecord,
  type PrivateKeyHandle,
  type RelayFrame,
  SESSION_PROTOCOL_ID,
  sealRecord,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { type DataChannel, PeerConnection } from 'node-datachannel';
import should from 'should';
import { NodeDataChannelEngine } from '../../../src/adapters/webrtc/index.ts';
import type { ApiRequest } from '../../../src/lib/api/http.ts';
import { LiveDeviceConnections } from '../../../src/lib/pairing/index.ts';
import { DirectSession } from '../../../src/lib/relay/direct-carrier.ts';
import { WebRtcCarrier } from '../../../src/lib/webrtc/index.ts';
import { waitFor } from '../support/wait-for.ts';
import { PeerWatch, withFreshOfferor } from '../support/webrtc-peer.ts';

const crypto_ = new WebCryptoRelayCrypto();
const DEVICE_ID = `fy_device_id_${'w'.repeat(22)}`;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(9));

let identity: DaemonIdentity;
let deviceKey: PrivateKeyHandle;
let deviceKeyText: string;
const cleanups: Array<() => void> = [];

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

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The daemon: a real carrier over the real engine, whose sessions are real direct sessions. */
function daemon() {
  const requests: ApiRequest[] = [];
  const carrier = new WebRtcCarrier({
    availability: { kind: 'ready' },
    engine: new NodeDataChannelEngine(),
    iceServers: [],
    sessions: (arrival, downstream, release) =>
      new DirectSession(
        {
          crypto: crypto_,
          identity,
          dispatch: async request => {
            requests.push(request);
            return { status: 200, headers: new Map([['content-type', 'application/json']]), body: '{"ok":true}' };
          },
          sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
          devices: {
            deviceKey: async deviceId => (deviceId === DEVICE_ID ? deviceKeyText : undefined),
            seen: () => undefined,
          },
          pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
          scheduler: {
            after: (milliseconds, action) => {
              const handle = setTimeout(action, milliseconds);
              return { cancel: () => clearTimeout(handle) };
            },
          },
          clock: { now: () => Date.now() },
          connections: new LiveDeviceConnections(),
        },
        arrival,
        downstream,
        release,
      ),
    scheduler: {
      after: (milliseconds, action) => {
        const handle = setTimeout(action, milliseconds);
        return { cancel: () => clearTimeout(handle) };
      },
    },
    peerId: () => 'peer-under-test',
  });
  cleanups.push(() => carrier.close());
  return { carrier, requests };
}

interface Client {
  readonly peer: PeerConnection;
  readonly watch: PeerWatch;
  readonly channel: DataChannel;
  readonly frames: RelayFrame[];
  readonly texts: string[];
  closed: boolean;
}

/** The browser: offers non-trickle, signals through the carrier, and waits for its channel to open. */
async function connect(carrier: WebRtcCarrier): Promise<Client> {
  return withFreshOfferor(() => connectOnce(carrier));
}

async function connectOnce(carrier: WebRtcCarrier): Promise<Client> {
  const peer = new PeerConnection('browser-under-test', { iceServers: [], bindAddress: '127.0.0.1' });
  cleanups.push(() => peer.close());
  const watch = new PeerWatch('browser-under-test', peer);
  const channel = peer.createDataChannel(WEBRTC_SESSION_CHANNEL_LABEL);
  const client = listen(peer, watch, channel);
  await watch.gathered();
  const offer = peer.localDescription();
  if (offer === null) throw new Error('the browser peer produced no offer');
  const answered = await carrier.offer(offer.sdp, { deviceId: DEVICE_ID, appSession: APP_SESSION });
  if (answered.kind !== 'answered') throw new Error(answered.reason);
  watch.answered(answered.sdp);
  await watch.opened(channel, WEBRTC_SESSION_CHANNEL_LABEL);
  return client;
}

/** Another session on a peer that is already connected: a new channel, no signalling at all. */
async function another(first: Client): Promise<Client> {
  const channel = first.peer.createDataChannel(WEBRTC_SESSION_CHANNEL_LABEL);
  const client = listen(first.peer, first.watch, channel);
  await first.watch.opened(channel, WEBRTC_SESSION_CHANNEL_LABEL);
  return client;
}

/** Records what arrives on one channel. */
function listen(peer: PeerConnection, watch: PeerWatch, channel: DataChannel): Client {
  const client: Client = { peer, watch, channel, frames: [], texts: [], closed: false };
  channel.onMessage(message => {
    if (typeof message === 'string') client.texts.push(message);
    else {
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
      const decoded = decodeFrame(bytes);
      if (!decoded.ok) throw new Error(decoded.reason);
      client.frames.push(decoded.frame);
    }
  });
  channel.onClosed(() => {
    client.closed = true;
  });
  return client;
}

async function until(what: string, condition: () => boolean): Promise<void> {
  await waitFor(condition, what);
}

/** The client half of §6 over the channel, after the daemon's `ready`. */
async function handshake(client: Client): Promise<{ readonly channel: ChannelState; readonly transcript: Uint8Array }> {
  await until('the daemon’s ready', () => client.frames.some(frame => frame.kind === FRAME_KINDS.control));
  const ready = client.frames.find(frame => frame.kind === FRAME_KINDS.control) as RelayFrame;
  should(decodeControlMessage(ready.payload)).containDeep({ t: 'ready' });
  const pending = await startClientHandshake(crypto_, ready.sessionId, identity.daemonId);
  client.channel.sendMessageBinary(
    encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId: ready.sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(pending.hello),
    }),
  );
  await until('the daemon hello', () => client.frames.some(frame => frame.kind === FRAME_KINDS.handshake));
  const hello = decodeDaemonHello(
    (client.frames.find(frame => frame.kind === FRAME_KINDS.handshake) as RelayFrame).payload,
  );
  if (hello === null) throw new Error('no daemon hello');
  const completed = await completeClientHandshake(crypto_, pending, hello);
  if (!completed.ok) throw new Error(completed.reason);
  return {
    channel: openChannel(ready.sessionId, completed.keys, 'client'),
    transcript: completed.keys.transcriptHash,
  };
}

async function send(client: Client, state: ChannelState, message: unknown): Promise<ChannelState> {
  const sealed = await sealRecord(crypto_, state, utf8Bytes(JSON.stringify(message)));
  if (!sealed.ok) throw new Error(sealed.reason);
  client.channel.sendMessageBinary(encodeFrame(sealed.frame));
  return sealed.state;
}

async function records(client: Client, state: ChannelState): Promise<unknown[]> {
  let reading = state;
  const out: unknown[] = [];
  for (const frame of client.frames.filter(candidate => candidate.kind === FRAME_KINDS.data)) {
    const opened = await openRecord(crypto_, reading, frame);
    if (!opened.ok) throw new Error(opened.reason);
    reading = opened.state;
    out.push(JSON.parse(utf8Text(opened.plaintext) ?? 'null'));
  }
  return out;
}

describe('the WebRTC carrier, two real peers in one process', () => {
  it('should carry a proven device’s request over a data channel, as a remote caller keyed by its peer', async () => {
    // Arrange
    const { carrier, requests } = daemon();
    const client = await connect(carrier);
    const { channel, transcript } = await handshake(client);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );

    // Act
    let next = await send(client, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });
    await until('the acceptance', () => client.frames.filter(frame => frame.kind === FRAME_KINDS.data).length >= 1);
    next = await send(client, next, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    await until('the answer', () => client.frames.filter(frame => frame.kind === FRAME_KINDS.data).length >= 2);
    client.channel.sendMessage('fy-ping');
    await until('the pong', () => client.texts.includes('fy-pong'));

    // Assert — both peers are on this machine, and the caller is still remote: locality is the
    // accepting carrier's answer, and this carrier's is never loopback.
    const messages = await records(client, channel);
    should(messages[0]).containDeep({ t: 'authenticated' });
    should(messages[1]).containDeep({ t: 'res', id: 1, status: 200, body: '{"ok":true}' });
    should(requests).have.length(1);
    should(requests[0]).containDeep({
      path: '/v1/sessions',
      device: { deviceId: DEVICE_ID, appSession: APP_SESSION },
      loopback: false,
      privilegedLoopback: false,
      clientAddress: 'webrtc-peer:peer-under-test',
    });
    should(carrier.peers).equal(1);
  });

  it('should tell the client a refused device proof as the session’s `closed`, then close the channel', async () => {
    // Arrange
    const { carrier, requests } = daemon();
    const client = await connect(carrier);
    const { channel, transcript } = await handshake(client);
    const stranger = `fy_device_id_${'s'.repeat(22)}`;
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', stranger, APP_SESSION),
    );

    // Act
    await send(client, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: stranger,
      appSession: APP_SESSION,
      proof,
    });
    await until('the refusal', () =>
      client.frames.some(
        frame => frame.kind === FRAME_KINDS.control && decodeControlMessage(frame.payload)?.t === 'closed',
      ),
    );
    await until('the channel to close', () => client.closed);

    // Assert
    const closed = client.frames
      .filter(frame => frame.kind === FRAME_KINDS.control)
      .map(frame => decodeControlMessage(frame.payload))
      .find(message => message?.t === 'closed');
    should(closed).containDeep({ t: 'closed', code: 4403 });
    should(requests).be.empty();
  });

  it('should end the session when the browser closes its channel, and carry the next one on the same peer', async () => {
    // Arrange
    const { carrier, requests } = daemon();
    const first = await connect(carrier);
    await handshake(first);

    // Act
    first.channel.close();
    await until('the channel to close', () => first.closed);
    const second = await another(first);
    const { channel, transcript } = await handshake(second);
    const proof = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcript, 'auth', DEVICE_ID, APP_SESSION),
    );
    const next = await send(second, channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof,
    });
    await until('the acceptance', () => second.frames.filter(frame => frame.kind === FRAME_KINDS.data).length >= 1);
    await send(second, next, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    await until('the answer', () => second.frames.filter(frame => frame.kind === FRAME_KINDS.data).length >= 2);

    // Assert
    should(carrier.peers).equal(1);
    should((await records(second, channel))[1]).containDeep({ t: 'res', id: 1, status: 200 });
    should(requests).have.length(1);
  });
});
