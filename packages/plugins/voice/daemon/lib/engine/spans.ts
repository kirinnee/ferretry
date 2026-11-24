import type { VoiceSpan } from '../../../contract/index.ts';

/** Silero VAD v5 reads 512 samples (32 ms at 16 kHz) at a time. */
export const VAD_CHUNK = 512;

/** Silero's own defaults: speech starts above 0.5 and ends below 0.35; shorter blips and gaps are noise. */
const START_ABOVE = 0.5;
const END_BELOW = 0.35;
const MIN_SPEECH_CHUNKS = 8; // 256 ms
const MIN_SILENCE_CHUNKS = 3; // 96 ms
const PAD_SAMPLES = 480; // 30 ms either side

/**
 * Speech spans from one probability per chunk. A pure function over numbers, so the decision a pause rests on is
 * tested without a model: hysteresis (start above 0.5, end below 0.35), gaps under 96 ms bridged, spans under
 * 256 ms dropped, and 30 ms of padding either side so a word's edge is never clipped.
 */
export function spansFromProbabilities(probabilities: readonly number[], totalSamples: number): readonly VoiceSpan[] {
  const raw: { start: number; end: number }[] = [];
  let start: number | undefined;
  let quiet = 0;
  probabilities.forEach((probability, index) => {
    if (start === undefined) {
      if (probability > START_ABOVE) {
        start = index;
        quiet = 0;
      }
      return;
    }
    if (probability >= END_BELOW) {
      quiet = 0;
      return;
    }
    quiet += 1;
    if (quiet >= MIN_SILENCE_CHUNKS) {
      raw.push({ start, end: index - quiet + 1 });
      start = undefined;
    }
  });
  if (start !== undefined) raw.push({ start, end: probabilities.length });
  return raw
    .filter(span => span.end - span.start >= MIN_SPEECH_CHUNKS)
    .map(span => ({
      start: Math.max(0, span.start * VAD_CHUNK - PAD_SAMPLES),
      end: Math.min(totalSamples, span.end * VAD_CHUNK + PAD_SAMPLES),
    }));
}
