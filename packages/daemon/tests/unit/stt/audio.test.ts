import { STT_SAMPLE_RATE } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  decodeRawPcm16le,
  decodeSttAudio,
  decodeWavPcm16le,
  encodeCanonicalWav,
  float32ToPcm16le,
  parseContentType,
  pcm16leToFloat32,
  type SttAudioError,
} from '../../../src/lib/index.ts';

function pcm16(...values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setInt16(index * 2, value, true);
  });
  return bytes;
}

function readPcm16(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

interface WavChunk {
  readonly id: string;
  readonly payload: Uint8Array;
}

function formatChunk(overrides: Partial<Record<string, number>> = {}): WavChunk {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint16(0, overrides.format ?? 1, true);
  view.setUint16(2, overrides.channels ?? 1, true);
  view.setUint32(4, overrides.sampleRate ?? STT_SAMPLE_RATE, true);
  view.setUint32(8, overrides.byteRate ?? STT_SAMPLE_RATE * 2, true);
  view.setUint16(12, overrides.blockAlign ?? 2, true);
  view.setUint16(14, overrides.bitsPerSample ?? 16, true);
  return { id: 'fmt ', payload: payload.subarray(0, overrides.chunkLength ?? 16) };
}

function buildWav(chunks: readonly WavChunk[], options: { readonly riffSize?: number; readonly wave?: string } = {}) {
  const body = chunks.flatMap(chunk => {
    const padded = chunk.payload.byteLength % 2 === 1 ? [0] : [];
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    for (let index = 0; index < 4; index++) header[index] = chunk.id.charCodeAt(index);
    view.setUint32(4, chunk.payload.byteLength, true);
    return [...header, ...chunk.payload, ...padded];
  });
  const bytes = new Uint8Array(12 + body.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) bytes[index] = 'RIFF'.charCodeAt(index);
  view.setUint32(4, options.riffSize ?? bytes.byteLength - 8, true);
  const wave = options.wave ?? 'WAVE';
  for (let index = 0; index < wave.length; index++) bytes[8 + index] = wave.charCodeAt(index);
  bytes.set(body, 12);
  return bytes;
}

const dataChunk = (payload: Uint8Array): WavChunk => ({ id: 'data', payload });

/** Hand-craft a RIFF body byte for byte, for shapes a well-formed writer cannot produce. */
function rawWav(body: readonly number[], riffSize = body.length + 4): Uint8Array {
  const bytes = new Uint8Array(12 + body.length);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) bytes[index] = 'RIFF'.charCodeAt(index);
  view.setUint32(4, riffSize, true);
  for (let index = 0; index < 4; index++) bytes[8 + index] = 'WAVE'.charCodeAt(index);
  bytes.set(body, 12);
  return bytes;
}

const asciiBytes = (value: string): number[] => [...value].map(character => character.charCodeAt(0));

function audioFailure(act: () => unknown): { code: string; message: string } {
  try {
    act();
  } catch (error) {
    const failure = error as SttAudioError;
    return { code: failure.code, message: failure.message };
  }
  throw new Error('expected the decode to reject');
}

