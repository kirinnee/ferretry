/**
 * The daemon's half of a rendezvous, driven by the real client half.
 *
 * Nothing here is stubbed above the socket: the frames are real frames, the handshake is the relay
 * package's own client code, the records are real AES-256-GCM under keys derived per session, and the
 * requests land in a dispatcher that answers like the daemon's route table. So the assertion that
 * matters — a browser reaches the daemon's API over a carrier that cannot read a byte of it — is made
 * against the code that would actually carry it.
 *
 * The refusals are tested as carefully as the success, because every one of them exists to stop a
 * session that would otherwise look healthy: a claim for a host the daemon never configured, a hello
 * addressed to another daemon, a token nobody knows, a repeated request identifier, a record whose
 * sequence is not the next one.
 */

import { beforeAll, describe, it } from 'bun:test';
import {
  MAX_SESSION_SECONDS,
  MAX_TUNNEL_BODY_BYTES,
  OLDER_APP_SENTENCE,
  RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
} from '@ferretry/protocol';
import {
  type ChannelState,
  type ClientHello,
  type ControlMessage,
  CREDIT_WINDOW_FRAMES,
  claimTranscript,
  completeClientHandshake,
  type DaemonIdentity,
  decodeControlMessage,
  decodeCreditPayload,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  devicePairMessage,
  deviceRenewMessage,
  encodeControlMessage,
  encodeCreditPayload,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HANDSHAKE_FRAME_SEQUENCE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_PLAINTEXT_BYTES,
  NONCE_BYTES,
  openChannel,
  openRecord,
  type PrivateKeyHandle,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayCrypto,
  type RelayFrame,
  SESSION_PROTOCOL_ID,
  type SessionId,
  type SessionKeys,
  sealRecord,
  sessionIdFromBytes,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
  verifyDeviceProof,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import type {
  SocketDownstream,
  SocketFrame,
  SocketHandler,
  SocketUpgradeDecision,
} from '../../../src/lib/api/socket.ts';
import { ApiSocketDispatcher, type SocketRoute } from '../../../src/lib/api/socket.ts';
import {
  LiveDeviceConnections,
  type PairingRedemption,
  type SessionPairingAttempt,
} from '../../../src/lib/pairing/index.ts';
import {
  ACCESS_LEASE_ENDED_REASON,
  type AccessLeasePolicy,
  MAX_CONCURRENT_REQUESTS,
  MAX_INCOMING_BODIES,
  MAX_PRE_CREDENTIAL_SESSIONS,
  RELAY_CREDENTIAL_DEADLINE_MS,
  RELAY_ENDED_SESSION_GRACE_MS,
  RELAY_MAX_ENDED_SESSIONS,
  RelayLink,
  type RelayLinkSocket,
  transcriptKey,
  UNKNOWN_DEVICE_KEY,
} from '../../../src/lib/relay/link.ts';
import { MAX_TUNNEL_DATA_BYTES } from '../../../src/lib/relay/tunnel.ts';

const crypto_ = new WebCryptoRelayCrypto();
const HOST = 'relay.example';
/**
 * The credential a test MEANS, before it is turned into what a session actually carries.
 *
 * A device now proves a key by signing its session's transcript, so a credential record cannot be
 * written as a literal: it depends on the handshake it follows. Cases still say which device they mean
 * — the known one, or a stranger — and `clientSend` turns that into a real signed claim.
 */
const DEVICE_TOKEN = 'fy_device_known';
const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(9));
const TEST_CLOCK = { now: () => 0 };
const AUTHENTICATED = {
  t: 'authenticated',
  protocol: SESSION_PROTOCOL_ID,
  accessExpiresAt: '1970-01-01T00:15:00.000Z',
} as const;
const STREAM_OPENED = {
  t: 'stream-opened',
  protocol: SESSION_PROTOCOL_ID,
  accessExpiresAt: '1970-01-01T00:15:00.000Z',
} as const;

let identity: DaemonIdentity;
let deviceKey: PrivateKeyHandle;
let deviceKeyText: string;
/** A key nobody paired, for a device the daemon must refuse. */
let strangerKey: PrivateKeyHandle;
/** Each open session's transcript hash, so a credential can be signed for exactly that session. */
const transcripts = new Map<string, Uint8Array>();

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    ...(base64.match(/.{1,64}/gu) ?? []),
    '-----END PRIVATE KEY-----',
    '',
  ].join('\n');
  identity = await crypto_.importDaemonIdentity(pem);
  const device = await crypto_.generateDeviceKey();
  deviceKey = crypto_.deviceKeyHandle(device.privateKey);
  deviceKeyText = toBase64Url(device.publicKeySpki);
  strangerKey = crypto_.deviceKeyHandle((await crypto_.generateDeviceKey()).privateKey);
});

/** A credential record as a session carries it: the device's claim, signed over this session. */
async function credentialed(channel: ChannelState, message: unknown): Promise<unknown> {
  if (typeof message !== 'object' || message === null) return message;
  const record = message as Record<string, unknown>;
  const transcript = transcripts.get(channel.sessionId.text) ?? new Uint8Array(32);
  if (record.t === 'pair' && !('deviceKey' in record))
    return {
      ...record,
      deviceKey: deviceKeyText,
      proof: await signDeviceProof(crypto_, deviceKey, devicePairMessage(transcript, deviceKeyText)),
    };
  if (!('deviceToken' in record) || (record.t !== 'auth' && record.t !== 'stream')) return message;
  const { deviceToken, ...rest } = record;
  const signer = deviceToken === DEVICE_TOKEN ? deviceKey : strangerKey;
  const proof = await signDeviceProof(crypto_, signer, deviceAuthMessage(transcript, record.t, DEVICE_ID, APP_SESSION));
  return { ...rest, deviceId: DEVICE_ID, appSession: APP_SESSION, proof };
}

interface Wire {
  readonly frames: RelayFrame[];
  readonly texts: string[];
  readonly closes: Array<{ code: number; reason: string }>;
  readonly socket: RelayLinkSocket;
}

function wire(): Wire {
  const frames: RelayFrame[] = [];
  const texts: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  return {
    frames,
    texts,
    closes,
    socket: {
      send: bytes => {
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) throw new Error(`the daemon sent an undecodable frame: ${decoded.reason}`);
        frames.push(decoded.frame);
      },
      sendText: text => texts.push(text),
      close: (code, reason) => closes.push({ code, reason }),
    },
  };
}

/** One armed deadline, so the ten-second credential window is provable without waiting ten seconds. */
interface FakeTimer {
  readonly milliseconds: number;
  readonly fire: () => void;
  cancelled: boolean;
}

/** One pairing attempt as the harness records it: its fields, and the verdict its own proof gave. */
interface RecordedPairing {
  readonly code: string;
  readonly deviceName: string;
  readonly deviceKey: string;
  readonly proven: boolean;
}

interface Harness {
  readonly link: RelayLink;
  readonly wire: Wire;
  readonly requests: ApiRequest[];
  /** Every upgrade the link asked the socket route table for. */
  readonly upgrades: ApiRequest[];
  /** Every pairing attempt the link handed to the redeemer. */
  /** Each attempt the pairing service was handed, with its proof already run — as the service runs it. */
  readonly pairings: RecordedPairing[];
  readonly timers: FakeTimer[];
  /** The device registry the link reports to, so a test can unpair the device a session belongs to. */
  readonly connections: LiveDeviceConnections;
}

function harness(
  answer: (request: ApiRequest) => Promise<ApiResponse> = async () => json(200, { ok: true }),
  knownToken = DEVICE_TOKEN,
  upgrade: (request: ApiRequest) => Promise<SocketUpgradeDecision> = async () => ({ outcome: 'unclaimed' }),
  redeem: (attempt: SessionPairingAttempt) => Promise<PairingRedemption> = async () => ({ kind: 'refused' }),
  extra: {
    readonly now?: () => number;
    readonly seen?: (deviceId: string) => void;
    readonly deviceKey?: (deviceId: string) => Promise<string | undefined>;
    readonly reauthorize?: (request: ApiRequest) => boolean;
    /** When this device's key is due for replacement; absent means the directory has no opinion at all. */
    readonly rotateBy?: (deviceId: string) => number | undefined;
    readonly lease?: AccessLeasePolicy;
    /** The `claim-handover` token (§5) a previous socket of this daemon was issued, offered as `replaces`. */
    readonly replaces?: string;
  } = {},
): Harness {
  const sent = wire();
  const requests: ApiRequest[] = [];
  const upgrades: ApiRequest[] = [];
  const pairings: RecordedPairing[] = [];
  const timers: FakeTimer[] = [];
  const connections = new LiveDeviceConnections();
  const link = new RelayLink({
    connections,
    crypto: crypto_,
    identity,
    relayHost: HOST,
    socket: sent.socket,
    dispatch: async request => {
      requests.push(request);
      return await answer(request);
    },
    sockets: {
      upgrade: async request => {
        upgrades.push(request);
        return await upgrade(request);
      },
      reauthorize: extra.reauthorize ?? (() => true),
    },
    devices: {
      deviceKey:
        extra.deviceKey ??
        (async deviceId => (knownToken === DEVICE_TOKEN && deviceId === DEVICE_ID ? deviceKeyText : undefined)),
      seen: extra.seen ?? (() => undefined),
      ...(extra.rotateBy === undefined ? {} : { rotateBy: extra.rotateBy }),
    },
    pairing: {
      redeemInSession: async attempt => {
        pairings.push({
          code: attempt.code,
          deviceName: attempt.deviceName,
          deviceKey: attempt.deviceKey,
          proven: await attempt.prove(),
        });
        return await redeem(attempt);
      },
    },
    clock: extra.now === undefined ? TEST_CLOCK : { now: extra.now },
    ...(extra.lease === undefined ? {} : { lease: extra.lease }),
    ...(extra.replaces === undefined ? {} : { replaces: extra.replaces }),
    scheduler: {
      after: (milliseconds, action) => {
        const timer: FakeTimer = { milliseconds, fire: action, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
  });
  return { link, wire: sent, requests, upgrades, pairings, timers, connections };
}

/** A stream handler that records what it was told, so a test can assert the bridge without a pane. */
interface FakeStream extends SocketHandler {
  readonly opened: number[];
  readonly fromClientFrames: SocketFrame[];
  readonly closed: number[];
  downstream: SocketDownstream | undefined;
}

function fakeStream(onOpen: (downstream: SocketDownstream) => void = () => undefined): FakeStream {
  const stream: FakeStream = {
    opened: [],
    fromClientFrames: [],
    closed: [],
    downstream: undefined,
    open: async () => {
      stream.opened.push(1);
      if (stream.downstream !== undefined) onOpen(stream.downstream);
    },
    fromClient: frame => {
      stream.fromClientFrames.push(frame);
    },
    close: () => {
      stream.closed.push(1);
    },
  };
  return stream;
}

/** An upgrade decision that accepts and hands back `stream`, capturing the downstream it is given. */
const accepts = (stream: FakeStream) => async (): Promise<SocketUpgradeDecision> => ({
  outcome: 'accepted',
  attach: async downstream => {
    stream.downstream = downstream;
    return stream;
  },
});

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  headers: new Map([['content-type', 'application/json']]),
  body: JSON.stringify(body),
});

const control = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID): Uint8Array =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });

const challenge = (host = HOST, nonce = crypto_.randomBytes(NONCE_BYTES)): Uint8Array =>
  control({
    t: 'challenge',
    protocol: RELAY_PROTOCOL_ID,
    nonce: toBase64Url(nonce),
    host,
    deadlineSeconds: 10,
  });

const claimed = (): Uint8Array =>
  control({
    t: 'claimed',
    protocol: RELAY_PROTOCOL_ID,
    limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
  });

const sessionOne = (): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  if (id === null) throw new Error('unreachable: a 16-byte identifier');
  return id;
};

/** The client half of one session, up to a keyed channel — the browser's side, using its own code. */
async function openSession(
  link: RelayLink,
  sent: Wire,
  sessionId: SessionId,
  expectedDaemonId = identity.daemonId,
): Promise<{ channel: ChannelState; keys: SessionKeys }> {
  await link.receiveBinary(control({ t: 'open' }, sessionId));
  const pending = await startClientHandshake(crypto_, sessionId, expectedDaemonId);
  await link.receiveBinary(
    encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId,
      sequence: HANDSHAKE_FRAME_SEQUENCE,
      payload: encodeHandshakeMessage(pending.hello),
    }),
  );
  const answerFrame = sent.frames.at(-1);
  if (answerFrame === undefined || answerFrame.kind !== FRAME_KINDS.handshake) throw new Error('no handshake answer');
  const hello = decodeDaemonHello(answerFrame.payload);
  if (hello === null) throw new Error('the daemon hello did not parse');
  const completed = await completeClientHandshake(crypto_, pending, hello);
  if (!completed.ok) throw new Error(completed.reason);
  transcripts.set(sessionId.text, completed.keys.transcriptHash);
  return { channel: openChannel(sessionId, completed.keys, 'client'), keys: completed.keys };
}

/** Seal one tunnel message as the client and hand it to the link. */
async function clientSend(link: RelayLink, channel: ChannelState, message: unknown): Promise<ChannelState> {
  const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(await credentialed(channel, message))));
  if (!sealed.ok) throw new Error(sealed.reason);
  await link.receiveBinary(encodeFrame(sealed.frame));
  return sealed.state;
}

/** Open the newest record the daemon sent, as the client. */
async function clientRead(sent: Wire, channel: ChannelState): Promise<{ state: ChannelState; message: unknown }> {
  const frame = sent.frames.filter(candidate => candidate.kind === FRAME_KINDS.data).at(-1);
  if (frame === undefined) throw new Error('the daemon sent no record');
  const opened = await openRecord(crypto_, channel, frame);
  if (!opened.ok) throw new Error(opened.reason);
  const text = utf8Text(opened.plaintext);
  if (text === null) throw new Error('a record carried invalid UTF-8');
  return { state: opened.state, message: JSON.parse(text) };
}

/**
 * Every record the daemon has sent since `from`, opened IN ORDER.
 *
 * A stream sends several records in a row, and the channel advances one sequence per record — so
 * reading only the newest one, as `clientRead` does, is exactly the "sequence is not the next one"
 * refusal the protocol exists to make. This is how a client actually reads a stream.
 */
async function clientReadAll(
  sent: Wire,
  channel: ChannelState,
  from = 0,
): Promise<{ state: ChannelState; messages: unknown[] }> {
  let state = channel;
  const messages: unknown[] = [];
  for (const frame of sent.frames.filter(candidate => candidate.kind === FRAME_KINDS.data).slice(from)) {
    const opened = await openRecord(crypto_, state, frame);
    if (!opened.ok) throw new Error(opened.reason);
    state = opened.state;
    const text = utf8Text(opened.plaintext);
    if (text === null) throw new Error('a record carried invalid UTF-8');
    messages.push(JSON.parse(text));
  }
  return { state, messages };
}

/**
 * Let the link finish everything it has queued.
 *
 * Sending is asynchronous — records are sealed with real crypto on the link's outbox — and
 * `receiveBinary` is the only thing that awaits it. A test that pushes frames through a stream's
 * downstream directly is not going through `receiveBinary`, so it needs one harmless frame to wait
 * on. A repeated `claimed` is the cheapest: the link records it and does nothing else.
 */
const settle = async (link: RelayLink): Promise<void> => {
  await link.receiveBinary(claimed());
};

/** Whether this link has yet told the peer that a session ended with its outcome already stated. */
const concluded = (sent: Wire): boolean =>
  sent.frames.some(frame => {
    const message = frame.kind === FRAME_KINDS.control ? decodeControlMessage(frame.payload) : null;
    return message?.t === 'closed' && message.code === RELAY_SESSION_CONCLUDED_CLOSE_CODE;
  });

const controlOf = (frame: RelayFrame | undefined): ControlMessage | null =>
  frame === undefined ? null : decodeControlMessage(frame.payload);

