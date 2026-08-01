/**
 * Silence-aligned segmentation for browser-local dictation.
 *
 * Parakeet is an offline (whole-buffer) recogniser. Feeding it arbitrary
 * clock-sized windows is unsafe: the measured fixed-window experiment returned
 * an empty transcript for roughly one voiced window in three, deterministically.
 * This segmenter therefore has one non-negotiable rule: IT NEVER CUTS ON THE
 * CLOCK ALONE. A normal segment ends after a real pause; a long continuous
 * phrase may end near the soft limit only after a sustained low-energy boundary.
 * That keeps phonemes on one side of a seam and removes the need for overlap or
 * fuzzy de-duplication (both of which made the measured failures worse).
 *
 * The implementation is deliberately model-free and browser-free. It consumes
 * the exact Float32 PCM copied out of audio capture, works in fixed-duration
 * frames, and returns complete buffers. That makes every boundary decision
 * deterministic and testable without a microphone or a DOM.
 */

import { concatFloat32 } from './pcm.ts';

export type SpeechSegmentReason = 'silence' | 'soft-limit' | 'flush';

export interface SpeechSegment {
  readonly id: number;
  readonly samples: Float32Array;
  /**
   * Position in the original capture, before any long held silence is
   * trimmed. Useful for measurements and diagnostics; not model input.
   */
  readonly startSample: number;
  readonly endSample: number;
  readonly voicedMs: number;
  readonly durationMs: number;
  readonly reason: SpeechSegmentReason;
}

export interface SilenceSegmenterOptions {
  readonly sampleRate: number;
  /**
   * Analysis frame. 20 ms is short enough to find a word gap without making
   * the energy estimate twitchy.
   */
  readonly frameMs?: number;
  /** Audio retained before confirmed voice onset. */
  readonly preRollMs?: number;
  /** Consecutive voice required before opening an utterance. */
  readonly startVoiceMs?: number;
  /** A normal pause that closes an utterance. */
  readonly endSilenceMs?: number;
  /** Do not send coughs, taps, or a clipped syllable to the model. */
  readonly minVoicedMs?: number;
  /** Aim to produce feedback by this point, but only at a quiet boundary. */
  readonly softMaxMs?: number;
  /** Minimum quiet boundary allowed to close a phrase at the soft limit. */
  readonly softCutSilenceMs?: number;
  /** Absolute voice floor after browser echo/noise suppression. */
  readonly speechRms?: number;
  /** Hysteresis: once speech is active, quieter consonants still count. */
  readonly continuingSpeechRms?: number;
  /**
   * Ambient noise raises the threshold rather than making the recorder stay
   * permanently voiced.
   */
  readonly noiseMultiplier?: number;
}

export const DEFAULT_SEGMENTER_OPTIONS = Object.freeze({
  frameMs: 20,
  preRollMs: 180,
  startVoiceMs: 80,
  // Measured at 240 ms: 0/7 browser-local segments empty while removing the
  // 10.16 s latency outlier produced by the earlier 480 ms hangover.
  endSilenceMs: 240,
  minVoicedMs: 360,
  softMaxMs: 5_000,
  softCutSilenceMs: 120,
  speechRms: 0.006,
  continuingSpeechRms: 0.004,
  noiseMultiplier: 2.8,
});

/** The idle noise floor a fresh capture starts from, before any frame is seen. */
const INITIAL_NOISE_FLOOR_RMS = 0.0015;

interface BufferedFrame {
  readonly samples: Float32Array;
  readonly startSample: number;
  readonly rms: number;
  readonly voiced: boolean;
}

const finitePositive = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const millisecondsToSamples = (ms: number, sampleRate: number): number =>
  Math.max(1, Math.round((ms / 1_000) * sampleRate));

/**
 * Root-mean-square energy for one PCM frame. Exported so fixture harnesses can
 * report the exact same quantity the boundary detector used.
 */
export const frameRms = (samples: Float32Array): number => {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] as number;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
};

/**
 * Stateful, single-capture segmenter. `push` and `flush` may each return more
 * than one segment because a worklet message is allowed to contain any number
 * of analysis frames. `flush` is terminal; later samples are ignored.
 */
export class SilenceSegmenter {
  readonly sampleRate: number;
  readonly frameSamples: number;

  readonly #preRollSamples: number;
  readonly #startVoiceSamples: number;
  readonly #endSilenceSamples: number;
  readonly #minVoicedSamples: number;
  readonly #softMaxSamples: number;
  readonly #softCutSilenceSamples: number;
  readonly #speechRms: number;
  readonly #continuingSpeechRms: number;
  readonly #noiseMultiplier: number;

