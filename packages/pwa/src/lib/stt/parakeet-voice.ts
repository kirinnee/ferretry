/**
 * PARAKEET ON THIS DEVICE — the one object the app holds for the on-device voice engine.
 *
 * It is a device-lifetime service (built once by `createAppStore`, like the dictation settings), and
 * it owns three things a screen or the dictation hook needs:
 *
 *   1. WHETHER THIS BROWSER CAN RUN IT AT ALL, as data with a sentence (`support`).
 *   2. THE INSTALL, as an observable snapshot — not installed, partly downloaded, downloading with
 *      progress, installed with its version and size — and the four things a person can do about it:
 *      Install, Cancel, Resume (Install again) and Remove. Nothing downloads unless Install is pressed.
 *   3. A DICTATION SESSION over the installed model (`parakeet-session.ts`), refused with an
 *      actionable reason when the model is not on this device — never a silent download.
 *
 * Which engine dictation USES is the person's choice (`stt-settings.ts`, `engine`): this service is
 * one of the two, never a fallback chain.
 */

import { browserFetch } from '../runtime-models.ts';
import { trustedWorkerUrl } from '../trusted-types.ts';
import {
  type AudioCaptureGlobalLike,
  type AudioCapturePort,
  browserAudioCapture,
  canCaptureAudio,
} from './audio-capture.ts';
import { BrowserRecognitionError } from './browser-recognition.ts';
import { ParakeetEngine, type ParakeetWorkerLike } from './parakeet-engine.ts';
import { formatMegabytes, PARAKEET_TOTAL_BYTES } from './parakeet-model.ts';
import { ParakeetRecognitionSession, type ParakeetSessionOptions } from './parakeet-session.ts';
import {
  type ParakeetCacheStorage,
  ParakeetInstallError,
  type ParakeetInstallErrorCode,
  ParakeetModelStore,
  type ParakeetStorageManager,
} from './parakeet-store.ts';

/** Where the build put the speech worker and the ONNX Runtime binary (bound in `src/main.tsx`). */
export interface ParakeetAssets {
  readonly workerUrl: string;
  readonly runtimeUrl: string;
}

export interface ParakeetSupport {
  readonly available: boolean;
  /** Ready-to-render, actionable copy when it is not. */
  readonly reason?: string;
}

type ParakeetPhase = 'unsupported' | 'checking' | 'absent' | 'partial' | 'installing' | 'installed' | 'removing';

export interface ParakeetInstallSnapshot {
  readonly phase: ParakeetPhase;
  readonly totalBytes: number;
  readonly downloadedBytes: number;
  /** While installing: the file in flight. */
  readonly label?: string;
  /** Once installed. */
  readonly version?: string;
  readonly installedAt?: string;
  /** The last install that failed, kept until the next attempt. A cancel is not a failure. */
  readonly error?: { readonly code: ParakeetInstallErrorCode | 'unknown'; readonly message: string };
  /** When unsupported: why, in a sentence. */
  readonly reason?: string;
}

/** The parts a dictation session needs besides the model. */
interface ParakeetSessionHost {
  readonly capture: AudioCapturePort;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ParakeetVoiceOptions {
  readonly support: ParakeetSupport;
  /** `null` exactly when unsupported. */
  readonly store: Pick<ParakeetModelStore, 'status' | 'install' | 'remove' | 'totalBytes'> | null;
  readonly engine:
    | (Pick<ParakeetEngine, 'preload' | 'transcribe' | 'transcribeTimed' | 'unload'> &
        Partial<Pick<ParakeetEngine, 'consumeLoadMs'>>)
    | null;
  readonly host: ParakeetSessionHost | null;
}

/** Progress is reported per network chunk; listeners hear about every 0.1 % at most. */
const PROGRESS_STEP = 1_000;

export class ParakeetVoice {
  readonly support: ParakeetSupport;
  readonly #options: ParakeetVoiceOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: ParakeetInstallSnapshot;
  #installing: Promise<void> | null = null;
  #controller: AbortController | null = null;

