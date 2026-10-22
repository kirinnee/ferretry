/**
 * THE SHERPA-ONNX MODELS — next-gen Kaldi (k2) speech models that run on the sherpa-onnx WebAssembly
 * runtime, pinned file by file. Listed in the catalog (`model-catalog.ts`); run by the sherpa worker
 * (`src/worker/sherpa-worker.ts`).
 *
 * THE RUNTIME is `@sherpaw/asr` (Apache-2.0), a WebAssembly build of sherpa-onnx with its ONNX Runtime
 * linked in, plus the JavaScript bindings for its recognizers. Its 14 MB binary is self-hosted — the
 * build emits it under `/assets/` and the signed release lists it but defers it
 * (`release-manifest.ts`), so only a device that installs a sherpa model ever downloads it — and it is
 * pinned here by size and SHA-256 like any model file. `tests/unit/stt/sherpa-models.test.ts` re-hashes
 * the installed package, so a version bump that forgets these lines fails there. It is downloaded once
 * and shared by every sherpa model (`bundle-set.ts`).
 *
 * THE STREAMING ZIPFORMERS hear words as they are spoken: the worker feeds them the recording a
 * fraction of a second at a time and reports the words so far, with endpoint detection committing a
 * phrase once the speaker pauses. They print English in capitals without punctuation, so the worker
 * puts the text into sentence case (`sherpa-worker-core.ts`); a hosted clean-up can add punctuation.
 */

import { RESEARCH } from './research-numbers.ts';
import type { PinnedFile } from './model-store.ts';
import type { OnDeviceModelBase, SpeechRuntime } from './model-catalog.ts';

/** `@sherpaw/asr` — pinned exactly in `package.json`. */
export const SHERPA_RUNTIME_VERSION = '0.3.0';

export const SHERPA_RUNTIME: SpeechRuntime = {
  id: 'sherpa-onnx',
  label: `sherpa-onnx WebAssembly (@sherpaw/asr ${SHERPA_RUNTIME_VERSION})`,
  version: SHERPA_RUNTIME_VERSION,
  licence: 'Apache-2.0',
  file: {
    role: 'runtime',
    label: 'Speech runtime',
    bytes: 13_788_938,
    sha256: 'e0dbc36b03561a45a0e41d9da7f4974ceaf4c550cec5a9b8ea50cef84a2f4f43',
  },
  shared: { cache: 'fy-stt-runtime-sherpa-v1', keyRoot: '/fy-stt/runtime/sherpa' },
};

/** How the worker builds a recognizer from the model's files, by role. */
type SherpaRecognizerSpec = {
  /**
   * `online-transducer` — a streaming transducer: roles `encoder`, `decoder`, `joiner`, `tokens`.
   * `offline-moonshine` — Moonshine, decoding a whole take: `preprocessor`, `encoder`,
   * `uncached-decoder`, `cached-decoder`, `tokens`.
   * `offline-nemo-transducer` — a NeMo TDT transducer decoding a whole take: `encoder`, `decoder`,
   * `joiner`, `tokens`.
   */
  readonly kind: 'online-transducer' | 'offline-moonshine' | 'offline-nemo-transducer';
};

export interface SherpaCatalogModel extends OnDeviceModelBase {
  readonly runtime: 'sherpa-onnx';
  readonly recognizer: SherpaRecognizerSpec;
  /** `upper` for a model that prints only capitals; the worker sentence-cases it. */
  readonly textCase: 'upper' | 'as-is';
}

const hf = (repository: string, revision: string) => (path: string) =>
  `https://huggingface.co/${repository}/resolve/${revision}/${path}`;

const ZIPFORMER_REPOSITORY = 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26';
const ZIPFORMER_REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24';
const zipformer = hf(ZIPFORMER_REPOSITORY, ZIPFORMER_REVISION);

const ZIPFORMER_TOKENS = {
  role: 'tokens',
  label: 'Vocabulary',
  bytes: 5_048,
  sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
} as const;

const ZIPFORMER_FILES: readonly PinnedFile[] = [
  {
    role: 'encoder',
    label: 'Encoder',
    url: zipformer('encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'),
    bytes: 71_083_163,
    sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1',
  },
  {
    role: 'decoder',
    label: 'Decoder',
    url: zipformer('decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'),
    bytes: 1_307_236,
    sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02',
  },
  {
    role: 'joiner',
    label: 'Joiner',
    url: zipformer('joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx'),
    bytes: 259_335,
    sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297',
  },
  { ...ZIPFORMER_TOKENS, url: zipformer('tokens.txt') },
];

