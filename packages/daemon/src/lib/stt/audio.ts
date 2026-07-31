import { STT_BITS_PER_SAMPLE, STT_CHANNELS, STT_MAX_DURATION_SECONDS, STT_SAMPLE_RATE } from '@ferretry/protocol';
import { SttAudioError } from './errors.ts';

const BYTES_PER_SAMPLE = STT_BITS_PER_SAMPLE / 8;
const FULL_SCALE = 32_768;
const MAX_PCM16 = 32_767;
const MIN_PCM16 = -32_768;
const CANONICAL_WAV_HEADER_BYTES = 44;

export interface DecodedSttAudio {
  readonly samples: Float32Array;
  readonly sampleRate: typeof STT_SAMPLE_RATE;
  readonly channels: typeof STT_CHANNELS;
  readonly durationMs: number;
  readonly source: 'pcm16le' | 'wav';
}

function badAudio(message: string): never {
  throw new SttAudioError('bad_audio', message);
}

function assertDuration(sampleCount: number, maxDurationSeconds: number): void {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new RangeError('maxDurationSeconds must be a positive finite number');
  }
  if (sampleCount > Math.floor(maxDurationSeconds * STT_SAMPLE_RATE)) {
    throw new SttAudioError('too_long', `audio exceeds the ${maxDurationSeconds} second limit`);
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = offset; index < offset + length; index++) value += String.fromCharCode(bytes[index] ?? 0);
  return value;
}

function decoded(samples: Float32Array, source: DecodedSttAudio['source']): DecodedSttAudio {
  return {
    samples,
    sampleRate: STT_SAMPLE_RATE,
    channels: STT_CHANNELS,
    durationMs: (samples.length / STT_SAMPLE_RATE) * 1_000,
    source,
  };
}

/** Convert signed little-endian 16-bit PCM into the normalized samples the recognizer wants. */
export function pcm16leToFloat32(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): Float32Array {
  if (bytes.byteLength === 0) badAudio('audio is empty');
  if (bytes.byteLength % BYTES_PER_SAMPLE !== 0) badAudio('PCM16 audio has an incomplete sample');

  const sampleCount = bytes.byteLength / BYTES_PER_SAMPLE;
  assertDuration(sampleCount, maxDurationSeconds);
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    samples[index] = input.getInt16(index * BYTES_PER_SAMPLE, true) / FULL_SCALE;
  }
  return samples;
}

/**
 * Encode normalized samples as little-endian signed PCM16.
 *
 * Both directions scale by 32768 and the positive side is clamped, so
 * `pcm16leToFloat32` and this function round-trip every sample exactly. The
 * asymmetric encoder this replaces scaled positives by 32767 and lost one step
 * of amplitude on every non-zero positive sample.
 */
export function float32ToPcm16le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const output = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index] ?? 0;
    if (!Number.isFinite(value)) badAudio('samples must be finite');
    const scaled = Math.round(Math.max(-1, Math.min(1, value)) * FULL_SCALE);
    output.setInt16(index * BYTES_PER_SAMPLE, Math.max(MIN_PCM16, Math.min(MAX_PCM16, scaled)), true);
  }
  return bytes;
}

export function decodeRawPcm16le(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): DecodedSttAudio {
  return decoded(pcm16leToFloat32(bytes, maxDurationSeconds), 'pcm16le');
}

interface WavBody {
  readonly dataOffset: number;
  readonly dataLength: number;
}

function scanWavChunks(bytes: Uint8Array, view: DataView, riffEnd: number): WavBody {
  let offset = 12;
  let formatSeen = false;
  let dataOffset = -1;
  let dataLength = -1;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) badAudio('WAV chunk header is truncated');
    const chunkId = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkLength;
    if (payloadEnd > riffEnd) badAudio(`WAV ${chunkId.trim() || 'unknown'} chunk exceeds the RIFF body`);

    if (chunkId === 'fmt ') {
      if (formatSeen) badAudio('WAV has more than one format chunk');
      assertWavFormat(view, payloadOffset, chunkLength);
      formatSeen = true;
    } else if (chunkId === 'data') {
      if (dataOffset !== -1) badAudio('WAV has more than one data chunk');
      dataOffset = payloadOffset;
      dataLength = chunkLength;
    }

    const paddedEnd = payloadEnd + (chunkLength % 2);
    if (paddedEnd > riffEnd) badAudio('WAV chunk padding is truncated');
    offset = paddedEnd;
  }

  if (!formatSeen) badAudio('WAV format chunk is missing');
  if (dataOffset === -1) badAudio('WAV data chunk is missing');
  return { dataOffset, dataLength };
}

