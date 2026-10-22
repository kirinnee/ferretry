/**
 * THE WHISPER WORKER — the composition root of Whisper dictation, built by Vite to
 * `/assets/whisper-worker-<hash>.js` (`src/main.tsx` names it).
 *
 * Wiring only, like `parakeet-worker.ts`: what the worker does with each message is decided in
 * `lib/stt/whisper-worker-core.ts`, and where its bytes come from in `lib/stt/whisper-store.ts`. This
 * file binds transformers.js, ONNX Runtime Web, WebGPU's adapter probe and the worker's own
 * `postMessage` to their ports, and is outside both coverage ledgers for the same reason the other
 * workers are: it runs only inside a browser worker.
 *
 * NO NETWORK, NO CDN — how transformers.js is kept off it:
 *
 *   - MODEL FILES come from this device's install only. transformers.js looks a file up in its cache
 *     before anything else, by the URL it would download it from, which is the pinned
 *     `https://huggingface.co/<repo>/resolve/<commit>/<path>` (the commit is fixed in
 *     `env.remotePathTemplate`, because some of its lookups pass no revision). With
 *     `env.useCustomCache` that cache is the map of verified bytes the store just read, and the browser
 *     cache, the local-path lookup and transformers.js's own WASM cache are all off.
 *   - `env.fetch` NEVER FETCHES. Anything transformers.js asks for that the map does not hold is
 *     answered `404` here, with a console warning naming it, so an optional file it probes for reads as
 *     absent and a required one fails the load loudly. `allowRemoteModels` stays `true` only because
 *     transformers.js refuses a configuration with both local and remote loading off; the "remote" it
 *     allows is this function.
 *   - THE RUNTIME BINARY is handed to ONNX Runtime as verified BYTES (`env.wasm.wasmBinary`), and
 *     `env.wasm.wasmPaths` is cleared: at import transformers.js points it at jsDelivr, and with it
 *     cleared ONNX Runtime uses the JavaScript glue embedded in this bundle and resolves no URL at all.
 *
 * ONE ONNX RUNTIME. `onnxruntime-web/webgpu` here is the same module transformers.js imports — the
 * root `package.json` overrides transformers.js's own ONNX Runtime dev build to the 1.24.1 Parakeet
 * runs, and Vite's global `onnxruntime-web` → `onnxruntime-web/wasm` alias only matches the bare name,
 * so Parakeet's 12 MB WebAssembly-only build is untouched.
 *
 * WEBGPU, THEN WEBASSEMBLY. `onnxruntime-web/webgpu` runs its WebGPU provider and its WebAssembly one
 * from the same binary. The core builds the model on WebGPU when `navigator.gpu` hands this worker an
 * adapter and on WebAssembly otherwise, or when WebGPU fails. Single-threaded either way: the app sends
 * no cross-origin isolation headers, so there is no `SharedArrayBuffer`.
 *
 * The page's policy must allow `'wasm-unsafe-eval'` for the runtime to compile (`public/_headers`).
 */

import { env, pipeline } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';
import { onDeviceModel, type WhisperCatalogModel } from '../lib/stt/model-catalog.ts';
import { WhisperModelStore } from '../lib/stt/whisper-store.ts';
import {
  type WhisperBackend,
  type WhisperLoadedModel,
  WhisperWorkerCore,
  type WhisperWorkerReply,
} from '../lib/stt/whisper-worker-core.ts';

interface WorkerScope {
  readonly caches: CacheStorage;
  readonly navigator: { readonly gpu?: { requestAdapter(): Promise<unknown> } };
  postMessage(message: WhisperWorkerReply): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const SAMPLE_RATE = 16_000;
/** Whisper hears 30 s at a time; a longer take is read in overlapping 30 s windows. */
const WINDOW_SECONDS = 30;

/** The narrow shape of the pipeline this worker builds. */
interface SpeechPipeline {
  (audio: Float32Array, options?: Record<string, unknown>): Promise<{ text: string } | readonly { text: string }[]>;
  dispose(): Promise<void>;
}

const whisperModel = (id: string): WhisperCatalogModel => {
  const model = onDeviceModel(id);
  if (model === null || model.runtime !== 'transformers-js') throw new Error(`${id} is not a Whisper model`);
  return model;
};

/** The verified bytes transformers.js reads from: answers a lookup by pinned URL, stores nothing. */
const verifiedCache = (files: ReadonlyMap<string, Uint8Array>) => ({
  match: async (key: string): Promise<Response | undefined> => {
    const bytes = files.get(key);
    return bytes === undefined
      ? undefined
      : new Response(bytes.slice(), { headers: { 'content-length': String(bytes.byteLength) } });
  },
  put: async (): Promise<void> => undefined,
});

const core = new WhisperWorkerCore({
  // The runtime URL is irrelevant here: reading names files by role, never fetches.
  read: async id =>
    await new WhisperModelStore({
      model: whisperModel(id),
      runtimeUrl: '',
      caches: scope.caches,
      fetch: refuse,
      runtimeInUse: () => true,
    }).readModel(),
  gpu: async () => (await scope.navigator.gpu?.requestAdapter()) != null,
  runtime: {
    load: async (id, bytes, backend: WhisperBackend) => {
      const model = whisperModel(id);
      ort.env.wasm.wasmBinary = bytes.runtime;
      (ort.env.wasm as { wasmPaths?: unknown }).wasmPaths = undefined;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = false;
      env.useWasmCache = false;
      env.useCustomCache = true;
      env.customCache = verifiedCache(bytes.files);
      env.fetch = answerFromNowhere;
      const { repository, revision } = model.source;
      // The commit is written INTO the URL template, not left to `{revision}`: several of
      // transformers.js's own lookups (the pipeline's file discovery, the tokenizer's config probe) pass
      // no revision and would ask at `main`. With it fixed, every ask is a pinned URL the map holds.
      env.remotePathTemplate = `{model}/resolve/${revision}/`;
      const asr = (await pipeline('automatic-speech-recognition', repository, {
        revision,
        dtype: 'q8',
        device: backend === 'webgpu' ? 'webgpu' : 'wasm',
      })) as unknown as SpeechPipeline;
      // Built: the verified bytes are inside the ONNX sessions now, so the map can be let go.
      env.customCache = verifiedCache(new Map());
      const loaded: WhisperLoadedModel = {
        transcribe: async samples => {
          const long = samples.length > SAMPLE_RATE * WINDOW_SECONDS;
          const heard = await asr(samples, long ? { chunk_length_s: WINDOW_SECONDS, stride_length_s: 5 } : {});
          return (Array.isArray(heard) ? heard : [heard]).map(part => part.text).join(' ');
        },
        dispose: () => asr.dispose(),
      };
      return loaded;
    },
  },
  post: reply => scope.postMessage(reply),
  warn: message => console.warn(`[whisper] ${message}`),
});

/** The worker has no network path: a read that tried to fetch would be a bug, so it fails loudly. */
async function refuse(): Promise<Response> {
  throw new Error('the speech worker never downloads');
}

/** transformers.js's `fetch`: never the network. Whatever the verified map lacks does not exist. */
async function answerFromNowhere(input: string | URL): Promise<Response> {
  console.warn(`[whisper] not pinned, answered 404 without a download: ${String(input)}`);
  return new Response(null, { status: 404, statusText: 'Not pinned' });
}

scope.addEventListener('message', event => void core.handle(event.data));
