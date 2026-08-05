/**
 * Browser-owned speech recognition, behind a testable port.
 *
 * The Web Speech API owns its microphone. It does not accept an existing
 * MediaStream or PCM buffer, so starting recognition is itself the capture
 * gesture: there is no honest adapter from the old "record, then upload"
 * engine seam. This module therefore owns one recognition session from the
 * synchronous `start()` call through the final `end` event.
 *
 * Target-browser facts checked for this implementation (2026-08-05):
 *
 * - Chrome exposes the standard constructor from 139 and still exposes the
 *   older `webkitSpeechRecognition` constructor.
 * - Safari and iOS Safari expose only `webkitSpeechRecognition` (14.1 / iOS
 *   14.5 onward). Installed iOS Home Screen apps are a known WebKit exception:
 *   the interface may be present but the recognition service is unavailable.
 * - Firefox recognition remains preference-gated, so an ordinary Firefox
 *   profile correctly fails the constructor check below.
 *
 * Feature detection is the authority at runtime. The compatibility facts only
 * explain the two deliberate probes: the prefixed constructor and the iOS
 * Home Screen refusal that constructor presence alone cannot prove.
 */

type BrowserRecognitionImplementation = 'standard' | 'webkit';
type BrowserRecognitionAvailability = 'available' | 'insecure-context' | 'ios-home-screen' | 'unsupported';

export interface BrowserRecognitionSupport {
  readonly available: boolean;
  readonly availability: BrowserRecognitionAvailability;
  readonly implementation: BrowserRecognitionImplementation | null;
  /** Ready-to-render, actionable copy. Absence is never represented as silence. */
  readonly reason?: string;
}

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence?: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
  item?(index: number): SpeechRecognitionAlternativeLike | null;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike | undefined;
  item?(index: number): SpeechRecognitionResultLike | null;
}

export interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onnomatch: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike;
}

interface StandaloneMediaQueryLike {
  readonly matches: boolean;
}

