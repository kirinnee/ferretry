/**
 * THE SHERPA WORKER — the composition root of on-device dictation with a sherpa-onnx model, built by
 * Vite to `/assets/sherpa-worker-<hash>.js` (`src/main.tsx` names it). One runs per model in use.
 *
 * Wiring only, like `parakeet-worker.ts`: what the worker does with each message is decided in
 * `lib/stt/sherpa-worker-core.ts`, and where its bytes come from in `lib/stt/model-store.ts`. This file
 * binds the sherpa-onnx WebAssembly module (`@sherpaw/asr`) to the core's runtime port, and is outside
 * both coverage ledgers because it runs only inside a browser worker.
 *
 * NO NETWORK, NO CDN. The worker never downloads. The WebAssembly binary is handed to Emscripten as
 * verified BYTES (`wasmBinary`) read from this device's install, so it never resolves a URL, and the
 * model's files are written into the module's in-memory file system from the same install, re-hashed
 * on the way out. Single-threaded: the app sends no cross-origin isolation headers.
 *
 * `sherpa-glue` is the package's Emscripten loader, which its exports map does not name; `vite.config.ts`
 * aliases it to the file of the pinned version, and `sherpa-glue.d.ts` declares the slice used here.
 */

import { createOnlineRecognizer, OfflineRecognizer, type OnlineRecognizer, type OnlineStream } from '@sherpaw/asr';
import initSherpa from 'sherpa-glue';
import { modelBundle, runtimeBundle } from '../lib/stt/model-catalog.ts';
import { type ModelCacheStorage, PinnedModelStore } from '../lib/stt/model-store.ts';
import { SHERPA_RUNTIME, type SherpaCatalogModel } from '../lib/stt/sherpa-models.ts';
import {
  SHERPA_SAMPLE_RATE,
  type SherpaLoadedModel,
  type SherpaStreamPort,
  SherpaWorkerCore,
  type SherpaWorkerReply,
} from '../lib/stt/sherpa-worker-core.ts';

interface WorkerScope {
  readonly caches: ModelCacheStorage;
  readonly performance: { now(): number };
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

/** Where each role's file lives in the module's file system. */
const MODEL_DIR = '/model';
const path = (role: string): string => `${MODEL_DIR}/${role}`;

const streamPort = (recognizer: OnlineRecognizer, stream: OnlineStream): SherpaStreamPort => ({
  accept: samples => stream.acceptWaveform(SHERPA_SAMPLE_RATE, samples),
  decode: () => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  },
  text: () => String(recognizer.getResult(stream).text ?? ''),
  isEndpoint: () => recognizer.isEndpoint(stream),
  reset: () => recognizer.reset(stream),
  inputFinished: () => stream.inputFinished(),
  free: () => stream.free(),
});

const core = new SherpaWorkerCore({
  read: async (model: SherpaCatalogModel) => {
    // The runtime URL is irrelevant here: reading names files by role, never fetches.
    const runtimeStore = runtimeBundle(SHERPA_RUNTIME, '');
    if (runtimeStore === null) throw new Error('the sherpa runtime has no bundle of its own');
    const runtime = (await storeOf(runtimeStore).read()).get('runtime') ?? new Uint8Array();
    return { runtime, files: await storeOf(modelBundle(model)).read() };
  },
  runtime: {
    load: async (model, runtime, files): Promise<SherpaLoadedModel> => {
      const module = await initSherpa({
        wasmBinary: runtime,
        // Emscripten names the binary even when it is handed the bytes; nothing is fetched by that name.
        locateFile: (file: string) => file,
        print: () => undefined,
        printErr: () => undefined,
      });
      module.FS_createPath('/', MODEL_DIR.slice(1), true, true);
      for (const [role, bytes] of files) module.FS_createDataFile(MODEL_DIR, role, bytes, true, false, true);
      if (model.recognizer.kind !== 'online-transducer') {
        const offline = new OfflineRecognizer(
          {
            featConfig: { sampleRate: SHERPA_SAMPLE_RATE, featureDim: 80 },
            modelConfig: {
              ...(model.recognizer.kind === 'offline-moonshine'
                ? {
                    moonshine: {
                      preprocessor: path('preprocessor'),
                      encoder: path('encoder'),
                      uncachedDecoder: path('uncached-decoder'),
                      cachedDecoder: path('cached-decoder'),
                    },
                  }
                : {
                    // NeMo's TDT transducer: sherpa reads the duration head from the model type.
                    transducer: { encoder: path('encoder'), decoder: path('decoder'), joiner: path('joiner') },
                    modelType: 'nemo_transducer',
                  }),
              tokens: path('tokens'),
              numThreads: 1,
              provider: 'cpu',
              debug: 0,
            },
            decodingMethod: 'greedy_search',
          },
          module,
        );
        return {
          openStream: () => null,
          transcribe: samples => {
            const stream = offline.createStream();
            try {
              stream.acceptWaveform(SHERPA_SAMPLE_RATE, samples);
              offline.decode(stream);
              return String(offline.getResult(stream).text ?? '');
            } finally {
              stream.free();
            }
          },
        };
      }
      const recognizer = createOnlineRecognizer(module, {
        modelConfig: {
          transducer: { encoder: path('encoder'), decoder: path('decoder'), joiner: path('joiner') },
          tokens: path('tokens'),
          numThreads: 1,
          debug: 0,
          modelingUnit: '',
        },
        // A dictation pause, not a sentence boundary: close a phrase after 0.8 s of silence.
        rule2MinTrailingSilence: 0.8,
      });
      return { openStream: () => streamPort(recognizer, recognizer.createStream()), transcribe: () => null };
    },
  },
  post: reply => scope.postMessage(reply),
  now: () => scope.performance.now(),
});

scope.addEventListener('message', event => void core.handle(event.data));
