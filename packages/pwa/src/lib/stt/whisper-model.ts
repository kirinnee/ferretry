/**
 * THE PINNED WHISPER MODELS — every byte the two Whisper engines download, named here once.
 *
 * OpenAI's Whisper tiny.en and base.en (MIT), English-only, as the ONNX exports
 * `onnx-community/whisper-tiny.en` and `onnx-community/whisper-base.en`, each at ONE commit. They run on
 * transformers.js (`@huggingface/transformers`, pinned exactly in `package.json`) over ONNX Runtime Web,
 * in a worker (`src/worker/whisper-worker.ts`).
 *
 * EVERY FILE TRANSFORMERS.JS READS, AND NO OTHER. The worker hands transformers.js these bytes and
 * nothing else (it never fetches), so the list is exactly what its Whisper pipeline asks for: the model
 * config, the generation config (which tokens start, end and are suppressed), the feature extractor's
 * config, the tokenizer and its config, and the two ONNX graphs. A file it asks for that is not here is
 * answered "not found" by the worker, never downloaded; the manual smoke (`harness/whisper-smoke.ts`)
 * logs any such ask, and a run that logs one is a broken pin.
 *
 * WHY q8. The `_quantized` (int8) graphs are the smallest export in both repositories by a wide margin:
 * tiny.en is 41 MB of graphs in q8 against 96 MB in q4, whose decoder keeps its 51 864-token embedding
 * in fp32, and q8 runs on WebAssembly everywhere, which is the only backend the app ships for Whisper
 * (see {@link WHISPER_RUNTIME_FILE}). One set of files therefore serves every device.
 *
 * Sizes and digests: Hugging Face's tree API at the pinned commit (`size`, `lfs.oid`) for the graphs;
 * the small JSON files are not in LFS and were downloaded at the commit and hashed.
 */

import type { WhisperCatalogModel } from './model-catalog.ts';
import type { PinnedFile } from './model-store.ts';
import { ORT_RUNTIME_FILE } from './parakeet-model.ts';
import { RESEARCH } from './research-numbers.ts';

/** The transformers.js release the worker runs, pinned exactly in `package.json`. */
export const TRANSFORMERS_JS_VERSION = '4.3.1';

/**
 * The runtime binary both Whisper models run on: ONNX Runtime Web's plain WebAssembly build,
 * `onnxruntime-web@1.24.1` `dist/ort-wasm-simd-threaded.wasm` — the SAME bytes Parakeet runs
 * ({@link ORT_RUNTIME_FILE}), because `vite.config.ts` resolves transformers.js's
 * `onnxruntime-web/webgpu` to `onnxruntime-web/wasm`. The WebGPU-capable build
 * (`ort-wasm-simd-threaded.asyncify.wasm`, 27,084,114 bytes) is over Cloudflare Pages' 25 MiB
 * per-file limit, so the app cannot ship it, and Whisper runs on WebAssembly only.
 *
 * SELF-HOSTED and DEFERRED: the build emits it under `/assets/`, every visitor's copy of the app lists
 * and verifies it without downloading it (`isDeferredReleaseFile`), and only Install fetches it. It is
 * kept in the transformers.js runtime's own cache, so a device with Parakeet and Whisper holds it
 * twice. `tests/unit/stt/whisper-model.test.ts` re-hashes the installed package, so a version bump that
 * forgets the pin fails there.
 */
export const WHISPER_RUNTIME_FILE = {
  ...ORT_RUNTIME_FILE,
  label: 'Speech runtime (WebAssembly)',
} as const satisfies Omit<PinnedFile, 'url'>;

/** The commit a repository's files are pinned at, and the URL prefix every one of them lives under. */
const pinnedAt = (repository: string, revision: string): string =>
  `https://huggingface.co/${repository}/resolve/${revision}`;