describe('claiming a rendezvous', () => {
  it('should probe the claim only on a rendezvous that offered it, and count each held', async () => {
    // Arrange — a plain `claimed`: a rendezvous that does not speak `claim-probe`.
    const plain = harness();
    await plain.link.receiveBinary(claimed());
    plain.link.probeClaim();
    should(plain.wire.frames).be.empty();
    should(plain.link.report()).containDeep({ claimProbe: false, held: 0 });

    // Act — a rendezvous that echoed the feature.
    const { link, wire: sent } = harness();
    await link.receiveBinary(
      control({
        t: 'claimed',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
        features: ['claim-probe'],
      }),
    );
    link.probeClaim();
    await link.receiveBinary(control({ t: 'held' }));
    await link.receiveBinary(control({ t: 'held' }));

    // Assert — one probe on the rendezvous session, two answers counted.
    should(sent.frames.map(controlOf)).deepEqual([{ t: 'probe' }]);
    should(sent.frames[0]?.sessionId.text).equal(RENDEZVOUS_SESSION_ID.text);
    should(link.report()).containDeep({ claimed: true, claimProbe: true, held: 2 });
  });

  it('should report the handover token only from a rendezvous that echoed claim-handover', async () => {
    const token = 'A'.repeat(43);
    const limits = { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 } as const;
    const handing = harness();
    await handing.link.receiveBinary(
      control({ t: 'claimed', protocol: RELAY_PROTOCOL_ID, limits, features: ['claim-handover'], handover: token }),
    );
    const silent = harness();
    await silent.link.receiveBinary(
      control({ t: 'claimed', protocol: RELAY_PROTOCOL_ID, limits, features: ['claim-probe'], handover: token }),
    );
    const plain = harness();
    await plain.link.receiveBinary(claimed());

    should(handing.link.report().handover).equal(token);
    should(silent.link.report().handover).be.undefined();
    should(plain.link.report().handover).be.undefined();
  });

  it('should offer the token it was given as `replaces` in the claim, and claim plainly without one', async () => {
    const token = 'B'.repeat(43);
    const offering = harness(undefined, undefined, undefined, undefined, { replaces: token });
    const plain = harness();

    await offering.link.receiveBinary(challenge());
    await plain.link.receiveBinary(challenge());

    const offered = controlOf(offering.wire.frames[0]);
    const unoffered = controlOf(plain.wire.frames[0]);
    if (offered?.t !== 'claim' || unoffered?.t !== 'claim') throw new Error('the daemon did not claim');
    should(offered.replaces).equal(token);
    should('replaces' in unoffered).be.false();
  });

  it('should sign the challenge for the host it dialled, and say what it claimed', async () => {
    // Arrange
    const { link, wire: sent } = harness();
    const nonce = crypto_.randomBytes(NONCE_BYTES);

    // Act
    await link.receiveBinary(challenge(HOST, nonce));

    // Assert — the claim is signed over the exact transcript the rendezvous will reproduce.
    const claim = controlOf(sent.frames[0]);
    if (claim?.t !== 'claim') throw new Error('the daemon did not claim the rendezvous');
    const signature = fromBase64UrlFixed(claim.signature, 64);
    const publicKey = fromBase64UrlFixed(claim.publicKey, 44);
    if (signature === null || publicKey === null) throw new Error('malformed claim');
    should(
      await crypto_.verifyEd25519(
        publicKey,
        signature,
        claimTranscript({ daemonId: identity.daemonId, relayHost: HOST, challenge: nonce }),
      ),
    ).be.true();
    should(link.report()).containDeep({ claimed: false, sessions: 0 });

    // Act + Assert — the rendezvous confirms, and only then does the link say it is claimed.
    await link.receiveBinary(claimed());
    should(link.report().claimed).be.true();
  });

  it('should refuse to sign a host it did not configure', async () => {
    // Arrange
    const { link, wire: sent } = harness();

    // Act
    await link.receiveBinary(challenge('someone-elses-relay.example'));

    // Assert — no signature is produced at all: a signature for another host is exactly what a
    // hostile relay would like to collect.
    should(sent.frames).be.empty();
    should(sent.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);
    should(link.report().lastRefusal).match(/someone-elses-relay\.example/u);
  });

  it('should refuse a malformed challenge, a second challenge and a control message meant for another role', async () => {
    // Assert — a nonce of the wrong width.
    const malformed = harness();
    await malformed.link.receiveBinary(
      // 43 base64url characters — the width the control schema admits — that decode to 32 bytes and
      // do not re-encode to themselves. The decoder still refuses a non-canonical spelling, and this
      // is the only way a challenge reaches the daemon's own nonce check.
      control({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        nonce: `${'A'.repeat(42)}B`,
        host: HOST,
        deadlineSeconds: 10,
      }),
    );
    should(malformed.wire.frames).be.empty();
    should(malformed.link.report().lastRefusal).match(/nonce is malformed/u);

    // Assert — a second challenge after the claim means the carrier and the daemon disagree.
    const second = harness();
    await second.link.receiveBinary(challenge());
    await second.link.receiveBinary(claimed());
    await second.link.receiveBinary(challenge());
    should(second.wire.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);

    // Assert — `ready` is the client's message. Receiving one is not this conversation.
    const wrongRole = harness();
    await wrongRole.link.receiveBinary(
      control({
        t: 'ready',
        protocol: RELAY_PROTOCOL_ID,
        limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
      }),
    );
    should(wrongRole.wire.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);

    // Assert — an unparseable control frame, and a frame that is not a frame.
    const garbage = harness();
    await garbage.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: utf8Bytes('{'),
      }),
    );
    should(garbage.wire.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);
    const short = harness();
    await short.link.receiveBinary(new Uint8Array([0xfe, 0x01]));
    should(short.wire.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);
  });

  it('should answer a heartbeat, ping on demand, and refuse any other text', async () => {
    // Arrange
    const { link, wire: sent } = harness();

    // Act + Assert
    link.receiveText(HEARTBEAT_REQUEST);
    should(sent.texts).deepEqual([HEARTBEAT_RESPONSE]);
    link.receiveText(HEARTBEAT_RESPONSE);
    should(sent.texts).deepEqual([HEARTBEAT_RESPONSE]);
    link.heartbeat();
    should(sent.texts).deepEqual([HEARTBEAT_RESPONSE, HEARTBEAT_REQUEST]);
    link.receiveText('hello?');
    should(sent.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);
  });
});

describe('a relayed session', () => {
  it('should carry a request to the daemon route table and the answer back, encrypted end to end', async () => {
    // Arrange
    const {
      link,
      wire: sent,
      requests,
    } = harness(async request =>
      request.path === '/v1/sessions' ? json(200, { sessions: ['one'] }) : json(404, { error: 'unknown_route' }),
    );
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const sessionId = sessionOne();

    // Act — the handshake, then the credential, then one request.
    const session = await openSession(link, sent, sessionId);
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const authenticated = await clientRead(sent, channel);
    should(authenticated.message).deepEqual(AUTHENTICATED);
    should(link.report()).containDeep({ claimed: true, sessions: 1 });

    channel = await clientSend(link, channel, {
      t: 'req',
      id: 9,
      method: 'GET',
      path: '/v1/sessions',
      headers: { 'x-ferretry-client': 'ui' },
    });
    const answer = await clientRead(sent, authenticated.state);

    // Assert — the answer, and the request the route table actually saw.
    should(answer.message).deepEqual({
      t: 'res',
      id: 9,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessions: ['one'] }),
    });
    should(requests).have.length(1);
    // The device the session PROVED, attached by the tunnel — and no header credential at all.
    should(requests[0]?.device).deepEqual({ deviceId: DEVICE_ID, appSession: APP_SESSION });
    should(requests[0]?.headers.has('authorization')).be.false();
    should(requests[0]?.headers.get('x-ferretry-client')).equal('ui');
    should(requests[0]?.loopback).be.false();
  });

  // R9-1
  it('should not send an answer whose last word changed while it queued and sealed, and end the session instead', async () => {
    // Arrange — the answer reads one way when it is spelled and another by the time it would leave.
    let spellings = 0;
    const spelled = (): ApiResponse => {
      spellings += 1;
      return json(200, { text: spellings === 1 ? 'pane-CANARY' : 'held' });
    };
    const { link, wire: sent } = harness(async () => ({ ...json(200, { text: 'pane-CANARY' }), late: spelled }));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    const channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const before = sent.frames.length;

    // Act
    await clientSend(link, channel, { t: 'req', id: 4, method: 'GET', path: '/v1/input' });

    // Assert — no data frame carried the old words, and the session ended rather than skip a sequence.
    const after = sent.frames.slice(before).filter(frame => frame.kind === FRAME_KINDS.data);
    should(after).have.length(0);
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
    should(link.report()).containDeep({ sessions: 0 });
  });

  it('should treat an answer that cannot be spelled again as changed', async () => {
    let spellings = 0;
    const late = (): ApiResponse => {
      spellings += 1;
      if (spellings > 1) throw new Error('cannot spell');
      return json(200, { text: 'once' });
    };
    const { link, wire: sent } = harness(async () => ({ ...json(200, { text: 'once' }), late }));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    const channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const before = sent.frames.length;

    await clientSend(link, channel, { t: 'req', id: 4, method: 'GET', path: '/v1/input' });

    should(sent.frames.slice(before).filter(frame => frame.kind === FRAME_KINDS.data)).have.length(0);
    should(link.report()).containDeep({ sessions: 0 });
  });

  it('should send an answer whose last word is unchanged', async () => {
    const { link, wire: sent } = harness(async () => ({
      ...json(200, { text: 'same' }),
      late: () => json(200, { text: 'same' }),
    }));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    const channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    await clientSend(link, channel, { t: 'req', id: 4, method: 'GET', path: '/v1/input' });

    const read = await clientReadAll(sent, session.channel);

    should(read.messages.at(-1)).containDeep({ t: 'res', id: 4, status: 200, body: JSON.stringify({ text: 'same' }) });
  });

  it('should carry an answer too large for one record as ordered parts, never truncating it', async () => {
    // Arrange — a response far past one record.
    const body = 'x'.repeat(70_000);
    const { link, wire: sent } = harness(async () => ({ status: 200, headers: new Map(), body }));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());

    // Act
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    channel = await clientSend(link, channel, { t: 'req', id: 1, method: 'GET', path: '/v1/big' });
    const read = await clientReadAll(sent, session.channel);

    // Assert — the head says more follows, the tail does not, and the parts are the whole body.
    const [, head, ...rest] = read.messages as Array<{ t: string; body?: string; more?: true }>;
    should(head).containDeep({ t: 'res', id: 1, status: 200, more: true });
    should(rest.at(-1)?.more).be.undefined();
    should([head, ...rest].map(part => part?.body ?? '').join('')).equal(body);
  });

  it('should assemble a request body that arrived in parts, and dispatch it once the last part lands', async () => {
    // Arrange
    const { link, wire: sent, requests } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act
    channel = await clientSend(link, channel, {
      t: 'req',
      id: 2,
      method: 'PUT',
      path: '/v1/x',
      body: 'one-',
      more: true,
    });
    channel = await clientSend(link, channel, { t: 'req-more', id: 2, body: 'two-', more: true });
    should(requests).be.empty();
    channel = await clientSend(link, channel, { t: 'req-more', id: 2, body: 'three' });

    // Assert
    should(requests).have.length(1);
    should(await requests[0]?.text()).equal('one-two-three');
    // A part for a request nobody started is a protocol error.
    await clientSend(link, channel, { t: 'req-more', id: 3, body: 'stray' });
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should answer 413 for a body past the limit, holding none of it, and keep the session serving', async () => {
    // Arrange — a body whose parts cross the limit; the daemon must stop holding them as soon as they do.
    const { link, wire: sent, requests } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const part = 'p'.repeat(60_000);
    channel = await clientSend(link, channel, {
      t: 'req',
      id: 4,
      method: 'PUT',
      path: '/v1/x',
      body: part,
      more: true,
    });
    const parts = Math.ceil(MAX_TUNNEL_BODY_BYTES / part.length);
    for (let index = 0; index < parts; index += 1) {
      channel = await clientSend(link, channel, { t: 'req-more', id: 4, body: part, more: true });
      // Return credit as the reader a browser is, or the daemon's window would close on its answers.
      if (index % 8 === 0) await Promise.resolve();
    }
    channel = await clientSend(link, channel, { t: 'req-more', id: 4, body: 'end' });
    const read = await clientReadAll(sent, session.channel);

    // Assert
    should(requests).be.empty();
    should(read.messages.at(-1)).containDeep({ t: 'res', id: 4, status: 413 });
    should(link.report().sessions).equal(1);
  });

  it('should refuse more bodies arriving at once than one session may assemble', async () => {
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    for (let id = 1; id <= MAX_INCOMING_BODIES + 1; id += 1)
      channel = await clientSend(link, channel, { t: 'req', id, method: 'PUT', path: '/v1/x', body: 'a', more: true });

    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should tell an app from before device keys which side is old, in words, at the handshake', async () => {
    // A `/1` hello is not an attack and not a bug; it is an app nobody updated.
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    await link.receiveBinary(control({ t: 'open' }, sessionOne()));
    const pending = await startClientHandshake(crypto_, sessionOne(), identity.daemonId);
    await link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionOne(),
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: utf8Bytes(JSON.stringify({ ...pending.hello, protocol: 'ferretry-relay/1' })),
      }),
    );

    should(controlOf(sent.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.versionUnsupported,
      reason: OLDER_APP_SENTENCE,
    });
  });

  it('should refuse a credential nobody knows, inside the encrypted channel', async () => {
    // Arrange
    const { link, wire: sent, requests } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const sessionId = sessionOne();
    const session = await openSession(link, sent, sessionId);

    // Act
    await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: 'fy_device_stolen',
    });

    // Assert — the session ends with 4403 and the socket stays up for everybody else.
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
    should(sent.closes).be.empty();
    should(link.report().sessions).equal(0);
    should(requests).be.empty();
  });

  it('should refuse a first record that is not an authentication, and a second one that is', async () => {
    // Arrange
    const first = harness();
    await first.link.receiveBinary(challenge());
    await first.link.receiveBinary(claimed());
    const session = await openSession(first.link, first.wire, sessionOne());

    // Act + Assert — a request before the credential.
    await clientSend(first.link, session.channel, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    should(controlOf(first.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });

    // Arrange — a session that authenticates twice.
    const twice = harness();
    await twice.link.receiveBinary(challenge());
    await twice.link.receiveBinary(claimed());
    const opened = await openSession(twice.link, twice.wire, sessionOne());
    const channel = await clientSend(twice.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act + Assert
    await clientSend(twice.link, channel, { t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN });
    should(controlOf(twice.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should refuse a repeated request identifier rather than answer it twice', async () => {
    // Arrange
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act
    channel = await clientSend(link, channel, { t: 'req', id: 5, method: 'GET', path: '/v1/health' });
    await clientSend(link, channel, { t: 'req', id: 5, method: 'GET', path: '/v1/health' });

    // Assert — an answer that could belong to either request is worse than a closed session.
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should refuse an unparseable record, a record before the handshake, and a hello for another daemon', async () => {
    // Arrange — a record whose plaintext is not a tunnel message.
    const garbage = harness();
    await garbage.link.receiveBinary(challenge());
    await garbage.link.receiveBinary(claimed());
    const session = await openSession(garbage.link, garbage.wire, sessionOne());
    await clientSend(garbage.link, session.channel, { t: 'whatever' });
    should(controlOf(garbage.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
    });

    // Assert — a record for a session that has not handshaked yet.
    const early = harness();
    await early.link.receiveBinary(challenge());
    await early.link.receiveBinary(claimed());
    await early.link.receiveBinary(control({ t: 'open' }, sessionOne()));
    await early.link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.data, sessionId: sessionOne(), sequence: 1, payload: new Uint8Array(32) }),
    );
    should(controlOf(early.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });

    // Assert — a hello naming a different daemon is a misrouted session, and answering it would key a
    // channel to a peer that thinks it reached somebody else.
    const misrouted = harness();
    await misrouted.link.receiveBinary(challenge());
    await misrouted.link.receiveBinary(claimed());
    await misrouted.link.receiveBinary(control({ t: 'open' }, sessionOne()));
    const strangerHello: ClientHello = (
      await startClientHandshake(crypto_, sessionOne(), `fy_daemon_${'A'.repeat(43)}`)
    ).hello;
    await misrouted.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionOne(),
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(strangerHello),
      }),
    );
    should(controlOf(misrouted.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });

    // Assert — an unparseable hello, and a handshake that arrives twice.
    const badHello = harness();
    await badHello.link.receiveBinary(challenge());
    await badHello.link.receiveBinary(claimed());
    await badHello.link.receiveBinary(control({ t: 'open' }, sessionOne()));
    await badHello.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionOne(),
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: utf8Bytes('{}'),
      }),
    );
    should(controlOf(badHello.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });

    const repeated = harness();
    await repeated.link.receiveBinary(challenge());
    await repeated.link.receiveBinary(claimed());
    await openSession(repeated.link, repeated.wire, sessionOne());
    const again = await startClientHandshake(crypto_, sessionOne(), identity.daemonId);
    await repeated.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionOne(),
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(again.hello),
      }),
    );
    should(controlOf(repeated.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should end a session whose record fails authentication or arrives out of order', async () => {
    // Arrange
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    const sealed = await sealRecord(crypto_, session.channel, utf8Bytes('{"t":"auth"}'));
    if (!sealed.ok) throw new Error(sealed.reason);

    // Act — one byte of the ciphertext altered by whatever is on the path.
    const tampered = encodeFrame(sealed.frame);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    await link.receiveBinary(tampered);

    // Assert
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.frameForged });

    // Arrange — a session whose second record skips a sequence number.
    const skipped = harness();
    await skipped.link.receiveBinary(challenge());
    await skipped.link.receiveBinary(claimed());
    const other = await openSession(skipped.link, skipped.wire, sessionOne());
    const first = await sealRecord(crypto_, other.channel, utf8Bytes('{"t":"auth"}'));
    if (!first.ok) throw new Error(first.reason);
    const third = await sealRecord(crypto_, first.state, utf8Bytes('{"t":"auth"}'));
    if (!third.ok) throw new Error(third.reason);

    // Act — deliver only the second record, so a frame is missing.
    await skipped.link.receiveBinary(encodeFrame(third.frame));

    // Assert — a gap is never repaired and never skipped.
    should(controlOf(skipped.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.sequenceBroken,
    });
  });

  it('should forget a session the rendezvous closed, and refuse a frame for one it never opened', async () => {
    // Arrange
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    await openSession(link, sent, sessionOne());
    should(link.report().sessions).equal(1);

    // Act — the client disconnected.
    await link.receiveBinary(
      control({ t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'gone' }, sessionOne()),
    );

    // Assert
    should(link.report().lastRefusal).match(/ended a session/u);

    // Act + Assert — a record for a session this link does not hold ends the whole link: it cannot
    // know which conversation it just failed to be part of.
    await link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.data, sessionId: sessionOne(), sequence: 1, payload: new Uint8Array(32) }),
    );
    should(sent.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);
  });

  it('should drop a frame already in flight for a session it ended, and keep every other session', async () => {
    // THE ATTACK, as the carrier delivers it: a stranger opens one session past the pre-credential
    // bound and sends its hello at `ready`. The rendezvous forwards `open` and the hello back to
    // back, so the daemon ends that session as busy and only THEN reads the hello naming it.
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const ids = Array.from({ length: MAX_PRE_CREDENTIAL_SESSIONS + 1 }, (_unused, index) => {
      const id = sessionIdFromBytes(new Uint8Array([index + 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 99]));
      if (id === null) throw new Error('unreachable: 16 bytes');
      return id;
    });
    for (const id of ids.slice(0, MAX_PRE_CREDENTIAL_SESSIONS)) await link.receiveBinary(control({ t: 'open' }, id));
    const busy = ids[MAX_PRE_CREDENTIAL_SESSIONS] as SessionId;
    const pending = await startClientHandshake(crypto_, busy, identity.daemonId);

    // Act
    await link.receiveBinary(control({ t: 'open' }, busy));
    await link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: busy,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
    await link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: busy, sequence: 0, payload: encodeCreditPayload(1) }),
    );

    // Assert — the busy session was refused, the stragglers were dropped, and the link still holds
    // the socket and every session it admitted.
    should(sent.closes).be.empty();
    should(link.report().sessions).equal(MAX_PRE_CREDENTIAL_SESSIONS);
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.rendezvousBusy });
  });

  it('should drop a straggler for a concluded session, and forget it once the grace window passes', async () => {
    // Arrange — a session that ends with a sealed outcome rather than a refusal.
    const stream = fakeStream();
    const { link, wire: sent, timers } = harness(undefined, DEVICE_TOKEN, accepts(stream));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const { channel: keyed } = await openSession(link, sent, sessionOne());
    const channel = await clientSend(link, keyed, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
      query: [],
    });
    await clientSend(link, channel, { t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1000, reason: 'x' });
    should(concluded(sent)).be.true();
    const straggler = encodeFrame({
      kind: FRAME_KINDS.data,
      sessionId: sessionOne(),
      sequence: 9,
      payload: new Uint8Array(32),
    });

    // Act + Assert — inside the window, dropped.
    await link.receiveBinary(straggler);
    should(sent.closes).be.empty();

    // Act + Assert — once it passes, the identifier names nothing this daemon remembers.
    const grace = timers.filter(timer => timer.milliseconds === RELAY_ENDED_SESSION_GRACE_MS);
    should(grace).have.length(1);
    for (const timer of grace) timer.fire();
    await link.receiveBinary(straggler);
    should(sent.closes).containDeep([
      { code: RELAY_CLOSE_CODES.protocolError, reason: 'a frame named no live session' },
    ]);
  });

  it('should treat a reopened identifier as a new session, and remember only the most recent endings', async () => {
    // Arrange
    const { link, wire: sent, timers } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const idFor = (index: number): SessionId => {
      const id = sessionIdFromBytes(
        new Uint8Array([index % 256, Math.floor(index / 256), 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 77]),
      );
      if (id === null) throw new Error('unreachable: 16 bytes');
      return id;
    };
    const timeOut = async (id: SessionId): Promise<void> => {
      await link.receiveBinary(control({ t: 'open' }, id));
      timers
        .filter(timer => timer.milliseconds === RELAY_CREDENTIAL_DEADLINE_MS)
        .at(-1)
        ?.fire();
    };

    // Act — one session ends, its identifier opens again, and the new one is served as itself.
    await timeOut(idFor(0));
    await link.receiveBinary(control({ t: 'open' }, idFor(0)));
    should(link.report().sessions).equal(1);
    await link.receiveBinary(control({ t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'gone' }, idFor(0)));

    // Assert — a session the RENDEZVOUS ended is not one this daemon ended, so its stragglers are
    // still a disagreement worth the link. Checked on a throwaway harness so this one keeps running.
    const strict = harness();
    await strict.link.receiveBinary(challenge());
    await strict.link.receiveBinary(claimed());
    await strict.link.receiveBinary(control({ t: 'open' }, idFor(0)));
    await strict.link.receiveBinary(
      control({ t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'gone' }, idFor(0)),
    );
    await strict.link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.data, sessionId: idFor(0), sequence: 1, payload: new Uint8Array(32) }),
    );
    should(strict.wire.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);

    // Act — more endings than the link remembers.
    for (let index = 1; index <= RELAY_MAX_ENDED_SESSIONS + 1; index += 1) await timeOut(idFor(index));
    const frameFor = (id: SessionId): Uint8Array =>
      encodeFrame({ kind: FRAME_KINDS.data, sessionId: id, sequence: 1, payload: new Uint8Array(32) });
    await link.receiveBinary(frameFor(idFor(RELAY_MAX_ENDED_SESSIONS + 1)));
    should(sent.closes).be.empty();
    await link.receiveBinary(frameFor(idFor(1)));

    // Assert — the oldest was forgotten to make room, so it names nothing now.
    should(sent.closes).containDeep([{ code: RELAY_CLOSE_CODES.protocolError }]);

    // Act + Assert — a forgotten ending's timer firing late touches nothing.
    for (const timer of timers.filter(candidate => candidate.milliseconds === RELAY_ENDED_SESSION_GRACE_MS))
      timer.fire();
  });

  it('should keep the reason a rendezvous refused it, without racing the close', async () => {
    // Arrange
    const { link, wire: sent } = harness();

    // Act
    await link.receiveBinary(
      control({ t: 'error', code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'the hosted relay is disabled' }),
    );

    // Assert — the rendezvous closes the socket itself; closing again from here would race its own
    // close frame.
    should(sent.closes).be.empty();
    should(link.report().lastRefusal).match(/hosted relay is disabled/u);
  });

  it('should end the session a second open would have overwritten', async () => {
    // Arrange
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    await openSession(link, sent, sessionOne());

    // Act
    await link.receiveBinary(control({ t: 'open' }, sessionOne()));

    // Assert
    should(controlOf(sent.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
    should(link.report().sessions).equal(0);
  });
});

