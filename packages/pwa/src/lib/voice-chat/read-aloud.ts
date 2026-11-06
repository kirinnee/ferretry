/**
 * THE READ-ALOUD CONTROLLER: which message is being read, which sentence is being said, and what the
 * row should say about it. One per page, because a device has one voice — pressing Read aloud on another
 * message moves the reading there rather than talking over itself.
 *
 * It owns no browser object and no clock: the speaker, the language and the rate arrive as arguments, so
 * every transition is a plain test. It is a tiny external store (`getState` / `subscribe`) for
 * `useSyncExternalStore`, and the state holds the words that are being said and nothing else about them —
 * nothing here logs, persists or sends the text. Total: a speaker that throws or a reply with nothing to
 * say ends in the `failed` / no-op state, never an exception.
 */

import type { SpeakerPort, SpeakerVoice } from './ports.ts';
import { readingCapForSeconds, speakableSegments } from './speakable.ts';
import { chooseVoice, clampSpeechRate, DEFAULT_SPEECH_RATE, voiceNote } from './voice-choice.ts';

/**
 * `idle`: nothing has been read here. `reading`: the voice is on. `stopped`: the person stopped it.
 * `finished`: it read to the end. `failed`: the device could not speak. `unavailable`: the device has no voice that
 * keeps the text on the device (and none was picked), so nothing is spoken and the reply stays text.
 */
type ReadAloudStatus = 'idle' | 'reading' | 'stopped' | 'finished' | 'failed' | 'unavailable';

export interface ReadAloudState {
  readonly status: ReadAloudStatus;
  /** The message being (or last) read, by the key its row gave. */
  readonly key: string | null;
  /** The captions: what is being said, a sentence at a time. */
  readonly segments: readonly string[];
  /** Index into `segments` of the sentence being said now. */
  readonly current: number;
  /** The reply was longer than one reading: the last caption says there is more on screen. */
  readonly truncated: boolean;
  /** Said next to the Stop button when the voice in use sends text away; null for a device voice. */
  readonly voiceNote: string | null;
}

/** What the person chose for ONE reading (their voice settings); each part falls back to the controller's default. */
interface ReadOptions {
  /** The chosen voice's id. */
  readonly voiceId?: string | null;
  readonly rate?: number;
  /** The longest the reading runs, in seconds; null for no limit. Absent: one minute. */
  readonly maxSeconds?: number | null;
}

export interface ReadAloudDeps {
  readonly speaker: SpeakerPort;
  /** The language to speak, read each time a reading starts (`navigator.language`). */
  readonly language?: () => string;
  /** The speech rate, read each time a reading starts. */
  readonly rate?: () => number;
  /** The id of the voice the person picked in the voice picker, if any: the only way a remote voice is used. */
  readonly pickedVoice?: () => string | undefined;
}

export interface ReadAloudController {
  readonly supported: boolean;
  /** The voices this device can speak with right now (may be empty at first: browsers load them late). Never throws. */
  voices(): readonly SpeakerVoice[];
  getState(): ReadAloudState;
  subscribe(listener: () => void): () => void;
  /** Read `markdown` aloud as message `key`, replacing any reading. Call it from the tap itself (iOS). */
  read(key: string, markdown: string, options?: ReadOptions): void;
  /** Stop whatever is being read. */
  stop(): void;
  /** What to say about the voice a reading would use right now, before anything is read: null for a device voice. */
  previewVoiceNote(voiceId?: string | null): string | null;
  /** Stop and forget the message (and its sentences): the conversation it belonged to has been left. */
  dismiss(): void;
}

export const IDLE: ReadAloudState = {
  status: 'idle',
  key: null,
  segments: [],
  current: 0,
  truncated: false,
  voiceNote: null,
};

export function createReadAloud(deps: ReadAloudDeps): ReadAloudController {
  const { speaker } = deps;
  let state: ReadAloudState = IDLE;
  let token = 0;
  const listeners = new Set<() => void>();
  const set = (next: ReadAloudState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** The voice a reading would use: the one the person picked, else the best that stays on the device; null for none. */
  const pickVoice = (voiceId?: string | null): { readonly voice: SpeakerVoice | null; readonly language: string } => {
    let language = 'en-US';
    try {
      language = deps.language?.() ?? language;
    } catch {
      // No language to ask: English.
    }
    try {
      return { voice: chooseVoice(speaker.voices(), language, voiceId ?? deps.pickedVoice?.()), language };
    } catch {
      return { voice: null, language };
    }
  };

  return {
    supported: speaker.supported,
    voices: () => {
      try {
        return speaker.voices();
      } catch {
        return [];
      }
    },
    getState: () => state,
    previewVoiceNote: voiceId => voiceNote(pickVoice(voiceId).voice),
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: (key, markdown, options = {}) => {
      const mine = ++token;
      const rate = clampSpeechRate(options.rate ?? deps.rate?.() ?? DEFAULT_SPEECH_RATE);
      const reading = speakableSegments(markdown, {
        maxCharacters: readingCapForSeconds(rate, options.maxSeconds === undefined ? 60 : options.maxSeconds),
      });
      const segments = reading.segments.map(segment => segment.text);
      if (segments.length === 0) {
        speaker.stop();
        set({ ...IDLE, key });
        return;
      }
      const { voice, language } = pickVoice(options.voiceId);
      if (voice === null) {
        // No voice that stays on the device and none picked: say so, and never hand the text to the browser's default.
        speaker.stop();
        set({ ...IDLE, status: 'unavailable', key, segments, truncated: reading.truncated });
        return;
      }
      set({ status: 'reading', key, segments, current: 0, truncated: reading.truncated, voiceNote: voiceNote(voice) });
      const live = (): boolean => mine === token;
      try {
        speaker.speak({ segments, rate, voice, language }, event => {
          if (!live()) return;
          switch (event.type) {
            case 'segment':
              set({ ...state, current: event.index });
              return;
            case 'end':
              set({ ...state, status: 'finished' });
              return;
            case 'stopped':
              set({ ...state, status: 'stopped' });
              return;
            case 'error':
              set({ ...state, status: 'failed' });
              return;
          }
        });
      } catch {
        if (live()) set({ ...state, status: 'failed' });
      }
    },
    dismiss: () => {
      token += 1;
      try {
        speaker.stop();
      } finally {
        if (state !== IDLE) set(IDLE);
      }
    },
    stop: () => {
      if (state.status !== 'reading') return;
      // The speaker answers with `stopped`; if it cannot, the state still has to say so.
      try {
        speaker.stop();
      } finally {
        if (state.status === 'reading') set({ ...state, status: 'stopped' });
      }
    },
  };
}
