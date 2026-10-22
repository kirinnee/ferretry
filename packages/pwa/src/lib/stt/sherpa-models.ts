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
  /** A streaming transducer: roles `encoder`, `decoder`, `joiner`, `tokens`. */
  readonly kind: 'online-transducer';
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

/** In the order Settings lists them. */
export const SHERPA_MODELS: readonly SherpaCatalogModel[] = [SHERPA_ZIPFORMER_MODEL, SHERPA_ZIPFORMER_20M_MODEL];
