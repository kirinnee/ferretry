/**
 * THE END OF A SPOKEN TURN, decided from the microphone's level alone.
 *
 * One endpointer serves every speech engine, so Live voice behaves the same whichever one a device
 * dictates with: it is fed the 20 ms loudness frames the page already measures and answers with
 * events — never with a timer. The clock is an INPUT (each frame carries its own `atMs`), so a test
 * feeds synthetic frames and asserts exact frame numbers.
 *
 * Pure and total, in the repo's functional style: {@link endpointerFeed} takes a state and a frame
 * and returns the next state with the events it caused. Nothing is mutated, nothing throws, and a
 * frame that makes no sense (non-finite, or older than the last one) is ignored.
 *
 * THE RULES (docs/voice.md › Pause detection):
 *
 *   - LOUD is a frame at or above the quiet threshold of `lib/stt/energy.ts`: `QUIET_FLOOR_MULTIPLIER`
 *     (2.8) times the 10th-percentile level of the last {@link FLOOR_WINDOW_MS}, held between its
 *     clamps. A fan or a room hum raises the bar instead of reading as speech, and the floor adapts
 *     continuously.
 *   - SPEECH STARTS after {@link SPEECH_START_MS} of loud time. A click or a cough is shorter. Quiet
 *     dips shorter than the {@link HANGOVER_MS} do not break the run: a breath between words is not
 *     the end of it.
 *   - A TURN CAN ONLY END after {@link MIN_SPEECH_MS} of loud time in total. A short burst that
 *     goes quiet is retracted (`speech-cancel`), so a lone "uh" never becomes a message.
 *   - A PAUSE is quiet longer than the hangover. It is reported once (`pause`), and if the voice
 *     returns it is withdrawn (`resume`).
 *   - THE TURN ENDS when the quiet since the last loud frame reaches the pause length: 1.5 s by
 *     default, 0.8–4 s by setting ({@link PAUSE_PRESETS}). The pause is counted from the last loud
 *     frame, so it includes the hangover.
 *   - AN ENGINE HINT (Web Speech "this is final", Vosk "committed at a pause") can only SHORTEN a
 *     pause that is already detected: with the hint, quiet of {@link HINT_QUIET_MS} ends the turn
 *     early. It never ends a turn while the level says the person is speaking, and it never
 *     starts one.
 *   - A TURN NEVER RUNS PAST {@link MAX_TURN_MS}: it ends there whatever the level says — but never
 *     under {@link MIN_SPEECH_MS} of loud time: a run that short is retracted at the cap instead.
 *   - FRAMES MORE THAN {@link STALL_MS} APART mean the stream stalled (a throttled tab, a
 *     suspended microphone). The audio in the gap is unknown, so quiet is counted afresh from the
 *     frame after it: a stall can delay the end of a turn, never cause one. A run that has not yet
 *     reached {@link MIN_SPEECH_MS} is cancelled by a stall, so sparse loud frames across gaps never
 *     add up to a turn.
 *   - ONLY MEASURED AUDIO COUNTS AS LOUD TIME: a loud frame is credited at most {@link FRAME_MS},
 *     however long after the previous frame it arrived — the gap's audio was never measured. An
 *     unconfirmed run with a gap longer than the {@link HANGOVER_MS} in it (missing or unusable
 *     frames) is not continuous, so it starts over rather than adding up.
 *   - THE NOISE FLOOR ONLY LEARNS FROM WHAT IS NOT SPEECH: while speech is under way, a loud frame
 *     is not added to the floor window, so a long stretch of soft speech can never raise the bar
 *     until the speaker reads as quiet.
 */

import { FRAME_MS, noiseFloor, quietThreshold } from '../stt/energy.ts';

/** One measurement of the microphone: when it was taken (ms, any steady clock) and its RMS level. */
export interface LevelFrame {
  readonly atMs: number;
  readonly rms: number;
}

