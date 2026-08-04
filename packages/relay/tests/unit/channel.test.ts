import { describe, it } from 'bun:test';
import {
  answerClientHandshake,
  type ChannelState,
  completeClientHandshake,
  encodeFrame,
  FRAME_KINDS,
  MAX_FRAME_SEQUENCE,
  MAX_PLAINTEXT_BYTES,
  openChannel,
  openRecord,
  RELAY_CLOSE_CODES,
  sealRecord,
  sessionIdFromBytes,
  type SessionId,
  startClientHandshake,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

function fixtureSessionId(fill: number): SessionId {
  const built = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (built === null) throw new Error('fixture session id is malformed');
  return built;
}

const sessionId = fixtureSessionId(5);

async function keyedPair(): Promise<{ client: ChannelState; daemon: ChannelState }> {
  const identity = await newDaemonIdentity();
  const pending = await startClientHandshake(relayCrypto, sessionId, identity.daemonId);
  const answered = await answerClientHandshake(relayCrypto, identity, sessionId, pending.hello);
  if (!answered.ok) throw new Error('fixture handshake failed');
  const completed = await completeClientHandshake(relayCrypto, pending, answered.hello);
  if (!completed.ok) throw new Error('fixture handshake failed');
  return {
    client: openChannel(sessionId, completed.keys, 'client'),
    daemon: openChannel(sessionId, answered.keys, 'daemon'),
  };
}

describe('record layer', () => {
  it('should carry records in both directions, in order', async () => {
    let { client, daemon } = await keyedPair();
    for (const message of ['first', 'second', 'third']) {
      const sealed = await sealRecord(relayCrypto, client, utf8Bytes(message));
      should(sealed.ok).be.true();
      if (!sealed.ok) return;
      client = sealed.state;

      const opened = await openRecord(relayCrypto, daemon, sealed.frame);
      should(opened.ok).be.true();
      if (!opened.ok) return;
      daemon = opened.state;
      should(utf8Text(opened.plaintext)).equal(message);
    }

    const back = await sealRecord(relayCrypto, daemon, utf8Bytes('reply'));
    should(back.ok).be.true();
    if (!back.ok) return;
    const heard = await openRecord(relayCrypto, client, back.frame);
    should(heard.ok).be.true();
    if (heard.ok) should(utf8Text(heard.plaintext)).equal('reply');
  });

  it('should keep the two directions on separate keys, so a record cannot be reflected', async () => {
    const { client, daemon } = await keyedPair();
    const sealed = await sealRecord(relayCrypto, client, utf8Bytes('hello'));
    if (!sealed.ok) return;
    const reflected = await openRecord(relayCrypto, sealed.state, sealed.frame);
    should(reflected.ok).be.false();
    if (!reflected.ok) should(reflected.code).equal(RELAY_CLOSE_CODES.frameForged);
    should(daemon.receiveKey).deepEqual(client.sendKey);
  });

  it('should refuse a record whose header was altered on the way', async () => {
    const { client, daemon } = await keyedPair();
    const sealed = await sealRecord(relayCrypto, client, utf8Bytes('hello'));
    if (!sealed.ok) return;
    const restamped = { ...sealed.frame, sequence: daemon.receiveSequence, payload: sealed.frame.payload.slice() };
    restamped.payload[0] = (restamped.payload[0] ?? 0) ^ 0xff;
    const opened = await openRecord(relayCrypto, daemon, restamped);
    should(opened.ok).be.false();
    if (!opened.ok) should(opened.code).equal(RELAY_CLOSE_CODES.frameForged);
  });

  it('should end the session on a gap rather than accept the frame after it', async () => {
    const { client, daemon } = await keyedPair();
    const first = await sealRecord(relayCrypto, client, utf8Bytes('one'));
    if (!first.ok) return;
    const second = await sealRecord(relayCrypto, first.state, utf8Bytes('two'));
    if (!second.ok) return;

    const skipped = await openRecord(relayCrypto, daemon, second.frame);
    should(skipped.ok).be.false();
    if (!skipped.ok) {
      should(skipped.code).equal(RELAY_CLOSE_CODES.sequenceBroken);
      should(skipped.reason).match(/not the next one/u);
    }
  });

  it('should refuse a frame that is not a record, or belongs to another session', async () => {
    const { daemon } = await keyedPair();
    const other = fixtureSessionId(6);

    const wrongKind = await openRecord(relayCrypto, daemon, {
      kind: FRAME_KINDS.handshake,
      sessionId,
      sequence: 1,
      payload: new Uint8Array(0),
    });
    should(wrongKind.ok).be.false();
    if (!wrongKind.ok) should(wrongKind.reason).match(/not a record/u);

    const wrongSession = await openRecord(relayCrypto, daemon, {
      kind: FRAME_KINDS.data,
      sessionId: other,
      sequence: 1,
      payload: new Uint8Array(0),
    });
    should(wrongSession.ok).be.false();
    if (!wrongSession.ok) should(wrongSession.reason).match(/another session/u);
  });

  it('should refuse a payload larger than one record, and a sequence space it has exhausted', async () => {
    const { client } = await keyedPair();
    const oversize = await sealRecord(relayCrypto, client, new Uint8Array(MAX_PLAINTEXT_BYTES + 1));
    should(oversize.ok).be.false();
    if (!oversize.ok) should(oversize.code).equal(RELAY_CLOSE_CODES.frameTooLarge);

    const exhausted = await sealRecord(
      relayCrypto,
      { ...client, sendSequence: MAX_FRAME_SEQUENCE + 1 },
      utf8Bytes('too late'),
    );
    should(exhausted.ok).be.false();
    if (!exhausted.ok) should(exhausted.code).equal(RELAY_CLOSE_CODES.sequenceBroken);
  });

  it('should produce a frame a carrier can route without reading', async () => {
    const { client } = await keyedPair();
    const sealed = await sealRecord(relayCrypto, client, utf8Bytes('a secret worth keeping'));
    if (!sealed.ok) return;
    const wire = encodeFrame(sealed.frame);
    should(utf8Text(wire.subarray(28))).not.match(/secret/u);
    should(wire.subarray(4, 20)).deepEqual(sessionId.bytes);
  });
});
