import type { EngineFile } from '../engine/catalog.ts';

/**
 * Spend roughly a quarter of the machine on a reply, capped at eight threads. On the measured 32-core Xeon this,
 * together with bounded clauses (`chunks.ts`), leaves room for the stream's 200 ms tick within the first-audio target.
 * More threads alone did not meet that wire target for an unbroken 14-word sentence. Small machines keep a CPU for
 * the daemon (one thread on a one/two-core machine); two threads are the floor elsewhere. Speech keeps its own budget.
 */
export function replyNativeThreads(cores: number): number {
  const available = Math.max(1, Math.floor(cores));
  return Math.max(1, Math.min(8, available - 1, Math.max(2, Math.floor(available / 4))));
}

/**
 * THE REPLY VOICE'S FILES, pinned by size and SHA-256 exactly as the speech engine's are. The voice is Kokoro-82M (Apache
 * 2.0), the multi-language 1.0 build the sherpa-onnx project publishes; its English text front end is a lexicon
 * (sherpa-onnx 2.x no longer uses espeak-ng). Two engines can run it, and each has its own model file:
 *
 *  - NATIVE (the one that runs wherever it loads): sherpa-onnx's compiled library for this machine (`../native/catalog.ts`)
 *    and the fp32 model, 326 MB. fp32 is not a luxury: on the measured CPU the int8 file is 1.7–3.3 times SLOWER natively
 *    (its kernels lose to fp32's), so the small file would cost speed and save only memory;
 *  - WEBASSEMBLY (the fallback for a machine with no native build, or whose native library would not start): the int8
 *    model, 114 MB, and sherpa-onnx's own WebAssembly build, fetched from the npm CDN at the version `package.json` pins.
 *
 * The voices, vocabulary and lexicon are the same files for both, so they are installed once.
 */
const KOKORO =
  'https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_0/resolve/57adb37fc0e8d4bd430cfc1b8f8c2294945b9af2';

export const REPLY_LABEL = 'Kokoro 82M, a natural English reply voice';

/** `state/voice/models/<REPLY_DIR>/<role>`: both engines' files, and the native library, side by side (its run-path is its own folder). */
export const REPLY_DIR = 'kokoro-82m-int8';

/** The WebAssembly engine's roles, in the order a load reads them. The runtime's bytes cross to the worker; the others are read by path there. */
export const REPLY_ROLES = ['runtime', 'model', 'voices', 'tokens', 'lexicon'] as const;
/** The files both engines read, installed once. */
export const REPLY_SHARED_ROLES = ['voices', 'tokens', 'lexicon'] as const;
/** The role of the fp32 model only the native engine reads. */
const REPLY_NATIVE_MODEL_ROLE = 'model-fp32';
type ReplyRole = (typeof REPLY_ROLES)[number] | typeof REPLY_NATIVE_MODEL_ROLE;

export interface ReplyFile extends EngineFile {
  readonly role: ReplyRole;
}

/** The WebAssembly engine's files: the whole install on a machine with no native build, and the fallback's on any other. */
export const REPLY_FILES: readonly ReplyFile[] = [
  {
    role: 'model',
    label: 'Kokoro voice model',
    url: `${KOKORO}/model.int8.onnx`,
    bytes: 114_202_993,
    sha256: '75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e',
  },
  {
    role: 'voices',
    label: 'Kokoro voices',
    url: `${KOKORO}/voices.bin`,
    bytes: 28_200_960,
    sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29',
  },
  {
    role: 'tokens',
    label: 'Kokoro vocabulary',
    url: `${KOKORO}/tokens.txt`,
    bytes: 687,
    sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425',
  },
  {
    role: 'lexicon',
    label: 'Kokoro English lexicon',
    url: `${KOKORO}/lexicon-us-en.txt`,
    bytes: 5_956_885,
    sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
  },
  {
    role: 'runtime',
    label: 'Voice runtime (sherpa-onnx)',
    url: 'https://cdn.jsdelivr.net/npm/sherpa-onnx@2.0.3/sherpa-onnx-wasm-nodejs.wasm',
    bytes: 15_660_851,
    sha256: '3e076d413f2fdc8de760e35c608ec9573099db5549b0ddbb6e73ec3d7072abd9',
  },
];

const KOKORO_FP32 =
  'https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b';

/** The fp32 model the native engine speaks with (the file's own size: the Hugging Face listing's figure is one megabyte off). */
export const REPLY_NATIVE_MODEL: ReplyFile = {
  role: REPLY_NATIVE_MODEL_ROLE,
  label: 'Kokoro voice model (full precision)',
  url: `${KOKORO_FP32}/model.onnx`,
  bytes: 325_560_556,
  sha256: 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11',
};