describe('backpressure on a relayed session', () => {
  it('should return credit as it consumes frames, and hold answers until the peer grants some', async () => {
    // Arrange — a request per frame, so the window is what bounds the conversation.
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act — fill the daemon's whole send window. The handshake answer and the authentication answer
    // have already spent two of it.
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES; id += 1) {
      channel = await clientSend(link, channel, { t: 'req', id, method: 'GET', path: '/v1/health' });
    }

    // Assert — the daemon stopped at its allowance rather than letting the rendezvous end the session
    // with a flow violation.
    const records = sent.frames.filter(frame => frame.kind === FRAME_KINDS.data);
    should(records.length + 1).equal(CREDIT_WINDOW_FRAMES);
    // Assert — and it returned credit for what it consumed, in batches of half a window.
    const credits = sent.frames.filter(frame => frame.kind === FRAME_KINDS.credit);
    should(credits.length).be.greaterThan(0);
    should(decodeCreditPayload(credits[0]?.payload ?? new Uint8Array())).equal(CREDIT_WINDOW_FRAMES / 2);

    // Act — the client returns credit, and the held answers go out.
    await link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.credit,
        sessionId: sessionOne(),
        sequence: 0,
        payload: encodeCreditPayload(CREDIT_WINDOW_FRAMES),
      }),
    );
    await link.receiveBinary(claimed());

    // Assert
    should(sent.frames.filter(frame => frame.kind === FRAME_KINDS.data).length).be.greaterThan(records.length);
  });

  it('should keep the session when a small answer queues behind a large answer of more parts than one window', async () => {
    // Arrange — the mirror of the browser's photo case: one answer is far more parts than the window,
    // the browser has returned no credit yet, and another request finishes behind it. Counting the
    // parts against the window ended the session here, failing every request on it.
    const big = 'x'.repeat(MAX_PLAINTEXT_BYTES * (CREDIT_WINDOW_FRAMES * 2 + 8));
    const { link, wire: sent } = harness(async request =>
      request.path === '/v1/big' ? { status: 200, headers: new Map(), body: big } : json(200, { small: true }),
    );
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act
    channel = await clientSend(link, channel, { t: 'req', id: 1, method: 'GET', path: '/v1/big' });
    await link.receiveBinary(claimed());
    channel = await clientSend(link, channel, { t: 'req', id: 2, method: 'GET', path: '/v1/small' });
    await link.receiveBinary(claimed());

    // Assert — still open, and once the browser returns credit both answers arrive whole.
    should(sent.frames.some(frame => controlOf(frame)?.t === 'closed')).be.false();
    should(link.report().sessions).equal(1);
    // Like a browser reading promptly: return credit for exactly what was delivered, until nothing is left.
    const delivered = (): number => sent.frames.filter(frame => frame.kind === FRAME_KINDS.data).length;
    let credited = 0;
    while (delivered() > credited) {
      const owed = delivered() - credited;
      credited += owed;
      await link.receiveBinary(
        encodeFrame({
          kind: FRAME_KINDS.credit,
          sessionId: sessionOne(),
          sequence: 0,
          payload: encodeCreditPayload(owed),
        }),
      );
      await link.receiveBinary(claimed());
    }
    const read = await clientReadAll(sent, session.channel);
    const answers = read.messages as Array<{ t: string; id?: number; body?: string }>;
    should(
      answers
        .filter(message => message.id === 1)
        .map(message => message.body ?? '')
        .join(''),
    ).equal(big);
    should(answers.find(message => message.id === 2)).containDeep({ t: 'res', status: 200 });
    should(sent.frames.some(frame => controlOf(frame)?.t === 'closed')).be.false();
  });

  it('should end a session over malformed credit, or a grant that changes nothing', async () => {
    // Arrange
    const malformed = harness();
    await malformed.link.receiveBinary(challenge());
    await malformed.link.receiveBinary(claimed());
    await openSession(malformed.link, malformed.wire, sessionOne());

    // Act + Assert
    await malformed.link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: sessionOne(), sequence: 0, payload: new Uint8Array(3) }),
    );
    should(controlOf(malformed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.flowViolation,
    });

    // Arrange — a grant against a full window raises nothing, so it is a violation on this side too.
    const pointless = harness();
    await pointless.link.receiveBinary(challenge());
    await pointless.link.receiveBinary(claimed());
    await pointless.link.receiveBinary(control({ t: 'open' }, sessionOne()));

    // Act + Assert
    await pointless.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.credit,
        sessionId: sessionOne(),
        sequence: 0,
        payload: encodeCreditPayload(4),
      }),
    );
    should(controlOf(pointless.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.flowViolation,
    });
  });
});

/** Bring one session all the way to a keyed channel, ready for its credential record. */
async function keyedSession(
  harnessed: Harness,
  sessionId: SessionId = sessionOne(),
): Promise<{ channel: ChannelState; keys: SessionKeys }> {
  await harnessed.link.receiveBinary(challenge());
  await harnessed.link.receiveBinary(claimed());
  return await openSession(harnessed.link, harnessed.wire, sessionId);
}

const PAIRED_RESPONSE = {
  deviceId: `fy_device_id_${'a'.repeat(22)}`,
  daemonId: `fy_daemon_${'b'.repeat(43)}`,
  daemonName: 'studio',
  capabilities: ['daemon-api'],
  carriers: [{ kind: 'relay', url: 'wss://relay.example' }],
  idleExpiryDays: 30,
} as const;

describe('one session, one job', () => {
  it('should refuse a record that is not a credential, and every message a mode does not list', async () => {
    // Arrange — a session that has keyed a channel and must now present a credential.
    const first = harness();
    const opened = await keyedSession(first);

    // Act — a payload record where a credential belongs.
    await clientSend(first.link, opened.channel, { t: 'data', text: 'hello' });

    // Assert — the fork accepts three records and this is not one of them.
    should(controlOf(first.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'the first record must be a credential',
    });

    // Arrange — a request session, authenticated.
    const second = harness();
    const request = await keyedSession(second);
    const authed = await clientSend(second.link, request.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act — a stream message on a session that carries requests.
    await clientSend(second.link, authed, { t: 'data', bytes: '' });

    // Assert — the mode is enforced by the union, not by convention.
    should(controlOf(second.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'this session does not carry that message',
    });
  });

  it('should admit two devices opening a full burst each, and refuse the arrival past the bound', async () => {
    // WHAT THE BOUND HAS TO ADMIT, spelled as the traffic rather than as the number. §14 gives every
    // live feed and every terminal a session of its own, so ONE tab is a request session, an event
    // stream and one attached terminal — the same 3 of 8 `What a stream session costs` states — and §9
    // names two devices, "a phone and a laptop, say". Six is those two bursts arriving together. A
    // bound of two refused honest work, and since nothing in this branch renders `4429`, what an owner
    // saw was a live feed that silently never opened.
    const harnessed = harness();
    await harnessed.link.receiveBinary(challenge());
    await harnessed.link.receiveBinary(claimed());
    const opens = Array.from({ length: MAX_PRE_CREDENTIAL_SESSIONS + 1 }, (_unused, index) => {
      const id = sessionIdFromBytes(new Uint8Array([index + 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
      if (id === null) throw new Error('unreachable: 16 bytes');
      return id;
    });

    // Act — the whole burst, then one arrival past it, all still pre-credential.
    for (const id of opens.slice(0, MAX_PRE_CREDENTIAL_SESSIONS)) {
      await harnessed.link.receiveBinary(control({ t: 'open' }, id));
    }
    const admitted = harnessed.link.report().sessions;
    await harnessed.link.receiveBinary(control({ t: 'open' }, opens[MAX_PRE_CREDENTIAL_SESSIONS] as SessionId));

    // Assert — two three-session devices fit, and the next is busy rather than an error, because a
    // client opening several did nothing wrong and must treat this as retryable.
    should(MAX_PRE_CREDENTIAL_SESSIONS).be.greaterThanOrEqual(6);
    should(admitted).equal(MAX_PRE_CREDENTIAL_SESSIONS);
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.rendezvousBusy,
      reason: 'too many sessions are awaiting a credential',
    });
    should(harnessed.link.report().sessions).equal(MAX_PRE_CREDENTIAL_SESSIONS);
    // Assert — and it never promises more than the rendezvous will open for it (§5's `maxSessions`).
    should(MAX_PRE_CREDENTIAL_SESSIONS).be.belowOrEqual(8);
  });

  it('should arm the credential window at the OPEN, so a session that never handshakes cannot squat', async () => {
    // THE DEFECT THIS PINS. The deadline used to be armed by the handshake answer, so `awaiting-hello`
    // had none at all: a peer could accept the `open`, send no client hello, answer heartbeats, and
    // hold a pre-credential slot for as long as it kept the socket. The fingerprint that addresses a
    // rendezvous is public by design — it is in the QR — so a stranger with a handful of idle sockets
    // denied every honest session on the link, requests, streams and pairing alike, with `4429`.
    const harnessed = harness();
    await harnessed.link.receiveBinary(challenge());
    await harnessed.link.receiveBinary(claimed());

    // Act — a session that opens and then says nothing at all.
    await harnessed.link.receiveBinary(control({ t: 'open' }, sessionOne()));

    // Assert — armed by the open itself, which is what gives the slot above a bound in time.
    should(harnessed.timers).have.length(1);
    should(harnessed.timers[0]?.milliseconds).equal(RELAY_CREDENTIAL_DEADLINE_MS);

    // Act — the window closes with no hello ever sent.
    harnessed.timers[0]?.fire();

    // Assert — the slot is returned rather than held forever.
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'no credential arrived before the deadline',
    });
    should(harnessed.link.report().sessions).equal(0);
  });

  it('should end a keyed session whose credential never arrives, and cancel that deadline when it does', async () => {
    // Arrange
    const harnessed = harness();
    const opened = await keyedSession(harnessed);

    // Assert — ONE window, armed by the open and covering the handshake too. Answering a hello buys
    // no second ten seconds, which is why a keyed session still has exactly one timer here.
    should(harnessed.timers).have.length(1);
    should(harnessed.timers[0]?.milliseconds).equal(RELAY_CREDENTIAL_DEADLINE_MS);

    // Act — nothing arrives and the window closes.
    harnessed.timers[0]?.fire();

    // Assert
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'no credential arrived before the deadline',
    });

    // Arrange — a session that answers in time.
    const answered = harness();
    const live = await keyedSession(answered);
    await clientSend(answered.link, live.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Assert — the window is closed by the record that answered it.
    should(answered.timers[0]?.cancelled).be.true();
    // Act — a deadline that fires anyway finds nothing to end.
    answered.timers[0]?.fire();
    should(answered.link.report().sessions).equal(1);
    should(opened.channel).be.ok();
  });
});

