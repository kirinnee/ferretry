import { describe, it } from 'bun:test';
import {
  decodeCreditPayload,
  decodeFrame,
  encodeCreditPayload,
  encodeFrame,
  encodeFrameHeader,
  FRAME_HEADER_BYTES,
  FRAME_KINDS,
  isEndToEndKind,
  isRendezvousSessionId,
  MAX_FRAME_BYTES,
  RELAY_CLOSE_CODES,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  sessionIdFromText,
  toBase64Url,
} from '@ferretry/relay';
import should from 'should';

const sessionId = sessionIdFromBytes(new Uint8Array(16).fill(9));
if (sessionId === null) throw new Error('fixture session id is malformed');

function failure(bytes: Uint8Array): { code: number; reason: string } {
  const decoded = decodeFrame(bytes);
  if (decoded.ok) throw new Error('expected the frame to be refused');
  return { code: decoded.code, reason: decoded.reason };
}

describe('relay frames', () => {
  it('should round-trip a frame through its fixed header', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const decoded = decodeFrame(encodeFrame({ kind: FRAME_KINDS.data, sessionId, sequence: 42, payload }));
    should(decoded.ok).be.true();
    if (!decoded.ok) return;
    should(decoded.frame.kind).equal(FRAME_KINDS.data);
    should(decoded.frame.sequence).equal(42);
    should(decoded.frame.sessionId.text).equal(sessionId.text);
    should(decoded.frame.payload).deepEqual(payload);
    should(encodeFrameHeader(FRAME_KINDS.data, sessionId, 42).length).equal(FRAME_HEADER_BYTES);
  });

  it('should name the two kinds that belong to the end-to-end stream', () => {
    should(isEndToEndKind(FRAME_KINDS.handshake)).be.true();
    should(isEndToEndKind(FRAME_KINDS.data)).be.true();
    should(isEndToEndKind(FRAME_KINDS.control)).be.false();
    should(isEndToEndKind(FRAME_KINDS.credit)).be.false();
  });

  it('should recognise the rendezvous-scoped identifier and refuse a wrong-sized one', () => {
    should(isRendezvousSessionId(RENDEZVOUS_SESSION_ID)).be.true();
    should(isRendezvousSessionId(sessionId)).be.false();
    should(sessionIdFromBytes(new Uint8Array(15))).be.null();
    should(sessionIdFromText(toBase64Url(sessionId.bytes))?.text).equal(sessionId.text);
    should(sessionIdFromText('nope')).be.null();
  });

  it('should refuse a frame that is not exactly one', () => {
    const good = encodeFrame({ kind: FRAME_KINDS.data, sessionId, sequence: 1, payload: new Uint8Array(0) });

    should(failure(good.subarray(0, 10)).code).equal(RELAY_CLOSE_CODES.protocolError);
    should(failure(new Uint8Array(MAX_FRAME_BYTES + 1)).code).equal(RELAY_CLOSE_CODES.frameTooLarge);

    const badMagic = Uint8Array.from(good);
    badMagic[0] = 0x00;
    should(failure(badMagic).reason).match(/frame magic/u);

    const badVersion = Uint8Array.from(good);
    badVersion[1] = 0x02;
    should(failure(badVersion).code).equal(RELAY_CLOSE_CODES.versionUnsupported);

    const badKind = Uint8Array.from(good);
    badKind[2] = 0x09;
    should(failure(badKind).reason).match(/unknown frame kind/u);

    const badReserved = Uint8Array.from(good);
    badReserved[3] = 0x01;
    should(failure(badReserved).reason).match(/reserved/u);

    const badSequence = Uint8Array.from(good);
    badSequence.set(new Uint8Array(8).fill(0xff), 20);
    should(failure(badSequence).code).equal(RELAY_CLOSE_CODES.sequenceBroken);
  });

  it('should carry a credit count in four big-endian bytes', () => {
    should(decodeCreditPayload(encodeCreditPayload(70_000))).equal(70_000);
    should(decodeCreditPayload(new Uint8Array(3))).be.null();
  });
});