  constructor(options: ParakeetVoiceOptions) {
    this.#options = options;
    this.support = options.support;
    const totalBytes = options.store?.totalBytes ?? PARAKEET_TOTAL_BYTES;
    this.#snapshot = options.support.available
      ? { phase: 'checking', totalBytes, downloadedBytes: 0 }
      : {
          phase: 'unsupported',
          totalBytes,
          downloadedBytes: 0,
          reason: options.support.reason ?? 'This browser cannot run Parakeet.',
        };
  }

  readonly getSnapshot = (): ParakeetInstallSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Re-read what is stored. Leaves a download in progress alone. */
  async refresh(): Promise<void> {
    const store = this.#options.store;
    if (store === null || this.#installing !== null) return;
    const status = await store.status().catch(() => ({ state: 'absent' as const }));
    if (this.#installing !== null) return;
    const error = this.#snapshot.error;
    const base = { totalBytes: store.totalBytes, ...(error === undefined ? {} : { error }) };
    if (status.state === 'installed')
      this.#publish({
        phase: 'installed',
        totalBytes: status.bytes,
        downloadedBytes: status.bytes,
        version: status.version,
        installedAt: status.installedAt,
      });
    else if (status.state === 'partial')
      this.#publish({ ...base, phase: 'partial', downloadedBytes: status.downloadedBytes });
    else this.#publish({ ...base, phase: 'absent', downloadedBytes: 0 });
  }

  /** Download (or resume) the model. Only ever called from a button the person pressed. */
  install(): Promise<void> {
    const store = this.#options.store;
    if (store === null) return Promise.resolve();
    if (this.#installing !== null) return this.#installing;
    const controller = new AbortController();
    this.#controller = controller;
    this.#publish({
      phase: 'installing',
      totalBytes: store.totalBytes,
      downloadedBytes: this.#snapshot.downloadedBytes,
    });
    const run = (async () => {
      let failure: ParakeetInstallSnapshot['error'];
      try {
        await store.install({
          signal: controller.signal,
          onProgress: progress => {
            const previous = this.#snapshot;
            const moved = progress.downloadedBytes - previous.downloadedBytes;
            if (previous.label === progress.label && moved < progress.totalBytes / PROGRESS_STEP) return;
            this.#publish({
              phase: 'installing',
              totalBytes: progress.totalBytes,
              downloadedBytes: progress.downloadedBytes,
              label: progress.label,
            });
          },
        });
      } catch (error) {
        const code = error instanceof ParakeetInstallError ? error.code : 'unknown';
        if (code !== 'cancelled')
          failure = {
            code,
            message: error instanceof Error ? error.message : 'Parakeet could not be installed.',
          };
      } finally {
        this.#installing = null;
        this.#controller = null;
      }
      const { error: _previous, ...rest } = this.#snapshot;
      this.#snapshot = failure === undefined ? rest : { ...rest, error: failure };
      await this.refresh();
    })();
    this.#installing = run;
    return run;
  }

  /** Stop a download. Every finished part is kept, so Install resumes. */
  cancel(): void {
    this.#controller?.abort();
  }

  /** Delete the model from this device and unload it from memory. */
  async remove(): Promise<void> {
    const store = this.#options.store;
    if (store === null) return;
    this.cancel();
    await this.#installing;
    this.#options.engine?.unload();
    this.#publish({ phase: 'removing', totalBytes: store.totalBytes, downloadedBytes: this.#snapshot.downloadedBytes });
    await store.remove().catch(() => undefined);
    this.#snapshot = { phase: 'removing', totalBytes: store.totalBytes, downloadedBytes: 0 };
    await this.refresh();
  }

  /**
   * One dictation over the installed model. Throws, before the microphone opens, when this device
   * cannot or has not installed it — dictation never downloads.
   */
  createSession(options: ParakeetSessionOptions): ParakeetRecognitionSession {
    const { engine, host } = this.#options;
    if (!this.support.available || engine === null || host === null)
      throw new BrowserRecognitionError(
        'recognition-unavailable',
        this.#snapshot.reason ?? 'This browser cannot run Parakeet.',
      );
    const snapshot = this.#snapshot;
    if (snapshot.phase === 'installing')
      throw new BrowserRecognitionError(
        'model-not-installed',
        `Parakeet is still downloading (${formatMegabytes(snapshot.downloadedBytes)} of ${formatMegabytes(snapshot.totalBytes)}). Dictate again when it finishes.`,
      );
    if (snapshot.phase === 'absent' || snapshot.phase === 'partial' || snapshot.phase === 'removing')
      throw new BrowserRecognitionError(
        'model-not-installed',
        'Parakeet is not installed on this device yet. Install it in Settings › Voice, or choose phone/browser voice there.',
      );
    return new ParakeetRecognitionSession({ ...host, engine }, options);
  }

  #publish(snapshot: ParakeetInstallSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The slice of the page the production service binds. */
