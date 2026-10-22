/**
 * THE PINNED PARAKEET MODEL — every byte the on-device voice engine downloads, named here once.
 *
 * Parakeet TDT 0.6B v3 (NVIDIA, CC-BY-4.0) as the int8 ONNX export
 * `ysdede/parakeet-tdt-0.6b-v3-onnx`, at ONE commit of that repository. Ported from kteam's
 * `src/stt-model.ts` (`parakeet-browser-v3`), which measured the same three files at the same
 * revision; the sizes and SHA-256 values below are kteam's, re-checked against Hugging Face's own
 * `x-linked-size` / `x-linked-etag` for the encoder and by hashing `vocab.txt`.
 *
 * PINNED, NOT "latest". A URL under `/resolve/<commit>/` can never change what it serves, and every
 * file is still hashed on arrival: a byte that is not the byte recorded here is refused and the file
 * is downloaded again. Nothing is fetched until the person presses Install (`parakeet-store.ts`).
 *
 * WHY THE PREPROCESSOR IS NOT DOWNLOADED. parakeet.js computes the mel spectrogram in JavaScript
 * (`JsPreprocessor`), so the fourth file (`nemo128.onnx`) the export also publishes is never needed.
 *
 * WHY int8. The fp32 encoder is ~2.5 GB — not a browser download. ONNX Runtime's WebGPU provider
 * cannot run this int8 encoder (parakeet.js itself swaps to fp32 when asked for WebGPU), so the
 * engine runs on WebAssembly. That is a decision, not a missing branch.
 */

import { formatMegabytes, type PinnedFile } from './model-store.ts';

/** Where the model is fetched from: the one origin this feature adds to the network the app reaches. */
export const PARAKEET_MODEL_ORIGIN = 'https://huggingface.co';
export const PARAKEET_REPOSITORY = 'ysdede/parakeet-tdt-0.6b-v3-onnx';
export const PARAKEET_REVISION = 'f88260fa0777fe0868dda6df85d1a98f012a4a7a';
/** What Settings shows as the installed version: the model and the commit it was pinned at. */
export const PARAKEET_VERSION_LABEL = `Parakeet TDT 0.6B v3 int8 · ${PARAKEET_REVISION.slice(0, 7)}`;

const MODEL_BASE = `${PARAKEET_MODEL_ORIGIN}/${PARAKEET_REPOSITORY}/resolve/${PARAKEET_REVISION}`;

export type ParakeetFileRole = 'encoder' | 'decoder' | 'vocabulary' | 'runtime';

export interface ParakeetFile extends PinnedFile {
  readonly role: ParakeetFileRole;
}

export const PARAKEET_MODEL_FILES: readonly ParakeetFile[] = [
  {
    role: 'encoder',
    label: 'Encoder',
    url: `${MODEL_BASE}/encoder-model.int8.onnx`,
    bytes: 652_183_999,
    sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09',
  },
  {
    role: 'decoder',
    label: 'Decoder',
    url: `${MODEL_BASE}/decoder_joint-model.int8.onnx`,
    bytes: 18_202_004,
    sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70',
  },
  {
    role: 'vocabulary',
    label: 'Vocabulary',
    url: `${MODEL_BASE}/vocab.txt`,
    bytes: 102_132,
    sha256: 'ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742',
  },
];

/**
 * ONNX Runtime Web's plain WebAssembly binary, `onnxruntime-web@1.24.1`
 * `dist/ort-wasm-simd-threaded.wasm`. It is SELF-HOSTED: the build emits it under `/assets/`, and it
 * is downloaded with the model on the same Install press rather than by every visitor (see
 * `isDeferredReleaseFile` in `release-manifest.ts`). Its hash is pinned here as well as in the signed
 * release list, so the worker refuses a runtime this exact package version did not publish.
 * `tests/unit/stt/parakeet-model.test.ts` re-hashes the installed package, so a version bump that
 * forgets this line fails there.
 */
export const ORT_RUNTIME_VERSION = '1.24.1';
export const ORT_RUNTIME_FILE = {
  role: 'runtime',
  label: 'Speech runtime',
  bytes: 12_297_086,
  sha256: 'fd078a39438a65660fc6c9df8d42fc886b5bf2931d6dbdd8dc51a17b1221499f',
} as const satisfies Omit<ParakeetFile, 'url'>;

/** Every file a device holds once Parakeet is installed: the three model files and the runtime. */
export const parakeetFiles = (runtimeUrl: string): readonly ParakeetFile[] => [
  ...PARAKEET_MODEL_FILES,
  { ...ORT_RUNTIME_FILE, url: runtimeUrl },
];

/** The whole download, in bytes. */
export const PARAKEET_TOTAL_BYTES =
  PARAKEET_MODEL_FILES.reduce((total, file) => total + file.bytes, 0) + ORT_RUNTIME_FILE.bytes;

export { formatMegabytes };

/** For copy that names the download before anything is fetched. */
export const PARAKEET_DOWNLOAD_SIZE = formatMegabytes(PARAKEET_TOTAL_BYTES);

/**
 * The Cache Storage cache the files live in. Not prefixed like the signed release's own caches, so
 * the release keeper's pruning never touches it; removing it is `ParakeetModelStore.remove`'s job alone.
 */
export const PARAKEET_CACHE = 'fy-stt-parakeet-v1';
