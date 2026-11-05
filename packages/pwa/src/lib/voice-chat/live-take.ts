/**
 * ONE LIVE TURN'S RECORDING, over the dictation engines the person already chose — no engine is
 * forked: the sessions are the ones `use-dictation.ts` drives (`BrowserRecognitionSessionLike`), made by
 * a factory the hook hands in, so Parakeet, Whisper, Vosk and Browser voice all work as they do for the
 * mic button.
 *
 * `endTurn()` is the end-of-turn call, and the one place engines differ:
 *
 *   - an engine that can work out the words WHILE recording stays open (`beginFinish()`, `tentative-take.ts`:
 *     the whole-take on-device engines) keeps the microphone open: the words are the early finish, and a
 *     voice coming back only discards it;
 *   - the others (Vosk, Browser voice, Parakeet with live words) `finish()` — the engine ends — and
 *     `resume()` opens a new session, keeping the words so far in front of whatever is said next.
 *
 * Either way the words are then cleaned (`live-cleanup.ts`, Fix only) and handed back. Audio never
 * leaves this object except through the engine the person chose; the words are never logged here.
 *
 * A session the take ended itself (`cancel`, `resume`) reports `aborted`/failures that nobody asked
 * about: every callback checks the generation of the session it belongs to.
 */

import {
  type BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  type BrowserRecognitionSessionOptions,
  browserRecognitionErrorFrom,
} from '../stt/browser-recognition.ts';
import { joinWords } from '../stt/near-live.ts';
import type { TentativeTake } from '../stt/tentative-take.ts';
import type { CleanedTurn } from './live-cleanup.ts';
import type { LiveBlock, TakeHandle, TakeListener, TakeOutcome, TakePort } from './ports.ts';

/** What a session callback set looks like for Live: the dictation set, plus near-live words as text. */
export interface LiveSessionCallbacks extends BrowserRecognitionSessionOptions {
  onLiveText(text: string): void;
}

export type LiveSession = BrowserRecognitionSessionLike & { start(): void };

export interface LiveTakeDeps {
  /** A session over the chosen engine, or the reason there is none. Never throws. */
  createSession(callbacks: LiveSessionCallbacks): LiveSession | LiveBlock;
  /** The Fix clean-up. Never throws; resolves the raw words on any failure. */
  clean(text: string, signal: AbortSignal): Promise<CleanedTurn>;
}

/** The words a failure should be shown as. */
export function blockOf(failure: BrowserRecognitionError): LiveBlock {
  switch (failure.code) {
    case 'permission-denied':
    case 'no-microphone':
      return 'mic-blocked';
    case 'model-not-installed':
      return 'engine-missing';
    default:
      return 'engine-failed';
  }
}

class LiveTake implements TakeHandle {
  readonly #deps: LiveTakeDeps;
  readonly #listener: TakeListener;
  #session: LiveSession | null = null;
  /** Bumped whenever a session is replaced or the take ends: a callback of an older one is dropped. */
  #gen = 0;
  /** The raw words of earlier sessions of this turn (engines that end on `endTurn`). */
  #carried = '';
  /** The session was finished by `endTurn` and must be replaced on `resume`. */
  #finished = false;
  #early: TentativeTake | null = null;
  #abort: AbortController | null = null;
  #cancelled = false;
  /** The raw words of the turn as `endTurn` last heard them: what `resume` carries into a new session. */
  #carriedAfterFinish = '';

  constructor(deps: LiveTakeDeps, listener: TakeListener) {
    this.#deps = deps;
    this.#listener = listener;
    this.#open();
  }

  /** Create and start a session. Synchronous: when it is the tap's, so is the permission prompt. */
  #open(): boolean {
    const gen = ++this.#gen;
    const carried = this.#carried;
    const current = (): boolean => gen === this.#gen && !this.#cancelled;
    const session = this.#deps.createSession({
      onStart: () => undefined,
      onTranscript: text => {
        if (current()) this.#listener.onLive(joinWords(carried, text));
      },
      onLiveText: text => {
        if (current()) this.#listener.onLive(joinWords(carried, text));
      },
      onFailure: failure => {
        if (current() && failure.code !== 'aborted') this.#listener.onFailed(blockOf(failure));
      },
      onAbort: () => {
        if (current()) this.#listener.onEnded();
      },
      onLimit: () => {
        if (current()) this.#listener.onEnded();
      },
    });
    if (typeof session === 'string') {
      this.#listener.onFailed(session);
      return false;
    }
    this.#session = session;
    this.#finished = false;
    try {
      session.start();
    } catch (failure) {
      this.#session = null;
      this.#listener.onFailed(blockOf(browserRecognitionErrorFrom(failure)));
      return false;
    }
    return true;
  }

  async endTurn(): Promise<TakeOutcome> {
    const session = this.#session;
    if (session === null || this.#cancelled) return { kind: 'empty' };
    this.#early?.discard();
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    let heard: string;
    try {
      const early = session.beginFinish?.() ?? null;
      this.#early = early;
      if (early === null) {
        heard = await session.finish();
        this.#finished = true;
      } else {
        heard = await early.text;
      }
    } catch (failure) {
      if (abort.signal.aborted || this.#cancelled) return { kind: 'empty' };
      const error = browserRecognitionErrorFrom(failure);
      return error.code === 'aborted' ? { kind: 'empty' } : { kind: 'failed', block: blockOf(error) };
    }
    if (abort.signal.aborted || this.#cancelled) return { kind: 'empty' };
    const rawWords = joinWords(this.#carried, heard);
    this.#carriedAfterFinish = rawWords;
    if (rawWords.trim() === '') return { kind: 'empty' };
    const cleaned = await this.#deps.clean(rawWords, abort.signal);
    if (abort.signal.aborted || this.#cancelled) return { kind: 'empty' };
    return { kind: 'words', text: cleaned.text, raw: rawWords, cleaned: cleaned.kept === 'cleaned' };
  }

  async resume(): Promise<boolean> {
    if (this.#cancelled) return false;
    this.#abort?.abort();
    this.#abort = null;
    this.#early?.discard();
    this.#early = null;
    if (!this.#finished) return true;
    this.#carried = this.#carriedAfterFinish;
    return this.#open();
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#gen += 1;
    this.#abort?.abort();
    this.#early?.discard();
    const session = this.#session;
    this.#session = null;
    try {
      session?.cancel();
    } catch {
      // Already ended.
    }
  }
}

export function liveTakePort(deps: LiveTakeDeps): TakePort {
  return { start: listener => new LiveTake(deps, listener) };
}
