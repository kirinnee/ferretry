/**
 * THE SHAPE OF A SPEED BENCHMARK RESULT, and the arithmetic behind it (docs/voice.md › Speed).
 *
 * The benchmark itself runs in a browser (`speed-bench/`, `harness/stt-speed-bench.ts`) because it needs a
 * real worker, a real WebAssembly runtime and a real clock. What it PRODUCES is plain data, defined here so
 * the result can be parsed, compared and pasted into an issue without trusting the page that made it:
 *
 *   - TIMINGS ONLY. Nothing here can hold a transcript: the schema is strict and has no text field, and an
 *     engine's failure is a short code, never its message. The clip is a synthetic voice (eSpeak NG), not a
 *     person.
 *   - NO IDENTITY. The device is described by class — user agent family, cores, memory, isolation, whether a
 *     WebGPU adapter exists and its vendor/architecture — never an address, a name, or a serial.
 *
 * Definitions, used everywhere the numbers are quoted:
 *
 *   load            the worker started and the model is built, from `preload()` to the worker's "ready".
 *   decode          one whole-take decode of the 5 s clip, with the model already loaded (median of warm runs).
 *   real-time factor  decode / audio duration. Below 1 is faster than speaking.
 *   last audio → text  what a person waits after the LAST audio arrives: for a whole-take engine the decode of
 *                    the take; for a streaming engine (Vosk) the time `finish()` takes after the last piece
 *                    was fed in real time.
 *   after early finish  the same wait when the decode was started `pauseMs` earlier (`tentative-take.ts`):
 *                    what is left of it once the pause has been confirmed.
 */

import { z } from 'zod';
import { ON_DEVICE_MODEL_IDS } from './model-catalog.ts';

export const SPEED_BENCH_VERSION = 1;

/** The paths a benchmark can force. WebGPU is reported as a probe, not a run, until a build ships it. */
const BENCH_PATHS = ['wasm-single', 'wasm-threads'] as const;
export type BenchPath = (typeof BENCH_PATHS)[number];

const Milliseconds = z.number().finite().nonnegative();

const RunSchema = z.strictObject({
  engine: z.enum(ON_DEVICE_MODEL_IDS),
  path: z.enum(BENCH_PATHS),
  /** Threads asked for. */
  threads: z.number().int().min(1).max(8),
  /** `null` when the model never loaded. */
  loadMs: Milliseconds.nullable(),
  /** The warm decodes of the clip, in order. Empty for a streaming engine. */
  decodeMs: z.array(Milliseconds).max(16),
  /** `null` when there was nothing to measure. */
  realTimeFactor: z.number().finite().nonnegative().nullable(),
  lastAudioToTextMs: Milliseconds.nullable(),
  /** What is left of the wait after the pause, when the decode began at the first quiet. `null` for streaming. */
  afterEarlyFinishMs: Milliseconds.nullable(),
  /** The runtime could not use the threads and the engine moved to one (`threads-failed`). */
  fellBack: z.boolean(),
  /** A short code when the run failed (`not-installed`, `load-failed`, …); never a message. */
  failure: z
    .string()
    .regex(/^[a-z-]{1,32}$/u)
    .nullable(),
});
export type BenchRun = z.infer<typeof RunSchema>;

const DeviceSchema = z.strictObject({
  userAgentFamily: z.string().max(64),
  crossOriginIsolated: z.boolean(),
  hardwareConcurrency: z.number().int().min(1).max(1024).nullable(),
  deviceMemoryGb: z.number().positive().max(1024).nullable(),
  /** `navigator.gpu` gave an adapter. */
  webgpuAdapter: z.boolean(),
  /** The adapter's vendor and architecture words (`info.vendor`, `info.architecture`), or `null`. */
  webgpuAdapterClass: z.string().max(96).nullable(),
  /** Whether the adapter is a software one (SwiftShader and friends), which is not a measurement of a GPU. */
  webgpuAdapterIsSoftware: z.boolean().nullable(),
});
export type BenchDevice = z.infer<typeof DeviceSchema>;

const SpeedBenchReportSchema = z.strictObject({
  v: z.literal(SPEED_BENCH_VERSION),
  clipSeconds: z.number().positive().max(120),
  /** The pause the early-finish figure assumes (the Live countdown). */
  pauseMs: Milliseconds,
  device: DeviceSchema,
  runs: z.array(RunSchema).max(64),
});
export type SpeedBenchReport = z.infer<typeof SpeedBenchReportSchema>;

/** Parse a result, or `null` for anything that is not one. Total. */
export const parseSpeedBenchReport = (value: unknown): SpeedBenchReport | null => {
  const parsed = SpeedBenchReportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The middle value; the mean of the two middle values for an even count; `null` for none. */
export const median = (values: readonly number[]): number | null => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 1
    ? (finite[mid] as number)
    : ((finite[mid - 1] as number) + (finite[mid] as number)) / 2;
};

/** Decode time over audio time. `null` for no decodes or no audio. */
export const realTimeFactor = (decodeMs: readonly number[], clipSeconds: number): number | null => {
  const middle = median(decodeMs);
  return middle === null || !(clipSeconds > 0) ? null : middle / (clipSeconds * 1000);
};

/** What is left of a decode after `pauseMs` of it already ran: never negative. */
export const afterPause = (decodeMs: number, pauseMs: number): number => Math.max(0, decodeMs - Math.max(0, pauseMs));

/** One decimal, for the table in docs/voice.md. */
export const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The family of a user agent, without its version numbers or platform details. */
export const userAgentFamily = (userAgent: string): string => {
  const families: readonly [RegExp, string][] = [
    [/Edg\//u, 'Edge'],
    [/OPR\//u, 'Opera'],
    [/Firefox\//u, 'Firefox'],
    [/Chrome\//u, 'Chrome'],
    [/Safari\//u, 'Safari'],
  ];
  const family = families.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Other';
  const mobile = /Android|iPhone|iPad|Mobile/u.test(userAgent) ? ' (mobile)' : '';
  return `${family}${mobile}`;
};

/** Whether an adapter description names a software renderer. */
export const isSoftwareAdapter = (description: string): boolean =>
  /swiftshader|llvmpipe|software|lavapipe/iu.test(description);

/** A fixed pseudo-voice for a device with no clip file: harmonic bursts with a formant-like sweep. Deterministic. */
export const syntheticClip = (seconds: number, sampleRate = 16_000): Float32Array => {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  const syllable = 0.22;
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / sampleRate;
    const within = (t % syllable) / syllable;
    const envelope = Math.sin(Math.PI * within) ** 2 * (t < seconds - 0.2 ? 1 : 0);
    const pitch = 110 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
    let voiced = 0;
    for (let harmonic = 1; harmonic <= 8; harmonic += 1)
      voiced += Math.sin(2 * Math.PI * pitch * harmonic * t) / harmonic;
    samples[index] = 0.25 * envelope * voiced;
  }
  return samples;
};