  #remainder = new Float32Array(0);
  #idleFrames: BufferedFrame[] = [];
  #idleSamples = 0;
  #voiceRunSamples = 0;
  #activeFrames: BufferedFrame[] = [];
  #activeSamples = 0;
  #activeVoicedSamples = 0;
  #trailingSilenceSamples = 0;
  #processedSamples = 0;
  #nextId = 0;
  #noiseFloorRms = INITIAL_NOISE_FLOOR_RMS;
  #closed = false;

  constructor(options: SilenceSegmenterOptions) {
    this.sampleRate = finitePositive(options.sampleRate, 16_000);
    const frameMs = finitePositive(options.frameMs, DEFAULT_SEGMENTER_OPTIONS.frameMs);
    this.frameSamples = millisecondsToSamples(frameMs, this.sampleRate);
    this.#preRollSamples = millisecondsToSamples(
      finitePositive(options.preRollMs, DEFAULT_SEGMENTER_OPTIONS.preRollMs),
      this.sampleRate,
    );
    this.#startVoiceSamples = millisecondsToSamples(
      finitePositive(options.startVoiceMs, DEFAULT_SEGMENTER_OPTIONS.startVoiceMs),
      this.sampleRate,
    );
    this.#endSilenceSamples = millisecondsToSamples(
      finitePositive(options.endSilenceMs, DEFAULT_SEGMENTER_OPTIONS.endSilenceMs),
      this.sampleRate,
    );
    this.#minVoicedSamples = millisecondsToSamples(
      finitePositive(options.minVoicedMs, DEFAULT_SEGMENTER_OPTIONS.minVoicedMs),
      this.sampleRate,
    );
    this.#softMaxSamples = millisecondsToSamples(
      finitePositive(options.softMaxMs, DEFAULT_SEGMENTER_OPTIONS.softMaxMs),
      this.sampleRate,
    );
    this.#softCutSilenceSamples = millisecondsToSamples(
      finitePositive(options.softCutSilenceMs, DEFAULT_SEGMENTER_OPTIONS.softCutSilenceMs),
      this.sampleRate,
    );
    this.#speechRms = finitePositive(options.speechRms, DEFAULT_SEGMENTER_OPTIONS.speechRms);
    this.#continuingSpeechRms = finitePositive(
      options.continuingSpeechRms,
      DEFAULT_SEGMENTER_OPTIONS.continuingSpeechRms,
    );
    this.#noiseMultiplier = finitePositive(options.noiseMultiplier, DEFAULT_SEGMENTER_OPTIONS.noiseMultiplier);
  }

  get bufferedDurationMs(): number {
    return ((this.#activeSamples + this.#idleSamples + this.#remainder.length) / this.sampleRate) * 1_000;
  }

  push(samples: Float32Array): readonly SpeechSegment[] {
    if (this.#closed || samples.length === 0) return [];
    const combined = new Float32Array(this.#remainder.length + samples.length);
    combined.set(this.#remainder, 0);
    combined.set(samples, this.#remainder.length);

    const segments: SpeechSegment[] = [];
    let offset = 0;
    while (combined.length - offset >= this.frameSamples) {
      segments.push(...this.#processFrame(combined.slice(offset, offset + this.frameSamples)));
      offset += this.frameSamples;
    }
    this.#remainder = combined.slice(offset);
    return segments;
  }

  /**
   * Consume the final partial worklet frame and emit one final utterance when
   * it contains the minimum amount of voice. Calling twice is a no-op.
   */
  flush(): readonly SpeechSegment[] {
    if (this.#closed) return [];
    const segments: SpeechSegment[] = [];
    if (this.#remainder.length > 0) {
      const tail = this.#remainder;
      this.#remainder = new Float32Array(0);
      segments.push(...this.#processFrame(tail));
    }
    if (this.#activeFrames.length > 0 && this.#activeVoicedSamples >= this.#minVoicedSamples) {
      segments.push(this.#emit('flush'));
    }
    this.#closed = true;
    this.#discardBuffers();
    return segments;
  }

  /**
   * Throw away buffered audio. A cancelled/backgrounded capture must not let
   * a later local decode publish a fragment from the abandoned generation.
   */
  reset(): void {
    this.#remainder = new Float32Array(0);
    this.#discardBuffers();
    this.#processedSamples = 0;
    this.#nextId = 0;
    this.#noiseFloorRms = INITIAL_NOISE_FLOOR_RMS;
    this.#closed = false;
  }

  #processFrame(samples: Float32Array): readonly SpeechSegment[] {
    const startSample = this.#processedSamples;
    this.#processedSamples += samples.length;
    const rms = frameRms(samples);

    if (this.#activeFrames.length === 0) return this.#processIdleFrame(samples, startSample, rms);

    const threshold = Math.max(this.#continuingSpeechRms, this.#noiseFloorRms * (this.#noiseMultiplier * 0.65));
    const voiced = rms >= threshold;

    // A sub-minimum sound is held for the next phrase instead of sent as a
    // fragment. Once its closing silence is long enough, retain only that
    // hangover rather than buffering an arbitrary quiet gap.
    const holdingShortSilence =
      !voiced &&
      this.#activeVoicedSamples < this.#minVoicedSamples &&
      this.#trailingSilenceSamples >= this.#endSilenceSamples;
    if (!holdingShortSilence) {
      this.#activeFrames.push({ samples, startSample, rms, voiced });
      this.#activeSamples += samples.length;
    }

    if (voiced) {
      this.#activeVoicedSamples += samples.length;
      this.#trailingSilenceSamples = 0;
    } else {
      this.#trailingSilenceSamples += samples.length;
    }

    if (
      this.#activeVoicedSamples >= this.#minVoicedSamples &&
      this.#trailingSilenceSamples >= this.#endSilenceSamples
    ) {
      return [this.#emit('silence')];
    }
    if (
      this.#activeVoicedSamples >= this.#minVoicedSamples &&
      this.#activeSamples >= this.#softMaxSamples &&
      this.#trailingSilenceSamples >= this.#softCutSilenceSamples
    ) {
      return [this.#emit('soft-limit')];
    }
    return [];
  }

  #processIdleFrame(samples: Float32Array, startSample: number, rms: number): readonly SpeechSegment[] {
    const threshold = Math.max(this.#speechRms, this.#noiseFloorRms * this.#noiseMultiplier);
    const voiced = rms >= threshold;
    if (!voiced) {
      // Slow enough not to chase a word, fast enough to follow a fan or a
      // phone moving between rooms while idle.
      this.#noiseFloorRms = this.#noiseFloorRms * 0.94 + rms * 0.06;
    }
    this.#idleFrames.push({ samples, startSample, rms, voiced });
    this.#idleSamples += samples.length;
    this.#trimIdleFrames();
    this.#voiceRunSamples = voiced ? this.#voiceRunSamples + samples.length : 0;
    if (this.#voiceRunSamples < this.#startVoiceSamples) return [];

    // The onset is confirmed. Move the whole pre-roll (not just the loud
    // frames) into the utterance so initial consonants never disappear.
    this.#activeFrames = this.#idleFrames;
    this.#activeSamples = this.#idleSamples;
    this.#activeVoicedSamples = this.#activeFrames.reduce(
      (total, buffered) => total + (buffered.voiced ? buffered.samples.length : 0),
      0,
    );
    this.#trailingSilenceSamples = 0;
    this.#idleFrames = [];
    this.#idleSamples = 0;
    this.#voiceRunSamples = 0;
    return [];
  }

  /** Only ever called with a non-empty active buffer; the fallbacks keep that
   *  precondition from becoming a crash if a future edit breaks it. */
  #emit(reason: SpeechSegmentReason): SpeechSegment {
    const first = this.#activeFrames[0];
    const last = this.#activeFrames.at(-1);
    const samples = concatFloat32(this.#activeFrames.map(frame => frame.samples));
    const startSample = first?.startSample ?? this.#processedSamples;
    const segment: SpeechSegment = {
      id: this.#nextId,
      samples,
      startSample,
      endSample: last === undefined ? startSample : last.startSample + last.samples.length,
      voicedMs: (this.#activeVoicedSamples / this.sampleRate) * 1_000,
      durationMs: (samples.length / this.sampleRate) * 1_000,
      reason,
    };
    this.#nextId += 1;
    this.#activeFrames = [];
    this.#activeSamples = 0;
    this.#activeVoicedSamples = 0;
    this.#trailingSilenceSamples = 0;
    this.#voiceRunSamples = 0;
    return segment;
  }

  #trimIdleFrames(): void {
    while (this.#idleFrames.length > 1 && this.#idleSamples > this.#preRollSamples) {
      const first = this.#idleFrames[0];
      if (first === undefined || this.#idleSamples - first.samples.length < this.#preRollSamples) break;
      this.#idleFrames.shift();
      this.#idleSamples -= first.samples.length;
    }
  }

  #discardBuffers(): void {
    this.#idleFrames = [];
    this.#idleSamples = 0;
    this.#voiceRunSamples = 0;
    this.#activeFrames = [];
    this.#activeSamples = 0;
    this.#activeVoicedSamples = 0;
    this.#trailingSilenceSamples = 0;
  }
}
