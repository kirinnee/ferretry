/**
 * A SHERPA MODEL ON THIS DEVICE — the on-device voice (`on-device-voice.ts`) for one sherpa-onnx
 * catalog entry (`sherpa-models.ts`): its install is the shared runtime's bundle plus the model's own
 * (`bundle-set.ts`), it runs in its own sherpa worker (`sherpa-engine.ts`), and a streaming model
 * dictates through a streaming session (`streaming-session.ts`) that shows words while you speak; a
 * whole-take model (Moonshine, Parakeet 110M) records and decodes once on Stop.
 */

import { browserFetch } from '../runtime-models.ts';
import { trustedWorkerUrl } from '../trusted-types.ts';
import { BrowserRecognitionError, browserRecognitionErrorFrom } from './browser-recognition.ts';
import { BundleSetInstaller } from './bundle-set.ts';
import { modelBundle, runtimeBundle } from './model-catalog.ts';
import { type ModelCacheStorage, type ModelStorageManager, PinnedModelStore } from './model-store.ts';
import { browserSessionHost, type OnDeviceHostGlobalLike, readOnDeviceSupport } from './on-device-host.ts';
import { OnDeviceVoice } from './on-device-voice.ts';
import { ParakeetRecognitionSession } from './parakeet-session.ts';
import { SherpaEngine, SherpaEngineError, type SherpaWorkerLike } from './sherpa-engine.ts';
import { SHERPA_RUNTIME, type SherpaCatalogModel } from './sherpa-models.ts';
import { StreamingRecognitionSession } from './streaming-session.ts';

/** Where the build put the sherpa worker and the sherpa-onnx WebAssembly binary (bound in `src/main.tsx`). */
export interface SherpaAssets {
  readonly workerUrl: string;
  readonly runtimeUrl: string;
}

/** The slice of the page a sherpa voice binds. */
export interface SherpaGlobalLike extends OnDeviceHostGlobalLike {
  readonly caches?: ModelCacheStorage;
  readonly Worker?: new (url: string, options: { type: 'module'; name: string }) => SherpaWorkerLike;
  readonly navigator?: OnDeviceHostGlobalLike['navigator'] & { readonly storage?: ModelStorageManager };
}

/** Engine failures → the dictation panel's vocabulary. */
export const sherpaFailure = (error: unknown): BrowserRecognitionError => {
  if (error instanceof SherpaEngineError) {
    if (error.code === 'cancelled') return new BrowserRecognitionError('aborted', error.message);
    if (error.code === 'not-installed') return new BrowserRecognitionError('model-not-installed', error.message);
    return new BrowserRecognitionError('recognition-failed', error.message);
  }
  return browserRecognitionErrorFrom(error);
};

/**
 * The production voice for one sherpa model, bound to this page. `sharedStillNeeded` answers, at
 * Remove, whether another installed sherpa model still needs the shared runtime.
 */
export function browserSherpaVoice(
  model: SherpaCatalogModel,
  global: SherpaGlobalLike,
  assets: SherpaAssets | null,
  sharedStillNeeded: () => boolean,
): OnDeviceVoice {
  const support = readOnDeviceSupport(global, assets !== null, model.shortName);
  const runtime = assets === null ? null : runtimeBundle(SHERPA_RUNTIME, assets.runtimeUrl);
  const Worker = global.Worker;
  if (!support.available || assets === null || runtime === null || Worker === undefined)
    return new OnDeviceVoice({ model, support, store: null, openSession: null });
  const storeOptions = {
    caches: global.caches ?? null,
    fetch: browserFetch,
    storage: global.navigator?.storage ?? null,
  };
  const store = new BundleSetInstaller({
    parts: [
      { installer: new PinnedModelStore({ ...storeOptions, bundle: runtime }), shared: true },
      { installer: new PinnedModelStore({ ...storeOptions, bundle: modelBundle(model) }), shared: false },
    ],
    sharedStillNeeded,
  });
  // The worker script is the app's own, built beside it; Trusted Types accepts exactly that URL.
  const engine = new SherpaEngine(
    () => new Worker(trustedWorkerUrl(assets.workerUrl), { type: 'module', name: `fy-${model.id}` }),
    model.id,
  );
  const host = browserSessionHost(global);
  return new OnDeviceVoice({
    model,
    support,
    store,
    openSession: options =>
      model.streaming
        ? new StreamingRecognitionSession(
            { ...host, engine, model: model.versionLabel, failure: sherpaFailure },
            options,
          )
        : // A whole-take model: record, then decode once on Stop — Parakeet's session, without near-live words.
          new ParakeetRecognitionSession(
            { ...host, engine, model: model.versionLabel, failure: sherpaFailure },
            { ...options, liveWords: false },
          ),
    unload: () => engine.unload(),
  });
}