interface VisibilityDocumentLike {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface BrowserRecognitionGlobalLike {
  readonly SpeechRecognition?: SpeechRecognitionConstructorLike;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  readonly isSecureContext?: unknown;
  readonly navigator?: {
    readonly userAgent?: string;
    readonly maxTouchPoints?: number;
    readonly standalone?: boolean;
  };
  readonly document?: VisibilityDocumentLike;
  matchMedia?(query: string): StandaloneMediaQueryLike;
  setTimeout?(callback: () => void, milliseconds: number): unknown;
  clearTimeout?(handle: unknown): void;
}

const userAgentOf = (global: BrowserRecognitionGlobalLike): string =>
  typeof global.navigator?.userAgent === 'string' ? global.navigator.userAgent : '';

/** iPadOS uses a desktop Macintosh UA, distinguished by its touch points. */
const isLikelyIosRecognitionHost = (global: BrowserRecognitionGlobalLike): boolean => {
  const agent = userAgentOf(global);
  if (/iPhone|iPad|iPod/u.test(agent)) return true;
  const touches = typeof global.navigator?.maxTouchPoints === 'number' ? global.navigator.maxTouchPoints : 0;
  return /Macintosh/u.test(agent) && touches > 1;
};

const isStandaloneRecognitionHost = (global: BrowserRecognitionGlobalLike): boolean => {
  if (global.navigator?.standalone === true) return true;
  try {
    return global.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
};

/**
 * Read support as data. Constructor presence is normally sufficient, except
 * for iOS Home Screen apps where WebKit exposes an unusable interface.
 */
export function readBrowserRecognitionSupport(global: BrowserRecognitionGlobalLike): BrowserRecognitionSupport {
  const standard = typeof global.SpeechRecognition === 'function';
  const prefixed = typeof global.webkitSpeechRecognition === 'function';
  const implementation: BrowserRecognitionImplementation | null = standard ? 'standard' : prefixed ? 'webkit' : null;

  if (global.isSecureContext !== true) {
    return {
      available: false,
      availability: 'insecure-context',
      implementation,
      reason: 'Dictation needs a secure HTTPS page in this browser.',
    };
  }

  // WebKit bug 225298 remains resolved LATER rather than FIXED. In this shell,
  // attempting to start is known to return service-not-allowed even though the
  // prefixed constructor may be visible, so constructor-only detection lies.
  if (isLikelyIosRecognitionHost(global) && isStandaloneRecognitionHost(global)) {
    return {
      available: false,
      availability: 'ios-home-screen',
      implementation,
      reason: 'Home Screen apps cannot use dictation on iPhone or iPad. Open Ferretry in Safari instead.',
    };
  }

  if (implementation === null) {
    return {
      available: false,
      availability: 'unsupported',
      implementation: null,
      reason: 'This browser does not support dictation for web apps.',
    };
  }

  return { available: true, availability: 'available', implementation };
}

export interface BrowserRecognitionProvider {
  readonly support: BrowserRecognitionSupport;
  create(): SpeechRecognitionLike;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Production provider. Tests inject the same four operations as plain data. */
export function browserRecognitionProvider(
  global: BrowserRecognitionGlobalLike = globalThis as unknown as BrowserRecognitionGlobalLike,
): BrowserRecognitionProvider {
  const support = readBrowserRecognitionSupport(global);
  const Recognition = support.implementation === 'standard' ? global.SpeechRecognition : global.webkitSpeechRecognition;
  return {
    support,
    create: () => {
      if (!support.available || Recognition === undefined) {
        throw new BrowserRecognitionError(
          'recognition-unavailable',
          support.reason ?? 'Dictation is unavailable here.',
        );
      }
      return new Recognition();
    },
    watchHidden: onHidden => {
      const document = global.document;
      if (document === undefined) return () => undefined;
      const listener = (): void => {
        if (document.visibilityState === 'hidden') onHidden();
      };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setTimeout: (callback, milliseconds) =>
      global.setTimeout?.(callback, milliseconds) ?? globalThis.setTimeout(callback, milliseconds),
    clearTimeout: handle => {
      if (global.clearTimeout !== undefined) global.clearTimeout(handle);
      else globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

export type BrowserRecognitionErrorCode =
  | 'permission-denied'
  | 'no-microphone'
  | 'recognition-network'
  | 'recognition-unavailable'
  | 'bad-audio'
  | 'recognition-failed'
  | 'aborted';

export class BrowserRecognitionError extends Error {
  readonly code: BrowserRecognitionErrorCode;

  constructor(code: BrowserRecognitionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BrowserRecognitionError';
    this.code = code;
  }
}

/** Stable Web Speech / DOM failures → the vocabulary the dictation panel owns. */
export function browserRecognitionErrorFrom(failure: unknown): BrowserRecognitionError {
  if (failure instanceof BrowserRecognitionError) return failure;
  const source = failure as { error?: unknown; message?: unknown; name?: unknown } | null;
  const error = typeof source?.error === 'string' ? source.error : undefined;
  const name = typeof source?.name === 'string' ? source.name : undefined;
  const detail = typeof source?.message === 'string' && source.message.trim() ? source.message.trim() : undefined;

  if (error === 'not-allowed' || name === 'NotAllowedError' || name === 'SecurityError') {
    return new BrowserRecognitionError('permission-denied', detail ?? 'Microphone access was blocked for this site.', {
      cause: failure,
    });
  }
  if (error === 'audio-capture' || name === 'NotReadableError' || name === 'NotFoundError') {
    return new BrowserRecognitionError(
      'no-microphone',
      detail ?? 'This browser could not open a microphone. It may be missing or already in use.',
      { cause: failure },
    );
  }
  if (error === 'network') {
    return new BrowserRecognitionError(
      'recognition-network',
      detail ?? 'The browser speech service could not be reached.',
      { cause: failure },
    );
  }
  if (
    error === 'service-not-allowed' ||
    error === 'language-not-supported' ||
    error === 'phrases-not-supported' ||
    name === 'NotSupportedError'
  ) {
    return new BrowserRecognitionError(
      'recognition-unavailable',
      detail ?? 'Enable speech recognition in this browser or its system settings, then try again.',
      { cause: failure },
    );
  }
  if (error === 'aborted' || name === 'AbortError') {
    return new BrowserRecognitionError('aborted', detail ?? 'Speech recognition was cancelled.', { cause: failure });
  }
  return new BrowserRecognitionError(
    'recognition-failed',
    detail ?? 'This browser could not finish speech recognition.',
    { cause: failure },
  );
}

const MAX_BROWSER_DICTATION_MS = 120_000;
const RECOGNITION_STOP_TIMEOUT_MS = 10_000;

export interface BrowserRecognitionSessionOptions {
  readonly language?: string;
  readonly maxDurationMs?: number;
  readonly stopTimeoutMs?: number;
  onStart(): void;
  onTranscript(text: string): void;
  onFailure(failure: BrowserRecognitionError): void;
  onAbort(): void;
  onLimit(): void;
}

/** The controller-facing slice. `finish` stops capture and settles the words. */
export interface BrowserRecognitionSessionLike {
  finish(): Promise<string>;
  cancel(): void;
}

type SessionState = 'active' | 'finishing' | 'finished' | 'failed' | 'cancelled';

const resultAt = (results: SpeechRecognitionResultListLike, index: number): SpeechRecognitionResultLike | null =>
  results[index] ?? results.item?.(index) ?? null;

const alternativeAt = (result: SpeechRecognitionResultLike): SpeechRecognitionAlternativeLike | null =>
  result[0] ?? result.item?.(0) ?? null;

/** Result boundaries already carry whitespace in the spec; trim and join as a defensive fallback. */
export const joinRecognitionChunks = (chunks: readonly string[]): string =>
  chunks
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * One recognition object for one user utterance.
 *
 * Mobile engines may end a continuous session after a pause. While the reader
 * still sees Recording we restart the same object and retain the settled words;
 * Stop turns the next `end` into a single final transcript. Interim entries are
 * indexed and replaced according to `resultIndex`, so a provisional rewrite is
 * never appended as a duplicate.
 */
export class BrowserRecognitionSession implements BrowserRecognitionSessionLike {
  readonly #recognition: SpeechRecognitionLike;
  readonly #provider: BrowserRecognitionProvider;
  readonly #options: BrowserRecognitionSessionOptions;
  readonly #segments = new Map<number, string>();
  readonly #settled: string[] = [];
  #state: SessionState = 'active';
  #heardSpeech = false;
  #finishPromise: Promise<string> | null = null;
  #resolveFinish: ((text: string) => void) | null = null;
  #rejectFinish: ((failure: BrowserRecognitionError) => void) | null = null;
  #limitTimer: unknown = null;
  #stopTimer: unknown = null;
  #unwatchHidden: (() => void) | null = null;

  constructor(provider: BrowserRecognitionProvider, options: BrowserRecognitionSessionOptions) {
    this.#provider = provider;
    this.#options = options;
    this.#recognition = provider.create();
    this.#recognition.continuous = true;
    this.#recognition.interimResults = true;
    this.#recognition.lang = options.language ?? 'en-US';
    this.#recognition.maxAlternatives = 1;

    this.#recognition.onstart = () => this.#onStart();
    this.#recognition.onend = () => this.#onEnd();
    this.#recognition.onspeechstart = () => {
      this.#heardSpeech = true;
    };
    this.#recognition.onresult = event => this.#onResult(event);
    this.#recognition.onnomatch = () => {
      // Speech happened, but no hypothesis met the engine's threshold. This is
      // a failed transcription, not an empty microphone.
      this.#heardSpeech = true;
    };
    this.#recognition.onerror = event => this.#onError(event);
  }

  /** Must be called synchronously from the reader's gesture. */
  start(): void {
    this.#unwatchHidden = this.#provider.watchHidden(() => {
      if (this.#state !== 'active' && this.#state !== 'finishing') return;
      this.cancel();
      this.#options.onAbort();
    });
    try {
      this.#recognition.start();
    } catch (failure) {
      this.#state = 'failed';
      this.#cleanup();
      throw browserRecognitionErrorFrom(failure);
    }
  }

  finish(): Promise<string> {
    if (this.#state === 'finished') return Promise.resolve(this.#transcript());
    if (this.#state === 'failed') {
      return Promise.reject(
        new BrowserRecognitionError('recognition-failed', 'Speech recognition has already failed.'),
      );
    }
    if (this.#state === 'cancelled') {
      return Promise.reject(new BrowserRecognitionError('aborted', 'Speech recognition was cancelled.'));
    }
    if (this.#finishPromise !== null) return this.#finishPromise;

    this.#state = 'finishing';
    this.#clearLimitTimer();
    this.#finishPromise = new Promise<string>((resolve, reject) => {
      this.#resolveFinish = resolve;
      this.#rejectFinish = reject;
    });
    this.#stopTimer = this.#provider.setTimeout(
      () => {
        if (this.#state !== 'finishing') return;
        try {
          this.#recognition.abort();
        } catch {
          // The timeout failure below is the useful fact.
        }
        this.#fail(
          new BrowserRecognitionError('recognition-failed', 'The browser did not finish speech recognition in time.'),
        );
      },
      Math.max(1, this.#options.stopTimeoutMs ?? RECOGNITION_STOP_TIMEOUT_MS),
    );

    // The spec says stop is ignored until a started request exists. Older
    // WebKit instead throws in this narrow pending-start window; onstart calls
    // stop again, so that throw is deliberately ignored here.
    try {
      this.#recognition.stop();
    } catch {
      // See above.
    }
    return this.#finishPromise;
  }

  cancel(): void {
    if (this.#state === 'cancelled' || this.#state === 'finished') return;
    this.#state = 'cancelled';
    this.#clearTimers();
    try {
      this.#recognition.abort();
    } catch {
      // An already-ended engine has nothing left to release.
    }
    this.#rejectFinish?.(new BrowserRecognitionError('aborted', 'Speech recognition was cancelled.'));
    this.#resolveFinish = null;
    this.#rejectFinish = null;
    this.#cleanup();
  }

  #onStart(): void {
    if (this.#state === 'cancelled' || this.#state === 'failed' || this.#state === 'finished') return;
    if (this.#limitTimer === null) {
      this.#limitTimer = this.#provider.setTimeout(
        () => {
          if (this.#state === 'active') this.#options.onLimit();
        },
        Math.max(1, this.#options.maxDurationMs ?? MAX_BROWSER_DICTATION_MS),
      );
    }
    if (this.#state === 'finishing') {
      try {
        this.#recognition.stop();
      } catch (failure) {
        this.#fail(browserRecognitionErrorFrom(failure));
      }
      return;
    }
    this.#options.onStart();
  }

  #onResult(event: SpeechRecognitionResultEventLike): void {
    if (this.#state === 'cancelled' || this.#state === 'failed' || this.#state === 'finished') return;
    const firstChanged = Math.max(0, Math.min(event.resultIndex, event.results.length));
    for (const index of [...this.#segments.keys()]) {
      if (index >= firstChanged) this.#segments.delete(index);
    }
    for (let index = firstChanged; index < event.results.length; index += 1) {
      const result = resultAt(event.results, index);
      const transcript = result === null ? '' : alternativeAt(result)?.transcript;
      if (typeof transcript === 'string' && transcript.trim()) {
        this.#segments.set(index, transcript);
        this.#heardSpeech = true;
      }
    }
    this.#options.onTranscript(this.#transcript());
  }

  #onError(event: SpeechRecognitionErrorEventLike): void {
    if (this.#state === 'cancelled' || this.#state === 'failed' || this.#state === 'finished') return;
    if (event.error === 'no-speech') return;
    this.#fail(browserRecognitionErrorFrom(event));
  }

  #onEnd(): void {
    // A terminal cycle is over for good. Engines are free to emit a second
    // `end` after the one that settled the take (and after `abort()` during a
    // failure or a cancel), and running the settle path again would re-emit
    // `onTranscript` for words the controller has already inserted — into a
    // panel it has already closed, or on top of a failure the reader is
    // currently reading. Terminal states are checked HERE rather than inside
    // `#settleCycle` so the restart below cannot be reached either.
    if (this.#state === 'finished' || this.#state === 'failed' || this.#state === 'cancelled') return;
    this.#settleCycle();
    if (this.#state === 'finishing') {
      this.#settleFinish();
      return;
    }
    if (this.#state !== 'active') return;

    // Continuous recognition is advisory on several mobile engines. A natural
    // end while the UI still says Recording starts the next bounded cycle.
    try {
      this.#recognition.start();
    } catch (failure) {
      this.#fail(browserRecognitionErrorFrom(failure));
    }
  }

  #settleCycle(): void {
    const current = joinRecognitionChunks([...this.#segments.values()]);
    if (current) this.#settled.push(current);
    this.#segments.clear();
    this.#options.onTranscript(this.#transcript());
  }

  #settleFinish(): void {
    const text = this.#transcript();
    if (!text && this.#heardSpeech) {
      this.#fail(
        new BrowserRecognitionError('bad-audio', 'Speech was heard, but this browser could not turn it into words.'),
      );
      return;
    }
    this.#state = 'finished';
    this.#clearTimers();
    this.#resolveFinish?.(text);
    this.#resolveFinish = null;
    this.#rejectFinish = null;
    this.#cleanup();
  }

  #fail(failure: BrowserRecognitionError): void {
    if (this.#state === 'failed' || this.#state === 'finished' || this.#state === 'cancelled') return;
    this.#state = 'failed';
    this.#clearTimers();
    this.#rejectFinish?.(failure);
    this.#resolveFinish = null;
    this.#rejectFinish = null;
    this.#cleanup();
    this.#options.onFailure(failure);
  }

  #transcript(): string {
    return joinRecognitionChunks([...this.#settled, ...this.#segments.values()]);
  }

  #clearLimitTimer(): void {
    if (this.#limitTimer === null) return;
    this.#provider.clearTimeout(this.#limitTimer);
    this.#limitTimer = null;
  }

  #clearTimers(): void {
    this.#clearLimitTimer();
    if (this.#stopTimer === null) return;
    this.#provider.clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }

  #cleanup(): void {
    this.#unwatchHidden?.();
    this.#unwatchHidden = null;
  }
}