export const SHERPA_ZIPFORMER_MODEL: SherpaCatalogModel = {
  id: 'sherpa-zipformer-en',
  label: 'Sherpa streaming Zipformer (English)',
  shortName: 'Sherpa Zipformer',
  family: 'zipformer',
  licence: 'Apache-2.0',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: true,
  nearLive: false,
  source: { repository: ZIPFORMER_REPOSITORY, revision: ZIPFORMER_REVISION },
  files: ZIPFORMER_FILES,
  cache: 'fy-stt-sherpa-zipformer-en-v1',
  keyRoot: '/fy-stt/sherpa-zipformer-en',
  versionLabel: `Zipformer streaming en 2023-06-26 int8 · ${ZIPFORMER_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'online-transducer' },
  textCase: 'upper',
  summary:
    'Live words while you speak, and very fast, but weaker on technical terms: it caught 17 of 33 in the benchmark. English only, no punctuation.',
  measured: RESEARCH.zipformerEn,
};

const MOONSHINE_TINY_REPOSITORY = 'csukuangfj/sherpa-onnx-moonshine-tiny-en-int8';
const MOONSHINE_TINY_REVISION = 'bf2b762c076d8ea61e2af0b3851c9564fb77552e';
const moonshineTiny = hf(MOONSHINE_TINY_REPOSITORY, MOONSHINE_TINY_REVISION);

const MOONSHINE_BASE_REPOSITORY = 'csukuangfj/sherpa-onnx-moonshine-base-en-int8';
const MOONSHINE_BASE_REVISION = '052b0798ad1bf046a140fdd4efcd9426530fa3f5';
const moonshineBase = hf(MOONSHINE_BASE_REPOSITORY, MOONSHINE_BASE_REVISION);

/** Both Moonshines share one vocabulary, byte for byte. */
const MOONSHINE_TOKENS = {
  role: 'tokens',
  label: 'Vocabulary',
  bytes: 436_688,
  sha256: '1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea',
} as const;

export const MOONSHINE_TINY_MODEL: SherpaCatalogModel = {
  id: 'moonshine-tiny-en',
  label: 'Moonshine Tiny (English)',
  shortName: 'Moonshine Tiny',
  family: 'moonshine',
  licence: 'MIT',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: false,
  nearLive: false,
  source: { repository: MOONSHINE_TINY_REPOSITORY, revision: MOONSHINE_TINY_REVISION },
  files: [
    {
      role: 'preprocessor',
      label: 'Preprocessor',
      url: moonshineTiny('preprocess.onnx'),
      bytes: 6_800_738,
      sha256: 'f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e',
    },
    {
      role: 'encoder',
      label: 'Encoder',
      url: moonshineTiny('encode.int8.onnx'),
      bytes: 18_249_187,
      sha256: '8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb',
    },
    {
      role: 'uncached-decoder',
      label: 'Decoder (first step)',
      url: moonshineTiny('uncached_decode.int8.onnx'),
      bytes: 53_216_096,
      sha256: '216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41',
    },
    {
      role: 'cached-decoder',
      label: 'Decoder',
      url: moonshineTiny('cached_decode.int8.onnx'),
      bytes: 45_264_830,
      sha256: '2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6',
    },
    { ...MOONSHINE_TOKENS, url: moonshineTiny('tokens.txt') },
  ],
  cache: 'fy-stt-moonshine-tiny-en-v1',
  keyRoot: '/fy-stt/moonshine-tiny-en',
  versionLabel: `Moonshine tiny en int8 · ${MOONSHINE_TINY_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'offline-moonshine' },
  textCase: 'as-is',
  summary:
    'Built for short, live speech: fast after Stop, with capitals and punctuation. Words appear after Stop, not while you speak. English only.',
  measured: RESEARCH.moonshineTiny,
};