describe('a pairing session', () => {
  it('should redeem through the pairing port, answer with the whole response, and close 4440', async () => {
    // Arrange
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, async () => ({
      kind: 'paired',
      response: PAIRED_RESPONSE,
    }));
    const opened = await keyedSession(harnessed);

    // Act
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'Ferretry PWA',
    });

    // Assert — the exchange reached the pairing state machine and NOT the route table.
    // The key it registers travels with it, and the session has already checked the proof over THIS
    // transcript — only the session holds the transcript, so only it can.
    should(harnessed.pairings).deepEqual([
      { code: 'ABCD-2345', deviceName: 'Ferretry PWA', deviceKey: deviceKeyText, proven: true },
    ]);
    should(harnessed.requests).be.empty();
    should(harnessed.upgrades).be.empty();

    // Assert — the answer carries the pairing API's response whole, `carriers` included. An envelope
    // that lost them would mint a device that can reach its daemon by nothing at all.
    const answer = await clientRead(harnessed.wire, after);
    should(answer.message).deepEqual({
      t: 'paired',
      protocol: SESSION_PROTOCOL_ID,
      response: PAIRED_RESPONSE,
    });

    // Assert — the sealed outcome crosses BEFORE the close that follows it.
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
    });
    should(harnessed.link.report().sessions).equal(0);
  });

  it('should refuse with one generic reason, in the same frame count a success takes', async () => {
    // Arrange
    const refusing = harness();
    const opened = await keyedSession(refusing);
    const before = refusing.wire.frames.length;

    // Act
    const after = await clientSend(refusing.link, opened.channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'Ferretry PWA',
    });

    // Assert — every cause collapses into one machine reason: a pre-auth surface the whole internet
    // can reach must not be an oracle.
    should((await clientRead(refusing.wire, after)).message).deepEqual({
      t: 'pair-refused',
      protocol: SESSION_PROTOCOL_ID,
      reason: 'pairing_refused',
    });
    should(controlOf(refusing.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
    });

    // Arrange — the same exchange, succeeding.
    const pairing = harness(undefined, DEVICE_TOKEN, undefined, async () => ({
      kind: 'paired',
      response: PAIRED_RESPONSE,
    }));
    const success = await keyedSession(pairing);
    const successBefore = pairing.wire.frames.length;
    await clientSend(pairing.link, success.channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-2345',
      deviceName: 'Ferretry PWA',
    });

    // Assert — a relay operator counting frames cannot tell the two apart.
    should(pairing.wire.frames.length - successBefore).equal(refusing.wire.frames.length - before);
  });

  it('should never accept a host token, and never reach a route, whatever it is handed', async () => {
    // Arrange — a pairing record whose code is a host admin token by any other name.
    const harnessed = harness();
    const opened = await keyedSession(harnessed);

    // Act
    await clientSend(harnessed.link, opened.channel, {
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'fy_admin_token',
      deviceName: 'Ferretry PWA',
    });

    // Assert — the branch reads no credential at all: nothing was dispatched and nothing upgraded.
    should(harnessed.requests).be.empty();
    should(harnessed.upgrades).be.empty();
    should(harnessed.pairings).have.length(1);
  });
});

describe('a stream session', () => {
  it('should open one stream through the daemon socket table and carry both frame shapes', async () => {
    // Arrange
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);

    // Act — the credential record opens the stream in the same breath.
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
      query: [['sessionId', 'fy_s']],
    });

    // Assert — it reached the SAME socket route table a direct upgrade reaches, with the session's
    // own credential, never as a loopback peer, and with a rate-limit identity it cannot choose.
    should(harnessed.upgrades).have.length(1);
    const upgrade = harnessed.upgrades[0];
    should(upgrade?.method).equal('GET');
    should(upgrade?.path).equal('/v1/events');
    should(upgrade?.device).deepEqual({ deviceId: DEVICE_ID, appSession: APP_SESSION });
    should(upgrade?.headers.has('authorization')).be.false();
    should(upgrade?.loopback).be.false();
    should(upgrade?.clientAddress).startWith('relay-session:');
    should(stream.opened).have.length(1);

    // Act — the daemon's own handler pushes a text frame and a byte run.
    stream.downstream?.send('{"kind":"event"}');
    stream.downstream?.send(new Uint8Array([104, 105]));
    await settle(harnessed.link);

    // Assert — the acceptance is AHEAD of the first frame the handler produced, and both value
    // shapes cross intact: text stays one complete message, bytes travel as unpadded base64url.
    should((await clientReadAll(harnessed.wire, after)).messages).deepEqual([
      STREAM_OPENED,
      { t: 'data', text: '{"kind":"event"}' },
      { t: 'data', bytes: 'aGk' },
    ]);

    // Act — the client types into it, both shapes.
    const typed = await clientSend(harnessed.link, after, { t: 'data', bytes: 'aGk' });
    await clientSend(harnessed.link, typed, { t: 'data', text: '{"cols":80,"rows":24}' });

    // Assert — bytes decode, text stays text, and both reach the handler in order.
    should(stream.fromClientFrames).have.length(2);
    should(stream.fromClientFrames[0]).deepEqual(new Uint8Array([104, 105]));
    should(stream.fromClientFrames[1]).equal('{"cols":80,"rows":24}');
  });

  it('should refuse a ticket or a token in a stream query, and an unknown credential', async () => {
    // Arrange
    const ticketed = harness();
    const opened = await keyedSession(ticketed);

    // Act — the credential a browser CANNOT carry here, smuggled into the query.
    await clientSend(ticketed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
      query: [['ticket', 'stolen-from-a-log']],
    });

    // Assert — refused by the schema, before anything is asked of the route table.
    should(controlOf(ticketed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'unparseable tunnel record',
    });
    should(ticketed.upgrades).be.empty();

    // Arrange — a stream asking with a credential nobody knows.
    const stranger = harness();
    const strange = await keyedSession(stranger);

    // Act
    await clientSend(stranger.link, strange.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: 'fy_device_unknown',
      path: '/v1/events',
    });

    // Assert — `4403` before any route is consulted, exactly as a request session is refused.
    should(controlOf(stranger.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.authRejected,
    });
    should(stranger.upgrades).be.empty();
  });

  it('should say what a status can say BEFORE anything switches, rather than closing a stream', async () => {
    // Arrange — the guard refuses this upgrade.
    const refused = harness(undefined, DEVICE_TOKEN, async () => ({
      outcome: 'refused',
      response: json(404, { error: 'no terminal' }),
    }));
    const opened = await keyedSession(refused);

    // Act
    const after = await clientSend(refused.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/sessions/s/terminals/t/stream',
    });

    // Assert — a refusal, not a close: "it is gone" and "the daemon broke" must stay distinguishable.
    should((await clientRead(refused.wire, after)).message).deepEqual({
      t: 'stream-refused',
      protocol: SESSION_PROTOCOL_ID,
      status: 404,
      body: JSON.stringify({ error: 'no terminal' }),
    });
    should(controlOf(refused.wire.frames.at(-1))).containDeep({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });

    // Arrange — a path no socket route serves at all.
    const unclaimed = harness();
    const none = await keyedSession(unclaimed);

    // Act
    const later = await clientSend(unclaimed.link, none.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/nothing',
    });

    // Assert
    should((await clientRead(unclaimed.wire, later)).message).containDeep({ t: 'stream-refused', status: 404 });
  });

  it('should refuse a stream it could not attach, and close one whose handler failed to open', async () => {
    // Arrange — attach throws before the switch, so there is still a status to send.
    const broken = harness(undefined, DEVICE_TOKEN, async () => ({
      outcome: 'accepted',
      attach: async () => {
        throw new Error('no pane');
      },
    }));
    const opened = await keyedSession(broken);

    // Act
    const after = await clientSend(broken.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Assert
    should((await clientRead(broken.wire, after)).message).containDeep({ t: 'stream-refused', status: 500 });

    // Arrange — `open` throws AFTER the acceptance has been sent, so the close taxonomy carries it.
    const failing = fakeStream(() => {
      throw new Error('the source is gone');
    });
    const late = harness(undefined, DEVICE_TOKEN, accepts(failing));
    const live = await keyedSession(late);

    // Act
    const opening = await clientSend(late.link, live.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Assert — `stream-opened` first, then a sealed close naming 1011.
    should((await clientReadAll(late.wire, opening)).messages).containDeep([
      { t: 'stream-opened' },
      { t: 'stream-close', code: 1011 },
    ]);
    should(controlOf(late.wire.frames.at(-1))).containDeep({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });
  });

  it('should drop an over-budget redraw, close an over-budget event, and report its backlog honestly', async () => {
    // Arrange
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');

    // Act + Assert — a redraw one byte over the derived budget is DROPPED and reported as not taken: the
    // next redraw supersedes it, so nothing is lost but latency.
    const before = harnessed.wire.frames.length;
    const huge = new Uint8Array(MAX_TUNNEL_DATA_BYTES + 1);
    // `0` is "not taken": the transport convention a producer reads to know it must send again.
    should(downstream.send(huge)).equal(0);
    should(harnessed.wire.frames.length).equal(before);
    should(harnessed.link.report().sessions).equal(1);

    // Act + Assert — a byte run at exactly the budget still fits one record, which is what makes the
    // number derived rather than guessed.
    should(downstream.send(new Uint8Array(MAX_TUNNEL_DATA_BYTES))).equal(MAX_TUNNEL_DATA_BYTES);

    // Act — an EVENT that cannot fit may be neither dropped nor split, so the stream closes.
    should(downstream.send('x'.repeat(MAX_PLAINTEXT_BYTES))).equal(-1);
    await settle(harnessed.link);

    // Assert — the handler is released, the taxonomy is sealed, and only then does the session close.
    // The at-budget frame queued a moment earlier is GONE: the close is what makes its loss explicit,
    // so payload behind it is discarded rather than made to arrive after the record that supersedes it.
    should(stream.closed).have.length(1);
    should((await clientReadAll(harnessed.wire, after)).messages).containDeep([
      { t: 'stream-opened' },
      { t: 'stream-close', code: 1009 },
    ]);
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });
    // Assert — a send after the stream is gone is refused rather than queued at a dead peer.
    should(downstream.send('anything')).equal(-1);
  });

  it('should report buffered bytes from its own un-credited backlog', async () => {
    // Arrange — a stream whose peer has granted nothing beyond the opening window.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');

    // Assert — a drained queue is zero, which is the honest answer and not a hard-coded one.
    should(downstream.bufferedBytes()).equal(0);

    // Act — fill past the credit window so records queue rather than leave.
    for (let index = 0; index < CREDIT_WINDOW_FRAMES + 4; index += 1) downstream.send(`{"n":${index}}`);
    await settle(harnessed.link);

    // Assert — the backlog is REAL. A stream layer answering `0` here would make every one of this
    // daemon's buffered-bytes policies vacuous over a relay while looking perfectly wired.
    should(downstream.bufferedBytes()).be.greaterThan(0);
    should(harnessed.link.report().sessions).equal(1);
  });

  it('should release the handler on a client close, a rendezvous close, and the link going away', async () => {
    // Arrange — the client says it is done.
    const byClient = fakeStream();
    const first = harness(undefined, DEVICE_TOKEN, accepts(byClient));
    const opened = await keyedSession(first);
    const after = await clientSend(first.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Act
    await clientSend(first.link, after, {
      t: 'stream-close',
      protocol: SESSION_PROTOCOL_ID,
      code: 1000,
      reason: 'the viewer left',
    });

    // Assert — a deliberate leave is not spelled the same as a network failure.
    should(byClient.closed).have.length(1);
    should(controlOf(first.wire.frames.at(-1))).containDeep({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE });

    // Arrange — the rendezvous ends the session under a live stream.
    const byRendezvous = fakeStream();
    const second = harness(undefined, DEVICE_TOKEN, accepts(byRendezvous));
    const live = await keyedSession(second);
    await clientSend(second.link, live.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Act
    await second.link.receiveBinary(
      control({ t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'the client left' }, sessionOne()),
    );

    // Assert — the handler holds a timer armed at a peer the rendezvous says is gone.
    should(byRendezvous.closed).have.length(1);

    // Arrange — the whole link goes, which is what a carrier stop and a redial both do.
    const byLink = fakeStream();
    const third = harness(undefined, DEVICE_TOKEN, accepts(byLink));
    const ending = await keyedSession(third);
    await clientSend(third.link, ending.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Act
    third.link.close();

    // Assert
    should(byLink.closed).have.length(1);
    should(third.link.report().sessions).equal(0);
  });

  it('should end a stream session that sends a request, or bytes that are not base64url', async () => {
    // Arrange
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Act — a request on a session that carries one stream.
    await clientSend(harnessed.link, after, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

    // Assert — there is no edge from `streaming` back to serving, so this cannot be answered.
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'this session carries one stream only',
    });
    should(harnessed.requests).be.empty();

    // Arrange — a payload whose `bytes` are not the spelling this protocol uses.
    const malformed = fakeStream();
    const second = harness(undefined, DEVICE_TOKEN, accepts(malformed));
    const live = await keyedSession(second);
    const streaming = await clientSend(second.link, live.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });

    // Act
    await clientSend(second.link, streaming, { t: 'data', bytes: 'not+base64url/' });

    // Assert
    should(controlOf(second.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'a stream record carried unusable bytes',
    });
    should(malformed.fromClientFrames).be.empty();
  });
});

describe('the key rotation a device is asked for', () => {
  /** An instant well past the epoch the harness clock stands at, so it reads unmistakably as a due date. */
  const DUE_MS = Date.parse('2026-10-20T00:00:00.000Z');
  const AUTH = { t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN } as const;
  const STREAM = {
    t: 'stream',
    protocol: SESSION_PROTOCOL_ID,
    deviceToken: DEVICE_TOKEN,
    path: '/v1/events',
    query: [],
  } as const;

  it('should tell a device when its key is due, in the record that accepts its session', async () => {
    const asked: string[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, {
      rotateBy: deviceId => {
        asked.push(deviceId);
        return DUE_MS;
      },
    });
    const opened = await keyedSession(harnessed);

    await clientSend(harnessed.link, opened.channel, AUTH);

    should((await clientRead(harnessed.wire, opened.channel)).message).deepEqual({
      ...AUTHENTICATED,
      rotateBy: '2026-10-20T00:00:00.000Z',
    });
    should(asked).deepEqual([DEVICE_ID]);
  });

  it('should say nothing about rotation when the directory has no date for the device', async () => {
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { rotateBy: () => undefined });
    const opened = await keyedSession(harnessed);

    await clientSend(harnessed.link, opened.channel, AUTH);

    should((await clientRead(harnessed.wire, opened.channel)).message).deepEqual(AUTHENTICATED);
  });

  it('should say nothing about rotation when the directory has no such question to answer', async () => {
    const harnessed = harness();
    const opened = await keyedSession(harnessed);

    await clientSend(harnessed.link, opened.channel, AUTH);

    should((await clientRead(harnessed.wire, opened.channel)).message).deepEqual(AUTHENTICATED);
  });

  it('should tell a stream session the same date in the record that accepts it', async () => {
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream), undefined, { rotateBy: () => DUE_MS });
    const opened = await keyedSession(harnessed);

    await clientSend(harnessed.link, opened.channel, STREAM);

    should((await clientReadAll(harnessed.wire, opened.channel)).messages[0]).deepEqual({
      ...STREAM_OPENED,
      rotateBy: '2026-10-20T00:00:00.000Z',
    });
  });

  it('should leave a stream acceptance bare when no rotation is due', async () => {
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream), undefined, { rotateBy: () => undefined });
    const opened = await keyedSession(harnessed);

    await clientSend(harnessed.link, opened.channel, STREAM);

    should((await clientReadAll(harnessed.wire, opened.channel)).messages[0]).deepEqual(STREAM_OPENED);
  });
});

