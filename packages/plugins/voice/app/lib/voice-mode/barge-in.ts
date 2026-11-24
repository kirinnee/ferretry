/**
 * BARGE-IN: has the person started talking over the reply? Pure and total: it is fed the microphone's 40 ms units (exactly
 * what the machine is sent, so a muted person is never heard here) and says, once, when at least {@link BARGE_IN_MS} of
 * speech has been heard while the reply is playing.
 *
 * WHY 300 ms AND A MOVING FLOOR. A cough, a chair and the tail of the reply's own echo are short or steady; words are
 * neither. The browser's echo cancellation takes most of the reply out of the microphone, and what is left is steady, so
 * the bar is a multiple of the room's own level (the quietest tenth of the last three seconds, which includes the left-over
 * echo) and never lower than {@link MIN_SPEECH_RMS}. A person's voice is several times louder than what is left, so it
 * clears the bar; the left-over does not. Only the person's own speakers and microphone can prove that, so the number is
 * measured on a recorded clip here and on the owner's laptop and phone, and it is the only thing to tune (`docs/voice.md`).
 *
 * Speech is allowed small gaps, as speech has: a quiet stretch shorter than {@link GAP_MS} does not restart the count.
 */
import { UNIT_MS } from '../../../contract/index.ts';

/** How much speech stops the reply. */
export const BARGE_IN_MS = 300;
/** The quietest a unit may be and still count as speech, however quiet the room. */
export const MIN_SPEECH_RMS = 0.02;
/** A unit is speech when it is this many times the room's level. */
const FLOOR_MULTIPLIER = 3;
/** A quiet stretch shorter than this inside speech does not break it. */
const GAP_MS = 120;
/** Units kept to judge the room's level: three seconds. */
const HISTORY_UNITS = 75;

export interface BargeInDetector {
  /**
   * One unit of the microphone. `armed` is true while a reply is being played; the room's level is learned either way, but
   * only an armed detector fires. Returns true at the unit that completes {@link BARGE_IN_MS} of speech, and then starts over.
   */
  push(pcm: Int16Array, armed: boolean): boolean;
  /** Forget the speech heard so far (a reply ended, or voice mode was muted). The room's level is kept. */
  reset(): void;
}

const levelOf = (pcm: Int16Array): number => {
  if (pcm.length === 0) return 0;
  let energy = 0;
  for (const sample of pcm) energy += (sample / 32768) ** 2;
  const level = Math.sqrt(energy / pcm.length);
  return Number.isFinite(level) ? level : 0;
};

export function createBargeInDetector(): BargeInDetector {
  const history: number[] = [];
  let speechMs = 0;
  let quietMs = 0;
  const floor = (): number => {
    if (history.length === 0) return 0;
    const sorted = [...history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  };
  return {
    push(pcm, armed) {
      const level = levelOf(pcm);
      const loud = level >= Math.max(MIN_SPEECH_RMS, floor() * FLOOR_MULTIPLIER);
      history.push(level);
      if (history.length > HISTORY_UNITS) history.shift();
      if (!armed) {
        speechMs = 0;
        quietMs = 0;
        return false;
      }
      if (loud) {
        speechMs += UNIT_MS;
        quietMs = 0;
      } else {
        quietMs += UNIT_MS;
        if (quietMs >= GAP_MS) speechMs = 0;
      }
      if (speechMs < BARGE_IN_MS) return false;
      speechMs = 0;
      quietMs = 0;
      return true;
    },
    reset() {
      speechMs = 0;
      quietMs = 0;
    },
  };
}
