import {
  VoiceModelSchema,
  type VoiceModel,
  VoiceRuntimeSchema,
  type VoiceRuntime,
  type VoiceRuntimeTarget,
} from '@ferretry/protocol';

/**
 * THE MACHINE'S SPEECH CATALOG — one owner of every URL, size, hash and file name Install trusts.
 *
 * `docs/design/voice-modes.md` §2.2 (the chooser) and §2.3 (the native runtime). Every row is a sherpa-onnx
 * archive on `k2-fsa/sherpa-onnx`'s `asr-models` release, so a new model is a row here, not new native code.
 * The app and `fy` read this through `GET /v1/voice/engine`; nothing else copies a figure from it.
 *
 * WHERE EACH FACT CAME FROM (checked 2026-11-05):
 *  - `bytes`: the release asset's `size` (`gh api repos/k2-fsa/sherpa-onnx/releases/tags/asr-models`).
 *  - `sha256`: the release asset's `digest` where GitHub publishes one. Three assets have none (Parakeet v2
 *    fp16, Whisper turbo, Whisper large-v3); their hash was computed by streaming the file once through
 *    `sha256sum` without keeping it, and is marked `computed` below. Every other row's hash was ALSO
 *    recomputed that way for the archives listed and matched GitHub's digest.
 *  - `extractedBytes` and `files`: read from the archive itself with `curl -L … | tar tvjf -` — the sum of
 *    its file sizes (also the unpack cap), and the names the recognizer needs.
 *  - `peakMemory`: NOT MEASURED. `estimatePeakMemory` is a deliberately conservative guess (twice what the
 *    model unpacks to, plus headroom) that the bench slice (§2.2.1) replaces with a measured peak.
 *
 * Changing a pin is a deliberate act with a reason in the commit: a hash that changes under the same URL is
 * exactly what the pin exists to notice.
 */

const MODELS_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

const MIB = 1024 * 1024;

/** Twice the unpacked size plus 256 MiB: onnxruntime holds weights and working buffers. A guess until measured. */
export const estimatePeakMemory = (extractedBytes: number): number => 2 * extractedBytes + 256 * MIB;

/** Everything in a model row that is not about the archive or the model's own character. */
interface Row {
  readonly id: string;
  readonly name: string;
  readonly role: VoiceModel['role'];
  readonly summary: string;
  readonly weight: VoiceModel['weight'];
  readonly sherpaType: VoiceModel['sherpaType'];
  readonly files: VoiceModel['files'];
  readonly languages: readonly string[];
  /** The archive's file name on the release; `.tar.bz2`. */
  readonly archiveName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly extractedBytes: number;
  readonly recommended?: true;
}

const model = (row: Row): VoiceModel =>
  VoiceModelSchema.parse({
    id: row.id,
    name: row.name,
    role: row.role,
    summary: row.summary,
    weight: row.weight,
    sherpaType: row.sherpaType,
    files: row.files,
    languages: row.languages,
    archive: {
      url: `${MODELS_BASE}/${row.archiveName}`,
      format: 'tar.bz2',
      bytes: row.bytes,
      sha256: row.sha256,
      extractedBytes: row.extractedBytes,
    },
    peakMemory: { bytes: estimatePeakMemory(row.extractedBytes), basis: 'estimate' },
    recommended: row.recommended === true,
  });