describe('the transcript a request travels in', () => {
  it('should hand the route table the hash of the session that carried the request', async () => {
    const harnessed = harness();
    const opened = await keyedSession(harnessed);
    const authenticated = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    await clientSend(harnessed.link, authenticated, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

    should(harnessed.requests).have.length(1);
    should(harnessed.requests[0]?.transcriptHash).deepEqual(opened.keys.transcriptHash);
    should(harnessed.requests[0]?.transcriptHash).deepEqual(transcripts.get(sessionOne().text));
  });

  it('should give each session its own hash, so a rotation proof cannot be lifted from another', async () => {
    const harnessed = harness();
    const first = await keyedSession(harnessed);
    const second = await openSession(
      harnessed.link,
      harnessed.wire,
      sessionIdFromBytes(new Uint8Array(16).fill(42)) ?? sessionOne(),
    );
    const auth = { t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN } as const;
    const firstReady = await clientSend(harnessed.link, first.channel, auth);
    const secondReady = await clientSend(harnessed.link, second.channel, auth);

    await clientSend(harnessed.link, firstReady, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    await clientSend(harnessed.link, secondReady, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

    should(harnessed.requests.map(carried => carried.transcriptHash)).deepEqual([
      first.keys.transcriptHash,
      second.keys.transcriptHash,
    ]);
    should(first.keys.transcriptHash).not.deepEqual(second.keys.transcriptHash);
  });

  it('should name a session by its transcript in hex, and by nothing before the handshake keyed it', () => {
    should(transcriptKey(new Uint8Array([0, 1, 15, 16, 171, 255]))).equal('00010f10abff');
    should(transcriptKey(new Uint8Array())).equal('');
    should(transcriptKey(undefined)).equal('');
  });
});

describe('a device that replaced its key while other sessions were live', () => {
  const AUTH = { t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN } as const;

  async function twoRequestSessions() {
    const harnessed = harness();
    const first = await keyedSession(harnessed);
    const secondId = sessionIdFromBytes(new Uint8Array(16).fill(42));
    if (secondId === null) throw new Error('unreachable: 16 bytes');
    const second = await openSession(harnessed.link, harnessed.wire, secondId);
    const firstReady = await clientSend(harnessed.link, first.channel, AUTH);
    await clientSend(harnessed.link, second.channel, AUTH);
    should(harnessed.link.report().sessions).equal(2);
    return { harnessed, first, firstReady };
  }

  const closesOf = (sent: Wire) => sent.frames.map(controlOf).filter(message => message?.t === 'closed');

  it('should end every other session with the lease-ended code, so each reopens with the new key', async () => {
    const { harnessed, first } = await twoRequestSessions();

    const lapsed = harnessed.connections.lapseDevice(DEVICE_ID, transcriptKey(first.keys.transcriptHash));

    should(lapsed).equal(1);
    should(harnessed.link.report().sessions).equal(1);
    should(closesOf(harnessed.wire).at(-1)).containDeep({
      t: 'closed',
      code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
      reason: ACCESS_LEASE_ENDED_REASON,
    });
    should(RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE).equal(4441);
  });

  it('should spare the session that carried the replacement, and keep serving it', async () => {
    const { harnessed, first, firstReady } = await twoRequestSessions();
    harnessed.connections.lapseDevice(DEVICE_ID, transcriptKey(first.keys.transcriptHash));

    await clientSend(harnessed.link, firstReady, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });

    should(harnessed.requests).have.length(1);
    should(harnessed.link.report().sessions).equal(1);
  });

  it('should end both when nothing is spared, and say nothing that reads as an unpair', async () => {
    const { harnessed } = await twoRequestSessions();

    should(harnessed.connections.lapseDevice(DEVICE_ID, '')).equal(2);

    should(harnessed.link.report().sessions).equal(0);
    const closes = closesOf(harnessed.wire);
    should(closes.slice(-2).every(close => close?.t === 'closed' && close.code === 4441)).be.true();
    should(closes.some(close => close?.t === 'closed' && close.reason === 'unknown device credential')).be.false();
  });

  it('should lapse a stream session the same way and release its handler', async () => {
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
      query: [],
    });

    should(harnessed.connections.lapseDevice(DEVICE_ID, '')).equal(1);

    should(stream.closed).have.length(1);
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ t: 'closed', code: 4441 });
  });

  it('should not lapse a session that has already ended on its own', async () => {
    const { harnessed } = await twoRequestSessions();
    await harnessed.link.receiveBinary(
      control({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError, reason: 'gone' }, sessionOne()),
    );

    should(harnessed.connections.lapseDevice(DEVICE_ID, '')).equal(1);

    should(harnessed.link.report().sessions).equal(0);
  });

  it('should leave another device’s sessions alone', async () => {
    const { harnessed } = await twoRequestSessions();

    should(harnessed.connections.lapseDevice('fy_device_id_bbbbbbbbbbbbbbbbbbbbbb', '')).equal(0);

    should(harnessed.link.report().sessions).equal(2);
  });
});

describe('a device unpaired while its sessions are live', () => {
  const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
  const streamRequest = {
    t: 'stream',
    protocol: SESSION_PROTOCOL_ID,
    deviceToken: DEVICE_TOKEN,
    path: '/v1/terminals/fy_t/stream',
    query: [],
  };

  it('should end its relayed terminal stream and its request session, and release the terminal', async () => {
    // Arrange — one stream session and one request session, both the same device.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const streaming = await keyedSession(harnessed);
    await clientSend(harnessed.link, streaming.channel, streamRequest);
    const second = sessionIdFromBytes(new Uint8Array(16).fill(42));
    if (second === null) throw new Error('unreachable: 16 bytes');
    const serving = await openSession(harnessed.link, harnessed.wire, second);
    await clientSend(harnessed.link, serving.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    should(harnessed.link.report().sessions).equal(2);
    should(stream.opened).have.length(1);

    // Act
    const ended = harnessed.connections.endDevice(DEVICE_ID);

    // Assert — both gone, the terminal handler released, and each refusal reads exactly like an
    // unknown credential so the carrier learns nothing about why.
    should(ended).equal(2);
    should(harnessed.link.report().sessions).equal(0);
    should(stream.closed).have.length(1);
    const closes = harnessed.wire.frames.map(controlOf).filter(message => message?.t === 'closed');
    should(closes.slice(-2)).containDeep([
      { t: 'closed', code: RELAY_CLOSE_CODES.authRejected, reason: 'unknown device credential' },
      { t: 'closed', code: RELAY_CLOSE_CODES.authRejected, reason: 'unknown device credential' },
    ]);
    // The socket itself, and every other device's sessions on it, are untouched.
    should(harnessed.wire.closes).be.empty();
  });

  it('should refuse a session for a device unpaired a moment before its credential arrived', async () => {
    // Arrange — a credential still in the directory, for a device the registry has already unpaired.
    const harnessed = harness();
    harnessed.connections.endDevice(DEVICE_ID);
    const opened = await keyedSession(harnessed);

    // Act
    await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Assert — never authenticated, nothing dispatched, the session ended.
    should(harnessed.link.report().sessions).equal(0);
    should(harnessed.wire.frames.filter(frame => frame.kind === FRAME_KINDS.data)).have.length(0);
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
  });

  it('should never install a stream whose session ended while the route table or the attachment was deciding', async () => {
    // Arrange — the route table answers only once the device has been unpaired under it.
    const decided = fakeStream();
    let unpair = (): void => undefined;
    const harnessed = harness(undefined, DEVICE_TOKEN, async () => {
      unpair();
      return await accepts(decided)();
    });
    unpair = () => harnessed.connections.endDevice(DEVICE_ID);
    const opened = await keyedSession(harnessed);

    // Act
    await clientSend(harnessed.link, opened.channel, streamRequest);

    // Assert — nothing attached, nothing opened.
    should(decided.opened).have.length(0);
    should(decided.downstream).be.undefined();

    // Arrange — this time the device is unpaired while the ATTACHMENT runs, so a handler exists.
    const attached = fakeStream();
    let unpairAgain = (): void => undefined;
    const late = harness(undefined, DEVICE_TOKEN, async () => ({
      outcome: 'accepted',
      attach: async downstream => {
        attached.downstream = downstream;
        unpairAgain();
        return attached;
      },
    }));
    unpairAgain = () => late.connections.endDevice(DEVICE_ID);
    const keyed = await keyedSession(late);

    // Act
    await clientSend(late.link, keyed.channel, streamRequest);

    // Assert — released at once, never opened, and the session is gone.
    should(attached.closed).have.length(1);
    should(attached.opened).have.length(0);
    should(late.link.report().sessions).equal(0);
  });

  it('should stop tracking a session that ended on its own', async () => {
    // Arrange
    const harnessed = harness();
    const opened = await keyedSession(harnessed);
    await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act — the client went away, then the device was unpaired.
    await harnessed.link.receiveBinary(
      control({ t: 'closed', code: RELAY_CLOSE_CODES.daemonAbsent, reason: 'gone' }, sessionOne()),
    );

    // Assert — there was nothing left to end.
    should(harnessed.connections.endDevice(DEVICE_ID)).equal(0);
  });
});

describe('an outcome that has not crossed yet', () => {
  it('should hold the concluding close until the sealed one has actually left', async () => {
    // THE DEFECT THIS PINS. `4440` means "the outcome was stated inside the channel before this
    // close", and §14 makes a `4440` with no sealed outcome before it a protocol violation. But the
    // sealed close is QUEUED, and a queue only drains while the peer's credit allows — so on the one
    // path that reaches this naturally, a viewer that has stopped returning credit, the concluding
    // control would overtake the very record it promises has already crossed.
    //
    // Arrange — a live stream whose peer has spent its whole opening window and granted nothing back.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');
    for (let index = 0; index < CREDIT_WINDOW_FRAMES + 8; index += 1) downstream.send(`{"n":${index}}`);
    await settle(harnessed.link);
    should(downstream.bufferedBytes()).be.greaterThan(0);

    // Act — a burst big enough to trip the backlog ceiling, which for an event stream is `1013`.
    const event = `{"e":"${'x'.repeat(60_000)}"}`;
    let refused = 0;
    for (let index = 0; index < 40; index += 1) {
      if (downstream.send(event) === -1) refused += 1;
    }
    await settle(harnessed.link);

    // Assert — the stream closed, and the SESSION HAS NOT, because the record saying so is still
    // waiting for credit. A `4440` here would be the violation.
    should(refused).be.greaterThan(0);
    should(stream.closed).have.length(1);
    should(harnessed.link.report().sessions).equal(1);
    should(concluded(harnessed.wire)).be.false();

    // Act — the viewer catches up and returns credit.
    await harnessed.link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.credit,
        sessionId: sessionOne(),
        sequence: 0,
        payload: encodeCreditPayload(CREDIT_WINDOW_FRAMES),
      }),
    );

    // Assert — the sealed close has crossed, it is the LAST thing this stream said, and only now does
    // the session end.
    const delivered = await clientReadAll(harnessed.wire, after);
    should(delivered.messages.at(-1)).containDeep({ t: 'stream-close', code: 1013 });
    should(concluded(harnessed.wire)).be.true();
    should(harnessed.link.report().sessions).equal(0);
  });

  it('should conclude a client-initiated close at once, because that outcome already crossed', async () => {
    // The mirror case, and the reason the rule is about DELIVERY rather than about waiting: when the
    // peer closed the stream itself there is no sealed record of ours to deliver, so holding the
    // session for credit a departed viewer will never return would be a session that never ends.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');
    for (let index = 0; index < CREDIT_WINDOW_FRAMES + 8; index += 1) downstream.send(`{"n":${index}}`);
    await settle(harnessed.link);

    // Act — the viewer says it is done while payload is still queued behind an exhausted window.
    await clientSend(harnessed.link, after, {
      t: 'stream-close',
      protocol: SESSION_PROTOCOL_ID,
      code: 1000,
      reason: 'the viewer left',
    });

    // Assert — the handler is released and the session ends immediately.
    should(stream.closed).have.length(1);
    should(concluded(harnessed.wire)).be.true();
    should(harnessed.link.report().sessions).equal(0);
  });
});

/**
 * The real crypto, with one operation held open until a test lets it finish.
 *
 * `Object.create` rather than a spread, because the real crypto is a class instance and a spread
 * would drop every method it inherits.
 *
 * `handshake` gates `generateEphemeralKeyPair`, which is the FIRST await inside
 * `answerClientHandshake` — so holding it suspends the daemon's whole handshake rather than some
 * later part of it, which is the window the credential deadline now covers.
 */
function heldCrypto(which: 'open' | 'seal' | 'handshake' = 'open'): RelayCrypto & {
  hold(): void;
  release(): void;
} {
  let resume: (() => void) | undefined;
  let holding = false;
  const wait = async (): Promise<void> => {
    if (holding) await new Promise<void>(resolve => (resume = resolve));
  };
  const gated = Object.create(crypto_) as RelayCrypto & { hold(): void; release(): void };
  gated.generateEphemeralKeyPair = async () => {
    if (which === 'handshake') await wait();
    return await crypto_.generateEphemeralKeyPair();
  };
  gated.open = async (key, nonce, aad, ciphertext) => {
    if (which === 'open') await wait();
    return await crypto_.open(key, nonce, aad, ciphertext);
  };
  gated.seal = async (key, nonce, aad, plaintext) => {
    if (which === 'seal') await wait();
    return await crypto_.seal(key, nonce, aad, plaintext);
  };
  gated.hold = () => {
    holding = true;
  };
  gated.release = () => {
    holding = false;
    resume?.();
    resume = undefined;
  };
  return gated;
}

/** Sequence numbers of every record the daemon has put on the wire, in order. */
const recordSequences = (sent: Wire): number[] =>
  sent.frames.filter(frame => frame.kind === FRAME_KINDS.data).map(frame => frame.sequence);

/** Let the event loop run until `ready`, so a test waits for real asynchronous work rather than a tick. */
async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for the link');
}

interface HeldStream {
  readonly crypto: RelayCrypto & { hold(): void; release(): void };
  readonly link: RelayLink;
  readonly sent: Wire;
  readonly stream: FakeStream;
  readonly downstream: SocketDownstream;
  /** The CLIENT's channel, positioned after the credential record it just sent. */
  readonly channel: ChannelState;
}

/**
 * A claimed link carrying one live stream, on crypto a test can suspend.
 *
 * Every interleave below needs exactly this and needs it built with the gate already installed —
 * `heldCrypto` wraps the instance, so it has to be the crypto the link was constructed with rather
 * than something swapped in later. Nothing is held yet: setup runs at full speed and the test calls
 * `hold()` at the moment it wants to freeze.
 */
async function heldStreamingLink(which: 'open' | 'seal'): Promise<HeldStream> {
  const crypto = heldCrypto(which);
  const stream = fakeStream();
  const sent = wire();
  const link = new RelayLink({
    crypto,
    identity,
    relayHost: HOST,
    socket: sent.socket,
    dispatch: async () => json(200, {}),
    sockets: { upgrade: accepts(stream), reauthorize: () => true },
    connections: new LiveDeviceConnections(),
    devices: {
      deviceKey: async deviceId => (deviceId === DEVICE_ID ? deviceKeyText : undefined),
      seen: () => undefined,
    },
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    clock: TEST_CLOCK,
    scheduler: { after: () => ({ cancel: () => undefined }) },
  });
  await link.receiveBinary(challenge());
  await link.receiveBinary(claimed());
  const opened = await openSession(link, sent, sessionOne());
  const channel = await clientSend(link, opened.channel, {
    t: 'stream',
    protocol: SESSION_PROTOCOL_ID,
    deviceToken: DEVICE_TOKEN,
    path: '/v1/events',
  });
  const downstream = stream.downstream;
  if (downstream === undefined) throw new Error('the stream was never attached');
  return { crypto, link, sent, stream, downstream, channel };
}

/** Where the `4440` that ends a session with its outcome already stated sits on the wire, or `-1`. */
const concludedAt = (sent: Wire): number =>
  sent.frames.findIndex(frame => {
    const message = frame.kind === FRAME_KINDS.control ? decodeControlMessage(frame.payload) : null;
    return message?.t === 'closed' && message.code === RELAY_SESSION_CONCLUDED_CLOSE_CODE;
  });

/** Where the last record sits on the wire, or `-1`. */
const lastRecordAt = (sent: Wire): number =>
  sent.frames.reduce((last, frame, index) => (frame.kind === FRAME_KINDS.data ? index : last), -1);

