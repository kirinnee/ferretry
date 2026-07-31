import { describe, it } from 'bun:test';
import should from 'should';
import {
  FRAME_ENVELOPE_HEADER_BYTES,
  FRAME_ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  decodeFrameEnvelope,
  encodeFrameEnvelope,
} from '../../../../src/lib/index.ts';

const jpeg = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

function encoded(pageId: string, bytes: Uint8Array): Uint8Array {
  const result = encodeFrameEnvelope(pageId, bytes);
  if (!result.ok) throw new Error(`expected an envelope, got: ${result.message}`);
  return result.value;
}

describe('browser frame envelope', () => {
  it('should round-trip a page id and its JPEG payload', () => {
    // Arrange
    const pixels = jpeg(0xff, 0xd8, 0xff, 0xd9);

    // Act
    const envelope = encoded('page-1', pixels);
    const decoded = decodeFrameEnvelope(envelope);

    // Assert
    should(envelope.byteLength).equal(FRAME_ENVELOPE_HEADER_BYTES + 6 + pixels.byteLength);
    should(String.fromCharCode(...envelope.subarray(0, 4))).equal('FYBF');
    should(envelope[4]).equal(FRAME_ENVELOPE_VERSION);
    should(decoded.ok).be.true();
    should(decoded.ok && decoded.value.pageId).equal('page-1');
    should(decoded.ok && [...decoded.value.jpegBytes]).deepEqual([...pixels]);
  });

  it('should round-trip a multi-byte page id whose character count differs from its byte count', () => {
    // Arrange
    const pageId = 'ページ-😀';

    // Act
    const decoded = decodeFrameEnvelope(encoded(pageId, jpeg(1, 2, 3)));

    // Assert
    should(decoded.ok && decoded.value.pageId).equal(pageId);
  });

  it('should write its length header relative to a pooled buffer offset', () => {
    // Arrange: a view that starts partway into a larger buffer, as a pooled allocation would.
    const pooled = new Uint8Array(new ArrayBuffer(32), 8, 16).fill(7);

    // Act
    const decoded = decodeFrameEnvelope(encoded('p', pooled));

    // Assert
    should(decoded.ok && decoded.value.pageId).equal('p');
    should(decoded.ok && decoded.value.jpegBytes.byteLength).equal(16);
  });

  it('should refuse to encode frames whose identity or payload cannot be trusted', () => {
    // Arrange
    const oversizePageId = 'p'.repeat(129);

    // Act
    const empty = encodeFrameEnvelope('', jpeg(1));
    const longId = encodeFrameEnvelope(oversizePageId, jpeg(1));
    const noPixels = encodeFrameEnvelope('p', jpeg());
    const tooBig = encodeFrameEnvelope('p', new Uint8Array(MAX_FRAME_BYTES + 1));
    const wideId = encodeFrameEnvelope('😀'.repeat(20_000), jpeg(1));

    // Assert
    should(empty).deepEqual({ ok: false, message: 'pageId must not be empty' });
    should(longId).deepEqual({ ok: false, message: 'pageId is too long' });
    should(noPixels).deepEqual({ ok: false, message: 'frame must not be empty' });
    should(tooBig).deepEqual({ ok: false, message: 'frame exceeds the byte ceiling' });
    should(wideId).deepEqual({ ok: false, message: 'pageId is too long' });
  });

  it('should reject envelopes that are truncated, mislabelled, or identity-free', () => {
    // Arrange
    const good = encoded('page-1', jpeg(9, 9));
    const wrongMagic = Uint8Array.from(good);
    wrongMagic[0] = 0x00;
    const wrongVersion = Uint8Array.from(good);
    wrongVersion[4] = 2;
    const noPageId = Uint8Array.from(good);
    noPageId[5] = 0;
    noPageId[6] = 0;
    const noPixels = good.subarray(0, FRAME_ENVELOPE_HEADER_BYTES + 6);
    const invalidUtf8 = Uint8Array.from(good);
    invalidUtf8[FRAME_ENVELOPE_HEADER_BYTES] = 0xff;

    // Act & Assert
    should(decodeFrameEnvelope(good.subarray(0, FRAME_ENVELOPE_HEADER_BYTES))).deepEqual({
      ok: false,
      message: 'envelope is truncated',
    });
    should(decodeFrameEnvelope(wrongMagic)).deepEqual({ ok: false, message: 'envelope magic does not match' });
    should(decodeFrameEnvelope(wrongVersion)).deepEqual({ ok: false, message: 'unsupported envelope version' });
    should(decodeFrameEnvelope(noPageId)).deepEqual({ ok: false, message: 'envelope carries no page id' });
    should(decodeFrameEnvelope(noPixels)).deepEqual({ ok: false, message: 'envelope is truncated' });
    should(decodeFrameEnvelope(invalidUtf8)).deepEqual({ ok: false, message: 'page id is not valid UTF-8' });
  });

  it('should reject a header that claims a page id longer than the ceiling', () => {
    // Arrange: a hand-built envelope whose declared page id exceeds the protocol maximum.
    const pageIdBytes = new TextEncoder().encode('p'.repeat(200));
    const envelope = new Uint8Array(FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes.byteLength + 1);
    envelope.set([0x46, 0x59, 0x42, 0x46], 0);
    envelope[4] = FRAME_ENVELOPE_VERSION;
    new DataView(envelope.buffer).setUint16(5, pageIdBytes.byteLength, false);
    envelope.set(pageIdBytes, FRAME_ENVELOPE_HEADER_BYTES);

    // Act
    const decoded = decodeFrameEnvelope(envelope);

    // Assert
    should(decoded).deepEqual({ ok: false, message: 'pageId is too long' });
  });
});
