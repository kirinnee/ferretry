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

import type { SpeakerEvent, SpeakerPort, SpeakerVoice, SpeakRequest, StopReason } from './ports.ts';
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
  /** Stop whatever is being read. `reason` is who stopped it (see {@link SpeakerPort.stop}); absent: automatic. */
  stop(reason?: StopReason): void;
  /** What to say about the voice a reading would use right now, before anything is read: null for a device voice. */
  previewVoiceNote(voiceId?: string | null): string | null;
  /** Stop and forget the message (and its sentences): the conversation it belonged to has been left. */
  dismiss(): void;
  /**
   * Voice mode's own voice (the machine's reply voice): while one is attached, every reading is spoken by it, with no device
   * voice needed. A reading it cannot begin (`unavailable`) is read by the device's own voice instead, exactly as it would
   * have been without it. A reading under way when this changes is stopped. `null` detaches.
   */
  attach(voice: SpeakerPort | null): void;
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
  /** Voice mode's voice, while voice mode is on. */
  let attached: SpeakerPort | null = null;
  /** The voice a reading is on right now (the machine's, or the device's after a fallback). */
  let voiceOn: SpeakerPort | null = null;
  const speaking = (): SpeakerPort => voiceOn ?? attached ?? speaker;
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
    get supported() {
      return attached !== null || speaker.supported;
    },
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
        speaking().stop();
        set({ ...IDLE, key });
        return;
      }
      const { voice, language } = pickVoice(options.voiceId);
      const machine = attached;
      if (voice === null && machine === null) {
        // No voice that stays on the device and none picked: say so, and never hand the text to the browser's default.
        speaking().stop();
        set({ ...IDLE, status: 'unavailable', key, segments, truncated: reading.truncated });
        return;
      }
      // The machine's voice keeps the text on the machine the person owns, so it carries no warning; the device's does as it did.
      set({
        status: 'reading',
        key,
        segments,
        current: 0,
        truncated: reading.truncated,
        voiceNote: machine === null ? voiceNote(voice) : null,
      });
      const live = (): boolean => mine === token;
      const request: SpeakRequest = { segments, rate, voice, language };
      const handle = (viaMachine: boolean) => (event: SpeakerEvent) => {
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
            if (viaMachine && event.reason === 'unavailable') {
              // The machine could not begin: the device reads the same words, or says it has no voice for them.
              if (voice === null) set({ ...IDLE, status: 'unavailable', key, segments, truncated: reading.truncated });
              else {
                set({ ...state, voiceNote: voiceNote(voice) });
                begin(speaker, handle(false));
              }
              return;
            }
            set({ ...state, status: 'failed' });
            return;
        }
      };
      const begin = (port: SpeakerPort, onEvent: (event: SpeakerEvent) => void): void => {
        voiceOn = port;
        try {
          port.speak(request, onEvent);
        } catch {
          if (live()) set({ ...state, status: 'failed' });
        }
      };
      // A reading on the other voice (the device's, after a fallback) must not talk under this one.
      if (voiceOn !== null && voiceOn !== (machine ?? speaker)) voiceOn.stop();
      begin(machine ?? speaker, handle(machine !== null));
    },
    attach: voice => {
      if (attached === voice) return;
      const before = attached;
      attached = voice;
      try {
        speaking().stop();
        before?.stop();
        if (voice !== null) speaker.stop();
        voiceOn = null;
      } finally {
        if (state.status === 'reading') set({ ...state, status: 'stopped' });
      }
    },
    dismiss: () => {
      token += 1;
      try {
        speaking().stop();
      } finally {
        if (state !== IDLE) set(IDLE);
      }
    },
    stop: reason => {
      if (state.status !== 'reading') return;
      // The speaker answers with `stopped`; if it cannot, the state still has to say so.
      try {
        speaking().stop(reason);
      } finally {
        if (state.status === 'reading') set({ ...state, status: 'stopped' });
      }
    },
  };
}