/** The models, in the order the chooser lists them: batch (recommended first), then streaming. */
export const VOICE_MODELS: readonly VoiceModel[] = [
  model({
    id: 'parakeet-tdt-0.6b-v3-int8',
    name: 'Parakeet TDT 0.6B v3 (int8)',
    role: 'batch',
    summary: 'the most accurate the app has measured; the default for voice chat and dictation',
    weight: 'standard',
    sherpaType: 'nemo-transducer',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['25 European languages'],
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    bytes: 487_170_055,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    extractedBytes: 671_239_000,
    recommended: true,
  }),
  model({
    id: 'parakeet-tdt-0.6b-v2-fp16',
    name: 'Parakeet TDT 0.6B v2 (fp16)',
    role: 'batch',
    summary: 'the same family at full precision, for a machine with memory to spare',
    weight: 'heavy',
    sherpaType: 'nemo-transducer',
    files: {
      encoder: 'encoder.fp16.onnx',
      decoder: 'decoder.fp16.onnx',
      joiner: 'joiner.fp16.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['English'],
    archiveName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16.tar.bz2',
    bytes: 1_120_982_957,
    // computed: the release lists no digest for this asset.
    sha256: '37f67a1a6c942dae27d345ee395fbd19e25ee48996faf70fca25779026054cf0',
    extractedBytes: 1_257_395_951,
  }),
  model({
    id: 'whisper-turbo',
    name: 'Whisper turbo',
    role: 'batch',
    summary: 'broad languages at moderate cost',
    weight: 'standard',
    sherpaType: 'whisper',
    files: { encoder: 'turbo-encoder.int8.onnx', decoder: 'turbo-decoder.int8.onnx', tokens: 'turbo-tokens.txt' },
    languages: ['about 100 languages'],
    archiveName: 'sherpa-onnx-whisper-turbo.tar.bz2',
    bytes: 563_790_207,
    // computed: the release lists no digest for this asset.
    sha256: 'b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22',
    extractedBytes: 1_037_438_452,
  }),
  model({
    id: 'whisper-large-v3',
    name: 'Whisper large-v3',
    role: 'batch',
    summary: 'the heaviest Whisper; for strong CPUs',
    weight: 'heavy',
    sherpaType: 'whisper',
    files: {
      encoder: 'large-v3-encoder.int8.onnx',
      decoder: 'large-v3-decoder.int8.onnx',
      tokens: 'large-v3-tokens.txt',
    },
    languages: ['about 100 languages'],
    archiveName: 'sherpa-onnx-whisper-large-v3.tar.bz2',
    bytes: 1_068_482_488,
    // computed: the release lists no digest for this asset.
    sha256: '2d0e134b3b5fc4a0533baf24a0c9d473b629aa47f030af0a165a05f461df7a03',
    extractedBytes: 1_776_578_579,
  }),
  model({
    id: 'qwen3-asr-0.6b-int8',
    name: 'Qwen3-ASR 0.6B (int8)',
    role: 'batch',
    summary: 'languages Parakeet lacks, with strong Chinese',
    weight: 'heavy',
    sherpaType: 'qwen3-asr',
    files: {
      convFrontend: 'conv_frontend.onnx',
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      tokenizer: 'tokenizer',
    },
    languages: ['multilingual, strong Chinese'],
    archiveName: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
    bytes: 878_702_423,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: '393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96',
    extractedBytes: 1_000_089_677,
  }),
  model({
    id: 'cohere-transcribe-int8',
    name: 'Cohere Transcribe (14 languages, int8)',
    role: 'batch',
    summary: 'the largest model on the list, for the strongest machines',
    weight: 'heaviest',
    sherpaType: 'cohere-transcribe',
    // The encoder keeps its weights in a sibling file (ONNX external data); both must stay together.
    files: {
      encoder: 'encoder.int8.onnx',
      encoderData: 'encoder.int8.onnx.data',
      decoder: 'decoder.int8.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['14 languages'],
    archiveName: 'sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01.tar.bz2',
    bytes: 1_699_791_751,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: 'bd582588d50685a795dcd2807ab77e11361b8312d96c53884682def45ab4206d',
    extractedBytes: 2_889_366_679,
  }),
  model({
    id: 'canary-180m-flash-int8',
    name: 'Canary 180M flash (int8)',
    role: 'batch',
    summary: 'for small machines',
    weight: 'light',
    sherpaType: 'nemo-canary',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
    languages: ['English', 'Spanish', 'German', 'French'],
    archiveName: 'sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2',
    bytes: 153_692_328,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: '7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9',
    extractedBytes: 207_476_042,
  }),
  model({
    id: 'nemotron-streaming-0.6b-560ms-int8',
    name: 'Nemotron speech streaming 0.6B, 560 ms (int8)',
    role: 'streaming',
    summary: 'a real streaming model for real-time dictation',
    weight: 'standard',
    sherpaType: 'online-transducer',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['English'],
    archiveName: 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25.tar.bz2',
    bytes: 463_945_051,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: '78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358',
    extractedBytes: 662_744_235,
    recommended: true,
  }),
  model({
    id: 'parakeet-unified-0.6b-streaming-560ms-int8',
    name: 'Parakeet unified 0.6B streaming, 560 ms (int8)',
    role: 'streaming',
    summary: "Parakeet's own streaming variant",
    weight: 'standard',
    sherpaType: 'online-transducer',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['English'],
    archiveName: 'sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms.tar.bz2',
    bytes: 501_360_769,
    // GitHub release asset digest; recomputed with curl|sha256sum and equal.
    sha256: 'dd2c2698f102eafbf0ee54bdfd7cd842ec00fa6cf2475cbbb048887f794ff52e',
    extractedBytes: 663_295_226,
  }),
];

/** The `sherpa-onnx-node` JavaScript wrapper the recognizer slice bundles; it must match the runtime's version. */
export const SHERPA_WRAPPER_VERSION = '2.0.1';

const RUNTIME_VERSION = '2.0.1';
const NPM = 'https://registry.npmjs.org';

interface RuntimeRow {
  readonly target: VoiceRuntimeTarget;
  readonly bytes: number;
  readonly sha256: string;
  readonly extractedBytes: number;
  readonly libraryExtension: 'so' | 'dylib';
  readonly libraryLookup: VoiceRuntime['libraryLookup'];
}

const runtime = (row: RuntimeRow): VoiceRuntime => {
  const packageName = `sherpa-onnx-${row.target}`;
  const library = (name: string): string => `${name}.${row.libraryExtension}`;
  return VoiceRuntimeSchema.parse({
    target: row.target,
    packageName,
    version: RUNTIME_VERSION,
    archive: {
      url: `${NPM}/${packageName}/-/${packageName}-${RUNTIME_VERSION}.tgz`,
      format: 'tgz',
      bytes: row.bytes,
      sha256: row.sha256,
      extractedBytes: row.extractedBytes,
    },
    addon: 'sherpa-onnx.node',
    libraries: [library('libsherpa-onnx-c-api'), library('libonnxruntime'), library('libsherpa-onnx-cxx-api')],
    libraryLookup: row.libraryLookup,
  });
};

/**
 * The native runtime per target: the npm tarball of `sherpa-onnx-<target>@2.0.1`, pinned by the SHA-256 of
 * the tarball (computed from the registry's file; the registry publishes an sha512 `integrity`, which is a
 * different fact). Read, never loaded, when pinned (2026-11-05):
 *
 *  - linux-x64: `sherpa-onnx.node` has `RUNPATH $ORIGIN:<build dir>` and needs `libsherpa-onnx-c-api.so`,
 *    which has `RPATH $ORIGIN` and needs `libonnxruntime.so`. glibc and libstdc++ dynamically.
 *  - linux-arm64: `sherpa-onnx.node` has `RPATH $ORIGIN:<build dir>`; the libraries have `RPATH $ORIGIN`.
 *  - darwin-arm64 (Mach-O): `sherpa-onnx.node` has `LC_RPATH @loader_path` (and a build-dir path), the
 *    libraries `LC_RPATH @loader_path`; `libonnxruntime.dylib` links CoreML and Foundation from the system.
 *
 * So all three find their siblings IN-TREE: the worker needs no `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH`,
 * only that the addon and its libraries stay together in one directory (as Install unpacks them).
 */
export const VOICE_RUNTIMES: readonly VoiceRuntime[] = [
  runtime({
    target: 'linux-x64',
    bytes: 11_005_484,
    sha256: '08c6fe2b65838febbd0c260aaa9991990d2d592e503e758bfd2f5db6cbc79338',
    extractedBytes: 33_196_612,
    libraryExtension: 'so',
    libraryLookup: 'origin',
  }),
  runtime({
    target: 'linux-arm64',
    bytes: 13_822_449,
    sha256: 'b8f18ee34c8e14bbafb7f51332361a6ab91f4ddbb4a4eac58f74ec0dafb39e87',
    extractedBytes: 40_205_239,
    libraryExtension: 'so',
    libraryLookup: 'origin',
  }),
  runtime({
    target: 'darwin-arm64',
    bytes: 10_013_200,
    sha256: 'afc9415260e232c4dadc25a29a8645acb0ba06ef989060d32274f4c749a4830e',
    extractedBytes: 34_070_681,
    libraryExtension: 'dylib',
    libraryLookup: 'loader-path',
  }),
];

export function findVoiceModel(id: string): VoiceModel | undefined {
  return VOICE_MODELS.find(candidate => candidate.id === id);
}
