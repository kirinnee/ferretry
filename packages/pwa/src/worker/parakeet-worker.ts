/**
 * THE SPEECH WORKER — the composition root of on-device dictation, built by Vite to
 * `/assets/parakeet-worker-<hash>.js` (`src/main.tsx` names it).
 *
 * Wiring only, like `service-worker.ts`: what the worker does with each message is decided in
 * `lib/stt/parakeet-worker-core.ts`, and where its bytes come from in `lib/stt/parakeet-store.ts`.
 * This file binds three real things to their ports — ONNX Runtime Web, parakeet.js, and the worker's
 * own `postMessage` — and is outside both coverage ledgers for the same reason the service worker is:
 * it runs only inside a browser worker.
 *
 * NO NETWORK, NO CDN. The worker never downloads. The ONNX Runtime WebAssembly binary is handed to
 * the runtime as verified BYTES (`env.wasm.wasmBinary`) read from this device's install, so the
 * runtime never resolves a path — parakeet.js would otherwise point it at jsDelivr — and the bundle's
 * embedded JavaScript glue is used, so no second script is loaded either. The model bytes come from
 * the same install and are re-hashed before a session is built.
 *
 * WHY WEBASSEMBLY AND NOT WEBGPU. The int8 encoder this feature pins cannot run on ONNX Runtime's
 * WebGPU provider (parakeet.js itself swaps to the 2.5 GB fp32 encoder when asked for WebGPU), so the
 * sessions are created on the `wasm` provider, single-threaded: the app sends no cross-origin
 * isolation headers, so `SharedArrayBuffer` — and with it multi-threading — is not available.
 *
 * The page's policy must allow `'wasm-unsafe-eval'` for the runtime to compile (`public/_headers`).
 */

import * as ort from 'onnxruntime-web/wasm';
import { JsPreprocessor } from 'parakeet.js/mel';
import { ParakeetModel } from 'parakeet.js/parakeet';
import { ParakeetModelStore } from '../lib/stt/parakeet-store.ts';
import { ParakeetVocabulary } from '../lib/stt/parakeet-vocabulary.ts';
import {
  type ParakeetLoadedModel,
  ParakeetWorkerCore,
  type ParakeetWorkerReply,
} from '../lib/stt/parakeet-worker-core.ts';

interface WorkerScope {
  readonly caches: CacheStorage;
  postMessage(message: ParakeetWorkerReply): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/** parakeet.js declares no public constructor; this is the one it has (`src/parakeet.js`). */
const ParakeetModelWithParts = ParakeetModel as unknown as new (parts: {
  tokenizer: ParakeetVocabulary;
  encoderSession: ort.InferenceSession;
  joinerSession: ort.InferenceSession;
  preprocessor: JsPreprocessor;
  ort: typeof ort;
  nMels: number;
}) => ParakeetModel;

/** Shorter than this decodes in one pass; longer goes through parakeet.js's windowed long-audio path. */
const ONE_PASS_SAMPLES = 16_000 * 25;

const sessionOptions: ort.InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
  logSeverityLevel: 3,
};

const core = new ParakeetWorkerCore({
  // The runtime URL is irrelevant here: reading names files by role, never fetches.
  read: async () => await new ParakeetModelStore({ caches: scope.caches, fetch: refuse, runtimeUrl: '' }).read(),
  runtime: {
    load: async bytes => {
      ort.env.wasm.wasmBinary = bytes.runtime;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const encoderSession = await ort.InferenceSession.create(bytes.encoder, sessionOptions);
      const joinerSession = await ort.InferenceSession.create(bytes.decoder, sessionOptions);
      const model = new ParakeetModelWithParts({
        tokenizer: ParakeetVocabulary.parse(bytes.vocabulary),
        encoderSession,
        joinerSession,
        preprocessor: new JsPreprocessor({ nMels: 128 }),
        ort,
        nMels: 128,
      });
      const loaded: ParakeetLoadedModel = {
        transcribe: async samples =>
          samples.length <= ONE_PASS_SAMPLES
            ? (await model.transcribe(samples, 16_000, { returnTimestamps: false, returnConfidences: false }))
                .utterance_text
            : (await model.transcribeLongAudio(samples, 16_000)).text,
      };
      return loaded;
    },
  },
  post: reply => scope.postMessage(reply),
});

/** The worker has no network path: a read that tried to fetch would be a bug, so it fails loudly. */
async function refuse(): Promise<Response> {
  throw new Error('the speech worker never downloads');
}

scope.addEventListener('message', event => void core.handle(event.data));