describe('PCM16 conversion', () => {
  it('should normalize signed samples against full scale', () => {
    // Arrange
    const bytes = pcm16(0, 16_384, -16_384, -32_768, 32_767);

    // Act
    const actual = Array.from(pcm16leToFloat32(bytes));

    // Assert
    should(actual).deepEqual([0, 0.5, -0.5, -1, 32_767 / 32_768]);
  });

  it('should round-trip every representable sample exactly', () => {
    // Arrange
    const original = pcm16(0, 1, -1, 32_767, -32_768, 12_345, -12_345);

    // Act
    const actual = readPcm16(float32ToPcm16le(pcm16leToFloat32(original)));

    // Assert
    should(actual).deepEqual([0, 1, -1, 32_767, -32_768, 12_345, -12_345]);
  });

  it('should clamp samples outside the normalized range', () => {
    // Act
    const actual = readPcm16(float32ToPcm16le(new Float32Array([2, -2, 1, -1])));

    // Assert
    should(actual).deepEqual([32_767, -32_768, 32_767, -32_768]);
  });

  it('should reject empty, misaligned, non-finite, and over-long audio', () => {
    // Act
    const actual = {
      empty: audioFailure(() => pcm16leToFloat32(new Uint8Array(0))),
      misaligned: audioFailure(() => pcm16leToFloat32(new Uint8Array(3))),
      nonFinite: audioFailure(() => float32ToPcm16le(new Float32Array([Number.NaN]))),
      tooLong: audioFailure(() => pcm16leToFloat32(pcm16(0, 0, 0), 1 / STT_SAMPLE_RATE)),
    };

    // Assert
    should(actual.empty).deepEqual({ code: 'bad_audio', message: 'audio is empty' });
    should(actual.misaligned.code).equal('bad_audio');
    should(actual.nonFinite).deepEqual({ code: 'bad_audio', message: 'samples must be finite' });
    should(actual.tooLong.code).equal('too_long');
  });

  it('should reject a non-positive or non-finite duration limit', () => {
    // Act & Assert
    should(() => pcm16leToFloat32(pcm16(1), 0)).throw(RangeError);
    should(() => pcm16leToFloat32(pcm16(1), Number.POSITIVE_INFINITY)).throw(RangeError);
  });

  it('should report duration and provenance for raw PCM', () => {
    // Act
    const actual = decodeRawPcm16le(pcm16(...new Array(1_600).fill(0)));

    // Assert
    should(actual.durationMs).equal(100);
    should(actual.source).equal('pcm16le');
    should(actual.sampleRate).equal(STT_SAMPLE_RATE);
    should(actual.channels).equal(1);
  });
});

describe('WAV decoding', () => {
  it('should decode a canonical WAV produced by the encoder', () => {
    // Arrange
    const samples = new Float32Array([0, 0.5, -0.5]);

    // Act
    const actual = decodeWavPcm16le(encodeCanonicalWav(samples));

    // Assert
    should(Array.from(actual.samples)).deepEqual([0, 0.5, -0.5]);
    should(actual.source).equal('wav');
  });

  it('should skip unknown chunks and their RIFF padding', () => {
    // Arrange
    const wav = buildWav([
      { id: 'LIST', payload: new Uint8Array([1, 2, 3]) },
      formatChunk(),
      dataChunk(pcm16(1_000, -1_000)),
    ]);

    // Act
    const actual = decodeWavPcm16le(wav);

    // Assert
    should(readPcm16(float32ToPcm16le(actual.samples))).deepEqual([1_000, -1_000]);
  });

  it('should reject every malformed container shape', () => {
    // Arrange
    const cases = {
      short: new Uint8Array(4),
      notRiff: buildWav([formatChunk(), dataChunk(pcm16(1))], { wave: 'WAVX' }),
      riffSize: buildWav([formatChunk(), dataChunk(pcm16(1))], { riffSize: 9_999 }),
      truncatedHeader: rawWav(asciiBytes('ab')),
      overrunChunk: rawWav([...asciiBytes('data'), 0xe8, 0x03, 0x00, 0x00, 1, 2, 3, 4]),
      overrunUnnamedChunk: rawWav([0x20, 0x20, 0x20, 0x20, 0xe8, 0x03, 0x00, 0x00]),
      duplicateFormat: buildWav([formatChunk(), formatChunk(), dataChunk(pcm16(1))]),
      duplicateData: buildWav([formatChunk(), dataChunk(pcm16(1)), dataChunk(pcm16(1))]),
      missingFormat: buildWav([dataChunk(pcm16(1))]),
      missingData: buildWav([formatChunk()]),
      emptyData: buildWav([formatChunk(), dataChunk(new Uint8Array(0))]),
      oddData: buildWav([formatChunk(), dataChunk(new Uint8Array([1]))]),
    };

    // Act
    const actual = Object.fromEntries(
      Object.entries(cases).map(([name, wav]) => [name, audioFailure(() => decodeWavPcm16le(wav)).message]),
    );

    // Assert
    should(actual).deepEqual({
      short: 'WAV header is truncated',
      notRiff: 'audio is not a RIFF/WAVE file',
      riffSize: 'WAV RIFF size does not match the body',
      truncatedHeader: 'WAV chunk header is truncated',
      overrunChunk: 'WAV data chunk exceeds the RIFF body',
      overrunUnnamedChunk: 'WAV unknown chunk exceeds the RIFF body',
      duplicateFormat: 'WAV has more than one format chunk',
      duplicateData: 'WAV has more than one data chunk',
      missingFormat: 'WAV format chunk is missing',
      missingData: 'WAV data chunk is missing',
      emptyData: 'audio is empty',
      oddData: 'WAV data has an incomplete PCM16 sample',
    });
  });

  it('should reject chunk padding that runs past the RIFF body', () => {
    // Arrange — a final odd-length chunk whose pad byte the declared body does not cover
    const wav = buildWav([formatChunk(), dataChunk(pcm16(1)), { id: 'PAD ', payload: new Uint8Array([7]) }]);
    const truncated = wav.subarray(0, wav.byteLength - 1);
    new DataView(truncated.buffer).setUint32(4, truncated.byteLength - 8, true);

    // Act
    const actual = audioFailure(() => decodeWavPcm16le(truncated));

    // Assert
    should(actual.message).equal('WAV chunk padding is truncated');
  });

  it('should reject every unsupported audio format', () => {
    // Arrange
    const cases = {
      shortFormat: formatChunk({ chunkLength: 14 }),
      encoding: formatChunk({ format: 3 }),
      stereo: formatChunk({ channels: 2, blockAlign: 4, byteRate: STT_SAMPLE_RATE * 4 }),
      sampleRate: formatChunk({ sampleRate: 44_100, byteRate: 44_100 * 2 }),
      bitDepth: formatChunk({ bitsPerSample: 8 }),
      blockAlign: formatChunk({ blockAlign: 4 }),
      byteRate: formatChunk({ byteRate: 1 }),
    };

    // Act
    const actual = Object.fromEntries(
      Object.entries(cases).map(([name, chunk]) => [
        name,
        audioFailure(() => decodeWavPcm16le(buildWav([chunk, dataChunk(pcm16(1))]))).message,
      ]),
    );

    // Assert
    should(actual).deepEqual({
      shortFormat: 'WAV format chunk is truncated',
      encoding: 'WAV must use integer PCM encoding',
      stereo: 'WAV must be mono',
      sampleRate: 'WAV sample rate must be 16000 Hz',
      bitDepth: 'WAV samples must be 16-bit',
      blockAlign: 'WAV block alignment is invalid',
      byteRate: 'WAV byte rate is invalid',
    });
  });
});

