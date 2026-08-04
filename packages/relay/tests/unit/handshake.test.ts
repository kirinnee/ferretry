import { describe, it } from 'bun:test';
import {
  answerClientHandshake,
  completeClientHandshake,
  type DaemonHello,
  decodeClientHello,
  decodeDaemonHello,
  encodeHandshakeMessage,
  handshakeTranscriptHash,
  sessionIdFromBytes,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto, stubbedCrypto } from '../support/identities.ts';

function fixtureSessionId(fill: number) {
  const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (sessionId === null) throw new Error('fixture session id is malformed');
  return sessionId;
}

const sessionId = fixtureSessionId(3);

async function handshake() {
  const identity = await newDaemonIdentity();
  const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
  const answered = await answerClientHandshake(relayCrypto, identity, sessionId, pending.hello);
  if (!answered.ok) throw new Error(`daemon refused its own client: ${answered.reason}`);
  return { identity, pending, answered };
}

describe('end-to-end handshake', () => {
  it('should agree on two directional keys, and on the transcript they came from', async () => {
    const { pending, answered, identity } = await handshake();
    const completed = await completeClientHandshake(relayCrypto, pending, answered.hello);
    should(completed.ok).be.true();
    if (!completed.ok) return;
    should(completed.keys.clientToDaemon).deepEqual(answered.keys.clientToDaemon);
    should(completed.keys.daemonToClient).deepEqual(answered.keys.daemonToClient);
    should(completed.keys.clientToDaemon).not.deepEqual(completed.keys.daemonToClient);
    should(completed.keys.transcriptHash).deepEqual(answered.keys.transcriptHash);
    should(completed.daemonPublicKeySpki).deepEqual(identity.publicKeySpki);
  });

  it('should tie the transcript to the session the carrier assigned', async () => {
    const { pending, answered } = await handshake();
    const elsewhere = await completeClientHandshake(
      relayCrypto,
      { ...pending, sessionId: fixtureSessionId(4) },
      answered.hello,
    );
    should(elsewhere.ok).be.false();
    if (!elsewhere.ok) should(elsewhere.reason).match(/does not cover this handshake/u);
  });

  it('should refuse a daemon whose key is not the pinned fingerprint', async () => {
    const impostor = await newDaemonIdentity();
    const expected = await newDaemonIdentity();
    const pending = await startClientHandshake(relayCrypto, sessionId, impostor.daemonId);
    const answered = await answerClientHandshake(relayCrypto, impostor, sessionId, pending.hello);
    if (!answered.ok) throw new Error('fixture handshake failed');

    const completed = await completeClientHandshake(
      relayCrypto,
      { ...pending, expectedDaemonId: expected.daemonId },
      answered.hello,
    );
    should(completed.ok).be.false();
    if (!completed.ok) should(completed.reason).match(/pinned fingerprint/u);
  });

  it('should refuse a tampered signature and malformed key material', async () => {
    const { pending, answered } = await handshake();
    const flipped: DaemonHello = {
      ...answered.hello,
      sig: `${answered.hello.sig.startsWith('A') ? 'B' : 'A'}${answered.hello.sig.slice(1)}`,
    };
    const tampered = await completeClientHandshake(relayCrypto, pending, flipped);
    should(tampered.ok).be.false();

    const malformed = await completeClientHandshake(relayCrypto, pending, { ...answered.hello, spki: 'AAAA' });
    should(malformed.ok).be.false();
    if (!malformed.ok) should(malformed.reason).match(/malformed key material/u);
  });

  it('should refuse a hello addressed to a different daemon, or carrying a bad ephemeral key', async () => {
    const identity = await newDaemonIdentity();
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);

    const misrouted = await answerClientHandshake(relayCrypto, identity, sessionId, {
      ...pending.hello,
      daemonId: `fy_daemon_${'z'.repeat(43)}`,
    });
    should(misrouted.ok).be.false();
    if (!misrouted.ok) should(misrouted.reason).match(/names a different daemon/u);

    const badKey = await answerClientHandshake(relayCrypto, identity, sessionId, { ...pending.hello, epk: 'AAAA' });
    should(badKey.ok).be.false();
    if (!badKey.ok) should(badKey.reason).match(/malformed ephemeral key/u);
  });

  it('should refuse a key agreement that produced nothing usable, on either side', async () => {
    const barren = stubbedCrypto({ deriveSharedSecret: async () => null });
    const identity = await newDaemonIdentity();
    const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);

    const daemonSide = await answerClientHandshake(barren, identity, sessionId, pending.hello);
    should(daemonSide.ok).be.false();
    if (!daemonSide.ok) should(daemonSide.reason).match(/no usable secret/u);

    const answered = await answerClientHandshake(relayCrypto, identity, sessionId, pending.hello);
    if (!answered.ok) throw new Error('fixture handshake failed');
    const clientSide = await completeClientHandshake(barren, pending, answered.hello);
    should(clientSide.ok).be.false();
    if (!clientSide.ok) should(clientSide.reason).match(/no usable secret/u);
  });

  it('should round-trip handshake messages and refuse anything else', async () => {
    const { pending, answered } = await handshake();
    should(decodeClientHello(encodeHandshakeMessage(pending.hello))).deepEqual(pending.hello);
    should(decodeDaemonHello(encodeHandshakeMessage(answered.hello))).deepEqual(answered.hello);
    should(decodeClientHello(encodeHandshakeMessage(answered.hello))).be.null();
    should(decodeDaemonHello(utf8Bytes('{"t":"hs2"}'))).be.null();
    should(decodeClientHello(utf8Bytes('not json'))).be.null();
    should(decodeClientHello(new Uint8Array([0xff, 0xfe]))).be.null();
  });

  it('should produce a different transcript for every field it covers', async () => {
    const { pending, answered } = await handshake();
    const base = await handshakeTranscriptHash(relayCrypto, sessionId, pending.hello, answered.hello);
    const moved = await handshakeTranscriptHash(
      relayCrypto,
      sessionId,
      { ...pending.hello, nonce: toBase64Url(relayCrypto.randomBytes(32)) },
      answered.hello,
    );
    should(toBase64Url(base)).not.equal(toBase64Url(moved));
  });
});
