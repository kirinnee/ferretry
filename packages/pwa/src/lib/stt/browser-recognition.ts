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

import type { SessionTimings } from './dictation-timeline.ts';
import type { CaptureMonitor } from './level-monitor.ts';

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
  /** True on Android, whose speech service gets its own wording when it returns no words. Absent means no. */
  readonly android?: boolean;
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
    android: /Android/u.test(userAgentOf(global)),
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
  /** The on-device engine was chosen, but its model is not on this device. */
  | 'model-not-installed'
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
/**
 * How long a Stop that ended with speech heard but no words waits for a late `result`. Android Chrome's
 * speech service is documented to deliver the last hypothesis after, or without, the `end` the page
 * sees, so "empty at the first `end`" is not yet "nothing was recognised".
 */
const LATE_RESULT_GRACE_MS = 1_200;
/** Once a late result lands, the quiet that must follow before the take settles (more may be on its way). */
const LATE_RESULT_QUIET_MS = 300;

export interface BrowserRecognitionSessionOptions {
  readonly language?: string;
  readonly maxDurationMs?: number;
  readonly stopTimeoutMs?: number;
  onStart(): void;
  onTranscript(text: string): void;
  onFailure(failure: BrowserRecognitionError): void;
  onAbort(): void;
  onLimit(): void;
  /**
   * The microphone's level tap, once the microphone is open, and `null` when it closes. Optional and
   * visual only: a session that cannot offer one simply never calls it.
   */
  onMonitor?(monitor: CaptureMonitor | null): void;
}

/** The controller-facing slice. `finish` stops capture and settles the words. */
export interface BrowserRecognitionSessionLike {
  finish(): Promise<string>;
  cancel(): void;
  /** What this session measured about its own last `finish`. Optional: a session that measures nothing omits it. */
  timings?(): SessionTimings | undefined;
}

type SessionState = 'active' | 'finishing' | 'finished' | 'failed' | 'cancelled';

const resultAt = (results: SpeechRecognitionResultListLike, index: number): SpeechRecognitionResultLike | null =>
  results[index] ?? results.item?.(index) ?? null;

const alternativeAt = (result: SpeechRecognitionResultLike): SpeechRecognitionAlternativeLike | null =>
  result[0] ?? result.item?.(0) ?? null;

interface RecognitionChunk {
  readonly text: string;
  readonly final: boolean;
}

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

