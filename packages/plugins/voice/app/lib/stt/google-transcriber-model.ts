/**
 * THE GOOGLE AUDIOTRANSCRIBER MODEL — Google's own on-device speech-to-text, pinned file by file. Listed in the catalog
 * (`model-catalog.ts`); run by the Google worker (`app/worker/google-worker.ts`) on MediaPipe's audio runtime.
 *
 * WHAT IT IS. Google AI Edge's `AudioTranscriber` task
 * (https://developers.google.com/edge/mediapipe/solutions/audio/audio_transcriber) runs NVIDIA's Parakeet TDT 0.6B v3
 * as one `.litertlm` bundle (the int8 graph, the tokenizer and the audio front-end in a single file), and its stream
 * mode answers WHILE the person speaks. The weights are the same ones the "Parakeet 0.6B" engine runs; what differs is
 * the runtime (LiteRT-LM on MediaPipe's WebAssembly build, not ONNX Runtime) and that words arrive live.
 *
 * WHERE IT COMES FROM — official upstream sources only, each pinned and hashed like every other model here:
 *   - the model: `litert-community/parakeet-tdt-0.6b-v3` on Hugging Face (Google's `litert-community` organisation),
 *     file `parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm`, at ONE commit. Size and SHA-256 are Hugging Face's own
 *     `x-linked-size` / `x-linked-etag` for that file, re-computed from the bytes. Licence: **CC-BY-4.0** (the model card's
 *     `license: cc-by-4.0`; base model `nvidia/parakeet-tdt-0.6b-v3`), so credit goes to NVIDIA and to Google's
 *     conversion, which the engine's details say.
 *   - the runtime: `@mediapipe/tasks-audio@1.2.3` on npm (Google, Apache-2.0), its `audio_wasm_module_internal.wasm`
 *     (22 MB). Self-hosted: the build emits it under `/assets/`, the signed release lists it but defers it
 *     (`release/manifest.ts`), and it is pinned here by size and SHA-256 like a model file. `tests/unit/app/stt/
 *     google-transcriber-model.test.ts` re-hashes the installed package, so a version bump that forgets these lines
 *     fails there. Its JavaScript loader (`audio_wasm_module_internal.js`) is part of the app's own build.
 *
 * ONE CPU DELEGATE. The model card recommends `Delegate.CPU`, and the worker runs it; the GPU delegate is a measurement
 * for later, not a branch nobody has run.
 */

import { RESEARCH } from './research-numbers.ts';
import type { OnDeviceModelBase, SpeechRuntime } from './model-catalog.ts';
import type { PinnedFile } from './model-store.ts';

/** `@mediapipe/tasks-audio` — pinned exactly in `package.json`. */
export const MEDIAPIPE_AUDIO_VERSION = '1.2.3';

export const MEDIAPIPE_AUDIO_RUNTIME: SpeechRuntime = {
  id: 'mediapipe-audio',
  label: `MediaPipe audio WebAssembly (@mediapipe/tasks-audio ${MEDIAPIPE_AUDIO_VERSION})`,
  version: MEDIAPIPE_AUDIO_VERSION,
  licence: 'Apache-2.0',
  file: {
    role: 'runtime',
    label: 'Speech runtime',
    bytes: 21_979_681,
    sha256: '49effd461e459f7e4f4a93591ce90eb9daa3132a985cf0d5c411ee2c51bc850a',
  },
  shared: { cache: 'fy:voice:runtime-mediapipe', keyRoot: '/fy-stt/runtime/mediapipe' },
};

/** The one Hugging Face repository and the one commit of it the model is pinned at. */
export const GOOGLE_TRANSCRIBER_REPOSITORY = 'litert-community/parakeet-tdt-0.6b-v3';
export const GOOGLE_TRANSCRIBER_REVISION = 'cd95f7bb97fd0757ab1bd6d5eff513cfcd7a2a10';

export interface GoogleCatalogModel extends OnDeviceModelBase {
  readonly runtime: 'mediapipe-audio';
  readonly family: 'google';
}

const MODEL_FILES: readonly PinnedFile[] = [
  {
    role: 'model',
    label: 'Speech model',
    url: `https://huggingface.co/${GOOGLE_TRANSCRIBER_REPOSITORY}/resolve/${GOOGLE_TRANSCRIBER_REVISION}/parakeet_tdt_0.6b_v3_5s_i8_stateful.litertlm`,
    bytes: 614_588_752,
    sha256: '66c5a74cf6c2c1d2b990901f6cece5bb53e3214dbceafa0989900a6f0eeb3504',
  },
];

export const GOOGLE_TRANSCRIBER_MODEL: GoogleCatalogModel = {
  id: 'google-audio-transcriber',
  label: 'Google AudioTranscriber (Parakeet TDT 0.6B v3)',
  shortName: 'Google live words',
  family: 'google',
  licence: 'CC-BY-4.0',
  // The model card's 25 European languages, with automatic language detection.
  languages: [
    'bg',
    'hr',
    'cs',
    'da',
    'nl',
    'en',
    'et',
    'fi',
    'fr',
    'de',
    'el',
    'hu',
    'it',
    'lv',
    'lt',
    'mt',
    'pl',
    'pt',
    'ro',
    'sk',
    'sl',
    'es',
    'sv',
    'ru',
    'uk',
  ],
  runtime: 'mediapipe-audio',
  streaming: true,
  nearLive: false,
  source: { repository: GOOGLE_TRANSCRIBER_REPOSITORY, revision: GOOGLE_TRANSCRIBER_REVISION },
  files: MODEL_FILES,
  cache: 'fy:voice:google-audio-transcriber',
  keyRoot: '/fy-stt/google-audio-transcriber',
  versionLabel: `Parakeet TDT 0.6B v3 int8 on MediaPipe · ${GOOGLE_TRANSCRIBER_REVISION.slice(0, 7)}`,
  summary:
    "Google's live transcriber runs the Parakeet 0.6B weights on MediaPipe: words appear while you speak and are corrected as you go, with punctuation. About 3 GB of browser memory, so it suits a laptop, not a phone.",
  measured: RESEARCH.googleAudioTranscriber,
};
