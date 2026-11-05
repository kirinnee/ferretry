/**
 * `SpeakerPort` OVER THE BROWSER'S `speechSynthesis` — the free voices built into the device.
 *
 * WHAT THIS ADAPTER KNOWS THAT THE REST DOES NOT
 *
 *   - Chrome stops a long utterance after about fifteen seconds, so a caption is spoken as a run of short
 *     utterances (`chunkForSpeech`), one at a time, each started when the last one ends.
 *   - iOS lets speech start only from a tap. `unlock()` is called inside one and speaks a silent,
 *     zero-volume space once; after that, speech started later (the Live loop's reply) is allowed.
 *   - An utterance cancelled by `cancel()` reports `interrupted` or `canceled`: that is us stopping, not
 *     a failure, so it is never reported as one.
 *   - A reading that was replaced or stopped must go quiet at once: every callback checks it still
 *     belongs to the live reading (a generation number) before it does anything.
 *
 * The browser objects arrive as `SpeechSynthesisDeps`, so a test drives every path with a fake and no
 * real audio. Nothing here logs, stores or sends the text it is handed.
 */

import type { SpeakerEvent, SpeakerPort, SpeakerVoice, SpeakRequest } from './ports.ts';
import { chunkForSpeech } from './speech-chunks.ts';
import { clampSpeechRate } from './voice-choice.ts';

/** The slice of `SpeechSynthesisUtterance` this adapter sets and listens to. */
export interface UtteranceLike {
  text: string;
  rate: number;
  volume: number;
  lang: string;
  voice: unknown;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
}

export interface BrowserVoiceLike {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
}

/** The slice of `SpeechSynthesis` this adapter calls. */
export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): readonly BrowserVoiceLike[];
}

export interface SpeechSynthesisDeps {
  /** Null where the browser has no speech synthesis. */
  readonly synth: SynthLike | null;
  readonly createUtterance: (text: string) => UtteranceLike;
}

const CANCELLED = new Set(['interrupted', 'canceled', 'cancelled']);

const asVoice = (voice: BrowserVoiceLike): SpeakerVoice => ({
  id: voice.voiceURI,
  name: voice.name,
  lang: voice.lang,
  local: voice.localService,
  isDefault: voice.default,
});

interface Piece {
  readonly segment: number;
  readonly text: string;
}

export function createSpeechSynthesisSpeaker(deps: SpeechSynthesisDeps): SpeakerPort {
  const { synth } = deps;
  let generation = 0;
  let listener: ((event: SpeakerEvent) => void) | null = null;
  let unlocked = false;

  const stopListener = (): void => {
    const heard = listener;
    listener = null;
    generation += 1;
    heard?.({ type: 'stopped' });
  };

  return {
    supported: synth !== null,
    voices: () => (synth === null ? [] : synth.getVoices().map(asVoice)),
    unlock: () => {
      if (synth === null || unlocked) return;
      unlocked = true;
      try {
        const silent = deps.createUtterance(' ');
        silent.volume = 0;
        synth.speak(silent);
      } catch {
        unlocked = false;
      }
    },
    speak: (request: SpeakRequest, onEvent) => {
      if (synth === null) {
        onEvent({ type: 'error', reason: 'unavailable' });
        return;
      }
      if (listener !== null) stopListener();
      try {
        synth.cancel();
      } catch {
        // Nothing was speaking that could be cancelled.
      }
      generation += 1;
      const mine = generation;
      listener = onEvent;
      const tell = (event: SpeakerEvent): void => {
        if (mine !== generation || listener === null) return;
        const heard = listener;
        if (event.type !== 'segment') {
          listener = null;
          generation += 1;
        }
        heard(event);
      };

      const pieces: Piece[] = request.segments.flatMap((text, segment) =>
        chunkForSpeech(text).map(piece => ({ segment, text: piece })),
      );
      if (pieces.length === 0) {
        tell({ type: 'end' });
        return;
      }
      const wanted = request.voice ?? null;
      const voice = wanted === null ? undefined : synth.getVoices().find(candidate => candidate.voiceURI === wanted.id);
      const rate = clampSpeechRate(request.rate);
      let announced = -1;
      const announce = (segment: number): void => {
        if (segment <= announced) return;
        announced = segment;
        tell({ type: 'segment', index: segment });
      };

      const say = (at: number): void => {
        if (mine !== generation) return;
        const piece = pieces[at];
        if (piece === undefined) {
          tell({ type: 'end' });
          return;
        }
        let utterance: UtteranceLike;
        try {
          utterance = deps.createUtterance(piece.text);
          utterance.rate = rate;
          if (voice !== undefined) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
          }
          utterance.onstart = () => announce(piece.segment);
          utterance.onend = () => {
            announce(piece.segment);
            say(at + 1);
          };
          utterance.onerror = event => {
            if (event.error !== undefined && CANCELLED.has(event.error)) return;
            tell({ type: 'error', reason: 'failed' });
          };
          synth.speak(utterance);
        } catch {
          tell({ type: 'error', reason: 'failed' });
        }
      };
      say(0);
    },
    stop: () => {
      if (synth === null || listener === null) return;
      stopListener();
      try {
        synth.cancel();
      } catch {
        // Already quiet.
      }
    },
  };
}

/** The speaker for this browser: the real `speechSynthesis`, or an unsupported one where there is none. */
export function browserSpeaker(): SpeakerPort {
  const present = typeof globalThis.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  return createSpeechSynthesisSpeaker({
    synth: present ? (globalThis.speechSynthesis as unknown as SynthLike) : null,
    createUtterance: text => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
  });
}
