/**
 * THE PINNED VOSK MODEL — every byte the light on-device engine downloads, named here once.
 *
 * `vosk-model-small-en-us-0.15` (Alpha Cephei, Apache-2.0): the small US-English Kaldi model Vosk
 * publishes as one zip on alphacephei.com. The catalog only takes immutable Hugging Face
 * `resolve/<commit>` URLs, so the zip comes from `tech-guy-1991-A/vosk-model-small-en-us-0.15` at ONE
 * commit — and it is the OFFICIAL zip, byte for byte: the same 41,205,931 bytes and the same SHA-256 as
 * `https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip`. The mirror is trusted for
 * nothing but serving those bytes; a byte that is not them is refused on arrival.
 *
 * ONE ARCHIVE, UNPACKED IN THE WORKER. The zip is 41 MB; its folder unpacked is 71 MB. Pinning the
 * archive halves what a phone downloads and stores, and keeps the provenance one hash long. The worker
 * hands the VERIFIED archive bytes to the runtime's own unpacker inside its in-memory file system
 * (`vosk-runtime.ts`) — nothing is unpacked from an unverified stream, and the unpacked copy is
 * dropped once the model has read it.
 *
 * THE RUNTIME is the Vosk/Kaldi WebAssembly build `@lichess-org/vosk-browser@0.0.3` publishes
 * (`dist/vosk.wasm`), lichess's maintained fork of ccoreilly's `vosk-browser`. It is SELF-HOSTED like
 * ONNX Runtime's binary: the build emits it under `/assets/`, a release lists it but defers it
 * (`release-manifest.ts`), and only someone who presses Install downloads it. Its JavaScript glue is
 * made eval-free at build time (`voskEvalFreeGlue` in `vite.config.ts`), because the page's policy has no
 * `'unsafe-eval'`. `tests/unit/stt/vosk-model.test.ts` re-hashes the installed package, so a version
 * bump that forgets these lines fails there.
 */

import type { PinnedBundle, PinnedFile } from './model-store.ts';

export const VOSK_REPOSITORY = 'tech-guy-1991-A/vosk-model-small-en-us-0.15';
export const VOSK_REVISION = '67cef5430f8b1898f41e5555929a743330d870a5';
/** What Settings shows as the installed version: the model and the commit it was pinned at. */
export const VOSK_VERSION_LABEL = `Vosk small en-US 0.15 · ${VOSK_REVISION.slice(0, 7)}`;

export const VOSK_MODEL_ROLE = 'model';
export const VOSK_RUNTIME_ROLE = 'runtime';

export const VOSK_MODEL_FILES: readonly PinnedFile[] = [
  {
    role: VOSK_MODEL_ROLE,
    label: 'Model',
    url: `https://huggingface.co/${VOSK_REPOSITORY}/resolve/${VOSK_REVISION}/vosk-model-small-en-us-0.15.zip`,
    bytes: 41_205_931,
    sha256: '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
  },
];

/** `@lichess-org/vosk-browser`, pinned exactly in `package.json`. */
export const VOSK_RUNTIME_VERSION = '0.0.3';
export const VOSK_RUNTIME_FILE = {
  role: VOSK_RUNTIME_ROLE,
  label: 'Speech runtime',
  bytes: 2_992_690,
  sha256: 'e2a33196eacd6cd7d863392f877b9360664d7614ce97cddf9de5b5e637e2ccf9',
} as const satisfies Omit<PinnedFile, 'url'>;

/**
 * The Cache Storage cache the files live in. Not prefixed like the signed release's own caches, so the
 * release keeper's pruning never touches it.
 */
export const VOSK_CACHE = 'fy-stt-vosk-small-en-v1';
export const VOSK_KEY_ROOT = '/fy-stt/vosk-small-en';

/** Everything a device holds once Vosk is installed: the model archive and the runtime, in one bundle. */
export const voskBundle = (runtimeUrl: string): PinnedBundle => ({
  name: 'Vosk',
  cache: VOSK_CACHE,
  keyRoot: VOSK_KEY_ROOT,
  versionLabel: VOSK_VERSION_LABEL,
  files: [...VOSK_MODEL_FILES, { ...VOSK_RUNTIME_FILE, url: runtimeUrl }],
});
