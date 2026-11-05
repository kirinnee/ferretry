/**
 * WHICH EXECUTION PATH A SPEECH MODEL RUNS ON, chosen per device — a PURE, TOTAL function.
 *
 * Three paths exist in principle; docs/voice.md › Speed has the measured facts behind this file:
 *
 *   - `webgpu`       the GPU, through ONNX Runtime Web's WebGPU provider. Needs no isolation.
 *   - `wasm-threads` WebAssembly with several threads. Needs `SharedArrayBuffer`, which a page has only
 *                    while it is cross-origin isolated (COOP + COEP headers).
 *   - `wasm-single`  WebAssembly on one thread. Runs everywhere. The floor, and the only path that cannot
 *                    be refused.
 *
 * WHAT A DEVICE CAN DO is three separate questions, answered by three separate owners:
 *
 *   1. what this BUILD ships ({@link BUILD_PATHS}) — the Pages size limit keeps the WebGPU runtime out;
 *   2. what each MODEL's artifacts can run on ({@link MODEL_PATHS}) — the int8 Parakeet encoder cannot
 *      use ONNX Runtime's WebGPU provider; sherpa-onnx's and Vosk's prebuilt binaries are single-thread;
 *   3. what THIS DEVICE offers right now ({@link SpeedSignals}) — a WebGPU adapter, isolation, cores,
 *      memory — and what already failed here ({@link SpeedMemory}).
 *
 * A path is a candidate only when all three agree. The fastest candidate wins; a path that failed on
 * this device recently is skipped (the memory forgets after {@link FAILURE_FORGET_MS}, so a fixed
 * driver or a new header is tried again). `wasm-single` is always a candidate, so the answer is total:
 * there is no input for which no path is chosen, and nothing here throws.
 */

import type { OnDeviceModelId } from './model-catalog.ts';

export type SpeedPath = 'webgpu' | 'wasm-threads' | 'wasm-single';

/** Fastest first. The order IS the preference. */
export const SPEED_PATH_ORDER: readonly SpeedPath[] = ['webgpu', 'wasm-threads', 'wasm-single'];

/** What a person reads, in the words Settings uses. */
export const SPEED_PATH_LABEL: Readonly<Record<SpeedPath, string>> = {
  webgpu: 'WebGPU',
  'wasm-threads': 'multi-thread WebAssembly',
  'wasm-single': 'single-thread WebAssembly',
};

/**
 * What THIS BUILD ships. WebGPU is absent on purpose: ONNX Runtime Web's WebGPU-capable binary is
 * 27,084,114 bytes, over Cloudflare Pages' 25 MiB per-file limit, so `vite.config.ts` aliases it away
 * (every Pages deploy failed while it shipped). Add `'webgpu'` here ONLY together with a runtime that
 * fits the host; the chooser, the workers and the tests already handle it.
 */
export const BUILD_PATHS: readonly SpeedPath[] = ['wasm-threads', 'wasm-single'];

const SINGLE_ONLY: readonly SpeedPath[] = ['wasm-single'];

/**
 * What each model's ARTIFACTS can run on.
 *
 *   - Parakeet 0.6B (int8 on ONNX Runtime Web): threads yes; WebGPU no — the int8 encoder uses integer
 *     kernels the WebGPU provider lacks, and parakeet.js itself swaps to the 2.5 GB fp32 encoder to
 *     use it.
 *   - Whisper q8 (transformers.js on ONNX Runtime Web): threads yes; WebGPU is listed because the
 *     worker core has a WebGPU-first path, but it is inert until the build ships a runtime for it.
 *   - Everything on sherpa-onnx (Parakeet 110M, Moonshine, Zipformer) and Vosk: prebuilt single-thread
 *     WebAssembly with no WebGPU provider.
 */
export const MODEL_PATHS: Readonly<Record<OnDeviceModelId, readonly SpeedPath[]>> = {
  parakeet: ['wasm-threads', 'wasm-single'],
  'whisper-tiny-en': ['webgpu', 'wasm-threads', 'wasm-single'],
  'whisper-base-en': ['webgpu', 'wasm-threads', 'wasm-single'],
  'parakeet-tdt-110m': SINGLE_ONLY,
  'sherpa-zipformer-en': SINGLE_ONLY,
  'moonshine-tiny-en': SINGLE_ONLY,
  'moonshine-base-en': SINGLE_ONLY,
  'vosk-small-en': SINGLE_ONLY,
};

/** What the device offers right now. `null` means the browser does not say. */
export interface SpeedSignals {
  /** `navigator.gpu.requestAdapter()` answered with an adapter. */
  readonly webgpuAdapter: boolean;
  /** `crossOriginIsolated`: `SharedArrayBuffer` exists. */
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number | null;
  /** `navigator.deviceMemory`, in GB, rounded and capped by the browser. */
  readonly deviceMemoryGb: number | null;
}

/** The signals of a device that offers nothing: the floor. */
export const NO_SIGNALS: SpeedSignals = {
  webgpuAdapter: false,
  crossOriginIsolated: false,
  hardwareConcurrency: null,
  deviceMemoryGb: null,
};

