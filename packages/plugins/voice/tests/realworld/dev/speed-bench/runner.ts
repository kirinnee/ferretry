/**
 * THE SPEED BENCHMARK RUNNER — browser-side, shared by the one-click dev page (`speed-bench/main.ts`) and the
 * headless driver (`harness/stt-speed-bench.ts`). Manual; never part of the shipped bundle, never in CI.
 *
 * For each engine and each path it starts a FRESH worker (so the load is a real cold load: read the
 * installed bytes, re-hash them, build the model), then decodes the same fixed 5 s clip several times,
 * then measures what an early finish leaves of the wait after a 1.5 s pause. What it returns is plain
 * timings (`lib/stt/speed-bench-report.ts`): no transcript text ever leaves this function.
 *
 * It installs a model through the shipped store ONLY when `install` is true — that is a download the
 * person asked for by pressing the benchmark's button.
 */

import { mixToMono } from '../../../../app/lib/stt/audio-capture.ts';
import { type OnDeviceModelId, onDeviceModel } from '../../../../app/lib/stt/model-catalog.ts';
import type { OnDeviceVoice } from '../../../../app/lib/stt/on-device-voice.ts';
import { ParakeetEngine, type ParakeetWorkerLike } from '../../../../app/lib/stt/parakeet-engine.ts';
import {
  browserParakeetVoice,
  type ParakeetAssets,
  type ParakeetGlobalLike,
} from '../../../../app/lib/stt/parakeet-voice.ts';
import { SherpaEngine, type SherpaWorkerLike } from '../../../../app/lib/stt/sherpa-engine.ts';
import { browserSherpaVoice, type SherpaAssets, type SherpaGlobalLike } from '../../../../app/lib/stt/sherpa-voice.ts';
import {
  type BenchDevice,
  type BenchPath,
  type BenchRun,
  isSoftwareAdapter,
  median,
  realTimeFactor,
  SPEED_BENCH_VERSION,
  type SpeedBenchReport,
  syntheticClip,
  userAgentFamily,
} from '../../../../app/lib/stt/speed-bench-report.ts';
import { threadsFor } from '../../../../app/lib/stt/speed-plan.ts';
import { TentativeTranscriber } from '../../../../app/lib/stt/tentative-take.ts';
import { trustedWorkerUrl } from '../../../../app/shell-voice.ts';
import { VoskEngine, type VoskWorkerLike } from '../../../../app/lib/stt/vosk-engine.ts';
import { browserVoskVoice, type VoskAssets } from '../../../../app/lib/stt/vosk-voice.ts';
import { WhisperEngine, type WhisperWorkerLike } from '../../../../app/lib/stt/whisper-engine.ts';
import { browserWhisperVoice, type WhisperAssets } from '../../../../app/lib/stt/whisper-voice.ts';

export interface BenchAssets {
  readonly parakeet: ParakeetAssets;
  readonly sherpa: SherpaAssets;
  readonly vosk: VoskAssets;
  readonly whisper: WhisperAssets;
}

export interface BenchOptions {
  readonly engines: readonly OnDeviceModelId[];
  readonly paths: readonly BenchPath[];
  /** Threads for the `wasm-threads` path; defaults to what the planner would ask on this device. */
  readonly threads?: number;
  /** Warm decodes per run. */
  readonly warmRuns: number;
  readonly pauseMs: number;
  /** Download a model that is not installed (the person pressed the button). */
  readonly install: boolean;
  readonly clipUrl: string;
  progress?(line: string): void;
}

type SpeedGlobal = ParakeetGlobalLike &
  SherpaGlobalLike & {
    readonly navigator?: {
      readonly userAgent?: string;
      readonly gpu?: { requestAdapter(): Promise<{ readonly info?: Record<string, unknown> } | null> };
    };
    readonly crossOriginIsolated?: boolean;
  };