describe('two directions sharing one channel value', () => {
  it('should never let a receive rewind the send counter, because a sequence IS a nonce', async () => {
    // THE DEFECT THIS PINS, and it is the worst one available in this module. `ChannelState` carries
    // BOTH counters. Each direction used to write the WHOLE value back after its own await, from a
    // copy captured before it — so whichever finished last silently rewound the other. Rewinding the
    // RECEIVE counter surfaces as an intermittent `4420`. Rewinding the SEND counter is silent, and
    // it is a NONCE REUSE: a record's sequence number is its AEAD nonce, so two records go out under
    // one key and one nonce, which is the single arithmetic mistake AES-256-GCM does not survive.
    //
    // Timing normally decides which lands last, which is why this is unprovable by repetition. The
    // held crypto makes the order a fact of the test.
    const { crypto, link, sent, stream, downstream, channel: streaming } = await heldStreamingLink('open');

    // Arrange — one client record whose decryption is held mid-flight. It has already captured the
    // channel; it has not yet written its counter back.
    crypto.hold();
    const sealed = await sealRecord(crypto_, streaming, utf8Bytes(JSON.stringify({ t: 'data', text: 'typed' })));
    if (!sealed.ok) throw new Error(sealed.reason);
    const receiving = link.receiveBinary(encodeFrame(sealed.frame));

    // Act — the daemon sends WHILE that receive is suspended, so the send counter advances first.
    const before = recordSequences(sent).length;
    downstream.send('{"kind":"event","n":1}');
    await until(() => recordSequences(sent).length > before);

    // Act — the held receive now finishes and writes its counter back.
    crypto.release();
    await receiving;
    downstream.send('{"kind":"event","n":2}');
    await settle(link);

    // Assert — every record this daemon sealed used its own sequence number, once. A repeat here is
    // two records under one key and one nonce.
    const sequences = recordSequences(sent);
    should(new Set(sequences).size).equal(sequences.length);
    should([...sequences].sort((left, right) => left - right)).deepEqual(sequences);
    // Assert — and the client's own record was still accepted, so the receive counter is intact too.
    should(stream.fromClientFrames).deepEqual(['typed']);
  });

  it('should never let a send rewind the receive counter, which is the intermittent 4420', async () => {
    // The mirror order. Here the SEAL finishes last, so it is the sender that would have written a
    // stale receive counter back — and that symptom is not silent: the next client record arrives at
    // a channel that has forgotten it already read one, and the session dies blaming the carrier for
    // frames it delivered perfectly. Both orders are fixed by the same rule, and both are pinned
    // because only one of them announces itself.
    const held = await heldStreamingLink('seal');
    const { crypto, link, stream, downstream } = held;
    let channel = held.channel;

    // Arrange — a seal suspended mid-flight, having already captured the channel.
    crypto.hold();
    downstream.send('{"kind":"event","n":1}');
    await new Promise(resolve => setTimeout(resolve, 1));

    // Act — a client record crosses and advances the receive counter while that seal is suspended.
    // It is NOT awaited: `receiveBinary` waits for the outbox at the end, and the outbox is exactly
    // what the held seal is blocking. The counter write-back has already happened by then, which is
    // the state this test needs — a receive that has advanced, and a sender still holding a copy
    // captured before it.
    const first = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify({ t: 'data', text: 'first' })));
    if (!first.ok) throw new Error(first.reason);
    const receiving = link.receiveBinary(encodeFrame(first.frame));
    await new Promise(resolve => setTimeout(resolve, 1));
    crypto.release();
    await receiving;
    channel = first.state;

    // Act — a second client record, which only a channel that kept its receive counter can open.
    await clientSend(link, channel, { t: 'data', text: 'second' });
    await settle(link);

    // Assert — both keystrokes reached the pane and the session is still alive.
    should(stream.fromClientFrames).deepEqual(['first', 'second']);
    should(link.report().sessions).equal(1);
  });
});

describe('a send queue spliced while one of its records is being sealed', () => {
  it('should keep the sealed stream-close on the wire behind the record it was sealing, and conclude only after it', async () => {
    // THE DEFECT THIS PINS, and it is the `ChannelState` race one array over. `#discardStreamPayload`
    // runs on the INBOUND path and splices the send queue — index `0` included — while a seal on the
    // outbox is suspended holding the record that WAS at index `0`. The `shift()` after that await
    // therefore removed whatever had taken the head, and on this exact path that is the sealed
    // `stream-close` the discard had just queued: the close was deleted, the superseded payload went
    // out in its place, and the `4440` behind it became a conclusion with no outcome stated inside the
    // channel. §14 makes that a protocol violation, so the browser reported an ordinary pane exit as a
    // broken daemon and lost the `1000`/`1009`/`1013` taxonomy the close exists to carry.
    //
    // Timing decides this in the wild. The held seal makes it a fact of the test.
    const { crypto, link, sent, stream, downstream, channel } = await heldStreamingLink('seal');

    // Arrange — one payload frame, captured by a seal that cannot finish yet.
    crypto.hold();
    downstream.send('{"kind":"event","n":1}');
    await new Promise(resolve => setTimeout(resolve, 1));

    // Act — the pane closes WHILE that seal is suspended, so the discard runs against a queue whose
    // head is the record being sealed, and queues the close behind it. Then the seal may finish.
    downstream.close(1013, 'fell behind');
    crypto.release();
    await settle(link);

    // Assert — read exactly as the client reads. The acceptance, then the frame that was already
    // sealed when the close was decided, then the close itself. A `stream-close` present at all is
    // what proves the seal did not delete it.
    //
    // THE PINNED FRAME IS SENT RATHER THAN DROPPED, and that is the invariant this shape buys: one
    // seal, one nonce, one frame on the wire. Dropping an already-produced ciphertext and sealing
    // the close under the same sequence number would put two AEAD invocations under one nonce, which
    // is not an exposure while only one can reach a socket but is a rule that stops being auditable
    // by reading. The discard loses nothing for it — this record already held its credit.
    //
    // `clientReadAll` also proves the sequence space: it opens every record in order against the
    // client's own channel, so a sequence that skipped or repeated throws here instead of asserting.
    const read = await clientReadAll(sent, channel);
    should(read.messages).deepEqual([
      STREAM_OPENED,
      { t: 'data', text: '{"kind":"event","n":1}' },
      { t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1013, reason: 'fell behind' },
    ]);

    // Assert — and §14's order holds around it: the sealed outcome crossed BEFORE the `4440` that
    // says the session ended with its outcome already stated.
    should(concludedAt(sent)).be.above(lastRecordAt(sent));
    should(stream.closed).have.length(1);
    should(link.report().sessions).equal(0);
  });

  it('should still discard the payload the close supersedes, keeping only the record under the seal', async () => {
    // The pin is an exemption for ONE record, not a retreat from the policy. A backlog behind an
    // exhausted window is still dropped, because the close is what makes that loss explicit and
    // holding those frames would make it wait for credit a departed viewer will never return.
    const { crypto, link, sent, stream, downstream, channel } = await heldStreamingLink('seal');

    // Arrange — one frame under the seal and two more queued behind it, none of them sent yet.
    crypto.hold();
    downstream.send('{"kind":"event","n":1}');
    await new Promise(resolve => setTimeout(resolve, 1));
    downstream.send('{"kind":"event","n":2}');
    downstream.send('{"kind":"event","n":3}');

    // Act
    downstream.close(1013, 'fell behind');
    crypto.release();
    await settle(link);

    // Assert — the pinned frame survives because it was already sealed; the two behind it do not.
    const read = await clientReadAll(sent, channel);
    should(read.messages).deepEqual([
      STREAM_OPENED,
      { t: 'data', text: '{"kind":"event","n":1}' },
      { t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1013, reason: 'fell behind' },
    ]);
    should(concludedAt(sent)).be.above(lastRecordAt(sent));
    should(stream.closed).have.length(1);
  });
});

describe('a record delivered twice', () => {
  it('should refuse the repeat as a broken sequence and never answer it a second time', async () => {
    // A carrier that duplicates a frame — by accident, or because it would like the request run
    // again — must not be able to replay one. The receive counter is the whole defence: the repeat
    // names a sequence this channel has already consumed, which earns the same `4420` a gap earns,
    // because "already read" and "never arrived" are both a stream this daemon refuses to repair.
    //
    // The counter only defends it while records are opened ONE AT A TIME, which is the contract
    // `receiveBinary` states and the carrier adapter's own promise chain keeps. Two opens in flight
    // would both read the same counter and both accept — so this case is also what that contract is
    // worth if anything ever hands frames over without awaiting.
    const { link, wire: sent, requests } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const opened = await openSession(link, sent, sessionOne());
    const authenticated = await clientSend(link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const request = await sealRecord(
      crypto_,
      authenticated,
      utf8Bytes(JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/v1/fleet' })),
    );
    if (!request.ok) throw new Error(request.reason);
    const frame = encodeFrame(request.frame);

    // Act — the same bytes twice. The copy is a copy on purpose: nothing here may depend on the
    // daemon recognising the same object, only on the sequence number the header carries.
    await link.receiveBinary(frame);
    should(requests).have.length(1);
    await link.receiveBinary(new Uint8Array(frame));

    // Assert — refused, the session is gone, and the dispatcher ran that request exactly once.
    should(controlOf(sent.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.sequenceBroken,
    });
    should(requests).have.length(1);
    should(link.report().sessions).equal(0);
  });
});

describe('a handler that produces a frame after its session ended', () => {
  it('should refuse a late frame from a handler the CLIENT closed, and keep the link serving', async () => {
    // THE DEFECT THIS PINS, and it is the ordinary relayed-terminal detach rather than an edge case.
    // `#closeStream` marks the session `concluding` before releasing the handler; the CLIENT-initiated
    // branch did not, so the session stayed in `streaming` after its `4440` had been sent and its
    // entry deleted. A handler does not necessarily stop producing the instant it is told to close —
    // `TerminalStreamBridge.redraw` has already awaited a pane capture and calls `downstream.send`
    // when it resumes — so that late frame was queued, sealed and put on the wire AFTER the close.
    //
    // A daemon frame naming no live session does not end a session at the rendezvous: `onDaemonFrame`
    // answers it with `refuse(daemon.socketId, …)`, which closes the DAEMON'S SOCKET. So closing one
    // terminal tab tore down the whole link — every other stream, the request session, and the claim.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const after = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/sessions/session-a/terminals/0123456789ab/stream',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');
    await settle(harnessed.link);

    // Act — the viewer leaves, and the pane's already-awaited capture resumes only afterwards.
    await clientSend(harnessed.link, after, {
      t: 'stream-close',
      protocol: SESSION_PROTOCOL_ID,
      code: 1000,
      reason: 'the viewer left this stream',
    });
    const late = downstream.send(Uint8Array.of(27, 91, 72));
    await settle(harnessed.link);

    // Assert — the producer is told the transport is gone rather than silently queued for.
    should(late).equal(-1);
    // Assert — and nothing followed the `4440` on the wire, which is the fact the rendezvous reads.
    should(concludedAt(harnessed.wire)).be.above(lastRecordAt(harnessed.wire));
    should(harnessed.link.report().sessions).equal(0);

    // Assert — THE LINK IS STILL USABLE, which is the consequence this whole test is about. The
    // socket was never closed, and a fresh session on it authenticates and is served as normal.
    should(harnessed.wire.closes).be.empty();
    const nextId = sessionIdFromBytes(new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    if (nextId === null) throw new Error('unreachable: 16 bytes');
    const reopened = await openSession(harnessed.link, harnessed.wire, nextId);
    const authenticated = await clientSend(harnessed.link, reopened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    await clientSend(harnessed.link, authenticated, { t: 'req', id: 1, method: 'GET', path: '/v1/fleet' });
    should(harnessed.requests).have.length(1);
    should(harnessed.link.report().sessions).equal(1);
  });

  it('should drop a record sealed for a session that was ended while the seal was suspended', async () => {
    // The same wire violation reached by the other route. `#endSession` runs from the INBOUND path and
    // sends its `closed` control at once, while a seal on the outbox may already hold a record it
    // captured before that. Both paths suspend on WebCrypto — one in `openRecord`, one in `sealRecord`
    // — so they interleave, and the resumed seal used to `shift`, advance the counter and write the
    // frame to a socket for a session the rendezvous had just been told was over.
    const { crypto, link, sent, downstream } = await heldStreamingLink('seal');

    // Arrange — one payload frame captured by a seal that cannot finish yet.
    crypto.hold();
    downstream.send('{"kind":"event","n":1}');
    await new Promise(resolve => setTimeout(resolve, 1));
    const recordsBefore = recordSequences(sent).length;

    // Act — a malformed credit frame ends this session synchronously, under the suspended seal. It is
    // NOT awaited: `receiveBinary` waits on the outbox at the end, and the held seal is that outbox.
    const ending = link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.credit,
        sessionId: sessionOne(),
        sequence: 0,
        // Three bytes: `decodeCreditPayload` admits exactly four, so this is a flow violation.
        payload: Uint8Array.of(0, 0, 1),
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 1));
    const closedAt = sent.frames.length - 1;

    // Assert — the session is already over and said so on the wire.
    should(controlOf(sent.frames[closedAt])).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.flowViolation,
      reason: 'malformed credit',
    });

    // Act — only now may the seal finish.
    crypto.release();
    await ending;

    // Assert — the produced ciphertext went nowhere. Nothing was appended after the close, and no
    // record at all was added once the seal resumed.
    should(recordSequences(sent)).have.length(recordsBefore);
    should(lastRecordAt(sent)).be.below(closedAt);
    should(link.report().sessions).equal(0);
    // Assert — and this is one session ending, never the link: the socket is untouched.
    should(sent.closes).be.empty();
  });
});

describe('what the rendezvous may read of a conclusion', () => {
  it('should never put the reason a stream ended into the unsealed close, from either side', async () => {
    // THE DISCLOSURE THIS PINS. A `closed` control frame is UNSEALED — the rendezvous has to read it
    // to route the session — so its `reason` is plaintext to the carrier. `#conclude` used to take
    // that string from its caller, and two callers made it a real leak: the CLIENT's own
    // `stream-close` text, which is reader-supplied content, and this daemon's own close taxonomy,
    // which tells a relay operator exactly why viewers stop watching. §14 requires every conclusion to
    // read the same from outside the channel; `RELAY_STREAM_CLOSES` in the link says the same thing
    // about the taxonomy in particular. The reason still crosses — sealed, in the record before it.
    const secret = 'the viewer left this stream because payroll finished';

    // Arrange + Act — the client's own close, carrying content nobody but the daemon should read.
    const byClient = harness(undefined, DEVICE_TOKEN, accepts(fakeStream()));
    const opened = await keyedSession(byClient);
    const after = await clientSend(byClient.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    await clientSend(byClient.link, after, {
      t: 'stream-close',
      protocol: SESSION_PROTOCOL_ID,
      code: 1000,
      reason: secret,
    });

    // Assert — the carrier reads one fixed sentence, and the client's words are nowhere in the clear.
    should(controlOf(byClient.wire.frames.at(-1))).deepEqual({
      t: 'closed',
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
      reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
    });
    should(relayVisibleText(byClient.wire)).not.match(/payroll/iu);
    should(relayVisibleText(byClient.wire)).not.match(/viewer/iu);

    // Arrange + Act — the DAEMON's own close, whose vocabulary is fixed but still descriptive.
    const stream = fakeStream();
    const byDaemon = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const second = await keyedSession(byDaemon);
    const streaming = await clientSend(byDaemon.link, second.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');
    downstream.close(1013, 'stream reader fell behind');
    await settle(byDaemon.link);

    // Assert — the same one sentence, and the taxonomy is not on the outside of the channel.
    should(controlOf(byDaemon.wire.frames.at(-1))).deepEqual({
      t: 'closed',
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
      reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
    });
    should(relayVisibleText(byDaemon.wire)).not.match(/fell behind/iu);

    // Assert — NOTHING WAS LOST BY HIDING IT. The client still learns the code and the reason, from
    // the sealed record that crossed immediately before the close. That is what `4440` means.
    const delivered = await clientReadAll(byDaemon.wire, streaming);
    should(delivered.messages.at(-1)).deepEqual({
      t: 'stream-close',
      protocol: SESSION_PROTOCOL_ID,
      code: 1013,
      reason: 'stream reader fell behind',
    });
  });

  it('should read the same for a pairing that succeeded and one that was refused', async () => {
    // §14's indistinguishability, at the exchange where it matters most: an observer counting frames
    // and reading closes must not be able to tell a daemon that gained a device from one that did not.
    const conclusionOf = async (redemption: PairingRedemption): Promise<ControlMessage | null> => {
      const harnessed = harness(undefined, DEVICE_TOKEN, undefined, async () => redemption);
      const opened = await keyedSession(harnessed);
      await clientSend(harnessed.link, opened.channel, {
        t: 'pair',
        protocol: SESSION_PROTOCOL_ID,
        code: '7F3K-Q2ND',
        deviceName: 'Ferretry PWA',
      });
      return controlOf(harnessed.wire.frames.at(-1));
    };

    // Act
    const paired = await conclusionOf({ kind: 'paired', response: PAIRED_RESPONSE });
    const refused = await conclusionOf({ kind: 'refused' });

    // Assert — one close, byte for byte, whichever happened.
    should(paired).deepEqual({
      t: 'closed',
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
      reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
    });
    should(refused).deepEqual(paired);
  });
});

/** Everything a rendezvous can actually READ of what this link sent: unsealed frames only. */
const relayVisibleText = (sent: Wire): string =>
  sent.frames
    .filter(frame => frame.kind !== FRAME_KINDS.data)
    .map(frame => utf8Text(frame.payload) ?? '')
    .join('\n');

/** A claimed link with controllable timers, on crypto a test can suspend at a chosen operation. */
interface HeldCredentialLink {
  readonly crypto: RelayCrypto & { hold(): void; release(): void };
  readonly link: RelayLink;
  readonly sent: Wire;
  readonly timers: FakeTimer[];
}

/**
 * A claimed link whose credential deadline a test fires by hand.
 *
 * Separate from {@link heldStreamingLink} because these cases need the SCHEDULER as well as the
 * crypto: the interleave under test is the deadline expiring inside an await, and a ten-second real
 * timer cannot be aimed at a window that is microseconds wide.
 */
async function heldCredentialLink(which: 'handshake' | 'open'): Promise<HeldCredentialLink> {
  const crypto = heldCrypto(which);
  const sent = wire();
  const timers: FakeTimer[] = [];
  const link = new RelayLink({
    crypto,
    identity,
    relayHost: HOST,
    socket: sent.socket,
    dispatch: async () => json(200, {}),
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    connections: new LiveDeviceConnections(),
    devices: {
      deviceKey: async deviceId => (deviceId === DEVICE_ID ? deviceKeyText : undefined),
      seen: () => undefined,
    },
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    clock: TEST_CLOCK,
    scheduler: {
      after: (milliseconds, action) => {
        const timer: FakeTimer = { milliseconds, fire: action, cancelled: false };
        timers.push(timer);
        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
  });
  await link.receiveBinary(challenge());
  await link.receiveBinary(claimed());
  return { crypto, link, sent, timers };
}

describe('a credential deadline that fires inside an await', () => {
  it('should not answer a handshake for a session the deadline ended while the crypto was suspended', async () => {
    // THE DEFECT THIS PINS, AND IT WAS INTRODUCED BY ARMING THE DEADLINE AT THE `open`. The timer used
    // to start when the handshake ANSWER was produced, so nothing could expire during
    // `answerClientHandshake`; covering `awaiting-hello` put that await inside the window. The
    // continuation then keyed a channel, wrote `awaiting-credential` over the `concluding` that
    // `#forget` had just set, and put the handshake answer on the wire BEHIND the `closed` control the
    // timer had already sent — a frame naming no live session, which the rendezvous answers by closing
    // the daemon's whole socket.
    const { crypto, link, sent, timers } = await heldCredentialLink('handshake');
    await link.receiveBinary(control({ t: 'open' }, sessionOne()));
    const pending = await startClientHandshake(crypto_, sessionOne(), identity.daemonId);

    // Act — the daemon's handshake suspends inside its own key generation.
    crypto.hold();
    const handshaking = link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionOne(),
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 1));

    // Act — and the credential window expires while it is suspended.
    timers[0]?.fire();
    const closedAt = sent.frames.length - 1;
    crypto.release();
    await handshaking;

    // Assert — the deadline ended it, and NOTHING followed that close: no handshake answer, no credit.
    should(controlOf(sent.frames[closedAt])).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'no credential arrived before the deadline',
    });
    should(sent.frames).have.length(closedAt + 1);
    should(link.report().sessions).equal(0);
    // Assert — one session ended, never the link.
    should(sent.closes).be.empty();
  });

  it('should not credit or dispatch a credential the deadline outran mid-decrypt', async () => {
    // The analogous race one await later, which predates the change above: the deadline can fire while
    // the FIRST record is being decrypted. The resumed continuation credited the peer against a
    // deleted session and then — because `#forget` leaves the phase `concluding` rather than a mode
    // this method serves — fell through to `#endSession` and sent a SECOND `closed` for a session the
    // rendezvous had already been told was gone. Checking the phase alone would not have caught it;
    // identity is the guard, and it is also what protects against a fresh `open` reusing the
    // identifier.
    const { crypto, link, sent, timers } = await heldCredentialLink('open');
    const opened = await openSession(link, sent, sessionOne());
    const credential = await sealRecord(
      crypto_,
      opened.channel,
      utf8Bytes(JSON.stringify({ t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN })),
    );
    if (!credential.ok) throw new Error(credential.reason);

    // Act — the credential record's decryption is suspended...
    crypto.hold();
    const receiving = link.receiveBinary(encodeFrame(credential.frame));
    await new Promise(resolve => setTimeout(resolve, 1));

    // ...and the window it was racing closes first.
    timers[0]?.fire();
    const closedAt = sent.frames.length - 1;
    crypto.release();
    await receiving;

    // Assert — one close, and nothing at all after it.
    should(controlOf(sent.frames[closedAt])).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'no credential arrived before the deadline',
    });
    should(sent.frames).have.length(closedAt + 1);
    should(link.report().sessions).equal(0);
    should(sent.closes).be.empty();
    // Assert — and the device was never authenticated, so no `authenticated` record was owed.
    should(sent.frames.filter(frame => frame.kind === FRAME_KINDS.data)).be.empty();
  });

  it('should still serve a handshake and a credential that beat the deadline', async () => {
    // The liveness checks must not cost the ordinary path anything, so the same two awaits are driven
    // with the timer left un-fired: the session keys, authenticates and serves as normal.
    const { link, sent, timers } = await heldCredentialLink('open');
    const opened = await openSession(link, sent, sessionOne());
    await clientSend(link, opened.channel, { t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceToken: DEVICE_TOKEN });

    // Assert — the window is cancelled by the record that answered it, and the session is serving.
    should(timers[0]?.cancelled).be.true();
    should(link.report().sessions).equal(1);
    const answered = await clientRead(sent, opened.channel);
    should(answered.message).containDeep(AUTHENTICATED);
  });
});