function assertWavFormat(view: DataView, payloadOffset: number, chunkLength: number): void {
  if (chunkLength < 16) badAudio('WAV format chunk is truncated');
  const format = view.getUint16(payloadOffset, true);
  const channels = view.getUint16(payloadOffset + 2, true);
  const sampleRate = view.getUint32(payloadOffset + 4, true);
  const byteRate = view.getUint32(payloadOffset + 8, true);
  const blockAlign = view.getUint16(payloadOffset + 12, true);
  const bitsPerSample = view.getUint16(payloadOffset + 14, true);
  if (format !== 1) badAudio('WAV must use integer PCM encoding');
  if (channels !== STT_CHANNELS) badAudio('WAV must be mono');
  if (sampleRate !== STT_SAMPLE_RATE) badAudio(`WAV sample rate must be ${STT_SAMPLE_RATE} Hz`);
  if (bitsPerSample !== STT_BITS_PER_SAMPLE) badAudio(`WAV samples must be ${STT_BITS_PER_SAMPLE}-bit`);
  if (blockAlign !== STT_CHANNELS * BYTES_PER_SAMPLE) badAudio('WAV block alignment is invalid');
  if (byteRate !== STT_SAMPLE_RATE * blockAlign) badAudio('WAV byte rate is invalid');
}

/**
 * Parse RIFF/WAVE PCM. Unknown chunks and their RIFF padding are accepted, but
 * the audio format itself is intentionally narrow: PCM16LE, mono, 16 kHz.
 */
export function decodeWavPcm16le(bytes: Uint8Array, maxDurationSeconds = STT_MAX_DURATION_SECONDS): DecodedSttAudio {
  if (bytes.byteLength < 12) badAudio('WAV header is truncated');
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') badAudio('audio is not a RIFF/WAVE file');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== bytes.byteLength) badAudio('WAV RIFF size does not match the body');

  const { dataOffset, dataLength } = scanWavChunks(bytes, view, riffEnd);
  if (dataLength === 0) badAudio('audio is empty');
  if (dataLength % BYTES_PER_SAMPLE !== 0) badAudio('WAV data has an incomplete PCM16 sample');

  return decoded(pcm16leToFloat32(bytes.subarray(dataOffset, dataOffset + dataLength), maxDurationSeconds), 'wav');
}

export interface ParsedContentType {
  readonly mime: string;
  readonly parameters: ReadonlyMap<string, string>;
}

export function parseContentType(contentType: string): ParsedContentType {
  const [rawMime, ...rawParameters] = contentType.split(';');
  const parameters = new Map<string, string>();
  for (const raw of rawParameters) {
    const separator = raw.indexOf('=');
    if (separator === -1) continue;
    const name = raw.slice(0, separator).trim().toLowerCase();
    const value = raw
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/gu, '');
    parameters.set(name, value);
  }
  return { mime: rawMime?.trim().toLowerCase() ?? '', parameters };
}

export function decodeSttAudio(
  bytes: Uint8Array,
  contentType: string,
  maxDurationSeconds = STT_MAX_DURATION_SECONDS,
): DecodedSttAudio {
  const { mime, parameters } = parseContentType(contentType);
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return decodeWavPcm16le(bytes, maxDurationSeconds);
  if (mime === 'audio/l16' || mime === 'audio/pcm') {
    const rate = parameters.get('rate');
    const channels = parameters.get('channels');
    if (rate !== undefined && rate !== String(STT_SAMPLE_RATE)) {
      badAudio(`PCM sample rate must be ${STT_SAMPLE_RATE} Hz`);
    }
    if (channels !== undefined && channels !== String(STT_CHANNELS)) badAudio('PCM audio must be mono');
    return decodeRawPcm16le(bytes, maxDurationSeconds);
  }
  badAudio(`content-type must be audio/wav or audio/L16; rate=${STT_SAMPLE_RATE}; channels=${STT_CHANNELS}`);
}

/** Produce a canonical 44-byte-header WAV, used by tests and by audio round-tripping. */
export function encodeCanonicalWav(samples: Float32Array): Uint8Array {
  const pcm = float32ToPcm16le(samples);
  const bytes = new Uint8Array(CANONICAL_WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, STT_CHANNELS, true);
  view.setUint32(24, STT_SAMPLE_RATE, true);
  view.setUint32(28, STT_SAMPLE_RATE * STT_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, STT_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, STT_BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, CANONICAL_WAV_HEADER_BYTES);
  return bytes;
}
