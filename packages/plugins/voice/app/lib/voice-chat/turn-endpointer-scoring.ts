/**
 * HOW A TURN THE ENDPOINTER ENDED IS JUDGED — the scoring half of `turn-endpointer-noise.ts`, split
 * out so a unit test can pin the rules with hand-made frames.
 *
 * The question for a turn that ended while the talker still had words to say: was the person really
 * quiet for the whole pause the setting asks for?
 *
 *   - YES (the real gap is at least the setting) → a CUT-OFF, by design: the setting costs whoever
 *     pauses that long. Nothing is wrong with the endpointer.
 *   - NO → a FALSE SEND, the endpointer's own error, and the number the 2 % target is about. This is
 *     scored STRICTLY: against the configured pause, with no allowance.
 *
 * A word's onset or tail can sit under the loudness threshold, so a gap a few frames short of the
 * setting is not unreasonable to forgive. That forgiveness is reported SEPARATELY as a NEAR MISS: a
 * false send whose real gap was within {@link NEAR_MISS_MS} of the setting. The strict rate counts
 * every near miss; the tolerant rate is the strict rate minus them. Both are published.
 */

import { FRAME_MS } from '../stt/energy.ts';
import {
  ENDPOINTER_MAX_QUIET_RMS,
  type EndpointerState,
  endpointerFeed,
  endpointerStart,
  PAUSE_PRESETS,
  type PausePreset,
} from './turn-endpointer.ts';

/** Ended after the last word more than this past (last word + pause) counts as LATE. */
const LATE_MS = 1_000;
/** A false send whose real gap was within this of the pause is also reported as a near miss. */
export const NEAR_MISS_MS = 150;

export interface Word {
  readonly startMs: number;
  readonly endMs: number;
}

export interface Outcome {
  /** STRICT: the turn ended mid-speech although the real quiet before it was shorter than the pause. */
  falseSend: boolean;
  /** Of the false sends: the real gap was within {@link NEAR_MISS_MS} of the pause (onset/tail slack). */
  nearMiss: boolean;
  /** The turn ended after a real pause of at least the preset's length, and the talker said more. */
  cutOff: boolean;
  /** Ended after the last word, but more than {@link LATE_MS} past the pause. */
  late: boolean;
  /** Never ended in the trailing silence. */
  missed: boolean;
  /** Noise-only turns that ended before the talker spoke. */
  falseTurns: number;
  /** How far past (last word + pause) the correct end came, ms; null unless ended after the last word. */
  lateByMs: number | null;
  note?: string;
}

/**
 * The real quiet around the middle of the quiet the endpointer measured (the stretch of `pauseMs`
 * ending at `endedAtMs`). 0 when that middle falls inside a word: speech read as quiet.
 */
export function realGapMs(words: readonly Word[], endedAtMs: number, pauseMs: number): number {
  const middle = endedAtMs - pauseMs / 2;
  const inside = words.some(word => word.startMs <= middle && middle < word.endMs);
  const before = words.filter(word => word.endMs <= middle).at(-1);
  const after = words.find(word => word.startMs > middle);
  return inside || after === undefined ? 0 : after.startMs - (before?.endMs ?? 0);
}

/** Run one preset over the frames and judge the first turn that contains speech. */
export function judge(
  levels: readonly number[],
  words: readonly Word[],
  offsetMs: number,
  preset: PausePreset,
  maxQuietRms: number = ENDPOINTER_MAX_QUIET_RMS,
): Outcome {
  const pauseMs = PAUSE_PRESETS[preset];
  const scripted = words.map(word => ({ startMs: word.startMs + offsetMs, endMs: word.endMs + offsetMs }));
  const lastEndMs = (scripted.at(-1) as Word).endMs;
  const overlaps = (fromMs: number, toMs: number): boolean =>
    scripted.some(word => word.startMs < toMs && word.endMs > fromMs);
  const result: Outcome = {
    falseSend: false,
    nearMiss: false,
    cutOff: false,
    late: false,
    missed: false,
    falseTurns: 0,
    lateByMs: null,
  };

  let state: EndpointerState = endpointerStart(preset, { maxQuietRms });
  let startedAt: number | null = null;
  for (const [index, rms] of levels.entries()) {
    const step = endpointerFeed(state, { atMs: (index + 1) * FRAME_MS, rms });
    state = step.state;
    for (const event of step.events) {
      if (event.kind === 'speech-start') startedAt = event.sinceMs;
      if (event.kind === 'speech-cancel') startedAt = null;
      if (event.kind !== 'turn-end') continue;
      const spoke = overlaps(startedAt ?? 0, event.speechEndedAtMs + FRAME_MS);
      if (!spoke) {
        // Noise alone made a "turn". The loop would find no words and listen again.
        result.falseTurns += 1;
        state = endpointerStart(preset, { maxQuietRms, floorLevels: state.levels });
        startedAt = null;
        continue;
      }
      if (event.atMs < lastEndMs) {
        const gap = realGapMs(scripted, event.atMs, pauseMs);
        if (gap >= pauseMs) result.cutOff = true;
        else {
          result.falseSend = true;
          result.nearMiss = gap >= pauseMs - NEAR_MISS_MS;
          result.note = `cut at ${event.atMs} ms, real pause ${Math.round(gap)} ms of a ${pauseMs} ms setting${result.nearMiss ? ' (near miss)' : ''}, last word ends ${Math.round(lastEndMs)} ms (${scripted.length} words)`;
        }
      } else {
        const lateBy = event.atMs - (lastEndMs + pauseMs);
        result.lateByMs = lateBy;
        if (lateBy > LATE_MS) result.late = true;
      }
      return result;
    }
  }
  result.missed = true;
  return result;
}
