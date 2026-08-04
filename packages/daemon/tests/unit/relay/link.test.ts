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
  encodeControlMessage,
  encodeCreditPayload,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HANDSHAKE_FRAME_SEQUENCE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayFrame,
  type SessionId,
  type SessionKeys,
  sealRecord,
  sessionIdFromBytes,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import { RelayLink, type RelayLinkSocket } from '../../../src/lib/relay/link.ts';

const crypto_ = new WebCryptoRelayCrypto();
const HOST = 'relay.example';
const DEVICE_TOKEN = 'fy_device_known';

let identity: DaemonIdentity;

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
});

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

interface Harness {
  readonly link: RelayLink;
  readonly wire: Wire;
  readonly requests: ApiRequest[];
}

function harness(
  answer: (request: ApiRequest) => Promise<ApiResponse> = async () => json(200, { ok: true }),
  knownToken = DEVICE_TOKEN,
): Harness {
  const sent = wire();
  const requests: ApiRequest[] = [];
  const link = new RelayLink({
    crypto: crypto_,
    identity,
    relayHost: HOST,
    socket: sent.socket,
    dispatch: async request => {
      requests.push(request);
      return await answer(request);
    },
    devices: { identifyDevice: token => (token === knownToken ? 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa' : undefined) },
  });
  return { link, wire: sent, requests };
}

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
  return { channel: openChannel(sessionId, completed.keys, 'client'), keys: completed.keys };
}

/** Seal one tunnel message as the client and hand it to the link. */
async function clientSend(link: RelayLink, channel: ChannelState, message: unknown): Promise<ChannelState> {
  const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(message)));
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

const controlOf = (frame: RelayFrame | undefined): ControlMessage | null =>
  frame === undefined ? null : decodeControlMessage(frame.payload);

describe('claiming a rendezvous', () => {
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
      protocol: RELAY_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const authenticated = await clientRead(sent, channel);
    should(authenticated.message).deepEqual({ t: 'authenticated', protocol: RELAY_PROTOCOL_ID });
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
    should(requests[0]?.headers.get('authorization')).equal(`Bearer ${DEVICE_TOKEN}`);
    should(requests[0]?.headers.get('x-ferretry-client')).equal('ui');
    should(requests[0]?.loopback).be.false();
  });

  it('should name an answer that does not fit one record rather than truncating it', async () => {
    // Arrange — a response far past one record.
    const { link, wire: sent } = harness(async () => ({
      status: 200,
      headers: new Map(),
      body: 'x'.repeat(70_000),
    }));
    await link.receiveBinary(challenge());
    await link.receiveBinary(claimed());
    const sessionId = sessionOne();
    const session = await openSession(link, sent, sessionId);

    // Act
    let channel = await clientSend(link, session.channel, {
      t: 'auth',
      protocol: RELAY_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });
    const authenticated = await clientRead(sent, channel);
    channel = await clientSend(link, channel, { t: 'req', id: 1, method: 'GET', path: '/v1/big' });
    const answer = await clientRead(sent, authenticated.state);

    // Assert — a typed refusal naming the size. A client that rendered half a list would show a
    // fleet that does not exist.
    should(answer.message).containDeep({ t: 'oversize', id: 1, status: 200 });
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
      protocol: RELAY_PROTOCOL_ID,
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
      protocol: RELAY_PROTOCOL_ID,
      deviceToken: DEVICE_TOKEN,
    });

    // Act + Assert
    await clientSend(twice.link, channel, { t: 'auth', protocol: RELAY_PROTOCOL_ID, deviceToken: DEVICE_TOKEN });
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
      protocol: RELAY_PROTOCOL_ID,
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
      protocol: RELAY_PROTOCOL_ID,
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