describe('the access lease', () => {
  const LEASE_MS = 900_000;
  const RENEW_AT_MS = 780_000;
  // A renewal a timer asks for has no receipt to await, and it is sealed with real WebCrypto on the
  // link's outbox: each case waits on that outbox with `settle`, never a fixed sleep a loaded runner outlasts.

  async function authenticated(upgrade?: (request: ApiRequest) => Promise<SocketUpgradeDecision>) {
    const harnessed = harness(undefined, DEVICE_TOKEN, upgrade);
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    return { harnessed, opened, channel };
  }

  const live = (timers: readonly FakeTimer[], milliseconds: number): FakeTimer | undefined =>
    timers.filter(timer => timer.milliseconds === milliseconds && !timer.cancelled).at(-1);

  it('should ask for a renewal ahead of the deadline, and extend the lease when the device signs it', async () => {
    // Arrange
    const { harnessed, opened, channel } = await authenticated();
    const renewal = live(harnessed.timers, RENEW_AT_MS);
    if (renewal === undefined) throw new Error('no renewal was armed');

    // Act — the daemon asks; the device answers with the same key over this transcript and the nonce.
    renewal.fire();
    await settle(harnessed.link);
    const read = await clientReadAll(harnessed.wire, opened.channel);
    const asked = read.messages.at(-1) as { t: string; nonce: string; expiresAt: string };
    should(asked).containDeep({ t: 'renew', protocol: SESSION_PROTOCOL_ID, expiresAt: '1970-01-01T00:15:00.000Z' });
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
    const firstLease = live(harnessed.timers, LEASE_MS);
    const after = await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });

    // Assert — the old deadline is gone and a fresh one stands; the session is still serving.
    should(firstLease?.cancelled).be.true();
    should(live(harnessed.timers, LEASE_MS)).not.be.undefined();
    should(harnessed.link.report().sessions).equal(1);

    // A second answer, with nothing outstanding, is a protocol error rather than a second chance.
    await clientSend(harnessed.link, after, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.protocolError });
  });

  it('should end the session with the lease code when nobody renewed, and say nothing about the device', async () => {
    const { harnessed } = await authenticated();
    live(harnessed.timers, LEASE_MS)?.fire();

    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
      reason: ACCESS_LEASE_ENDED_REASON,
    });
    should(harnessed.link.report().sessions).equal(0);
  });

  it('should refuse a renewal signed by another key exactly as it refuses an unknown device', async () => {
    const { harnessed, opened, channel } = await authenticated();
    live(harnessed.timers, RENEW_AT_MS)?.fire();
    await settle(harnessed.link);
    const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const forged = await signDeviceProof(crypto_, strangerKey, deviceRenewMessage(transcript, asked.nonce));

    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof: forged });

    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
  });

  it('should renew a stream session the same way, between its frames', async () => {
    // Arrange
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    await settle(harnessed.link);

    // Act
    live(harnessed.timers, RENEW_AT_MS)?.fire();
    await settle(harnessed.link);
    const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { t: string; nonce: string };
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });

    // Assert
    should(asked.t).equal('renew');
    should(stream.closed).be.empty();
    should(harnessed.link.report().sessions).equal(1);
  });

  /** A stream session whose grant answer the test decides, open and past its acceptance. */
  async function grantedStream(allowed: () => boolean) {
    const stream = fakeStream();
    const asked: ApiRequest[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream), undefined, {
      reauthorize: request => {
        asked.push(request);
        return allowed();
      },
    });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    await settle(harnessed.link);
    return { stream, asked, harnessed, opened, channel };
  }

  it('should end a stream at renewal when its grant no longer allows it, with a sealed 1008 and not 4403', async () => {
    // Arrange — a grant narrowed after the stream opened.
    let allowed = true;
    const { stream, asked, harnessed, opened, channel } = await grantedStream(() => allowed);
    allowed = false;

    // Act
    live(harnessed.timers, RENEW_AT_MS)?.fire();
    await settle(harnessed.link);
    const renew = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, renew.nonce));
    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    await settle(harnessed.link);

    // Assert — asked about the very request the stream was accepted for; the device stays paired.
    should(asked.map(request => request.path)).eql(['/v1/events']);
    should(stream.closed).not.be.empty();
    const after = await clientReadAll(harnessed.wire, channel);
    should(after.messages).containDeep([
      { t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1008, reason: 'this stream is no longer allowed' },
    ]);
    const refused = harnessed.wire.frames
      .filter(frame => frame.kind === FRAME_KINDS.control)
      .map(controlOf)
      .some(control => control?.t === 'closed' && control.code === RELAY_CLOSE_CODES.authRejected);
    should(refused).be.false();
  });

  it('should end a stream at renewal with a sealed 1008 once its device’s unlock lapsed, over the real socket dispatcher', async () => {
    // Arrange — the boundary the daemon runs: a governed terminal route, an unlock the case can lapse,
    // and NO per-act step-up held, so the unlock is the only thing that admits the stream.
    const unlocked = { value: true };
    const terminal: SocketRoute = {
      method: 'GET',
      path: '/v1/events',
      minimum: 'operator',
      capability: { capability: 'terminal', axis: 'use' },
      accept: async () => async () => ({
        open: async () => undefined,
        fromClient: () => undefined,
        close: () => undefined,
      }),
    };
    const dispatcher = new ApiSocketDispatcher(
      new ApiRouter([terminal]),
      { admin: 'admin-secret', warden: 'warden-secret', devices: { has: () => true } },
      {
        decide: (_demand, presentation) =>
          presentation.stepUp ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'step-up-required' },
        governance: () => ({ governed: true, decide: () => ({ allowed: false, refusal: 'undetermined' }) }),
        explain: () => 'confirm with your passkey',
      },
      undefined,
      { held: () => unlocked.value, unlockRequired: () => !unlocked.value },
    );
    const stream = fakeStream();
    const asked: ApiRequest[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream), undefined, {
      reauthorize: request => {
        asked.push(request);
        return dispatcher.reauthorize(request);
      },
    });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    await settle(harnessed.link);
    const renewOnce = async (renewing: Awaited<ReturnType<typeof clientSend>>) => {
      live(harnessed.timers, RENEW_AT_MS)?.fire();
      await settle(harnessed.link);
      const renew = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
      const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
      const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, renew.nonce));
      const next = await clientSend(harnessed.link, renewing, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
      await settle(harnessed.link);
      return next;
    };

    // Act — a renewal while unlocked keeps the stream; one after the unlock lapsed ends it.
    const renewed = await renewOnce(channel);
    const keptWhileUnlocked = stream.closed.length === 0;
    unlocked.value = false;
    const lapsed = await renewOnce(renewed);

    // Assert
    should(keptWhileUnlocked).be.true();
    should(asked.map(request => request.path)).eql(['/v1/events', '/v1/events']);
    should(stream.closed).not.be.empty();
    const after = await clientReadAll(harnessed.wire, lapsed);
    should(after.messages).containDeep([
      { t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1008, reason: 'this stream is no longer allowed' },
    ]);
  });

  it('should ask every live stream again when grants change, and keep the ones still allowed', async () => {
    // Arrange
    let allowed = true;
    const { stream, asked, harnessed } = await grantedStream(() => allowed);

    // Act — a change that still allows it, then one that does not.
    harnessed.connections.recheckAll();
    should(stream.closed).be.empty();
    allowed = false;
    harnessed.connections.recheckAll();
    await settle(harnessed.link);

    // Assert
    should(asked).have.length(2);
    should(stream.closed).not.be.empty();
  });

  it('should leave a request session alone when grants change: each request is decided on its own', async () => {
    // Arrange
    const asked: ApiRequest[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, {
      reauthorize: request => {
        asked.push(request);
        return false;
      },
    });
    const opened = await keyedSession(harnessed);
    await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act
    harnessed.connections.recheckAll();

    // Assert
    should(asked).be.empty();
    should(harnessed.link.report().sessions).equal(1);
  });

  it('should ask for nothing on a session that has already ended, and keep a renewal timer from reviving it', async () => {
    const { harnessed } = await authenticated();
    const renewal = live(harnessed.timers, RENEW_AT_MS);
    harnessed.link.close();
    const before = harnessed.wire.frames.length;
    renewal?.fire();
    should(harnessed.wire.frames.length).equal(before);
  });
});

const sessionTwo = (): SessionId => {
  const id = sessionIdFromBytes(new Uint8Array(16).fill(9));
  if (id === null) throw new Error('unreachable: a 16-byte identifier');
  return id;
};

/** The close the link sent last, as the rendezvous would read it. */
const lastClose = (sent: Wire) => controlOf(sent.frames.at(-1));

describe('a device proof is good for one session and one kind only', () => {
  /*
   * THE PROPERTY THE WHOLE DESIGN RESTS ON: a proof signs THIS session's transcript. The right key over
   * another session's transcript must be refused exactly like a stranger — which only a test that
   * signs a real, different transcript can show; a constant or a reused transcript would pass every
   * case that signs the right one.
   */
  it('should refuse a proof by the right key lifted from another session', async () => {
    const harnessed = harness();
    const first = await keyedSession(harnessed, sessionOne());
    const second = await openSession(harnessed.link, harnessed.wire, sessionTwo());
    const transcriptOfFirst = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const lifted = await signDeviceProof(
      crypto_,
      deviceKey,
      deviceAuthMessage(transcriptOfFirst, 'auth', DEVICE_ID, APP_SESSION),
    );

    await clientSend(harnessed.link, second.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof: lifted,
    });

    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
    should(harnessed.requests).be.empty();
    void first;
  });

  it('should refuse a renewal signed over another session’s transcript, even with the right nonce', async () => {
    const harnessed = harness();
    const first = await keyedSession(harnessed, sessionOne());
    const channel = await clientSend(harnessed.link, first.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    await openSession(harnessed.link, harnessed.wire, sessionTwo());
    harnessed.timers.filter(timer => timer.milliseconds === 780_000 && !timer.cancelled)[0]?.fire();
    await settle(harnessed.link);
    const renewRecord = harnessed.wire.frames
      .filter(frame => frame.kind === FRAME_KINDS.data && frame.sessionId.text === sessionOne().text)
      .at(-1);
    if (renewRecord === undefined) throw new Error('no renewal was asked');
    const { messages } = await clientReadAll(
      { ...harnessed.wire, frames: harnessed.wire.frames.filter(frame => frame.sessionId.text === sessionOne().text) },
      first.channel,
    );
    const asked = messages.at(-1) as { nonce: string };
    const otherTranscript = transcripts.get(sessionTwo().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(otherTranscript, asked.nonce));

    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });

    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
  });

  it('should refuse a proof of one kind presented as another', async () => {
    const swaps = [
      // An auth-kind proof on a stream record, and a stream-kind proof on an auth record.
      { record: 't:stream', sign: (th: Uint8Array) => deviceAuthMessage(th, 'auth', DEVICE_ID, APP_SESSION) },
      { record: 't:auth', sign: (th: Uint8Array) => deviceAuthMessage(th, 'stream', DEVICE_ID, APP_SESSION) },
      // A pairing-label proof is not an authentication.
      { record: 't:auth', sign: (th: Uint8Array) => devicePairMessage(th, deviceKeyText) },
    ];
    for (const swap of swaps) {
      const harnessed = harness();
      const opened = await keyedSession(harnessed);
      const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
      const proof = await signDeviceProof(crypto_, deviceKey, swap.sign(transcript));
      await clientSend(harnessed.link, opened.channel, {
        t: swap.record === 't:stream' ? 'stream' : 'auth',
        protocol: SESSION_PROTOCOL_ID,
        deviceId: DEVICE_ID,
        appSession: APP_SESSION,
        proof,
        ...(swap.record === 't:stream' ? { path: '/v1/events' } : {}),
      });
      should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
      should(harnessed.upgrades).be.empty();
    }
  });
});

