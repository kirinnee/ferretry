/**
 * THE GOOGLE TRANSCRIBER ON THIS DEVICE — the on-device voice (`on-device-voice.ts`) for the one MediaPipe catalog entry
 * (`google-transcriber-model.ts`): its install is the shared MediaPipe runtime's bundle plus the model's own
 * (`bundle-set.ts`), it runs in its own worker (`app/worker/google-worker.ts`) that speaks the sherpa worker's protocol —
 * so the page side is `SherpaEngine`, unchanged — and it dictates through a streaming session
 * (`streaming-session.ts`): words appear while the person speaks, settled ones first.
 */

import { browserFetch, trustedWorkerUrl } from '../../shell-voice.ts';
import { runtimeAndModelInstaller } from './bundle-set.ts';
import { GOOGLE_TRANSCRIBER_MODEL, MEDIAPIPE_AUDIO_RUNTIME } from './google-transcriber-model.ts';
import { modelBundle, runtimeBundle } from './model-catalog.ts';
import { browserSessionHost, readOnDeviceSupport } from './on-device-host.ts';
import { OnDeviceVoice } from './on-device-voice.ts';
import { SherpaEngine } from './sherpa-engine.ts';
import { type SherpaAssets, type SherpaGlobalLike, sherpaFailure } from './sherpa-voice.ts';
import { StreamingRecognitionSession } from './streaming-session.ts';

/** Where the build put the Google worker and the MediaPipe WebAssembly binary: a worker URL and a runtime URL, like sherpa's. */
export type GoogleAssets = SherpaAssets;

/**
 * The production voice for the Google transcriber, bound to this page. `sharedStillNeeded` answers, at Remove, whether
 * another installed model still needs the shared runtime (none does today: it is the only MediaPipe model).
 */
export function browserGoogleVoice(
  global: SherpaGlobalLike,
  assets: GoogleAssets | null,
  sharedStillNeeded: () => boolean,
): OnDeviceVoice {
  const model = GOOGLE_TRANSCRIBER_MODEL;
  const support = readOnDeviceSupport(global, assets !== null, model.shortName);
  const runtime = assets === null ? null : runtimeBundle(MEDIAPIPE_AUDIO_RUNTIME, assets.runtimeUrl);
  const Worker = global.Worker;
  if (!support.available || assets === null || runtime === null || Worker === undefined)
    return new OnDeviceVoice({ model, support, store: null, openSession: null });
  const store = runtimeAndModelInstaller(
    runtime,
    modelBundle(model),
    { caches: global.caches ?? null, fetch: browserFetch, storage: global.navigator?.storage ?? null },
    sharedStillNeeded,
  );
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
      new StreamingRecognitionSession({ ...host, engine, model: model.versionLabel, failure: sherpaFailure }, options),
    unload: () => engine.unload(),
  });
}
