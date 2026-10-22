/**
 * VOSK ON THIS DEVICE — the on-device voice service (`on-device-voice.ts`) over Vosk's catalog entry:
 * its pinned bundle in the generic store (`vosk-model.ts`, `model-store.ts`), its worker
 * (`vosk-engine.ts`) and its streaming session (`vosk-session.ts`).
 *
 * Which engine dictation USES is the person's choice (`stt-settings.ts`, `engine`): this service is one
 * of the options, never a fallback chain.
 */

import { browserFetch } from '../runtime-models.ts';
import { trustedWorkerUrl } from '../trusted-types.ts';
import { type AudioCapturePort, browserAudioCapture, canCaptureAudio } from './audio-capture.ts';
import { VOSK_CATALOG_MODEL } from './model-catalog.ts';
import { type ModelInstaller, PinnedModelStore } from './model-store.ts';
import { OnDeviceVoice, type OnDeviceSupport } from './on-device-voice.ts';
import type { ParakeetGlobalLike } from './parakeet-voice.ts';
import { VoskEngine, type VoskWorkerLike } from './vosk-engine.ts';
import { voskBundle } from './vosk-model.ts';
import { VoskRecognitionSession } from './vosk-session.ts';

/** Where the build put the Vosk worker and its WebAssembly runtime (bound in `src/main.tsx`). */
export interface VoskAssets {
  readonly workerUrl: string;
  readonly runtimeUrl: string;
}

/** The parts a dictation session needs besides the model. */
interface VoskSessionHost {
  readonly capture: AudioCapturePort;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface VoskVoiceOptions {
  readonly support: OnDeviceSupport;
  /** `null` exactly when unsupported. */
  readonly store: ModelInstaller | null;
  readonly engine:
    | (Pick<VoskEngine, 'preload' | 'open' | 'unload'> & Partial<Pick<VoskEngine, 'consumeLoadMs'>>)
    | null;
  readonly host: VoskSessionHost | null;
}

/** Vosk's on-device voice: the generic service over Vosk's store, worker and session. */
export class VoskVoice extends OnDeviceVoice {
  constructor(options: VoskVoiceOptions) {
    const { engine, host } = options;
    super({
      model: VOSK_CATALOG_MODEL,
      support: options.support,
      store: options.store,
      openSession:
        engine === null || host === null
          ? null
          : sessionOptions => new VoskRecognitionSession({ ...host, engine }, sessionOptions),
      unload: () => engine?.unload(),
    });
  }
}

/** The page this voice binds: the same slice Parakeet's does, so one page object serves both. */
export type VoskGlobalLike = ParakeetGlobalLike;

/** Whether this page can run Vosk, as data with the reason. */
export function readVoskSupport(global: VoskGlobalLike, assets: VoskAssets | null): OnDeviceSupport {
  if (assets === null)
    return { available: false, reason: 'This copy of Ferretry was built without the Vosk speech engine.' };
  if (global.isSecureContext !== true)
    return { available: false, reason: 'Vosk needs a secure HTTPS page in this browser.' };
  if (global.WebAssembly === undefined || typeof global.Worker !== 'function')
    return { available: false, reason: 'This browser cannot run WebAssembly in a worker, which Vosk needs.' };
  if (global.caches === undefined)
    return {
      available: false,
      reason: 'This browser will not keep the speech model on this device (no Cache Storage).',
    };
  if (!canCaptureAudio(global))
    return { available: false, reason: 'This browser cannot record audio for on-device dictation.' };
  return { available: true };
}

/** The production service, bound to this page. Nothing is downloaded until Install. */
export function browserVoskVoice(global: VoskGlobalLike, assets: VoskAssets | null): VoskVoice {
  const support = readVoskSupport(global, assets);
  if (!support.available || assets === null) return new VoskVoice({ support, store: null, engine: null, host: null });
  const Worker = global.Worker as unknown as new (url: string, options: WorkerOptions) => VoskWorkerLike;
  const store = new PinnedModelStore({
    bundle: voskBundle(assets.runtimeUrl),
    caches: global.caches ?? null,
    fetch: browserFetch,
    storage: global.navigator?.storage ?? null,
  });
  // The worker script is the app's own, built beside it; Trusted Types accepts exactly that URL.
  const engine = new VoskEngine(
    () => new Worker(trustedWorkerUrl(assets.workerUrl), { type: 'module', name: 'fy-vosk' }),
  );
  const host: VoskSessionHost = {
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
  return new VoskVoice({ support, store, engine, host });
}
