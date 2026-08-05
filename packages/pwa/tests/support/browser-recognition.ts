/**
 * A deterministic stand-in for the browser's SpeechRecognition, behind the very
 * port production injects.
 *
 * The Web Speech API is self-driving: it opens its own microphone, fires
 * `start` when the engine is live, streams provisional results, and ends
 * whenever it decides the utterance is over. None of those moments is
 * reproducible from a test, so each one is a method here — `begin()`,
 * `result()`, `end()` — and nothing happens until a test asks for it.
 *
 * Time is fake for the same reason. The duration ceiling and the Stop timeout
 * are `setTimeout` handles the provider itself hands out, so only `fireTimers()`
 * ever settles them and a suite never waits on a real clock.
 *
 * Every `create()` builds a FRESH recognition object, the way a retry gets a
 * fresh browser prompt rather than the previous refusal again.
 */

import {
  BrowserRecognitionError,
  type BrowserRecognitionProvider,
  type BrowserRecognitionSupport,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
} from '../../src/lib/stt/browser-recognition.ts';

export const AVAILABLE_RECOGNITION: BrowserRecognitionSupport = {
  available: true,
  availability: 'available',
  implementation: 'standard',
};

export const UNSUPPORTED_RECOGNITION: BrowserRecognitionSupport = {
  available: false,
  availability: 'unsupported',
  implementation: null,
  reason: 'This browser does not support dictation for web apps.',
};

/** One provisional or settled hypothesis, as the engine would report it. */
interface RecognitionChunk {
  readonly text: string;
  readonly final?: boolean;
}

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onnomatch: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  starts = 0;
  stops = 0;
  aborts = 0;
  /** Thrown by `start()`, the way a refused page refuses synchronously. */
  startFailure: unknown;
  readonly #endsOnStop: boolean;

  constructor(endsOnStop: boolean, startFailure: unknown) {
    this.#endsOnStop = endsOnStop;
    this.startFailure = startFailure;
  }

  start(): void {
    this.starts += 1;
    if (this.startFailure !== undefined) throw this.startFailure;
  }

  stop(): void {
    this.stops += 1;
    // A prompt engine settles Stop with an `end` of its own; a slow one does
    // not, which is what `endsOnStop: false` reproduces.
    if (this.#endsOnStop) this.onend?.();
  }

  abort(): void {
    this.aborts += 1;
  }
}

export interface FakeRecognitionOptions {
  /** What feature detection would have answered on this page. */
  readonly support?: BrowserRecognitionSupport;
  /** Settle `stop()` with an immediate `end`, so one Stop finishes one take. */
  readonly endsOnStop?: boolean;
  /** Thrown by the next `start()` until it is cleared. */
  readonly startFailure?: unknown;
}

export interface FakeRecognitionProvider extends BrowserRecognitionProvider {
  /** The recognition object the live session is driving. */
  readonly recognition: FakeRecognition;
  /** How many recognition objects have been built — one per take. */
  readonly created: number;
  /** Armed on every recognition built from now on; `undefined` disarms it. */
  startFailure: unknown;
  /** The engine went live. */
  begin(): void;
  /** Report hypotheses, replacing everything from `resultIndex` onwards. */
  result(chunks: readonly RecognitionChunk[], resultIndex?: number): void;
  /** The one-liner form of `result` for a settled phrase. */
  speak(text: string): void;
  /** Speech happened but no hypothesis met the engine's threshold. */
  nomatch(): void;
  /** A Web Speech error event, by its spec name. */
  fail(error: string, message?: string): void;
  /** This recognition cycle ended, for any reason the engine likes. */
  end(): void;
  /** The page went to the background. */
  hide(): void;
  /** Settle every pending duration ceiling and Stop timeout. */
  fireTimers(): void;
}

export function fakeRecognitionProvider(options: FakeRecognitionOptions = {}): FakeRecognitionProvider {
  const support = options.support ?? AVAILABLE_RECOGNITION;
  const endsOnStop = options.endsOnStop ?? false;
  let current: FakeRecognition | null = null;
  let created = 0;
  let hiddenListener: (() => void) | null = null;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();

  const live = (): FakeRecognition => {
    if (current === null) throw new Error('no recognition has been created yet');
    return current;
  };

  const provider: FakeRecognitionProvider = {
    support,
    startFailure: options.startFailure,
    get recognition() {
      return live();
    },
    get created() {
      return created;
    },
    create: () => {
      if (!support.available) {
        throw new BrowserRecognitionError('recognition-unavailable', support.reason ?? 'Dictation is unavailable.');
      }
      created += 1;
      current = new FakeRecognition(endsOnStop, provider.startFailure);
      return current;
    },
    watchHidden: onHidden => {
      hiddenListener = onHidden;
      return () => {
        if (hiddenListener === onHidden) hiddenListener = null;
      };
    },
    setTimeout: callback => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: handle => {
      timers.delete(handle as number);
    },
    begin: () => live().onstart?.(),
    result: (chunks, resultIndex = 0) => {
      live().onresult?.({
        resultIndex,
        results: chunks.map(chunk => ({
          0: { transcript: chunk.text, confidence: 0.9 },
          isFinal: chunk.final ?? true,
          length: 1,
        })),
      });
    },
    speak: text => provider.result([{ text, final: true }]),
    nomatch: () => live().onnomatch?.({ resultIndex: 0, results: [] }),
    fail: (error, message) => live().onerror?.(message === undefined ? { error } : { error, message }),
    end: () => live().onend?.(),
    hide: () => hiddenListener?.(),
    fireTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
  return provider;
}

/** A browser that never had the interface at all. */
export const unsupportedRecognitionProvider = (
  support: BrowserRecognitionSupport = UNSUPPORTED_RECOGNITION,
): FakeRecognitionProvider => fakeRecognitionProvider({ support });