const startsWithWords = (words: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= words.length && prefix.every((word, index) => words[index] === word);

/**
 * Collapse the cumulative re-emission Android Chrome performs: each result repeats everything said so
 * far, often at a new index and sometimes across a restart. A chunk that restates its predecessor
 * (a word-wise prefix) replaces it. A lone-word FINAL predecessor is kept only when the next chunk
 * opens with the whitespace that marks a new segment; everything else is treated as a rewrite.
 * The whole of what came before is compared too, which catches a restarted cycle replaying it all.
 */
export const mergeRecognitionChunks = (chunks: readonly RecognitionChunk[]): string => {
  const out: RecognitionChunk[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (!text) continue;
    const words = wordsOf(text);
    const earlier = wordsOf(out.map(item => item.text).join(' '));
    if (earlier.length >= 2 && startsWithWords(words, earlier)) {
      out.length = 0;
      out.push({ text, final: chunk.final });
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined) {
      const lastWords = wordsOf(last.text);
      // A raw chunk that opens with whitespace is the engine marking a NEW segment, so a lone final
      // word before it stays: "no" … " no way" are two utterances, "hello" … "hello there" is one.
      const newSegment = /^\s/u.test(chunk.text);
      if ((lastWords.length >= 2 || !last.final || !newSegment) && startsWithWords(words, lastWords)) {
        out[out.length - 1] = { text, final: chunk.final };
        continue;
      }
    }
    out.push({ text, final: chunk.final });
  }
  return joinRecognitionChunks(out.map(item => item.text));
};

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
  readonly #segments = new Map<number, RecognitionChunk>();
  readonly #settled: string[] = [];
  #state: SessionState = 'active';
  #heardSpeech = false;
  #noMatch = false;
  #graceTimer: unknown = null;
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
      // a failed transcription, not an empty microphone, and the engine has
      // already said so: there is no late result to wait for.
      this.#heardSpeech = true;
      this.#noMatch = true;
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
        // `#fail` owns releasing the engine, so the unsettled Stop is closed
        // by the same code path as every other terminal failure.
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
        this.#segments.set(index, { text: transcript, final: result?.isFinal === true });
        this.#heardSpeech = true;
      }
    }
    // A result landing in the grace window is the late hypothesis it was waiting for.
    if (this.#graceTimer !== null && this.#segments.size > 0) this.#armGrace(LATE_RESULT_QUIET_MS);
    this.#options.onTranscript(this.#transcript());
  }

  #onError(event: SpeechRecognitionErrorEventLike): void {
    if (this.#state === 'cancelled' || this.#state === 'failed' || this.#state === 'finished') return;
    if (event.error === 'no-speech') return;
    // Android reports `aborted` and `network` AFTER it has already heard the user, typically while
    // it wraps up a Stop. A reader who pressed Stop keeps what was recognised: the `end` that follows
    // settles it. While still recording, an abort is somebody else taking the microphone and stays a
    // cancellation; only an error with nothing to keep fails a finishing take.
    if (this.#state === 'finishing' && (event.error === 'aborted' || event.error === 'network') && this.#hasWords()) {
      return;
    }
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
    if (this.#graceTimer !== null) return;
    this.#settleCycle();
    if (this.#state === 'finishing') {
      this.#settleFinish(true);
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
    const current = mergeRecognitionChunks([...this.#segments.values()]);
    if (current) this.#settled.push(current);
    this.#segments.clear();
    this.#options.onTranscript(this.#transcript());
  }

  #armGrace(milliseconds: number): void {
    if (this.#graceTimer !== null) this.#provider.clearTimeout(this.#graceTimer);
    this.#graceTimer = this.#provider.setTimeout(() => {
      this.#graceTimer = null;
      if (this.#state !== 'finishing') return;
      this.#settleCycle();
      this.#settleFinish(false);
    }, milliseconds);
  }

  #settleFinish(mayWait: boolean): void {
    const text = this.#transcript();
    if (!text && this.#heardSpeech && !this.#noMatch && mayWait) {
      this.#armGrace(LATE_RESULT_GRACE_MS);
      return;
    }
    if (!text && this.#heardSpeech) {
      this.#fail(
        new BrowserRecognitionError(
          'bad-audio',
          this.#provider.android === true
            ? "Android's speech service returned no words."
            : 'Speech was heard, but this browser could not turn it into words.',
        ),
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
    // Web Speech imposes no order between `error` and `end`, so a terminal
    // error can arrive after the `end` that already opened the next mobile
    // cycle. Failing without releasing the engine would leave a live
    // microphone with no owner while the reader is told recognition stopped.
    // The state above is already terminal, so the `aborted` callbacks this
    // triggers are refused by `#onError` and `#onEnd`: they can neither
    // replace this failure nor restart another cycle. Both event orders
    // therefore end in the same place.
    try {
      this.#recognition.abort();
    } catch {
      // An already-ended engine has nothing left to release.
    }
    this.#rejectFinish?.(failure);
    this.#resolveFinish = null;
    this.#rejectFinish = null;
    this.#cleanup();
    this.#options.onFailure(failure);
  }

  #hasWords(): boolean {
    return this.#settled.length > 0 || this.#segments.size > 0;
  }

  #transcript(): string {
    return mergeRecognitionChunks([...this.#settled.map(text => ({ text, final: true })), ...this.#segments.values()]);
  }

  #clearLimitTimer(): void {
    if (this.#limitTimer === null) return;
    this.#provider.clearTimeout(this.#limitTimer);
    this.#limitTimer = null;
  }

  #clearTimers(): void {
    this.#clearLimitTimer();
    if (this.#graceTimer !== null) {
      this.#provider.clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    if (this.#stopTimer === null) return;
    this.#provider.clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }

  #cleanup(): void {
    this.#unwatchHidden?.();
    this.#unwatchHidden = null;
  }
}