/** The named pause lengths a person picks between. */
export const PAUSE_PRESETS = Object.freeze({ quick: 900, normal: 1_500, thinker: 2_500 });
export type PausePreset = keyof typeof PAUSE_PRESETS;
/** The shortest and longest pause a setting may ask for. */
export const PAUSE_RANGE_MS = Object.freeze({ min: 800, max: 4_000 });
export const DEFAULT_PAUSE_MS = PAUSE_PRESETS.normal;

/** Loud time before speech has started: ignores clicks and coughs. */
const SPEECH_START_MS = 200;
/** Loud time in a turn before it can end: ignores a lone "uh". */
const MIN_SPEECH_MS = 400;
/** A quiet dip shorter than this is a breath between words. */
export const HANGOVER_MS = 250;
/** A turn ends here whatever the level says. */
export const MAX_TURN_MS = 120_000;
/** With an engine hint, this much quiet ends a turn (never longer than the pause itself). */
export const HINT_QUIET_MS = 600;
/** Frames further apart than this mean the stream stalled. */
const STALL_MS = 500;
/** The noise floor is read from this much recent audio. */
const FLOOR_WINDOW_MS = 10_000;
/** The loudest the quiet threshold may rise to: see the measurements in docs/voice.md. */
export const ENDPOINTER_MAX_QUIET_RMS = 0.03;

const FLOOR_WINDOW_FRAMES = FLOOR_WINDOW_MS / FRAME_MS;

/** What the endpointer says happened. `atMs` is the frame that made it true. */
export type EndpointerEvent =
  /** The person has started talking. `sinceMs` is when the loud run began. */
  | { readonly kind: 'speech-start'; readonly atMs: number; readonly sinceMs: number }
  /** A burst too short to be a turn went quiet: forget the `speech-start` before it. */
  | { readonly kind: 'speech-cancel'; readonly atMs: number }
  /** The person has stopped, for now: quiet longer than the hangover, after real speech. */
  | { readonly kind: 'pause'; readonly atMs: number; readonly sinceMs: number }
  /** The voice came back during a pause: the pause is withdrawn. */
  | { readonly kind: 'resume'; readonly atMs: number }
  /** The turn is over. `speechEndedAtMs` is the last loud frame; `reason` says which rule ended it. */
  | {
      readonly kind: 'turn-end';
      readonly atMs: number;
      readonly speechEndedAtMs: number;
      readonly reason: 'pause' | 'engine-hint' | 'max-turn';
    };

type Phase = 'listening' | 'speaking' | 'ended';

export interface EndpointerState {
  readonly pauseMs: number;
  /** The highest the quiet threshold may rise to. */
  readonly maxQuietRms: number;
  readonly phase: Phase;
  /** When the last accepted frame was measured; null before the first. */
  readonly lastAtMs: number | null;
  /** Recent levels, oldest first, for the noise floor. */
  readonly levels: readonly number[];
  /** Loud time so far in the run or turn. */
  readonly voicedMs: number;
  /** When the loud run (or turn) began; null while there is none. */
  readonly runStartMs: number | null;
  /** When the current quiet stretch began; null while the last frame was loud. */
  readonly quietSinceMs: number | null;
  /** The last loud frame. */
  readonly lastLoudAtMs: number | null;
  /** Whether `pause` has been said for the current quiet stretch. */
  readonly pauseSaid: boolean;
  /** Whether the engine has hinted that the current quiet stretch ends a sentence. */
  readonly hinted: boolean;
}

export interface EndpointerStep {
  readonly state: EndpointerState;
  readonly events: readonly EndpointerEvent[];
}

/** A pause length from anything: a preset name, a number of ms (clamped), or garbage (the default). */
export function resolvePauseMs(input: unknown): number {
  if (typeof input === 'string')
    return Object.hasOwn(PAUSE_PRESETS, input) ? PAUSE_PRESETS[input as PausePreset] : DEFAULT_PAUSE_MS;
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_PAUSE_MS;
  return Math.min(PAUSE_RANGE_MS.max, Math.max(PAUSE_RANGE_MS.min, Math.round(input)));
}

