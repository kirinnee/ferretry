/**
 * WHERE THE BUILD PUT EVERY ON-DEVICE ENGINE'S WORKER AND BINARY — the only module of the Voice app half that
 * names a bundler query (`?worker&url`, `?url`), so a suite never imports it and the rest of the half stays plain
 * TypeScript. Today's PWA bound the same eight URLs in `src/main.tsx` and passed them down through `App`; 5.0's shell
 * holds no feature, so Voice binds its own here and hands them to its voice store (`index.ts` → `surfaces.tsx`).
 *
 * Each worker is a MODULE worker built to `/assets/<engine>-worker-<hash>.js` (`vite.config.ts` › `worker`; the
 * `fy-worker` Trusted Types policy accepts exactly that shape), and each binary is emitted under `/assets/` and
 * fetched only by an Install. Whisper runs on the same WebAssembly-only ONNX Runtime build Parakeet does.
 */

import sherpaRuntimeUrl from 'sherpa-runtime-wasm?url';
import voskRuntimeUrl from '@lichess-org/vosk-browser/dist/vosk.wasm?url';
import runtimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { SpeechAssets } from './lib/stt/on-device-voices.ts';
import workerUrl from './worker/parakeet-worker.ts?worker&url';
import sherpaWorkerUrl from './worker/sherpa-worker.ts?worker&url';
import voskWorkerUrl from './worker/vosk-worker.ts?worker&url';
import whisperWorkerUrl from './worker/whisper-worker.ts?worker&url';

/** The URLs the bundler gave this build's speech workers and WebAssembly binaries. */
export const speechAssets: SpeechAssets = {
  workerUrl,
  runtimeUrl,
  sherpa: { workerUrl: sherpaWorkerUrl, runtimeUrl: sherpaRuntimeUrl },
  vosk: { workerUrl: voskWorkerUrl, runtimeUrl: voskRuntimeUrl },
  whisper: { workerUrl: whisperWorkerUrl, runtimeUrl },
};
