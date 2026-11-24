import type { LoadRole } from './protocol.ts';

/**
 * THE MACHINE SPEECH ENGINE'S FILES, pinned by size and SHA-256 like every model file the app installs. Nothing here
 * is embedded in the daemon: Install downloads each file once, checks it against these lines, and keeps it in
 * `state/voice/models/`. A download that is not exactly the pinned file is refused and nothing of it is kept.
 *
 * The two WebAssembly runtimes are the very files the app's browser engine pins (`app/lib/stt/sherpa-models.ts`
 * for sherpa; onnxruntime-web 1.24.1 is the version `package.json` pins), fetched from the npm CDN at the
 * version the lockfile resolves.
 */
export interface EngineFile {
  readonly role: LoadRole;
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

const PARAKEET =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8';
const SILERO = 'https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec';

export const ENGINE_LABEL = 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection';

/** `state/voice/models/<ENGINE_DIR>/<role>`. */
export const ENGINE_DIR = 'parakeet-tdt-0.6b-v3';

export const ENGINE_FILES: readonly EngineFile[] = [
  {
    role: 'encoder',
    label: 'Parakeet encoder',
    url: `${PARAKEET}/encoder.int8.onnx`,
    bytes: 652_282_294,
    sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479',
  },
  {
    role: 'decoder',
    label: 'Parakeet decoder',
    url: `${PARAKEET}/decoder.int8.onnx`,
    bytes: 11_845_274,
    sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5',
  },
  {
    role: 'joiner',
    label: 'Parakeet joiner',
    url: `${PARAKEET}/joiner.int8.onnx`,
    bytes: 6_355_277,
    sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98',
  },
  {
    role: 'tokens',
    label: 'Parakeet vocabulary',
    url: `${PARAKEET}/tokens.txt`,
    bytes: 93_939,
    sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
  },
  {
    role: 'vad',
    label: 'Silero voice detection',
    url: `${SILERO}/onnx/model.onnx`,
    bytes: 2_243_022,
    sha256: 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808',
  },
  {
    role: 'sherpa-wasm',
    label: 'Speech runtime (sherpa-onnx)',
    url: 'https://cdn.jsdelivr.net/npm/@sherpaw/asr@0.3.0/dist/prebuilt/asr.wasm',
    bytes: 13_788_938,
    sha256: 'e0dbc36b03561a45a0e41d9da7f4974ceaf4c550cec5a9b8ea50cef84a2f4f43',
  },
  {
    role: 'ort-wasm',
    label: 'Voice detection runtime (onnxruntime)',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort-wasm-simd-threaded.wasm',
    bytes: 12_297_086,
    sha256: 'fd078a39438a65660fc6c9df8d42fc886b5bf2931d6dbdd8dc51a17b1221499f',
  },
];
