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
   * `offline-nemo-ctc` — a NeMo CTC model decoding a whole take: `model`, `tokens`.
   */
  readonly kind: 'online-transducer' | 'offline-moonshine' | 'offline-nemo-ctc';
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

const ZIPFORMER_20M_REPOSITORY = 'csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const ZIPFORMER_20M_REVISION = 'd42f2d9f7ca24806fb667456a18a9f1b60f70d16';
const zipformer20m = hf(ZIPFORMER_20M_REPOSITORY, ZIPFORMER_20M_REVISION);

/** Both Zipformers share one BPE vocabulary, byte for byte. */
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

const ZIPFORMER_20M_FILES: readonly PinnedFile[] = [
  {
    role: 'encoder',
    label: 'Encoder',
    url: zipformer20m('encoder-epoch-99-avg-1.int8.onnx'),
    bytes: 42_845_182,
    sha256: '3810755ce7c3ab26b42a8bcf39d191308fa27fb0f53358823ba46141d03b7eb3',
  },
  {
    role: 'decoder',
    label: 'Decoder',
    url: zipformer20m('decoder-epoch-99-avg-1.int8.onnx'),
    bytes: 539_499,
    sha256: '21e2a2acd961b3ac72f55be2f10f1a285e1b0b0ba010d7c0b6eab141411b163c',
  },
  {
    role: 'joiner',
    label: 'Joiner',
    url: zipformer20m('joiner-epoch-99-avg-1.int8.onnx'),
    bytes: 259_572,
    sha256: 'e085d73b593cf9b0707f370dbd656d58327d3fe36d80d849202ef81df02cb01e',
  },
  { ...ZIPFORMER_TOKENS, url: zipformer20m('tokens.txt') },
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
    'Words appear while you speak, and a phrase settles each time you pause. Accurate on clear speech, light on memory, and fine on a phone. English only, no punctuation.',
  measured: {
    where: 'Chrome on an x64 server, LibriSpeech clips streamed in real time',
    speed: 'final text 0.09 s after Stop; first load 2.6 s',
    accuracy: 'word-perfect on all three clips',
  },
};

export const SHERPA_ZIPFORMER_20M_MODEL: SherpaCatalogModel = {
  id: 'sherpa-zipformer-en-20m',
  label: 'Sherpa streaming Zipformer 20M (English)',
  shortName: 'Sherpa Zipformer 20M',
  family: 'zipformer',
  licence: 'Apache-2.0',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: true,
  nearLive: false,
  source: { repository: ZIPFORMER_20M_REPOSITORY, revision: ZIPFORMER_20M_REVISION },
  files: ZIPFORMER_20M_FILES,
  cache: 'fy-stt-sherpa-zipformer-en-20m-v1',
  keyRoot: '/fy-stt/sherpa-zipformer-en-20m',
  versionLabel: `Zipformer streaming en 20M 2023-02-17 int8 · ${ZIPFORMER_20M_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'online-transducer' },
  textCase: 'upper',
  summary:
    'The smallest and fastest engine here, with words while you speak. It mishears more than the larger Zipformer; try it on an older phone. English only, no punctuation.',
  measured: {
    where: 'Chrome on an x64 server, LibriSpeech clips streamed in real time',
    speed: 'final text 0.04 s after Stop; first load 1.2 s',
    accuracy: 'one word misheard in 94 across three clips',
  },
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
  measured: {
    where: 'Chrome on an x64 server, a 10.4 s LibriSpeech clip',
    speed: 'text about 1.0 s after Stop; first load 2.2 s',
    accuracy: 'one word misheard, punctuated',
  },
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
  measured: {
    where: 'Chrome on an x64 server, a 10.4 s LibriSpeech clip',
    speed: 'text about 1.9 s after Stop; first load 4.1 s',
    accuracy: 'one word misheard, punctuated',
  },
};

const PARAKEET_CTC_REPOSITORY = 'entropora/parakeet-ctc-110m-int8';
const PARAKEET_CTC_REVISION = '5d9e8f5bf3663b6b79796e4fe94297ffb8a53ffb';
const parakeetCtc = hf(PARAKEET_CTC_REPOSITORY, PARAKEET_CTC_REVISION);

/**
 * PARAKEET SMALL. NVIDIA's parakeet-tdt_ctc-110m, through its CTC head: k2-fsa's sherpa-onnx export,
 * quantised to int8 and republished (CC-BY-4.0) by Entropora. k2-fsa's own int8 export of it is
 * published only inside a release tarball, which a browser cannot download file by file; the file
 * here is pinned by SHA-256 like every other, so a republished copy cannot change under us.
 */
export const PARAKEET_CTC_110M_MODEL: SherpaCatalogModel = {
  id: 'parakeet-ctc-110m',
  label: 'Parakeet 110M CTC (English)',
  shortName: 'Parakeet 110M',
  family: 'parakeet',
  licence: 'CC-BY-4.0',
  languages: ['en'],
  runtime: 'sherpa-onnx',
  streaming: false,
  nearLive: false,
  source: { repository: PARAKEET_CTC_REPOSITORY, revision: PARAKEET_CTC_REVISION },
  files: [
    {
      role: 'model',
      label: 'Model',
      url: parakeetCtc('encoder.int8.onnx'),
      bytes: 131_652_072,
      sha256: 'e83b7e578ead963691028b3d4719af7f7e5bd9260c39d398bd8489c69cb5a5ca',
    },
    {
      role: 'tokens',
      label: 'Vocabulary',
      url: parakeetCtc('tokens.txt'),
      bytes: 9_953,
      sha256: '450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10',
    },
  ],
  cache: 'fy-stt-parakeet-ctc-110m-v1',
  keyRoot: '/fy-stt/parakeet-ctc-110m',
  versionLabel: `Parakeet TDT-CTC 110M (CTC head) int8 · ${PARAKEET_CTC_REVISION.slice(0, 7)}`,
  recognizer: { kind: 'offline-nemo-ctc' },
  textCase: 'as-is',
  summary:
    'A fifth the size of Parakeet 0.6B and much lighter on memory, with punctuation and capitals; a little less accurate. Words appear after Stop. English only.',
  measured: {
    where: 'Chrome on an x64 server, a 10.4 s LibriSpeech clip',
    speed: 'text about 2.1 s after Stop; first load 2.5 s',
    accuracy: 'word-perfect, punctuated',
  },
};

/** In the order Settings lists them: streaming first, then whole-take models. */
export const SHERPA_MODELS: readonly SherpaCatalogModel[] = [
  SHERPA_ZIPFORMER_MODEL,
  SHERPA_ZIPFORMER_20M_MODEL,
  MOONSHINE_TINY_MODEL,
  MOONSHINE_BASE_MODEL,
  PARAKEET_CTC_110M_MODEL,
];