/** One engine, whatever its runtime, as the benchmark drives it. */
interface Rig {
  preload(): void;
  consumeLoadMs(): number | undefined;
  /** Decode a whole take; the text is discarded here and never leaves. */
  decode(samples: Float32Array, signal?: AbortSignal): Promise<void>;
  /** For a streaming engine: feed in real time, then time `finish()`. `null` for a whole-take engine. */
  readonly stream: ((samples: Float32Array) => Promise<{ readonly finishMs: number; readonly totalMs: number }>) | null;
  unload(): void;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const failureCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z-]{1,32}$/u.test(code) ? code : 'failed';
};

/** What the page can say about its device, without identifying it. */
const describeDevice = async (global: SpeedGlobal): Promise<BenchDevice> => {
  const nav = global.navigator as
    | (SpeedGlobal['navigator'] & { hardwareConcurrency?: number; deviceMemory?: number })
    | undefined;
  let adapterClass: string | null = null;
  let software: boolean | null = null;
  let has = false;
  try {
    const adapter = await nav?.gpu?.requestAdapter();
    if (adapter) {
      has = true;
      const info = adapter.info ?? {};
      const words = [info.vendor, info.architecture].filter(word => typeof word === 'string' && word !== '');
      adapterClass = words.length > 0 ? words.join(' ').slice(0, 96) : null;
      software = isSoftwareAdapter(
        `${String(info.description ?? '')} ${String(info.vendor ?? '')} ${String(info.architecture ?? '')}`,
      );
    }
  } catch {
    // No adapter is an answer.
  }
  return {
    userAgentFamily: userAgentFamily(nav?.userAgent ?? ''),
    crossOriginIsolated: global.crossOriginIsolated === true,
    hardwareConcurrency: typeof nav?.hardwareConcurrency === 'number' ? Math.floor(nav.hardwareConcurrency) : null,
    deviceMemoryGb: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    webgpuAdapter: has,
    webgpuAdapterClass: adapterClass,
    webgpuAdapterIsSoftware: software,
  };
};

/** The fixed clip: the committed synthetic-voice WAV, else a deterministic synthetic signal. */
const loadClip = async (url: string): Promise<{ samples: Float32Array; source: 'wav' | 'synthetic' }> => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('no clip');
    const buffer = await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(await response.arrayBuffer());
    return { samples: mixToMono(buffer), source: 'wav' };
  } catch {
    return { samples: syntheticClip(5), source: 'synthetic' };
  }
};

export async function runBench(
  global: SpeedGlobal,
  assets: BenchAssets,
  options: BenchOptions,
): Promise<SpeedBenchReport> {
  const say = options.progress ?? (() => undefined);
  const device = await describeDevice(global);
  const clip = await loadClip(options.clipUrl);
  say(`clip: ${clip.source}, ${(clip.samples.length / 16_000).toFixed(2)} s`);
  const clipSeconds = clip.samples.length / 16_000;
  const askedThreads = options.threads ?? Math.max(2, threadsFor(device.hardwareConcurrency));
  const runs: BenchRun[] = [];

  for (const id of options.engines) {
    const model = onDeviceModel(id);
    if (model === null) continue;
    const prepared = await prepare(global, assets, id, options.install, say);
    for (const path of options.paths) {
      const threads = path === 'wasm-threads' ? askedThreads : 1;
      const base = { engine: id, path, threads } as const;
      if (prepared === null) {
        runs.push({ ...empty(base), failure: 'not-installed' });
        continue;
      }
      if (path === 'wasm-threads' && !device.crossOriginIsolated) {
        runs.push({ ...empty(base), failure: 'not-isolated' });
        continue;
      }
      if (path === 'wasm-threads' && !prepared.threadable) {
        runs.push({ ...empty(base), failure: 'single-only' });
        continue;
      }
      say(`${id} · ${path} (${threads} thread${threads === 1 ? '' : 's'})`);
      runs.push(await runOne(prepared.rig(threads), base, clip.samples, clipSeconds, options, say));
    }
  }
  return { v: SPEED_BENCH_VERSION, clipSeconds, pauseMs: options.pauseMs, device, runs };
}

