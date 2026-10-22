/**
 * ONE ON-DEVICE SPEECH MODEL ON THIS DEVICE — the object the app holds per catalog entry
 * (`model-catalog.ts`), generalised from Parakeet's service, which is now one of these
 * (`parakeet-voice.ts`).
 *
 * It owns three things a screen or the dictation hook needs:
 *
 *   1. WHETHER THIS BROWSER CAN RUN IT AT ALL, as data with a sentence (`support`).
 *   2. THE INSTALL, as an observable snapshot — not installed, partly downloaded, downloading with
 *      progress, installed with its version and size — and the four things a person can do about it:
 *      Install, Cancel, Resume (Install again) and Remove. Nothing downloads unless Install is pressed.
 *   3. A DICTATION SESSION over the installed model, refused with an actionable reason when the model
 *      is not on this device — never a silent download.
 *
 * Which engine dictation USES is the person's choice (`stt-settings.ts`, `engine`): every service here
 * is one option among several, never a fallback chain.
 */

import {
  BrowserRecognitionError,
  type BrowserRecognitionSessionLike,
  type BrowserRecognitionSessionOptions,
} from './browser-recognition.ts';
import { modelDownloadBytes, type OnDeviceModel } from './model-catalog.ts';
import { formatMegabytes, ModelInstallError, type ModelInstallErrorCode, type ModelInstaller } from './model-store.ts';
import type { NearLiveState } from './near-live.ts';

export interface OnDeviceSupport {
  readonly available: boolean;
  /** Ready-to-render, actionable copy when it is not. */
  readonly reason?: string;
}

type OnDevicePhase = 'unsupported' | 'checking' | 'absent' | 'partial' | 'installing' | 'installed' | 'removing';

export interface OnDeviceInstallSnapshot {
  readonly phase: OnDevicePhase;
  readonly totalBytes: number;
  readonly downloadedBytes: number;
  /** While installing: the file in flight. */
  readonly label?: string;
  /** Once installed. */
  readonly version?: string;
  readonly installedAt?: string;
  /** The last install that failed, kept until the next attempt. A cancel is not a failure. */
  readonly error?: { readonly code: ModelInstallErrorCode | 'unknown'; readonly message: string };
  /** When unsupported: why, in a sentence. */
  readonly reason?: string;
}

/** What only an on-device session can do on top of the browser-speech contract. */
export interface OnDeviceSessionOptions extends BrowserRecognitionSessionOptions {
  /** Near-live words while recording, where the model offers them (the per-device "Live words" setting). */
  readonly liveWords?: boolean;
  /** Committed and interim words as they change. Never the output seam: Stop's result is. */
  onLive?(state: NearLiveState): void;
}

/** A session `use-dictation.ts` can drive: `start` from the gesture, then `finish` or `cancel`. */
export type OnDeviceSession = BrowserRecognitionSessionLike & { start(): void };

export interface OnDeviceVoiceOptions {
  readonly model: OnDeviceModel;
  readonly support: OnDeviceSupport;
  /** `null` exactly when unsupported. */
  readonly store: ModelInstaller | null;
  /** Opens one dictation over the installed model; `null` exactly when unsupported. */
  readonly openSession: ((options: OnDeviceSessionOptions) => OnDeviceSession) | null;
  /** Frees the model's memory (terminates its worker). */
  unload?(): void;
}

/** Progress is reported per network chunk; listeners hear about every 0.1 % at most. */
const PROGRESS_STEP = 1_000;

export class OnDeviceVoice {
  readonly model: OnDeviceModel;
  readonly support: OnDeviceSupport;
  readonly #options: OnDeviceVoiceOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: OnDeviceInstallSnapshot;
  #installing: Promise<void> | null = null;
  #controller: AbortController | null = null;

  constructor(options: OnDeviceVoiceOptions) {
    this.#options = options;
    this.model = options.model;
    this.support = options.support;
    const totalBytes = options.store?.totalBytes ?? modelDownloadBytes(options.model);
    this.#snapshot = options.support.available
      ? { phase: 'checking', totalBytes, downloadedBytes: 0 }
      : {
          phase: 'unsupported',
          totalBytes,
          downloadedBytes: 0,
          reason: options.support.reason ?? `This browser cannot run ${options.model.shortName}.`,
        };
  }

  readonly getSnapshot = (): OnDeviceInstallSnapshot => this.#snapshot;

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
      let failure: OnDeviceInstallSnapshot['error'];
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
        const code = error instanceof ModelInstallError ? error.code : 'unknown';
        if (code !== 'cancelled')
          failure = {
            code,
            message: error instanceof Error ? error.message : `${this.model.shortName} could not be installed.`,
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
    this.#options.unload?.();
    this.#publish({ phase: 'removing', totalBytes: store.totalBytes, downloadedBytes: this.#snapshot.downloadedBytes });
    await store.remove().catch(() => undefined);
    this.#snapshot = { phase: 'removing', totalBytes: store.totalBytes, downloadedBytes: 0 };
    await this.refresh();
  }

  /** Free the model's memory without touching what is stored. */
  unload(): void {
    this.#options.unload?.();
  }

  /**
   * One dictation over the installed model. Throws, before the microphone opens, when this device
   * cannot or has not installed it — dictation never downloads.
   */
  createSession(options: OnDeviceSessionOptions): OnDeviceSession {
    const open = this.#options.openSession;
    const name = this.model.shortName;
    if (!this.support.available || open === null)
      throw new BrowserRecognitionError(
        'recognition-unavailable',
        this.#snapshot.reason ?? `This browser cannot run ${name}.`,
      );
    const snapshot = this.#snapshot;
    if (snapshot.phase === 'installing')
      throw new BrowserRecognitionError(
        'model-not-installed',
        `${name} is still downloading (${formatMegabytes(snapshot.downloadedBytes)} of ${formatMegabytes(snapshot.totalBytes)}). Dictate again when it finishes.`,
      );
    if (snapshot.phase === 'absent' || snapshot.phase === 'partial' || snapshot.phase === 'removing')
      throw new BrowserRecognitionError(
        'model-not-installed',
        `${name} is not installed on this device yet. Install it in Settings › Voice, or choose phone/browser voice there.`,
      );
    return open(options);
  }

  #publish(snapshot: OnDeviceInstallSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }
}