export interface ParakeetGlobalLike extends AudioCaptureGlobalLike {
  readonly isSecureContext?: unknown;
  readonly caches?: ParakeetCacheStorage;
  readonly WebAssembly?: unknown;
  readonly Worker?: new (url: string, options: { type: 'module'; name: string }) => ParakeetWorkerLike;
  readonly navigator?: AudioCaptureGlobalLike['navigator'] & { readonly storage?: ParakeetStorageManager };
  readonly document?: {
    readonly visibilityState?: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  readonly performance?: { now(): number };
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Whether this page can run Parakeet, as data with the reason. */
export function readParakeetSupport(global: ParakeetGlobalLike, assets: ParakeetAssets | null): ParakeetSupport {
  if (assets === null)
    return { available: false, reason: 'This copy of Ferretry was built without the on-device speech engine.' };
  if (global.isSecureContext !== true)
    return { available: false, reason: 'Parakeet needs a secure HTTPS page in this browser.' };
  if (global.WebAssembly === undefined || typeof global.Worker !== 'function')
    return { available: false, reason: 'This browser cannot run WebAssembly in a worker, which Parakeet needs.' };
  if (global.caches === undefined)
    return {
      available: false,
      reason: 'This browser will not keep the speech model on this device (no Cache Storage).',
    };
  if (!canCaptureAudio(global))
    return { available: false, reason: 'This browser cannot record audio for on-device dictation.' };
  return { available: true };
}

/** The production service, bound to this page. */
export function browserParakeetVoice(global: ParakeetGlobalLike, assets: ParakeetAssets | null): ParakeetVoice {
  const support = readParakeetSupport(global, assets);
  if (!support.available || assets === null)
    return new ParakeetVoice({ support, store: null, engine: null, host: null });
  const Worker = global.Worker as NonNullable<ParakeetGlobalLike['Worker']>;
  const store = new ParakeetModelStore({
    caches: global.caches ?? null,
    fetch: browserFetch,
    runtimeUrl: assets.runtimeUrl,
    storage: global.navigator?.storage ?? null,
  });
  // The worker script is the app's own, built beside it; Trusted Types accepts exactly that URL.
  const engine = new ParakeetEngine(
    () => new Worker(trustedWorkerUrl(assets.workerUrl), { type: 'module', name: 'fy-parakeet' }),
  );
  const host: ParakeetSessionHost = {
    capture: browserAudioCapture(global),
    watchHidden: onHidden => {
      const document = global.document;
      if (document === undefined) return () => undefined;
      const listener = (): void => {
        if (document.visibilityState === 'hidden') onHidden();
      };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    setTimeout: (callback, milliseconds) => global.setTimeout(callback, milliseconds),
    clearTimeout: handle => global.clearTimeout(handle),
    now: () => global.performance?.now() ?? Date.now(),
  };
  return new ParakeetVoice({ support, store, engine, host });
}