describe('content-type dispatch', () => {
  it('should parse parameters case-insensitively and strip quotes', () => {
    // Act
    const actual = parseContentType('Audio/L16; Rate="16000"; channels=1; broken');

    // Assert
    should(actual.mime).equal('audio/l16');
    should([...actual.parameters]).deepEqual([
      ['rate', '16000'],
      ['channels', '1'],
    ]);
  });

  it('should decode both WAV media types and both raw PCM media types', () => {
    // Arrange
    const wav = encodeCanonicalWav(new Float32Array([0.25]));
    const raw = pcm16(4_096);

    // Act
    const actual = {
      wav: decodeSttAudio(wav, 'audio/wav').source,
      xWav: decodeSttAudio(wav, 'audio/x-wav').source,
      l16: decodeSttAudio(raw, 'audio/L16; rate=16000; channels=1').source,
      pcm: decodeSttAudio(raw, 'audio/pcm').source,
    };

    // Assert
    should(actual).deepEqual({ wav: 'wav', xWav: 'wav', l16: 'pcm16le', pcm: 'pcm16le' });
  });

  it('should reject mismatched PCM parameters and unknown media types', () => {
    // Arrange
    const raw = pcm16(1);

    // Act
    const actual = {
      rate: audioFailure(() => decodeSttAudio(raw, 'audio/L16; rate=8000')).message,
      channels: audioFailure(() => decodeSttAudio(raw, 'audio/L16; channels=2')).message,
      unknown: audioFailure(() => decodeSttAudio(raw, 'audio/mpeg')).message,
    };

    // Assert
    should(actual.rate).equal('PCM sample rate must be 16000 Hz');
    should(actual.channels).equal('PCM audio must be mono');
    should(actual.unknown).equal('content-type must be audio/wav or audio/L16; rate=16000; channels=1');
  });

  it('should honour a caller-supplied duration limit', () => {
    // Act
    const actual = audioFailure(() => decodeSttAudio(pcm16(...new Array(1_600).fill(0)), 'audio/pcm', 0.05));

    // Assert
    should(actual).deepEqual({ code: 'too_long', message: 'audio exceeds the 0.05 second limit' });
  });
});
