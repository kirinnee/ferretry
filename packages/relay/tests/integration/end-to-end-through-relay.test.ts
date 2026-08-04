/**
 * The whole claim, exercised once.
 *
 * A real daemon identity, a real handshake, real AES-GCM records, and the actual rendezvous code
 * in between — and then the assertion that matters: the rendezvous forwarded every byte and could
 * not read a single one of them.
 */

import { describe, it } from 'bun:test';
import { type RelayEnvironment, RendezvousDurableObject } from '../../src/adapters/index.ts';
import {
  answerClientHandshake,
  type ChannelState,
  claimContextForChallenge,
  completeClientHandshake,
  type ControlMessage,
  decodeControlMessage,
  decodeDaemonHello,
  encodeClaim,
  encodeControlMessage,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HANDSHAKE_FRAME_SEQUENCE,
  NONCE_BYTES,
  openChannel,
  openRecord,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayFrame,
  RENDEZVOUS_SESSION_ID,
  sealRecord,
  type SessionId,
  signRendezvousClaim,
  startClientHandshake,
  utf8Bytes,
  utf8Text,
} from '../../src/lib/index.ts';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';
import { FakeObjectState, type FakeSocket, testRuntime } from '../support/workers-fakes.ts';

const host = 'relay.example';

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

function wire(frame: RelayFrame): ArrayBuffer {
  const bytes = encodeFrame(frame);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function controlOf(frame: RelayFrame | undefined): ControlMessage | null {
  return frame === undefined ? null : decodeControlMessage(frame.payload);
}

describe('a session carried end to end by the rendezvous', () => {
  it('should key a channel the rendezvous cannot read, and refuse a rendezvous that alters a frame', async () => {
    const objectState = new FakeObjectState();
    const runtime = testRuntime();
    const rendezvous = new RendezvousDurableObject(objectState, environment, runtime);
    const identity = await newDaemonIdentity();

    // ── the daemon dials out and proves it owns the fingerprint in the path ──
    await rendezvous.fetch(
      new Request(`https://${host}/v1/rendezvous/${identity.daemonId}/daemon`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    const daemonSocket = objectState.sockets[0] as FakeSocket;
    const challengeMessage = controlOf(daemonSocket.drain()[0]);
    if (challengeMessage?.t !== 'challenge') throw new Error('expected a challenge');
    const challenge = fromBase64UrlFixed(challengeMessage.nonce, NONCE_BYTES);
    if (challenge === null) throw new Error('malformed challenge');
    const context = claimContextForChallenge(identity.daemonId, host, challengeMessage.host, challenge);
    if (context === null) throw new Error('the daemon would not sign for this host');
    await rendezvous.webSocketMessage(
      daemonSocket,
      wire({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: encodeControlMessage({
          t: 'claim',
          protocol: RELAY_PROTOCOL_ID,
          ...encodeClaim(await signRendezvousClaim(relayCrypto, identity, context)),
        }),
      }),
    );
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'claimed' });

    // ── the phone joins, knowing only the fingerprint the pairing QR gave it ──
    await rendezvous.fetch(
      new Request(`https://${host}/v1/rendezvous/${identity.daemonId}/client`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    const clientSocket = objectState.sockets[1] as FakeSocket;
    const ready = clientSocket.drain()[0];
    if (ready === undefined) throw new Error('the client was never made ready');
    const sessionId: SessionId = ready.sessionId;
    should(controlOf(daemonSocket.drain()[0])).match({ t: 'open' });

    // ── handshake, over the rendezvous, in both directions ──
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
    await rendezvous.webSocketMessage(
      clientSocket,
      wire({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(pending.hello),
      }),
    );
    const relayedHello = daemonSocket.drain()[0];
    if (relayedHello === undefined) throw new Error('the hello was not carried');
    should(relayedHello.kind).equal(FRAME_KINDS.handshake);

    const answered = await answerClientHandshake(relayCrypto, identity, sessionId, pending.hello);
    if (!answered.ok) throw new Error(answered.reason);
    await rendezvous.webSocketMessage(
      daemonSocket,
      wire({
        kind: FRAME_KINDS.handshake,
        sessionId,
        sequence: HANDSHAKE_FRAME_SEQUENCE,
        payload: encodeHandshakeMessage(answered.hello),
      }),
    );
    const relayedAnswer = clientSocket.drain()[0];
    if (relayedAnswer === undefined) throw new Error('the answer was not carried');
    const daemonHello = decodeDaemonHello(relayedAnswer.payload);
    if (daemonHello === null) throw new Error('the answer did not survive the carrier');

    const completed = await completeClientHandshake(relayCrypto, pending, daemonHello);
    should(completed.ok).be.true();
    if (!completed.ok) return;

    let clientChannel: ChannelState = openChannel(sessionId, completed.keys, 'client');
    let daemonChannel: ChannelState = openChannel(sessionId, answered.keys, 'daemon');

    // ── a record crosses the rendezvous, which never sees the plaintext ──
    const secret = 'the device token never appears on this wire';
    const sealed = await sealRecord(relayCrypto, clientChannel, utf8Bytes(secret));
    if (!sealed.ok) throw new Error(sealed.reason);
    clientChannel = sealed.state;

    await rendezvous.webSocketMessage(clientSocket, wire(sealed.frame));
    const carried = daemonSocket.drain()[0];
    if (carried === undefined) throw new Error('the record was not carried');

    should(utf8Text(encodeFrame(carried)) ?? '').not.match(/device token/u);
    const opened = await openRecord(relayCrypto, daemonChannel, carried);
    should(opened.ok).be.true();
    if (!opened.ok) return;
    daemonChannel = opened.state;
    should(utf8Text(opened.plaintext)).equal(secret);

    // ── and a rendezvous that changed one byte is caught, not tolerated ──
    const reply = await sealRecord(relayCrypto, daemonChannel, utf8Bytes('acknowledged'));
    if (!reply.ok) throw new Error(reply.reason);
    await rendezvous.webSocketMessage(daemonSocket, wire(reply.frame));
    const returned = clientSocket.drain()[0];
    if (returned === undefined) throw new Error('the reply was not carried');

    const meddled: RelayFrame = { ...returned, payload: Uint8Array.from(returned.payload) };
    meddled.payload[0] = (meddled.payload[0] ?? 0) ^ 0x01;
    const rejected = await openRecord(relayCrypto, clientChannel, meddled);
    should(rejected.ok).be.false();
    if (!rejected.ok) should(rejected.code).equal(RELAY_CLOSE_CODES.frameForged);

    should(await openRecord(relayCrypto, clientChannel, returned)).match({ ok: true });
  });

  it('should refuse a client whose daemon is not there, without leaking whether it exists', async () => {
    const objectState = new FakeObjectState();
    const rendezvous = new RendezvousDurableObject(objectState, environment, testRuntime());
    const identity = await newDaemonIdentity();

    await rendezvous.fetch(
      new Request(`https://${host}/v1/rendezvous/${identity.daemonId}/client`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    const clientSocket = objectState.sockets[0] as FakeSocket;
    should(clientSocket.closed?.code).equal(RELAY_CLOSE_CODES.daemonAbsent);
  });
});
