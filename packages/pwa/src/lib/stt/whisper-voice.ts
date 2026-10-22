/**
 * WHISPER ON THIS DEVICE — the on-device voice service (`on-device-voice.ts`) over one Whisper catalog
 * entry: its store (`whisper-store.ts`), its worker (`whisper-engine.ts`) and its session
 * (`whisper-session.ts`). The registry (`on-device-voices.ts`) builds one per Whisper model; each has
 * its own worker, and the two share the transformers.js runtime binary on disk.
 *
 * Which engine dictation USES is the person's choice (`stt-settings.ts`, `engine`): this service is one
 * of the options, never a fallback chain.
 */

import { browserFetch } from '../runtime-models.ts';
import { trustedWorkerUrl } from '../trusted-types.ts';
import { type AudioCapturePort, browserAudioCapture, canCaptureAudio } from './audio-capture.ts';
import type { WhisperCatalogModel } from './model-catalog.ts';
import type { ModelInstaller } from './model-store.ts';
import { OnDeviceVoice, type OnDeviceSupport } from './on-device-voice.ts';
import type { ParakeetGlobalLike } from './parakeet-voice.ts';
import { WhisperEngine, type WhisperWorkerLike } from './whisper-engine.ts';
import { WhisperRecognitionSession } from './whisper-session.ts';
import { WhisperModelStore } from './whisper-store.ts';

/** Where the build put the Whisper worker and its runtime binary (bound in `src/main.tsx`). */
export interface WhisperAssets {
  readonly workerUrl: string;
  readonly runtimeUrl: string;
}

/** The parts a dictation session needs besides the model. */
interface WhisperSessionHost {
  readonly capture: AudioCapturePort;
  watchHidden(onHidden: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface WhisperVoiceOptions {
  readonly model: WhisperCatalogModel;
  readonly support: OnDeviceSupport;
  /** `null` exactly when unsupported. */
  readonly store: ModelInstaller | null;
  readonly engine:
    | (Pick<WhisperEngine, 'preload' | 'transcribe' | 'unload'> & Partial<Pick<WhisperEngine, 'consumeLoadMs'>>)
    | null;
  readonly host: WhisperSessionHost | null;
}

/** A Whisper model's on-device voice: the generic service over its store, worker and session. */
export function whisperVoice(options: WhisperVoiceOptions): OnDeviceVoice {
  const { model, engine, host } = options;
  return new OnDeviceVoice({
    model,
    support: options.support,
    store: options.store,
    openSession:
      engine === null || host === null
        ? null
        : sessionOptions =>
            new WhisperRecognitionSession({ ...host, engine, versionLabel: model.versionLabel }, sessionOptions),
    unload: () => engine?.unload(),
  });
}

/** The slice of the page the production service binds: the same one Parakeet's does. */
export type WhisperGlobalLike = ParakeetGlobalLike;

/** Whether this page can run a Whisper model, as data with the reason. */
export function readWhisperSupport(
  global: WhisperGlobalLike,
  assets: WhisperAssets | null | undefined,
  model: WhisperCatalogModel,
): OnDeviceSupport {
  const name = model.shortName;
  if (assets === null || assets === undefined)
    return { available: false, reason: `This copy of Ferretry was built without ${name}.` };
  if (global.isSecureContext !== true)
    return { available: false, reason: `${name} needs a secure HTTPS page in this browser.` };
  if (global.WebAssembly === undefined || typeof global.Worker !== 'function')
    return { available: false, reason: `This browser cannot run WebAssembly in a worker, which ${name} needs.` };
  if (global.caches === undefined)
    return {
      available: false,
      reason: 'This browser will not keep the speech model on this device (no Cache Storage).',
    };
  if (!canCaptureAudio(global))
    return { available: false, reason: 'This browser cannot record audio for on-device dictation.' };
  return { available: true };
}

/** The production service for one Whisper model, bound to this page. */
export function browserWhisperVoice(
  global: WhisperGlobalLike,
  assets: WhisperAssets | null | undefined,
  model: WhisperCatalogModel,
  runtimeInUse: () => boolean,
): OnDeviceVoice {
  const support = readWhisperSupport(global, assets, model);
  if (!support.available || assets === null || assets === undefined)
    return whisperVoice({ model, support, store: null, engine: null, host: null });
  const Worker = global.Worker as NonNullable<WhisperGlobalLike['Worker']>;
  const store = new WhisperModelStore({
    model,
    runtimeUrl: assets.runtimeUrl,
    caches: global.caches ?? null,
    fetch: browserFetch,
    storage: global.navigator?.storage ?? null,
    runtimeInUse,
  });
  // The worker script is the app's own, built beside it; Trusted Types accepts exactly that URL.
  const engine = new WhisperEngine(
    model.id,
    () =>
      new Worker(trustedWorkerUrl(assets.workerUrl), {
        type: 'module',
        name: `fy-${model.id}`,
      }) as unknown as WhisperWorkerLike,
  );
  const host: WhisperSessionHost = {
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
  return whisperVoice({ model, support, store, engine, host });
}