/** A path that failed on this device, and when. */
export interface SpeedFailure {
  readonly model: OnDeviceModelId;
  readonly path: SpeedPath;
  readonly at: number;
}

/** What this device already learned. */
export interface SpeedMemory {
  readonly failures: readonly SpeedFailure[];
}

export const NO_MEMORY: SpeedMemory = { failures: [] };

/** A failure is forgotten after a week: a driver update or a new header deserves another try. */
export const FAILURE_FORGET_MS = 7 * 24 * 60 * 60 * 1000;

/** At or below this many GB a device runs one thread: each thread adds working memory. */
const LOW_MEMORY_GB = 4;
const MIN_THREADS = 2;
export const MAX_THREADS = 4;

export type SpeedReason =
  | 'fastest'
  /** The model's artifacts or the build offer nothing faster than one thread. */
  | 'only-path'
  /** A faster path exists for this model, but this page is not cross-origin isolated. */
  | 'not-isolated'
  | 'no-gpu'
  | 'low-memory'
  | 'few-cores'
  /** A faster path failed on this device and is skipped for now. */
  | 'failed-before';

export interface SpeedPlan {
  readonly path: SpeedPath;
  /** Threads for the WebAssembly runtime: 1 unless `wasm-threads`. */
  readonly threads: number;
  readonly reason: SpeedReason;
}

const failedRecently = (memory: SpeedMemory, model: OnDeviceModelId, path: SpeedPath, now: number): boolean =>
  memory.failures.some(
    failure =>
      failure.model === model &&
      failure.path === path &&
      Number.isFinite(failure.at) &&
      now - failure.at >= 0 &&
      now - failure.at < FAILURE_FORGET_MS,
  );

/** Threads for a device with this many logical cores: half of them, between {@link MIN_THREADS} and {@link MAX_THREADS}. */
export const threadsFor = (hardwareConcurrency: number | null): number => {
  if (hardwareConcurrency === null || !Number.isFinite(hardwareConcurrency)) return 1;
  const half = Math.floor(hardwareConcurrency / 2);
  return half < MIN_THREADS ? 1 : Math.min(MAX_THREADS, half);
};

/** What stops a faster path on this device, or `null` when nothing does. */
const blockerOf = (
  path: SpeedPath,
  model: OnDeviceModelId,
  signals: SpeedSignals,
  memory: SpeedMemory,
  now: number,
): SpeedReason | null => {
  if (failedRecently(memory, model, path, now)) return 'failed-before';
  if (path === 'webgpu') return signals.webgpuAdapter ? null : 'no-gpu';
  if (!signals.crossOriginIsolated) return 'not-isolated';
  if (signals.deviceMemoryGb !== null && signals.deviceMemoryGb <= LOW_MEMORY_GB) return 'low-memory';
  return threadsFor(signals.hardwareConcurrency) < MIN_THREADS ? 'few-cores' : null;
};

/**
 * The plan for one model on one device. Pure and total: any `model`, any `signals`, any `memory` gives
 * a plan, and `wasm-single` is the answer when nothing else qualifies.
 */
export function chooseSpeedPlan(
  model: OnDeviceModelId,
  signals: SpeedSignals,
  memory: SpeedMemory,
  now: number,
  /** What the build ships; a seam for the day it ships WebGPU, and for tests. */
  build: readonly SpeedPath[] = BUILD_PATHS,
): SpeedPlan {
  const offered = MODEL_PATHS[model] ?? SINGLE_ONLY;
  const faster = SPEED_PATH_ORDER.filter(
    path => path !== 'wasm-single' && offered.includes(path) && build.includes(path),
  );
  // The reason reported is the first thing that stopped the fastest path.
  let firstBlocker: SpeedReason | null = null;
  for (const path of faster) {
    const blocker = blockerOf(path, model, signals, memory, now);
    if (blocker === null)
      return {
        path,
        threads: path === 'wasm-threads' ? threadsFor(signals.hardwareConcurrency) : 1,
        reason: 'fastest',
      };
    firstBlocker ??= blocker;
  }
  return { path: 'wasm-single', threads: 1, reason: firstBlocker ?? 'only-path' };
}

/** The sentence Settings shows, read-only. */
export const speedLine = (plan: SpeedPlan): string => `Using: ${SPEED_PATH_LABEL[plan.path]}`;

/** Why that path, in a sentence a person can read under the line. */
export const SPEED_REASON_TEXT: Readonly<Record<SpeedReason, string>> = {
  fastest: 'The fastest option this device offers.',
  'only-path': 'This engine runs on one thread.',
  'not-isolated': 'More threads need a browser feature this page does not turn on.',
  'no-gpu': 'No graphics-card speed-up is available on this device.',
  'low-memory': 'Kept to one thread to save memory.',
  'few-cores': 'Too few cores for more threads to help.',
  'failed-before': 'A faster option failed on this device, so it is skipped for now.',
};
