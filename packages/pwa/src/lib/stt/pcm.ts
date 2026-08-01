/**
 * The pure sample maths behind microphone capture.
 *
 * kteam kept these beside the imperative recorder in `ui/src/lib/stt/audio-capture.ts:30-166`.
 * They are separated here because everything in this subsystem that CAN be a
 * pure function is one: the segmenter, the local engine and the utterance
 * lifecycle all need sample arithmetic, and none of them should have to import
 * a module that opens a microphone to get it.
 *
 * Nothing in this file touches a browser API.
 */

/** What the model wants, in both engines. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Hard ceiling on one utterance. 120 s of 16 kHz mono PCM16 is 3.84 MB — a
 * sane POST body, and far longer than anyone dictates into a chat box. Capture
 * stops itself at the limit rather than growing without bound.
 */
export const MAX_UTTERANCE_SECONDS = 120;

/**
 * Below this an "utterance" is a button bounce, not speech. Returned to the
 * caller as an empty result so it can stay silent instead of showing an
 * error for a mis-tap.
 */
export const MIN_UTTERANCE_SECONDS = 0.25;

/**
 * Backstop for the worklet's flush acknowledgement.
 *
 * The acknowledgement normally arrives within one render quantum (~3 ms at
 * 48 kHz). This exists only so a worklet that has already crashed cannot hang
 * `stop()` forever — it is not the mechanism, and anything that relies on it
 * firing has already lost the tail of the utterance.
 */
export const FLUSH_TIMEOUT_MS = 250;

/**
 * Float32 [-1, 1] → PCM16LE.
 *
 * The asymmetric scale (32767 up, 32768 down) is the correct one: the Int16
 * range is not symmetric, and using 32768 in both directions clips every
 * full-scale positive sample to -32768 — a loud click at the peak of the
 * loudest word.
 */
export const floatToPcm16 = (input: Float32Array): Int16Array => {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] as number;
    const clamped = Math.min(1, Math.max(-1, sample));
    out[i] = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
  }
  return out;
};

/** PCM16LE → Float32 [-1, 1]. */
export const pcm16ToFloat = (input: Int16Array): Float32Array => {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] as number;
    out[i] = sample < 0 ? sample / 32_768 : sample / 32_767;
  }
  return out;
};

export const concatFloat32 = (chunks: readonly Float32Array[]): Float32Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/**
 * Resample to `to` Hz.
 *
 * Downsampling uses a BOX AVERAGE over each output sample's input span, not
 * nearest-neighbour decimation. Decimating 48 kHz to 16 kHz by taking every
 * third sample folds everything above 8 kHz back down into the speech band as
 * audible hiss, and an ASR model hears that as noise. A box filter is a crude
 * low-pass, but it is a low-pass, and it costs one pass over the samples.
 *
 * Upsampling (a context that runs BELOW 16 kHz — rare, but some mobile
 * hardware does) is linear interpolation: there is no detail to recover, so
 * anything cleverer would be theatre.
 */
export const resample = (input: Float32Array, from: number, to: number): Float32Array => {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return input;
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(length);

  if (ratio > 1) {
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j += 1) {
        sum += input[j] as number;
        count += 1;
      }
      out[i] = count === 0 ? (input[Math.min(start, input.length - 1)] as number) : sum / count;
    }
    return out;
  }

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const low = Math.floor(position);
    const high = Math.min(input.length - 1, low + 1);
    const fraction = position - low;
    out[i] = (input[low] as number) * (1 - fraction) + (input[high] as number) * fraction;
  }
  return out;
};

/**
 * Canonical 44-byte-header mono WAV around PCM16LE samples.
 *
 * The daemon accepts raw `audio/L16` too, but WAV is what survives being
 * saved, replayed or handed to a debugging tool without anyone having to
 * remember the sample rate — and 44 bytes is not a size argument.
 */
export const encodeWav = (pcm: Int16Array, sampleRate: number): Uint8Array => {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i] as number, true);
  return bytes;
};

/** Seconds of audio in a 16 kHz mono buffer. */
export const durationSeconds = (samples: Float32Array, sampleRate: number = TARGET_SAMPLE_RATE): number =>
  sampleRate > 0 ? samples.length / sampleRate : 0;