export interface EndpointerOptions {
  /** Levels heard just before, so the noise floor is known from the first frame of a new turn. */
  readonly floorLevels?: readonly number[];
  /** Override {@link ENDPOINTER_MAX_QUIET_RMS} (the dev harness sweeps it). */
  readonly maxQuietRms?: number;
}

/** A fresh endpointer, listening for the first words of a turn. */
export function endpointerStart(pause: unknown = 'normal', options: EndpointerOptions = {}): EndpointerState {
  const max = options.maxQuietRms;
  return {
    pauseMs: resolvePauseMs(pause),
    maxQuietRms: typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : ENDPOINTER_MAX_QUIET_RMS,
    phase: 'listening',
    lastAtMs: null,
    levels: (options.floorLevels ?? [])
      .filter(level => Number.isFinite(level) && level >= 0)
      .slice(-FLOOR_WINDOW_FRAMES),
    voicedMs: 0,
    runStartMs: null,
    quietSinceMs: null,
    lastLoudAtMs: null,
    pauseSaid: false,
    hinted: false,
  };
}

const unchanged = (state: EndpointerState): EndpointerStep => ({ state, events: [] });

const forgetRun = (state: EndpointerState): EndpointerState => ({
  ...state,
  phase: 'listening',
  voicedMs: 0,
  runStartMs: null,
  quietSinceMs: null,
  lastLoudAtMs: null,
  pauseSaid: false,
  hinted: false,
});

const isUsable = (frame: LevelFrame): boolean =>
  Number.isFinite(frame.atMs) && Number.isFinite(frame.rms) && frame.rms >= 0;

/** The turn-ending rule that applies to a quiet stretch of `quietMs`, if any. */
function endingReason(state: EndpointerState, quietMs: number): 'pause' | 'engine-hint' | null {
  if (quietMs >= state.pauseMs) return 'pause';
  if (state.hinted && quietMs >= Math.min(HINT_QUIET_MS, state.pauseMs)) return 'engine-hint';
  return null;
}

