import { describe, it } from 'bun:test';
import should from 'should';
import {
  concatFloat32,
  durationSeconds,
  encodeWav,
  floatToPcm16,
  MAX_UTTERANCE_SECONDS,
  MIN_UTTERANCE_SECONDS,
  pcm16ToFloat,
  resample,
  TARGET_SAMPLE_RATE,
} from '../../../src/lib/stt/pcm.ts';

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  [...bytes.slice(offset, offset + length)].map(byte => String.fromCharCode(byte)).join('');

describe('floatToPcm16', () => {
  it('uses the asymmetric Int16 scale, so a full-scale peak does not wrap to a click', () => {
    const pcm = floatToPcm16(new Float32Array([1, -1, 0]));
    should([...pcm]).deepEqual([32_767, -32_768, 0]);
  });

  it('clamps anything the graph pushed out of range', () => {
    const pcm = floatToPcm16(new Float32Array([4, -4]));
    should([...pcm]).deepEqual([32_767, -32_768]);
  });
});

describe('pcm16ToFloat', () => {
  it('round-trips the rails back to unity', () => {
    should([...pcm16ToFloat(new Int16Array([32_767, -32_768, 0]))]).deepEqual([1, -1, 0]);
  });
});

describe('concatFloat32', () => {
  it('joins the chunks in order', () => {
    const joined = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    should([...joined]).deepEqual([1, 2, 3]);
  });

  it('answers an empty buffer for no chunks', () => {
    should(concatFloat32([]).length).equal(0);
  });
});

describe('resample', () => {
  it('box-averages on the way down, so aliasing does not fold into the speech band', () => {
    const out = resample(new Float32Array([0, 1, 0, 1, 0, 1]), 48_000, 16_000);
    should(out.length).equal(2);
    should(out[0]).be.approximately(1 / 3, 1e-6);
  });

  it('interpolates linearly on the way up', () => {
    const out = resample(new Float32Array([0, 1]), 8_000, 16_000);
    should([...out]).deepEqual([0, 0.5, 1, 1]);
  });

  it('returns the input untouched when there is nothing to do', () => {
    const input = new Float32Array([0.5]);
    should(resample(input, 16_000, 16_000)).equal(input);
    should(resample(new Float32Array(0), 48_000, 16_000).length).equal(0);
  });

  it('refuses a nonsensical rate rather than producing nonsense samples', () => {
    const input = new Float32Array([0.5]);
    should(resample(input, 0, 16_000)).equal(input);
    should(resample(input, 48_000, Number.NaN)).equal(input);
    should(resample(input, Number.POSITIVE_INFINITY, 16_000)).equal(input);
    should(resample(input, 48_000, -1)).equal(input);
  });

  it('falls back to the nearest sample when a downsampled span is empty', () => {
    // A ratio just above 1 leaves some output spans with no input frames.
    const out = resample(new Float32Array([0.25, 0.75, 0.5, 1]), 1_000, 999);
    should(out.length).equal(3);
    should([...out].every(Number.isFinite)).be.true();
  });
});

describe('encodeWav', () => {
  it('writes a canonical 44-byte mono header around the samples', () => {
    const bytes = encodeWav(new Int16Array([1, -1]), 16_000);

    should(bytes.length).equal(48);
    should(ascii(bytes, 0, 4)).equal('RIFF');
    should(ascii(bytes, 8, 4)).equal('WAVE');
    should(ascii(bytes, 12, 4)).equal('fmt ');
    should(ascii(bytes, 36, 4)).equal('data');

    const view = new DataView(bytes.buffer);
    should(view.getUint32(4, true)).equal(40);
    should(view.getUint16(22, true)).equal(1);
    should(view.getUint32(24, true)).equal(16_000);
    should(view.getUint32(28, true)).equal(32_000);
    should(view.getUint32(40, true)).equal(4);
    should(view.getInt16(44, true)).equal(1);
    should(view.getInt16(46, true)).equal(-1);
  });
});

describe('durationSeconds', () => {
  it('measures at the target rate by default', () => {
    should(durationSeconds(new Float32Array(8_000))).equal(0.5);
  });

  it('honours an explicit rate', () => {
    should(durationSeconds(new Float32Array(48_000), 48_000)).equal(1);
  });

  it('answers zero rather than infinity for an impossible rate', () => {
    should(durationSeconds(new Float32Array(10), 0)).equal(0);
  });
});

describe('capture limits', () => {
  it('keeps one utterance to a sane POST body and rejects a button bounce', () => {
    should(TARGET_SAMPLE_RATE).equal(16_000);
    should(MAX_UTTERANCE_SECONDS * TARGET_SAMPLE_RATE * 2).be.below(4_000_000);
    should(MIN_UTTERANCE_SECONDS).be.below(1);
  });
});
