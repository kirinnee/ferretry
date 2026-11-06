/**
 * LOUDNESS MATH shared by everything that decides "is anyone talking?" from raw audio.
 *
 * `near-live.ts` uses it to find the pauses a Parakeet window may start in; `lib/voice-chat/turn-
 * endpointer.ts` uses it to find the pause that ends a spoken turn. One definition of "quiet" means
 * the two can never disagree about the same audio.
 *
 * Pure and total: no clock, no IO, and every input — empty, reversed bounds, non-finite — has an
 * answer.
 *
 * LEVEL is the root-mean-square of a stretch of samples (0 = silence, ~1 = full scale). The NOISE
 * FLOOR is the 10th-percentile level of what was heard lately: the quietest stretches are the room,
 * not the person. QUIET is {@link QUIET_FLOOR_MULTIPLIER} times that floor, held between
 * {@link MIN_QUIET_RMS} and {@link MAX_QUIET_RMS}, so a fan raises the bar but steady speech with
 * no pause in it can never raise it past itself.
 */

/** Energy is measured in frames this long. */
export const FRAME_MS = 20;
/** The quietest a pause has to be, whatever the noise floor. */
export const MIN_QUIET_RMS = 0.004;
/** Ambient noise raises the bar: quiet is under this multiple of the noise floor. */
const QUIET_FLOOR_MULTIPLIER = 2.8;
/** …but never so far that steady speech with no pause in it reads as quiet. */
export const MAX_QUIET_RMS = 0.015;
/** Below this RMS level a whole window is silence, not speech a model failed to hear. */
export const SPEECH_RMS = 0.005;
/** Which of the sorted levels is "the floor": the 10th percentile. */
const FLOOR_PERCENTILE = 0.1;

/** The RMS of `samples[from, to)`. An empty, reversed or out-of-range stretch is 0, never NaN. */
export function rms(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (!(end > start)) return 0;
  let energy = 0;
  for (let index = start; index < end; index += 1) energy += (samples[index] as number) ** 2;
  const level = Math.sqrt(energy / (end - start));
  return Number.isFinite(level) ? level : 0;
}

/**
 * One RMS level per whole frame of `frameSamples` in `samples[from, to)`. Total: a non-finite bound or
 * frame size has no frames (never an endless loop), and the stretch is clamped to the buffer first,
 * so the loop is bounded by `samples.length`.
 */
export function frameLevels(samples: Float32Array, from: number, to: number, frameSamples: number): number[] {
  const levels: number[] = [];
  if (![from, to, frameSamples].every(Number.isFinite) || frameSamples < 1) return levels;
  const frame = Math.floor(frameSamples);
  const end = Math.min(samples.length, Math.floor(to));
  for (let at = Math.max(0, Math.ceil(from)); at + frame <= end; at += frame) levels.push(rms(samples, at, at + frame));
  return levels;
}

/** The noise floor of some frame levels: their 10th percentile. No levels, no floor: 0. */
export function noiseFloor(levels: readonly number[]): number {
  return [...levels].sort((a, b) => a - b)[Math.floor(levels.length * FLOOR_PERCENTILE)] ?? 0;
}

/** The level under which a frame is QUIET, given the noise floor. */
export function quietThreshold(floor: number, maxQuiet: number = MAX_QUIET_RMS): number {
  return Math.min(maxQuiet, Math.max(MIN_QUIET_RMS, floor * QUIET_FLOOR_MULTIPLIER));
}

/** Whether some samples are loud enough to hold speech. */
export const hasSpeech = (samples: Float32Array): boolean => rms(samples, 0, samples.length) >= SPEECH_RMS;