/** Feed one frame. Frames must come oldest first; an older or unusable one changes nothing. */
export function endpointerFeed(incoming: EndpointerState, frame: LevelFrame): EndpointerStep {
  if (incoming.phase === 'ended' || !isUsable(frame)) return unchanged(incoming);
  if (incoming.lastAtMs !== null && frame.atMs <= incoming.lastAtMs) return unchanged(incoming);

  const previous = incoming.lastAtMs;
  const stalled = previous === null || frame.atMs - previous > STALL_MS;
  const events: EndpointerEvent[] = [];
  // A stall cannot confirm speech: an unconfirmed run (under the minimum) is cancelled, so sparse
  // loud frames that straddle gaps never add up to a turn. A confirmed turn survives and just waits.
  // The same goes for an unconfirmed run with a hole in it longer than a breath: frames went
  // missing (or were unusable), so the run is not continuous.
  const unconfirmed = incoming.runStartMs !== null && incoming.voicedMs < MIN_SPEECH_MS;
  const broken = previous !== null && unconfirmed && frame.atMs - previous > HANGOVER_MS;
  let state = incoming;
  if ((stalled || broken) && previous !== null && unconfirmed) {
    if (incoming.phase === 'speaking') events.push({ kind: 'speech-cancel', atMs: frame.atMs });
    state = forgetRun(incoming);
  }
  // The interval this frame speaks for. After a stall nothing is known about the gap, so one frame.
  const spanMs = stalled ? FRAME_MS : frame.atMs - (previous as number);
  const intervalStartMs = frame.atMs - spanMs;
  // Loud time is only what was measured: one frame, whatever the gap before it.
  const measuredMs = Math.min(spanMs, FRAME_MS);

  const heard = [...state.levels.slice(1 - FLOOR_WINDOW_FRAMES), frame.rms];
  const loud = frame.rms >= quietThreshold(noiseFloor(heard), state.maxQuietRms);
  // The floor is the room, not the person: loud frames of speech under way are not learned.
  const levels = loud && state.phase === 'speaking' ? state.levels : heard;
  let next: EndpointerState = { ...state, lastAtMs: frame.atMs, levels };

  if (loud) {
    const voicedMs = state.voicedMs + measuredMs;
    const runStartMs = state.runStartMs ?? frame.atMs - measuredMs;
    if (state.pauseSaid) events.push({ kind: 'resume', atMs: frame.atMs });
    next = {
      ...next,
      voicedMs,
      runStartMs,
      quietSinceMs: null,
      lastLoudAtMs: frame.atMs,
      pauseSaid: false,
      hinted: false,
    };
    if (state.phase === 'listening' && voicedMs >= SPEECH_START_MS) {
      next = { ...next, phase: 'speaking' };
      events.push({ kind: 'speech-start', atMs: frame.atMs, sinceMs: runStartMs });
    }
  } else if (state.runStartMs !== null) {
    // Quiet inside a run or a turn. A stall restarts the count: the gap's audio is unknown.
    const quietSinceMs = stalled || state.quietSinceMs === null ? intervalStartMs : state.quietSinceMs;
    const quietMs = frame.atMs - quietSinceMs;
    next = { ...next, quietSinceMs };
    if (state.phase === 'listening') {
      // A loud run that never became speech: a dip longer than the hangover ends it.
      if (quietMs >= HANGOVER_MS) next = forgetRun(next);
    } else if (state.voicedMs < MIN_SPEECH_MS) {
      if (quietMs >= HANGOVER_MS) {
        events.push({ kind: 'speech-cancel', atMs: frame.atMs });
        next = forgetRun(next);
      }
    } else {
      if (quietMs >= HANGOVER_MS && !state.pauseSaid) {
        next = { ...next, pauseSaid: true };
        events.push({ kind: 'pause', atMs: frame.atMs, sinceMs: quietSinceMs });
      }
      const reason = endingReason(next, quietMs);
      if (reason !== null) {
        next = { ...next, phase: 'ended' };
        events.push({
          kind: 'turn-end',
          atMs: frame.atMs,
          speechEndedAtMs: state.lastLoudAtMs ?? quietSinceMs,
          reason,
        });
      }
    }
  }

  if (next.phase === 'speaking' && next.runStartMs !== null && frame.atMs - next.runStartMs >= MAX_TURN_MS) {
    if (next.voicedMs < MIN_SPEECH_MS) {
      // The cap never sends what the minimum would have retracted.
      events.push({ kind: 'speech-cancel', atMs: frame.atMs });
      next = forgetRun(next);
    } else {
      events.push({
        kind: 'turn-end',
        atMs: frame.atMs,
        speechEndedAtMs: next.lastLoudAtMs ?? frame.atMs,
        reason: 'max-turn',
      });
      next = { ...next, phase: 'ended' };
    }
  }
  return { state: next, events };
}

/**
 * The engine says the sentence is final. This only SHORTENS a pause the level has already shown:
 * with no quiet stretch under way it does nothing, and it can end the turn only on quiet the
 * frames have already measured — never on its own say-so.
 */
export function endpointerHint(state: EndpointerState): EndpointerStep {
  if (state.phase !== 'speaking' || state.quietSinceMs === null || state.lastAtMs === null || state.hinted)
    return unchanged(state);
  const hinted: EndpointerState = { ...state, hinted: true };
  if (!state.pauseSaid || state.voicedMs < MIN_SPEECH_MS) return { state: hinted, events: [] };
  const quietMs = state.lastAtMs - state.quietSinceMs;
  if (endingReason(hinted, quietMs) === null) return { state: hinted, events: [] };
  return {
    state: { ...hinted, phase: 'ended' },
    events: [
      {
        kind: 'turn-end',
        atMs: state.lastAtMs,
        speechEndedAtMs: state.lastLoudAtMs ?? state.quietSinceMs,
        reason: 'engine-hint',
      },
    ],
  };
}