describe('what keeps a device from idling out, and what keeps a session from living forever', () => {
  it('should move the idle clock only for a request the page marked as a person’s', async () => {
    const seen: string[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { seen: id => seen.push(id) });
    const opened = await keyedSession(harnessed);
    let channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    // Opening the session is not a person: a background tab does it by itself.
    should(seen).be.empty();
    channel = await clientSend(harnessed.link, channel, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    should(seen).be.empty();
    await clientSend(harnessed.link, channel, { t: 'req', id: 2, method: 'GET', path: '/v1/sessions', presence: true });
    should(seen).eql([DEVICE_ID]);
  });

  it('should not move the idle clock when a tab answers a renewal by itself', async () => {
    const seen: string[] = [];
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { seen: id => seen.push(id) });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    harnessed.timers.filter(timer => timer.milliseconds === 780_000)[0]?.fire();
    await settle(harnessed.link);
    const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    should(harnessed.link.report().sessions).equal(1);
    should(seen).be.empty();
  });

  it('should refuse a renewal for a device revoked or expired since the session opened', async () => {
    let known = true;
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, {
      deviceKey: async deviceId => (known && deviceId === DEVICE_ID ? deviceKeyText : undefined),
    });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    harnessed.timers.filter(timer => timer.milliseconds === 780_000)[0]?.fire();
    await settle(harnessed.link);
    const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
    // Gone from the registry between the open and the renewal — revoked, or idle-expired.
    known = false;
    await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.authRejected });
  });

  it('should stop renewing at the session cap, and end the last lease exactly there', async () => {
    let now = 0;
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { now: () => now });
    const opened = await keyedSession(harnessed);
    let channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const capMs = MAX_SESSION_SECONDS * 1_000;
    // The credential window and stragglers arm their own timers; the lease's are the other two.
    const leaseTimers = (from: number) => harnessed.timers.slice(from).filter(timer => timer.milliseconds !== 45_000);
    let armed = leaseTimers(0).filter(timer => !timer.cancelled);
    let renewal: FakeTimer | undefined = armed.find(timer => timer.milliseconds === 780_000);
    let lastLease: FakeTimer | undefined = armed.find(timer => timer.milliseconds === 900_000);
    // A tab that answers every renewal, as a real one does, until the daemon stops asking.
    for (let round = 0; round < 100 && renewal !== undefined; round += 1) {
      now += renewal.milliseconds;
      renewal.fire();
      await settle(harnessed.link);
      const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
      // The client returns credit for what it read, as a real one does, so the daemon can keep asking.
      await harnessed.link.receiveBinary(
        encodeFrame({
          kind: FRAME_KINDS.credit,
          sessionId: sessionOne(),
          sequence: 0,
          payload: encodeCreditPayload(1),
        }),
      );
      const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
      const before = harnessed.timers.length;
      channel = await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
      armed = leaseTimers(before);
      lastLease = armed.at(-1);
      renewal = armed.length === 2 ? armed[0] : undefined;
    }
    // The last lease ends AT the cap, and nothing is left to ask for another.
    should(lastLease?.milliseconds).equal(capMs - now);
    should(
      harnessed.timers.filter(timer => !timer.cancelled && timer !== lastLease && timer.milliseconds < 900_000),
    ).be.empty();
    lastLease?.fire();
    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE });
  });

  it('should run the lease, its renewal and the cap on an injected policy, in seconds rather than hours', async () => {
    // B20: the policy is the seam an end-to-end run drives a lease end and the cap through, without
    // waiting out fifteen minutes or twelve hours. Six-second leases, asked again two seconds ahead,
    // and a nine-second cap: one renewal, then a last lease that ends exactly at the cap.
    let now = 0;
    const lease: AccessLeasePolicy = { leaseMs: 6_000, renewLeadMs: 2_000, maxSessionMs: 9_000 };
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { now: () => now, lease });
    const opened = await keyedSession(harnessed);
    let channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const transcript = transcripts.get(sessionOne().text) ?? new Uint8Array();
    const leaseTimers = (from: number) => harnessed.timers.slice(from).filter(timer => timer.milliseconds !== 45_000);
    const first = leaseTimers(0).filter(timer => !timer.cancelled);

    now = 4_000;
    first[0]?.fire();
    await settle(harnessed.link);
    const asked = (await clientReadAll(harnessed.wire, opened.channel)).messages.at(-1) as { nonce: string };
    await harnessed.link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: sessionOne(), sequence: 0, payload: encodeCreditPayload(1) }),
    );
    const proof = await signDeviceProof(crypto_, deviceKey, deviceRenewMessage(transcript, asked.nonce));
    const before = harnessed.timers.length;
    channel = await clientSend(harnessed.link, channel, { t: 'renewed', protocol: SESSION_PROTOCOL_ID, proof });
    const last = leaseTimers(before);
    last.at(-1)?.fire();

    should(first.map(timer => timer.milliseconds)).eql([4_000, 6_000]);
    should(last.map(timer => timer.milliseconds)).eql([5_000]);
    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE });
  });

  it('should refuse a record that arrives after the lease ended, even before its timer has run', async () => {
    let now = 0;
    const harnessed = harness(undefined, DEVICE_TOKEN, undefined, undefined, { now: () => now });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    now = 900_000;
    await clientSend(harnessed.link, channel, { t: 'req', id: 1, method: 'GET', path: '/v1/sessions' });
    should(harnessed.requests).be.empty();
    should(lastClose(harnessed.wire)).containDeep({ t: 'closed', code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE });
  });
});

describe('the key an unknown device id is verified against', () => {
  /** RFC 8032 test 1: a key whose SECRET is published, which this key once was. */
  const RFC_8032_TEST_1_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';

  it('should verify nothing: not a proof by a real device key, and not one signed with a published secret', async () => {
    const message = deviceAuthMessage(new Uint8Array(32).fill(7), 'auth', DEVICE_ID, APP_SESSION);
    const honest = await signDeviceProof(crypto_, deviceKey, message);
    const seed = Uint8Array.from(RFC_8032_TEST_1_SEED.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
    const pkcs8 = Uint8Array.from([
      0x30,
      0x2e,
      0x02,
      0x01,
      0x00,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x04,
      0x22,
      0x04,
      0x20,
      ...seed,
    ]);
    const published = await globalThis.crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    const forged = toBase64Url(
      new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', published, new Uint8Array(message))),
    );

    should(await verifyDeviceProof(crypto_, UNKNOWN_DEVICE_KEY, honest, message)).be.false();
    should(await verifyDeviceProof(crypto_, UNKNOWN_DEVICE_KEY, forged, message)).be.false();
  });
});

describe('requests that run side by side', () => {
  /** A request handler that answers only when the test says so, one gate per path. */
  function gated() {
    const gates = new Map<string, () => void>();
    const answer = async (request: ApiRequest): Promise<ApiResponse> => {
      if (request.path.startsWith('/slow')) await new Promise<void>(resolve => gates.set(request.path, resolve));
      if (request.path === '/throws') throw new Error('a route that threw');
      return json(200, { path: request.path });
    };
    const open = (path: string): void => {
      const gate = gates.get(path);
      if (gate === undefined) throw new Error(`no request is waiting at ${path}`);
      gates.delete(path);
      gate();
    };
    return { gates, answer, open };
  }

  /** Seal one message as the client and hand it over the way a carrier does: handled, not answered. */
  async function clientAccept(
    link: RelayLink,
    channel: ChannelState,
    message: unknown,
  ): Promise<{ state: ChannelState; settled: Promise<void> }> {
    const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(message)));
    if (!sealed.ok) throw new Error(sealed.reason);
    const receipt = await link.accept(encodeFrame(sealed.frame));
    return { state: sealed.state, settled: receipt.settled };
  }

  async function serving(answer: (request: ApiRequest) => Promise<ApiResponse>, now?: () => number) {
    const harnessed = harness(answer, DEVICE_TOKEN, undefined, undefined, now === undefined ? {} : { now });
    const opened = await keyedSession(harnessed);
    const channel = await clientSend(harnessed.link, opened.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    return { harnessed, opened, channel };
  }

  const answeredIds = async (sent: Wire, channel: ChannelState): Promise<number[]> =>
    (await clientReadAll(sent, channel)).messages
      .filter((message): message is { t: 'res'; id: number } => (message as { t?: string }).t === 'res')
      .map(message => message.id);

  it('should answer a fast request while a slow one on the same link is still running', async () => {
    // Arrange — the defect: requests were served inside the carrier's inbound chain, so one slow
    // handler held up every request behind it on the link.
    const routes = gated();
    const { harnessed, opened, channel } = await serving(routes.answer);

    // Act — the slow request first, then the fast one, each handed over the way a carrier does.
    const slow = await clientAccept(harnessed.link, channel, { t: 'req', id: 1, method: 'GET', path: '/slow' });
    const fast = await clientAccept(harnessed.link, slow.state, { t: 'req', id: 2, method: 'GET', path: '/fast' });
    await fast.settled;

    // Assert — the fast one crossed while the slow one is still running.
    should(routes.gates.has('/slow')).be.true();
    should(await answeredIds(harnessed.wire, opened.channel)).deepEqual([2]);

    // Act + Assert — the slow one answers when its handler does, under its own id.
    routes.open('/slow');
    await slow.settled;
    should(await answeredIds(harnessed.wire, opened.channel)).deepEqual([2, 1]);
  });

  it('should run at most the bound at once, and start a waiting request when one answers', async () => {
    // Arrange
    const routes = gated();
    const { harnessed, opened, channel } = await serving(routes.answer);
    let state = channel;
    const receipts: Promise<void>[] = [];

    // Act — one more request than the bound, every one of them slow.
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS + 1; id += 1) {
      const sent = await clientAccept(harnessed.link, state, { t: 'req', id, method: 'GET', path: `/slow/${id}` });
      state = sent.state;
      receipts.push(sent.settled);
    }

    // Assert — the last one waits rather than running.
    should(harnessed.requests).have.length(MAX_CONCURRENT_REQUESTS);

    // Act + Assert — one answer frees one slot, and the request that waited longest takes it.
    routes.open('/slow/3');
    await receipts[2];
    should(harnessed.requests.map(request => request.path).at(-1)).equal(`/slow/${MAX_CONCURRENT_REQUESTS + 1}`);
    for (const path of [...routes.gates.keys()]) routes.open(path);
    await Promise.all(receipts);
    should((await answeredIds(harnessed.wire, opened.channel)).toSorted((a, b) => a - b)).deepEqual(
      Array.from({ length: MAX_CONCURRENT_REQUESTS + 1 }, (_, index) => index + 1),
    );
  });

  it('should keep the credit of a waiting request until it starts, so the peer is held back by §8', async () => {
    // Arrange — a full window of requests past the bound: the handshake, the credential, then the bound
    // running and half a window waiting.
    const routes = gated();
    const { harnessed, channel } = await serving(routes.answer);
    let state = channel;
    const receipts: Promise<void>[] = [];
    const credited = (): number =>
      harnessed.wire.frames
        .filter(frame => frame.kind === FRAME_KINDS.credit)
        .reduce((total, frame) => total + (decodeCreditPayload(frame.payload) ?? 0), 0);
    const total = MAX_CONCURRENT_REQUESTS + CREDIT_WINDOW_FRAMES / 2;

    // Act
    for (let id = 1; id <= total; id += 1) {
      const sent = await clientAccept(harnessed.link, state, { t: 'req', id, method: 'GET', path: `/slow/${id}` });
      state = sent.state;
      receipts.push(sent.settled);
    }

    // Assert — the waiting half-window is not consumed as far as credit is concerned: one batch went
    // back for what is running, none for what waits.
    should(credited()).equal(CREDIT_WINDOW_FRAMES / 2);

    // Act + Assert — once everything has run, the credit it held goes back too: the second batch, which
    // a link that counted waiting records as consumed would have returned before any of them ran.
    while (routes.gates.size > 0) {
      for (const path of [...routes.gates.keys()]) routes.open(path);
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await Promise.all(receipts);
    should(credited()).equal(CREDIT_WINDOW_FRAMES);
  });

  it('should answer a handler that throws with a 500 and keep the session serving', async () => {
    const routes = gated();
    const { harnessed, opened, channel } = await serving(routes.answer);

    const thrown = await clientAccept(harnessed.link, channel, { t: 'req', id: 4, method: 'GET', path: '/throws' });
    await thrown.settled;
    const after = await clientAccept(harnessed.link, thrown.state, { t: 'req', id: 5, method: 'GET', path: '/ok' });
    await after.settled;

    const read = await clientReadAll(harnessed.wire, opened.channel);
    should(read.messages.at(-2)).containDeep({ t: 'res', id: 4, status: 500 });
    should(JSON.parse((read.messages.at(-2) as { body: string }).body)).deepEqual({
      error: { code: 'internal_error', message: 'the daemon failed to handle this request' },
    });
    should(read.messages.at(-1)).containDeep({ t: 'res', id: 5, status: 200 });
    should(harnessed.link.report().sessions).equal(1);
  });

  it('should send nothing for a request whose session ended while it ran, nor start the ones waiting', async () => {
    // Arrange — the bound running, one more waiting.
    const routes = gated();
    const { harnessed, channel } = await serving(routes.answer);
    let state = channel;
    const receipts: Promise<void>[] = [];
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS + 1; id += 1) {
      const sent = await clientAccept(harnessed.link, state, { t: 'req', id, method: 'GET', path: `/slow/${id}` });
      state = sent.state;
      receipts.push(sent.settled);
    }

    // Act — the session ends under them (a malformed credit is the cheapest ending), then they finish.
    await harnessed.link.receiveBinary(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: sessionOne(), sequence: 0, payload: new Uint8Array(3) }),
    );
    const framesAtEnd = harnessed.wire.frames.length;
    for (const path of [...routes.gates.keys()]) routes.open(path);
    await Promise.all(receipts);

    // Assert — the close is the last thing said for that session, and the waiting request never ran.
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({ t: 'closed', code: RELAY_CLOSE_CODES.flowViolation });
    should(harnessed.wire.frames).have.length(framesAtEnd);
    should(harnessed.requests).have.length(MAX_CONCURRENT_REQUESTS);
  });

  it('should end the session with the lease code when a waiting request reaches its turn after the lease', async () => {
    // Arrange
    let now = 0;
    const routes = gated();
    const { harnessed, channel } = await serving(routes.answer, () => now);
    let state = channel;
    const receipts: Promise<void>[] = [];
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS + 1; id += 1) {
      const sent = await clientAccept(harnessed.link, state, { t: 'req', id, method: 'GET', path: `/slow/${id}` });
      state = sent.state;
      receipts.push(sent.settled);
    }

    // Act — the lease runs out while the request waits (its timer starved), then a slot frees.
    now = 900_000;
    routes.open('/slow/1');
    await Promise.all([receipts[0], receipts[MAX_CONCURRENT_REQUESTS]]);

    // Assert
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE,
      reason: ACCESS_LEASE_ENDED_REASON,
    });
    should(harnessed.requests).have.length(MAX_CONCURRENT_REQUESTS);
    for (const path of [...routes.gates.keys()]) routes.open(path);
    await Promise.all(receipts);
  });

  it('should refuse a peer that queues more requests than its allowance could have carried', async () => {
    // Arrange — a peer ignoring credit, which a rendezvous would refuse and a direct socket cannot.
    const routes = gated();
    const { harnessed, channel } = await serving(routes.answer);
    let state = channel;
    const receipts: Promise<void>[] = [];

    // Act — the bound, then one more than a window plus the one record whose credit may already be back.
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS + CREDIT_WINDOW_FRAMES + 2; id += 1) {
      const sent = await clientAccept(harnessed.link, state, { t: 'req', id, method: 'GET', path: `/slow/${id}` });
      state = sent.state;
      receipts.push(sent.settled);
    }

    // Assert
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.flowViolation,
      reason: 'more requests than the window allows',
    });
    for (const path of [...routes.gates.keys()]) routes.open(path);
    await Promise.all(receipts);
  });
});

describe('a session that cannot carry its own answer', () => {
  it('should end the session when a peer that never returns credit lets the answer queue outgrow a window', async () => {
    // Arrange — a peer ignoring credit: the daemon's answers pile up behind a window that never reopens.
    const { link, wire: sent } = harness();
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const session = await openSession(link, sent, sessionOne());
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act — the window carries what it can, a second window's worth queues, and one request more has nowhere to wait.
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES * 2 + 1; id += 1) {
      channel = await clientSend(link, channel, { t: 'req', id, method: 'GET', path: '/v1/health' });
    }

    // Assert
    should(controlOf(sent.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.protocolError,
      reason: 'this session cannot carry its own answer',
    });
    should(link.report().sessions).equal(0);
  });
});

describe('a record the channel refuses to seal', () => {
  it('should end the session with the seal refusal when a handler closes with a reason too long for one record', async () => {
    // Arrange — a stream whose close reason is the handler's to choose, and is not bounded on the way in.
    const stream = fakeStream();
    const harnessed = harness(undefined, DEVICE_TOKEN, accepts(stream));
    const opened = await keyedSession(harnessed);
    await clientSend(harnessed.link, opened.channel, {
      t: 'stream',
      protocol: SESSION_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
      path: '/v1/events',
    });
    const downstream = stream.downstream;
    if (downstream === undefined) throw new Error('the stream was never attached');

    // Act
    downstream.close(1000, 'x'.repeat(MAX_PLAINTEXT_BYTES));
    await settle(harnessed.link);

    // Assert — the channel's own refusal, said once, and nothing sealed behind it
    should(controlOf(harnessed.wire.frames.at(-1))).containDeep({
      t: 'closed',
      code: RELAY_CLOSE_CODES.frameTooLarge,
      reason: 'payload exceeds one record',
    });
    should(harnessed.link.report().sessions).equal(0);
  });
});