interface WhisperFileSpec {
  readonly role: string;
  readonly label: string;
  /** The path inside the repository, exactly as transformers.js asks for it. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const pinFiles = (repository: string, revision: string, specs: readonly WhisperFileSpec[]): readonly PinnedFile[] =>
  specs.map(({ role, label, path, bytes, sha256 }) => ({
    role,
    label,
    url: `${pinnedAt(repository, revision)}/${path}`,
    bytes,
    sha256,
  }));

/** The JSON files both English models share byte for byte (same tokenizer, same feature extractor). */
const SHARED_TEXT_FILES: readonly WhisperFileSpec[] = [
  {
    role: 'preprocessor',
    label: 'Audio features config',
    path: 'preprocessor_config.json',
    bytes: 339,
    sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  },
  {
    role: 'tokenizer',
    label: 'Tokenizer',
    path: 'tokenizer.json',
    bytes: 2_405_679,
    sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
  },
  {
    role: 'tokenizer-config',
    label: 'Tokenizer config',
    path: 'tokenizer_config.json',
    bytes: 282_662,
    sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c',
  },
];

const TINY_REPOSITORY = 'onnx-community/whisper-tiny.en';
const TINY_REVISION = '2575352d61be1bf7225cf8f8b268a4678025fc58';
const BASE_REPOSITORY = 'onnx-community/whisper-base.en';
const BASE_REVISION = '51eefc0af78b103839eda9e7e4f4186acc6517fe';

export const WHISPER_TINY_EN_FILES: readonly PinnedFile[] = pinFiles(TINY_REPOSITORY, TINY_REVISION, [
  {
    role: 'config',
    label: 'Model config',
    path: 'config.json',
    bytes: 2_197,
    sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233',
  },
  {
    role: 'generation-config',
    label: 'Generation config',
    path: 'generation_config.json',
    bytes: 1_646,
    sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9',
  },
  ...SHARED_TEXT_FILES,
  {
    role: 'encoder',
    label: 'Encoder',
    path: 'onnx/encoder_model_quantized.onnx',
    bytes: 10_124_993,
    sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25',
  },
  {
    role: 'decoder',
    label: 'Decoder',
    path: 'onnx/decoder_model_merged_quantized.onnx',
    bytes: 30_718_858,
    sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52',
  },
]);

export const WHISPER_BASE_EN_FILES: readonly PinnedFile[] = pinFiles(BASE_REPOSITORY, BASE_REVISION, [
  {
    role: 'config',
    label: 'Model config',
    path: 'config.json',
    bytes: 2_197,
    sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1',
  },
  {
    role: 'generation-config',
    label: 'Generation config',
    path: 'generation_config.json',
    bytes: 1_556,
    sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120',
  },
  ...SHARED_TEXT_FILES,
  {
    role: 'encoder',
    label: 'Encoder',
    path: 'onnx/encoder_model_quantized.onnx',
    bytes: 23_201_320,
    sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10',
  },
  {
    role: 'decoder',
    label: 'Decoder',
    path: 'onnx/decoder_model_merged_quantized.onnx',
    bytes: 53_692_803,
    sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909',
  },
]);

export const WHISPER_TINY_EN_CATALOG_MODEL: WhisperCatalogModel = {
  id: 'whisper-tiny-en',
  label: 'Whisper tiny.en',
  shortName: 'Whisper tiny',
  family: 'whisper',
  licence: 'MIT',
  languages: ['en'],
  runtime: 'transformers-js',
  streaming: false,
  nearLive: false,
  source: { repository: TINY_REPOSITORY, revision: TINY_REVISION },
  files: WHISPER_TINY_EN_FILES,
  cache: 'fy-stt-whisper-tiny-en-v1',
  keyRoot: '/fy-stt/whisper-tiny-en',
  versionLabel: `Whisper tiny.en q8 · ${TINY_REVISION.slice(0, 7)}`,
  summary:
    'English only. The smallest download here, and quick, but it mishears more than the larger models. Expect about 600 MB of memory while it transcribes. Words appear after Stop. Runs on WebAssembly, on this device’s processor.',
  measured: RESEARCH.whisperTinyEn,
};

export const WHISPER_BASE_EN_CATALOG_MODEL: WhisperCatalogModel = {
  id: 'whisper-base-en',
  label: 'Whisper base.en',
  shortName: 'Whisper base',
  family: 'whisper',
  licence: 'MIT',
  languages: ['en'],
  runtime: 'transformers-js',
  streaming: false,
  nearLive: false,
  source: { repository: BASE_REPOSITORY, revision: BASE_REVISION },
  files: WHISPER_BASE_EN_FILES,
  cache: 'fy-stt-whisper-base-en-v1',
  keyRoot: '/fy-stt/whisper-base-en',
  versionLabel: `Whisper base.en q8 · ${BASE_REVISION.slice(0, 7)}`,
  summary:
    'English only. About twice tiny’s download and time, for fewer mistakes. Expect about 750 MB of memory while it transcribes. Words appear after Stop. Runs on WebAssembly, on this device’s processor.',
  measured: RESEARCH.whisperBaseEn,
};
