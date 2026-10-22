/**
 * THE VOSK SPEECH WORKER — the composition root of Vosk dictation, built by Vite to
 * `/assets/vosk-worker-<hash>.js` (`src/main.tsx` names it).
 *
 * Wiring only, like `parakeet-worker.ts`: what the worker does with each message is decided in
 * `lib/stt/vosk-worker-core.ts`, how the runtime is driven in `lib/stt/vosk-runtime.ts`, and where its
 * bytes come from in the pinned store (`lib/stt/model-store.ts` over `lib/stt/vosk-model.ts`). This
 * file binds three real things to their ports — the Vosk glue, Cache Storage, and the worker's own
 * `postMessage` — and is outside both coverage ledgers for the same reason the other workers are: it
 * runs only inside a browser worker.
 *
 * NO NETWORK, NO CDN, NO EVAL. The worker never downloads. The Vosk WebAssembly binary is handed to the
 * runtime as verified BYTES (`wasmBinary`) read from this device's install, so Emscripten never resolves
 * or fetches one, and the model archive comes from the same install. The glue imported below is
 * `@lichess-org/vosk-browser`'s, cut down to the Emscripten module and rewritten without
 * `new Function` at build time (`voskEvalFreeGlue` in `vite.config.ts`), so it starts under the page's policy:
 * `'wasm-unsafe-eval'`, no `'unsafe-eval'`, Trusted Types (`public/_headers`).
 *
 * Single-threaded: the build uses no threads, and the app sends no cross-origin isolation headers.
 */

import LoadVosk from '@lichess-org/vosk-browser/dist/vosk.worker.js';
import { PinnedModelStore } from '../lib/stt/model-store.ts';
import { voskBundle } from '../lib/stt/vosk-model.ts';
import { type VoskModule, voskRuntime } from '../lib/stt/vosk-runtime.ts';
import { VoskWorkerCore, type VoskWorkerReply } from '../lib/stt/vosk-worker-core.ts';

interface WorkerScope {
  readonly caches: CacheStorage;
  postMessage(message: VoskWorkerReply): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/** Kaldi's own logging goes nowhere: what matters reaches the page as a failure. */
const silent = (): void => undefined;

const core = new VoskWorkerCore({
  // The runtime URL is irrelevant here: reading names files by role, never fetches.
  read: async () => await new PinnedModelStore({ bundle: voskBundle(''), caches: scope.caches, fetch: refuse }).read(),
  runtime: voskRuntime(
    async wasmBinary => (await LoadVosk({ wasmBinary, print: silent, printErr: silent })) as VoskModule,
  ),
  post: reply => scope.postMessage(reply),
});

/** The worker has no network path: a read that tried to fetch would be a bug, so it fails loudly. */
async function refuse(): Promise<Response> {
  throw new Error('the speech worker never downloads');
}

scope.addEventListener('message', event => void core.handle(event.data));
