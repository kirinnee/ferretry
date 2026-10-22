/**
 * PARAKEET ON THIS DEVICE — the on-device voice service (`on-device-voice.ts`) over Parakeet's catalog
 * entry: its store (`parakeet-store.ts`), its worker (`parakeet-engine.ts`) and its session
 * (`parakeet-session.ts`), with near-live words.
 *
 * Which engine dictation USES is the person's choice (`stt-settings.ts`, `engine`): this service is
 * one of the options, never a fallback chain.
 */

import { browserFetch } from '../runtime-models.ts';
import { trustedWorkerUrl } from '../trusted-types.ts';
import {
  type AudioCaptureGlobalLike,
  type AudioCapturePort,
  browserAudioCapture,
  canCaptureAudio,
} from './audio-capture.ts';
import { PARAKEET_CATALOG_MODEL } from './model-catalog.ts';
import type { OnDeviceInstallSnapshot, OnDeviceSupport } from './on-device-voice.ts';
import { OnDeviceVoice } from './on-device-voice.ts';
import { ParakeetEngine, type ParakeetWorkerLike } from './parakeet-engine.ts';
import { ParakeetRecognitionSession, type ParakeetSessionOptions } from './parakeet-session.ts';
import { type ParakeetCacheStorage, ParakeetModelStore, type ParakeetStorageManager } from './parakeet-store.ts';

/** Where the build put the speech worker and the ONNX Runtime binary (bound in `src/main.tsx`). */
export interface ParakeetAssets {
  readonly workerUrl: string;
  readonly runtimeUrl: string;
}

export type ParakeetSupport = OnDeviceSupport;

export type ParakeetInstallSnapshot = OnDeviceInstallSnapshot;

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

/** Parakeet's on-device voice: the generic service over Parakeet's store, worker and session. */
export class ParakeetVoice extends OnDeviceVoice {
  constructor(options: ParakeetVoiceOptions) {
    const { engine, host } = options;
    super({
      model: PARAKEET_CATALOG_MODEL,
      support: options.support,
      store: options.store,
      openSession:
        engine === null || host === null
          ? null
          : sessionOptions => new ParakeetRecognitionSession({ ...host, engine }, sessionOptions),
      unload: () => engine?.unload(),
    });
  }

  /** One dictation over the installed model; see {@link OnDeviceVoice.createSession}. */
  override createSession(options: ParakeetSessionOptions): ParakeetRecognitionSession {
    return super.createSession(options) as ParakeetRecognitionSession;
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