const empty = (base: Pick<BenchRun, 'engine' | 'path' | 'threads'>): BenchRun => ({
  ...base,
  loadMs: null,
  decodeMs: [],
  realTimeFactor: null,
  lastAudioToTextMs: null,
  afterEarlyFinishMs: null,
  fellBack: false,
  failure: null,
});

interface Prepared {
  /** Whether the engine can take more than one thread. */
  readonly threadable: boolean;
  /** A fresh rig (fresh worker) asking for `threads`. `fellBack` is set if the engine moved to one. */
  rig(threads: number): Rig & { fellBack(): boolean };
}

async function prepare(
  global: SpeedGlobal,
  assets: BenchAssets,
  id: OnDeviceModelId,
  install: boolean,
  say: (line: string) => void,
): Promise<Prepared | null> {
  const model = onDeviceModel(id);
  if (model === null) return null;
  let voice: OnDeviceVoice;
  if (model.runtime === 'onnxruntime-web') voice = browserParakeetVoice(global, assets.parakeet);
  else if (model.runtime === 'sherpa-onnx') voice = browserSherpaVoice(model, global, assets.sherpa, () => false);
  else if (model.runtime === 'vosk-wasm') voice = browserVoskVoice(global, assets.vosk);
  else if (model.runtime === 'transformers-js') voice = browserWhisperVoice(global, assets.whisper, model, () => false);
  else return null;
  await voice.refresh();
  if (voice.getSnapshot().phase !== 'installed') {
    if (!install) return null;
    say(`${id}: installing (a download you asked for)…`);
    await voice.install();
    const after = voice.getSnapshot();
    if (after.phase !== 'installed') {
      say(`${id}: install ended ${after.phase}${after.error === undefined ? '' : ` (${after.error.code})`}`);
      return null;
    }
  }
  const spawn =
    <W>(name: string): (() => W) =>
    () =>
      new (global.Worker as unknown as new (url: string, options: { type: 'module'; name: string }) => W)(
        trustedWorkerUrl(
          model.runtime === 'onnxruntime-web'
            ? assets.parakeet.workerUrl
            : model.runtime === 'sherpa-onnx'
              ? assets.sherpa.workerUrl
              : model.runtime === 'vosk-wasm'
                ? assets.vosk.workerUrl
                : assets.whisper.workerUrl,
        ),
        { type: 'module', name },
      );
  if (model.runtime === 'onnxruntime-web')
    return {
      threadable: true,
      rig: threads => {
        let fell = false;
        const engine = new ParakeetEngine(spawn<ParakeetWorkerLike>('fy-bench-parakeet'), undefined, {
          threads: () => threads,
          onThreadsFailed: reason => {
            fell = true;
            say(`  threads did not work: ${reason}`);
          },
        });
        return {
          preload: () => engine.preload(),
          consumeLoadMs: () => engine.consumeLoadMs(),
          decode: async (samples, signal) => void (await engine.transcribe(samples, signal)),
          stream: null,
          unload: () => engine.unload(),
          fellBack: () => fell,
        };
      },
    };
  if (model.runtime === 'transformers-js')
    return {
      threadable: true,
      rig: threads => {
        let fell = false;
        const engine = new WhisperEngine(id, spawn<WhisperWorkerLike>('fy-bench-whisper'), undefined, {
          threads: () => threads,
          onThreadsFailed: reason => {
            fell = true;
            say(`  threads did not work: ${reason}`);
          },
        });
        return {
          preload: () => engine.preload(),
          consumeLoadMs: () => engine.consumeLoadMs(),
          decode: async (samples, signal) => void (await engine.transcribe(samples, signal)),
          stream: null,
          unload: () => engine.unload(),
          fellBack: () => fell,
        };
      },
    };
  if (model.runtime === 'sherpa-onnx')
    return {
      threadable: false,
      rig: () => {
        const engine = new SherpaEngine(spawn<SherpaWorkerLike>('fy-bench-sherpa'), id);
        return {
          preload: () => engine.preload(),
          consumeLoadMs: () => engine.consumeLoadMs(),
          decode: async (samples, signal) => void (await engine.transcribe(samples, signal)),
          stream: null,
          unload: () => engine.unload(),
          fellBack: () => false,
        };
      },
    };
  return {
    threadable: false,
    rig: () => {
      const engine = new VoskEngine(spawn<VoskWorkerLike>('fy-bench-vosk'));
      return {
        preload: () => engine.preload(),
        consumeLoadMs: () => engine.consumeLoadMs(),
        decode: async () => undefined,
        stream: async samples => {
          const piece = 6_400; // 0.4 s, the pump the app uses
          const stream = engine.open({ onHeard: () => undefined, onFailure: () => undefined });
          const began = performance.now();
          for (let offset = 0; offset < samples.length; offset += piece) {
            stream.feed(samples.slice(offset, offset + piece));
            await sleep(400);
          }
          const stopped = performance.now();
          await stream.finish();
          return { finishMs: performance.now() - stopped, totalMs: performance.now() - began };
        },
        unload: () => engine.unload(),
        fellBack: () => false,
      };
    },
  };
}

