/**
 * THE SPEECH WORKER — the machine half of voice mode. One thread per daemon, started on the first use and ended after
 * ten idle minutes (`daemon/lib/engine/engine.ts`), so its memory is the OS's again the moment it is not needed.
 *
 * Parakeet TDT 0.6B v3 (int8) is decoded by one of two engines, whichever the main thread asks for:
 *  - NATIVE: sherpa-onnx's own compiled library, loaded by path from the folder Install put it in (`native-addon.ts`),
 *    on several threads, reading the three graphs from their own paths. About six times faster than the other;
 *  - WebAssembly (`@sherpaw/asr`, the same runtime the app ships), one thread: the fallback for a machine with no native
 *    build or whose native library would not start.
 * Silero VAD v5 runs on onnxruntime-web in both: it costs about 10 ms per second of audio, a native one would save a
 * tenth of that, and its per-chunk probabilities (which the pause decision reads) are not exposed by sherpa's detector.
 *
 * NO NETWORK. The WebAssembly path takes every byte from the main thread as a transferred ArrayBuffer (it read them from
 * its own state folder, after checking each against its pinned hash): the sherpa glue is handed its binary instead of
 * fetching it, and the model files go into the module's in-memory file system and are deleted from it as soon as the
 * graphs are built, which halves the resident memory (the graphs keep their own copy). The native path is sent paths
 * (the main thread verified the library against its pinned hashes first) and only the small Silero files as bytes.
 */
import { pathToFileURL } from 'node:url';
import { OfflineRecognizer } from '@sherpaw/asr';
import * as ort from 'onnxruntime-web/wasm';
// Imported as a FILE (24 KB), so a compiled binary embeds it: onnxruntime imports its loader by path, and a path
// resolved from the package at run time exists only in a source checkout.
import ORT_LOADER_PATH from 'onnxruntime-web/ort-wasm-simd-threaded.mjs' with { type: 'file' };
// The Emscripten loader of @sherpaw/asr 0.3.0, which its exports map does not name (same file `app/vite-voice.ts` aliases).
import initSherpaUntyped from './sherpa-glue.js';
import { type SpeechReply, type SpeechRequest, SPEECH_SAMPLE_RATE } from '../lib/engine/protocol.ts';
import { spansFromProbabilities, VAD_CHUNK } from '../lib/engine/spans.ts';
import { collectNative, type Handle, loadAddon, type NativeAddon, track } from './native-addon.ts';

interface SherpaModule {
  FS_createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): void;
  FS_createDataFile(
    parent: string,
    name: string,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    canOwn: boolean,
  ): void;
  FS_unlink(path: string): void;
  HEAPU8: { readonly length: number };
}

interface SherpaOptions {
  readonly wasmBinary: Uint8Array;
  locateFile(file: string): string;
  print(text: string): void;
  printErr(text: string): void;
}
const initSherpa = initSherpaUntyped as unknown as (options: SherpaOptions) => Promise<SherpaModule>;

const MODEL_DIR = '/model';
const FEATURE_DIM = 128; // Parakeet v3's mel bins (the 110M model uses 80)
const CONTEXT = 64; // Silero v5 wants the previous 64 samples in front of each chunk
const MEMORY_UNIT = 1_048_576;

/** Whichever engine is loaded: both turn 16 kHz samples into words, and say how many ms they took. */
type Decode = (samples: Float32Array) => string;

let decode: Decode | undefined;
let vad: ort.InferenceSession | undefined;

declare const self: {
  onmessage: ((event: { readonly data: SpeechRequest }) => void) | null;
  postMessage(reply: SpeechReply): void;
};

let heapBytes = 0;
/** The sherpa module's own memory. A worker thread shares its process's resident size, so that figure would say nothing about the speech engine. */
const memoryMb = (): number => Math.round(heapBytes / MEMORY_UNIT);

/** Silero, on onnxruntime-web, from the two small files both engines are sent. */
async function loadVad(ortWasm: ArrayBuffer, vadModel: ArrayBuffer): Promise<void> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = new Uint8Array(ortWasm);
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(ORT_LOADER_PATH).href };
  vad = await ort.InferenceSession.create(new Uint8Array(vadModel), { executionProviders: ['wasm'] });
}

async function loadWasm(request: Extract<SpeechRequest, { kind: 'load'; engine: 'wasm' }>): Promise<number> {
  const started = performance.now();
  const files = request.files;
  const module = await initSherpa({
    wasmBinary: new Uint8Array(files['sherpa-wasm']),
    locateFile: (file: string) => file,
    print: () => undefined,
    printErr: () => undefined,
  });
  module.FS_createPath('/', MODEL_DIR.slice(1), true, true);
  const names = {
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
  };
  for (const [role, name] of Object.entries(names))
    module.FS_createDataFile(MODEL_DIR, name, new Uint8Array(files[role as keyof typeof names]), true, false, true);
  const path = (name: string): string => `${MODEL_DIR}/${name}`;
  const recognizer = new OfflineRecognizer(
    {
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: FEATURE_DIM },
      modelConfig: {
        transducer: { encoder: path(names.encoder), decoder: path(names.decoder), joiner: path(names.joiner) },
        modelType: 'nemo_transducer',
        tokens: path(names.tokens),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    },
    module as never,
  );
  heapBytes = module.HEAPU8.length;
  // The graphs are built: the file copies in the in-memory file system are dead weight now.
  for (const name of Object.values(names)) module.FS_unlink(path(name));
  decode = samples => {
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(SPEECH_SAMPLE_RATE, samples);
      recognizer.decode(stream);
      return String(recognizer.getResult(stream).text ?? '');
    } finally {
      stream.free();
    }
  };
  await loadVad(files['ort-wasm'], files.vad);
  return performance.now() - started;
}

