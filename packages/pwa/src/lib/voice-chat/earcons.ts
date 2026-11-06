/**
 * LIVE'S EARCONS AND BUZZES: short, distinct tones (and, on Android, a short vibration) that say where
 * the loop is to someone who is not looking at the screen. Docs: voice.md › Live voice › Sounds.
 *
 * Three parts, each total and small:
 *
 *   - {@link cueFor} — PURE. From the machine's state before and after one event: which tone and which
 *     buzz (if any) that event deserves. It only ever reads two states, so the table is tested without a
 *     browser, an audio device or a clock.
 *   - {@link earconTones} — PURE. The notes of each tone. Four tones, told apart by SHAPE not pitch
 *     alone (rising pair, one short blip, two-note chime, falling pair), so they are told apart by anyone.
 *   - {@link webAudioEarcons} / {@link navigatorHaptics} — the two adapters, over minimal structural
 *     types so a test hands them plain objects. No external files: every tone is an oscillator.
 *
 * The tones are quiet and short on purpose: the "listening" tone sounds as the microphone opens, and the
 * endpointer ignores anything shorter than a real utterance, so the tone is never taken for a turn.
 * Nothing here is a way to hear, record or send anything.
 */

import type { LiveState } from './live-machine.ts';
import type { EarconKind, EarconPort, HapticsPort } from './ports.ts';

interface EarconTone {
  /** Hertz. */
  readonly frequency: number;
  /** Milliseconds after the tone starts. */
  readonly startMs: number;
  readonly durationMs: number;
}

/** Peak loudness of every tone, 0..1: quiet enough to be a hint and never a startle. */
export const EARCON_GAIN = 0.12;

const TONES: Readonly<Record<EarconKind, readonly EarconTone[]>> = Object.freeze({
  // Rising pair: "I'm listening".
  listening: [
    { frequency: 523.25, startMs: 0, durationMs: 70 },
    { frequency: 783.99, startMs: 80, durationMs: 90 },
  ],
  // One short high blip: "sent".
  sent: [{ frequency: 987.77, startMs: 0, durationMs: 80 }],
  // Two-note chime, lower then higher, a little longer: "the reply is ready".
  'reply-ready': [
    { frequency: 659.25, startMs: 0, durationMs: 110 },
    { frequency: 880, startMs: 130, durationMs: 160 },
  ],
  // Falling pair: "stopped".
  stopped: [
    { frequency: 659.25, startMs: 0, durationMs: 80 },
    { frequency: 392, startMs: 90, durationMs: 130 },
  ],
});

export const earconTones = (kind: EarconKind): readonly EarconTone[] => TONES[kind] ?? [];

/** The vibration pattern for each buzz, in ms (on, off, on…). */
export const HAPTIC_PATTERNS: Readonly<Record<'sent' | 'reply-ready', readonly number[]>> = Object.freeze({
  sent: [40],
  'reply-ready': [40, 60, 40],
});

export interface Cue {
  readonly earcon: EarconKind | null;
  readonly haptic: 'sent' | 'reply-ready' | null;
}

const NO_CUE: Cue = Object.freeze({ earcon: null, haptic: null });

/**
 * The tone and buzz one event earns, from the state before it and after it:
 *
 *   - the microphone just opened and Live is listening (the first time, and again after each reply): "listening";
 *   - the message just went and Live is working: "sent" (+ buzz);
 *   - the ferret's turn just ended — read, or heard as a question, or simply over: "reply ready" (+ buzz);
 *   - Live just ended (End, the ferret stopped, ten quiet minutes): "stopped". A refusal to START has no tone.
 *
 * Anything else — hearing you, a countdown, a hold, a take that came to nothing — is silent.
 */
export function cueFor(before: LiveState, after: LiveState): Cue {
  if (before.phase === after.phase) return NO_CUE;
  if (after.phase === 'listening' && before.phase === 'starting') return { earcon: 'listening', haptic: null };
  if (after.phase === 'working' && before.phase === 'sending') return { earcon: 'sent', haptic: 'sent' };
  if (before.phase === 'working' && after.phase !== 'off' && after.phase !== 'paused')
    return { earcon: 'reply-ready', haptic: 'reply-ready' };
  if (after.phase === 'off' && before.phase !== 'off' && after.notice?.kind !== 'blocked')
    return { earcon: 'stopped', haptic: null };
  return NO_CUE;
}

// — adapters ————————————————————————————————————————————————————————————

/** The few parts of a Web Audio context the tones use. */
interface AudioParamLike {
  setValueAtTime(value: number, at: number): unknown;
  linearRampToValueAtTime(value: number, at: number): unknown;
}
interface AudioNodeLike {
  connect(destination: unknown): unknown;
}
interface OscillatorLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  start(at: number): void;
  stop(at: number): void;
}
interface GainLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}
interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state?: string;
  resume?(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}
export type AudioContextConstructor = new () => AudioContextLike;

/**
 * Tones over Web Audio. The context is made lazily and `unlock()` (called inside the person's tap) resumes it:
 * a page may not sound before a gesture. A device with no Web Audio, or one that refuses, is silent — never an error.
 */
export function webAudioEarcons(AudioContextClass: AudioContextConstructor | undefined): EarconPort {
  let context: AudioContextLike | null = null;
  const contextOf = (): AudioContextLike | null => {
    if (context !== null) return context;
    if (AudioContextClass === undefined) return null;
    try {
      context = new AudioContextClass();
    } catch {
      context = null;
    }
    return context;
  };
  const unlock = (): void => {
    try {
      const ready = contextOf();
      if (ready !== null && ready.state === 'suspended') void ready.resume?.().catch(() => undefined);
    } catch {
      // Silent.
    }
  };
  return {
    unlock,
    play: kind => {
      try {
        const ready = contextOf();
        if (ready === null) return;
        if (ready.state === 'suspended') void ready.resume?.().catch(() => undefined);
        const origin = ready.currentTime;
        for (const tone of earconTones(kind)) {
          const oscillator = ready.createOscillator();
          const gain = ready.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(tone.frequency, origin);
          const start = origin + tone.startMs / 1_000;
          const end = start + tone.durationMs / 1_000;
          // A short fade in and out: no click at either end.
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(EARCON_GAIN, start + 0.012);
          gain.gain.linearRampToValueAtTime(0, end);
          oscillator.connect(gain);
          gain.connect(ready.destination);
          oscillator.start(start);
          oscillator.stop(end + 0.02);
        }
      } catch {
        // Silent.
      }
    },
  };
}

/** `navigator.vibrate`, where there is one (Android Chrome; iOS web has none). Guarded: never throws. */
export function navigatorHaptics(nav: { vibrate?: (pattern: readonly number[]) => boolean } | undefined): HapticsPort {
  return {
    pulse: kind => {
      try {
        nav?.vibrate?.(HAPTIC_PATTERNS[kind]);
      } catch {
        // No buzz.
      }
    },
  };
}