async function waitForLoad(rig: Rig, timeoutMs: number): Promise<number | null> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    const loaded = rig.consumeLoadMs();
    if (loaded !== undefined) return loaded;
    await sleep(25);
  }
  return null;
}

async function runOne(
  rig: Rig & { fellBack(): boolean },
  base: Pick<BenchRun, 'engine' | 'path' | 'threads'>,
  clip: Float32Array,
  clipSeconds: number,
  options: BenchOptions,
  say: (line: string) => void,
): Promise<BenchRun> {
  try {
    rig.preload();
    const loadMs = await waitForLoad(rig, 180_000);
    if (loadMs === null) return { ...empty(base), failure: 'load-timeout' };
    const result = { ...empty(base), loadMs };
    if (rig.stream !== null) {
      // Streaming: nothing is decoded "at the pause"; the wait is `finish()` after the last piece.
      const paced = await rig.stream(clip);
      say(`  finish after the last piece: ${paced.finishMs.toFixed(0)} ms`);
      return { ...result, lastAudioToTextMs: paced.finishMs };
    }
    const decodeMs: number[] = [];
    for (let run = 0; run < options.warmRuns + 1; run += 1) {
      const began = performance.now();
      await rig.decode(clip.slice());
      const took = performance.now() - began;
      // The first decode after a load is warm-up (JIT, allocator): it is dropped from the figures.
      if (run > 0) decodeMs.push(took);
      say(`  decode ${run === 0 ? '(warm-up)' : run}: ${took.toFixed(0)} ms`);
    }
    // Early finish: the decode starts at the first quiet; the pause is then confirmed `pauseMs` later.
    const tail = new Float32Array(Math.round((16_000 * options.pauseMs) / 1000));
    const final = new Float32Array(clip.length + tail.length);
    final.set(clip);
    const outer = new AbortController();
    const early = new TentativeTranscriber(
      {
        peek: async () => clip.slice(),
        transcribe: async (samples, signal) => (await rig.decode(samples, signal), ''),
      },
      outer.signal,
    );
    early.begin();
    await sleep(options.pauseMs);
    const reuseAt = performance.now();
    await early.reuse(final);
    const afterEarlyFinishMs = performance.now() - reuseAt;
    const middle = median(decodeMs);
    return {
      ...result,
      decodeMs,
      realTimeFactor: realTimeFactor(decodeMs, clipSeconds),
      lastAudioToTextMs: middle,
      afterEarlyFinishMs: middle === null ? null : afterEarlyFinishMs,
      fellBack: rig.fellBack(),
    };
  } catch (error) {
    return { ...empty(base), failure: failureCode(error), fellBack: rig.fellBack() };
  } finally {
    rig.unload();
  }
}
