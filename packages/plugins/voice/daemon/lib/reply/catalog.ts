import type { EngineFile } from '../engine/catalog.ts';

/**
 * THE REPLY VOICE'S FILES, pinned by size and SHA-256 exactly as the speech engine's are. The voice is Kokoro-82M (Apache
 * 2.0), int8, the multi-language 1.0 build the sherpa-onnx project publishes; its English text front end is a lexicon
 * (sherpa-onnx 2.x no longer uses espeak-ng), so five files are all there is. The runtime is sherpa-onnx's own
 * WebAssembly build for Node and Bun, fetched from the npm CDN at the version `package.json` pins.
 */
const KOKORO =
  'https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_0/resolve/57adb37fc0e8d4bd430cfc1b8f8c2294945b9af2';

export const REPLY_LABEL = 'Kokoro 82M (int8), a natural English reply voice';

/** `state/voice/models/<REPLY_DIR>/<role>`. */
export const REPLY_DIR = 'kokoro-82m-int8';

/** The roles, in the order a load reads them. The runtime's bytes cross to the worker; the others are read by path there. */
export const REPLY_ROLES = ['runtime', 'model', 'voices', 'tokens', 'lexicon'] as const;
type ReplyRole = (typeof REPLY_ROLES)[number];

export interface ReplyFile extends EngineFile {
  readonly role: ReplyRole;
}

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