export const MOONSHINE_BASE_MODEL: SherpaCatalogModel = {
  id: 'moonshine-base-en',
  label: 'Moonshine Base (English)',
  shortName: 'Moonshine Base',
  family: 'moonshine',
  licence: 'MIT',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: false,
  nearLive: false,
  source: { repository: MOONSHINE_BASE_REPOSITORY, revision: MOONSHINE_BASE_REVISION },
  files: [
    {
      role: 'preprocessor',
      label: 'Preprocessor',
      url: moonshineBase('preprocess.onnx'),
      bytes: 14_077_290,
      sha256: 'ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2',
    },
    {
      role: 'encoder',
      label: 'Encoder',
      url: moonshineBase('encode.int8.onnx'),
      bytes: 50_311_494,
      sha256: '7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2',
    },
    {
      role: 'uncached-decoder',
      label: 'Decoder (first step)',
      url: moonshineBase('uncached_decode.int8.onnx'),
      bytes: 122_120_451,
      sha256: 'c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987',
    },
    {
      role: 'cached-decoder',
      label: 'Decoder',
      url: moonshineBase('cached_decode.int8.onnx'),
      bytes: 99_983_837,
      sha256: '2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03',
    },
    { ...MOONSHINE_TOKENS, url: moonshineBase('tokens.txt') },
  ],
  cache: 'fy-stt-moonshine-base-en-v1',
  keyRoot: '/fy-stt/moonshine-base-en',
  versionLabel: `Moonshine base en int8 · ${MOONSHINE_BASE_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'offline-moonshine' },
  textCase: 'as-is',
  summary:
    'Moonshine’s larger model: more accurate than Tiny on hard audio, about twice the download and time. Punctuated; words appear after Stop. English only.',
  measured: RESEARCH.moonshineBase,
};

const PARAKEET_TDT_REPOSITORY = 'punitd/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8';
const PARAKEET_TDT_REVISION = '66a4fa70643dc7ce25c9b38b2f87e1b35ddad33d';
const parakeetTdt = hf(PARAKEET_TDT_REPOSITORY, PARAKEET_TDT_REVISION);

/**
 * PARAKEET SMALL — the phone default (`engine-defaults.ts`). NVIDIA's parakeet-tdt_ctc-110m through its
 * TDT (transducer) head: k2-fsa's sherpa-onnx int8 export, which k2-fsa publishes only inside a release
 * tarball a browser cannot install file by file. These four files are a Hugging Face copy of that
 * tarball's files, BYTE-IDENTICAL to them (checked against the copy the research benchmark measured), and
 * pinned by SHA-256 like every other file, so a republished copy cannot change under us.
 *
 * The TDT head replaced the CTC head this entry first shipped with: on the research clips it is more
 * accurate on general speech (2.0% against 3.4% WER) and about 1.5× faster, for the same download.
 */
export const PARAKEET_TDT_110M_MODEL: SherpaCatalogModel = {
  id: 'parakeet-tdt-110m',
  label: 'Parakeet TDT 110M (English)',
  shortName: 'Parakeet 110M',
  family: 'parakeet',
  licence: 'CC-BY-4.0',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: false,
  nearLive: false,
  source: { repository: PARAKEET_TDT_REPOSITORY, revision: PARAKEET_TDT_REVISION },
  files: [
    {
      role: 'encoder',
      label: 'Encoder',
      url: parakeetTdt('encoder.int8.onnx'),
      bytes: 131_113_202,
      sha256: '0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657',
    },
    {
      role: 'decoder',
      label: 'Decoder',
      url: parakeetTdt('decoder.int8.onnx'),
      bytes: 3_955_863,
      sha256: 'f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19',
    },
    {
      role: 'joiner',
      label: 'Joiner',
      url: parakeetTdt('joiner.int8.onnx'),
      bytes: 1_411_403,
      sha256: 'bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6',
    },
    {
      role: 'tokens',
      label: 'Vocabulary',
      url: parakeetTdt('tokens.txt'),
      bytes: 9_953,
      sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10',
    },
  ],
  cache: 'fy-stt-parakeet-tdt-110m-v1',
  keyRoot: '/fy-stt/parakeet-tdt-110m',
  versionLabel: `Parakeet TDT 110M int8 · ${PARAKEET_TDT_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'offline-nemo-transducer' },
  textCase: 'as-is',
  summary:
    'The phone default: as accurate as Parakeet 0.6B on everyday speech at a fifth of the download and a third of the memory, with punctuation. A little weaker on technical terms. Words appear after Stop. English only.',
  measured: RESEARCH.parakeetTdt110m,
};

/** In the order Settings lists them: streaming first, then whole-take models. */
export const SHERPA_MODELS: readonly SherpaCatalogModel[] = [
  SHERPA_ZIPFORMER_MODEL,
  MOONSHINE_TINY_MODEL,
  MOONSHINE_BASE_MODEL,
  PARAKEET_TDT_110M_MODEL,
];
