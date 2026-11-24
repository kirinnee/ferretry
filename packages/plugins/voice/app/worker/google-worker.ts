/**
 * THE GOOGLE TRANSCRIBER WORKER — the composition root of on-device dictation with Google's AudioTranscriber, built by
 * Vite to `/assets/google-worker-<hash>.js` (`speech-assets.ts` names it).
 *
 * Wiring only, like `sherpa-worker.ts`: what the worker does with each message is decided in
 * `lib/stt/google-worker-core.ts`, and where its bytes come from in `lib/stt/model-store.ts`. This file binds MediaPipe's
 * `AudioTranscriber` to the core's runtime port, and is outside both coverage ledgers because it runs only inside a
 * browser worker.
 *
 * NO NETWORK, NO CDN. The worker never downloads. The WebAssembly binary is compiled from verified BYTES by Emscripten's
 * own `Module.instantiateWasm` hook (MediaPipe's loader keeps a `Module` set before the task is created), so it never
 * resolves or fetches a URL — a `blob:` URL would be refused by the page's `connect-src` — and the model is handed over
 * as the verified bytes of this device's install, re-hashed on the way out. Only the JavaScript loader is a URL: the app's own
 * build output, imported as a module, which `useModule` selects.
 *
 * CPU, not GPU: the model card recommends the CPU delegate, and it is the one measured.
 */

import { AudioTranscriber } from '@mediapipe/tasks-audio';
import loaderUrl from '@mediapipe/tasks-audio/audio_wasm_module_internal.js?url';
import { MEDIAPIPE_AUDIO_RUNTIME } from '../lib/stt/google-transcriber-model.ts';
import { type GoogleTranscriberPort, GoogleWorkerCore } from '../lib/stt/google-worker-core.ts';
import { modelBundle, runtimeBundle } from '../lib/stt/model-catalog.ts';
import { type ModelCacheStorage, PinnedModelStore } from '../lib/stt/model-store.ts';
import type { SherpaWorkerReply } from '../lib/stt/sherpa-worker-core.ts';

interface WorkerScope {
  readonly caches: ModelCacheStorage;
  readonly performance: { now(): number };
  Module?:
    | { instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void): void }
    | undefined;
  postMessage(message: SherpaWorkerReply): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/** The worker has no network path: a read that tried to fetch would be a bug, so it fails loudly. */
async function refuse(): Promise<Response> {
  throw new Error('the speech worker never downloads');
}

const storeOf = (bundle: NonNullable<ReturnType<typeof runtimeBundle>>): PinnedModelStore =>
  new PinnedModelStore({ bundle, caches: scope.caches, fetch: refuse });

const core = new GoogleWorkerCore({
  read: async model => {
    // The runtime URL is irrelevant here: reading names files by role, never fetches.
    const runtimeStore = runtimeBundle(MEDIAPIPE_AUDIO_RUNTIME, '');
    if (runtimeStore === null) throw new Error('the MediaPipe runtime has no bundle of its own');
    const runtime = (await storeOf(runtimeStore).read()).get('runtime') ?? new Uint8Array();
    const model_ = (await storeOf(modelBundle(model)).read()).get('model') ?? new Uint8Array();
    return { runtime, model: model_ };
  },
  runtime: {
    load: async (runtime, model): Promise<GoogleTranscriberPort> => {
      // MediaPipe's loader keeps a `Module` that is already set and gives it its `locateFile`: Emscripten then asks
      // `instantiateWasm` for the instance and fetches nothing. The loader clears it again once the task exists. A binary
      // that will not compile must end the load, not leave it waiting for an instance that never comes.
      let broke: (reason: unknown) => void = () => undefined;
      const broken = new Promise<never>((_, reject) => {
        broke = reject;
      });
      scope.Module = {
        instantiateWasm: (imports, done) => {
          WebAssembly.instantiate(runtime, imports).then(result => done(result.instance), broke);
        },
      };
      const created = AudioTranscriber.createFromOptions(
        { wasmLoaderPath: loaderUrl, wasmBinaryPath: 'audio_wasm_module_internal.wasm' },
        {
          baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
          sampleRateHz: 16_000,
          enableInterimResults: true,
        },
      );
      created.catch(() => undefined);
      const transcriber = await Promise.race([created, broken]);
      await transcriber.prewarm();
      return {
        transcribeStream: samples => transcriber.transcribeStream(samples),
        finishStream: () => transcriber.finishStream(),
      };
    },
  },
  post: reply => scope.postMessage(reply),
  now: () => scope.performance.now(),
});

scope.addEventListener('message', event => void core.handle(event.data));