async function loadNative(request: Extract<SpeechRequest, { kind: 'load'; engine: 'native' }>): Promise<number> {
  const started = performance.now();
  const before = process.memoryUsage().rss;
  const addon: NativeAddon = loadAddon(request.addon);
  const recognizer: Handle = track(
    addon.createOfflineRecognizer({
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: FEATURE_DIM },
      modelConfig: {
        transducer: { encoder: request.paths.encoder, decoder: request.paths.decoder, joiner: request.paths.joiner },
        modelType: 'nemo_transducer',
        tokens: request.paths.tokens,
        numThreads: request.threads,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    }),
  );
  decode = samples => {
    const stream = addon.createOfflineStream(recognizer);
    addon.acceptWaveformOffline(stream, { sampleRate: SPEECH_SAMPLE_RATE, samples });
    addon.decodeOfflineStream(recognizer, stream);
    return String((JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as { text?: unknown }).text ?? '');
  };
  await loadVad(request.files['ort-wasm'], request.files.vad);
  // The native engine's memory is the process's growth while it loaded (a worker shares its process's resident size).
  heapBytes = Math.max(0, process.memoryUsage().rss - before);
  return performance.now() - started;
}

function transcribe(samples: Float32Array): { text: string; decodeMs: number } {
  if (decode === undefined) throw new Error('the speech models are not loaded');
  const started = performance.now();
  const text = decode(samples).trim();
  return { text, decodeMs: performance.now() - started };
}

async function detect(samples: Float32Array): Promise<readonly { start: number; end: number }[]> {
  if (vad === undefined) throw new Error('the speech models are not loaded');
  const sampleRate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SPEECH_SAMPLE_RATE)]), []);
  let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  let context = new Float32Array(CONTEXT);
  const probabilities: number[] = [];
  for (let at = 0; at + VAD_CHUNK <= samples.length; at += VAD_CHUNK) {
    const input = new Float32Array(CONTEXT + VAD_CHUNK);
    input.set(context, 0);
    input.set(samples.subarray(at, at + VAD_CHUNK), CONTEXT);
    context = samples.slice(at + VAD_CHUNK - CONTEXT, at + VAD_CHUNK);
    const out = await vad.run({
      input: new ort.Tensor('float32', input, [1, CONTEXT + VAD_CHUNK]),
      state,
      sr: sampleRate,
    });
    state = out.stateN as ort.Tensor;
    probabilities.push((out.output?.data as Float32Array | undefined)?.[0] ?? 0);
  }
  return spansFromProbabilities(probabilities, samples.length);
}

async function answer(request: SpeechRequest): Promise<SpeechReply> {
  switch (request.kind) {
    case 'load': {
      const loadMs = request.engine === 'native' ? await loadNative(request) : await loadWasm(request);
      return { id: request.id, ok: true, kind: 'load', loadMs, memoryMb: memoryMb() };
    }
    case 'probe':
      return { id: request.id, ok: true, kind: 'probe', version: String(loadAddon(request.addon).version) };
    case 'release':
      decode = undefined;
      await collectNative();
      return { id: request.id, ok: true, kind: 'release' };
    case 'transcribe':
      return { id: request.id, ok: true, kind: 'transcribe', ...transcribe(request.samples) };
    case 'detect':
      return { id: request.id, ok: true, kind: 'detect', spans: await detect(request.samples) };
  }
}

self.onmessage = event => {
  const request = event.data;
  // `fyd --check` starts this thread with nothing granted and asks `{ probe: true }`: answering it proves the program
  // and both WebAssembly runtimes' JavaScript loaded in this binary, without touching a model.
  if ((request as { probe?: unknown }).probe === true) {
    (self as unknown as { postMessage(reply: unknown): void }).postMessage({ probe: true, ok: true });
    return;
  }
  // A failure says what failed and nothing it held: an error here could carry decoded words.
  void answer(request).then(
    reply => self.postMessage(reply),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        // Only a load or a probe says why: its error names a file or a runtime, never audio. A decode's could hold what was said.
        sentence: `The speech engine could not ${request.kind}${request.kind === 'load' || request.kind === 'probe' ? `: ${String((error as Error)?.message ?? error).slice(0, 300)}` : ''}.`,
      }),
  );
};
