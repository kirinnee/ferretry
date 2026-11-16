/**
 * WHAT THIS DEVICE OFFERS for speech speed (`speed-plan.ts`), read from the page's globals.
 *
 * The one place that touches `navigator.gpu`, `crossOriginIsolated`, `hardwareConcurrency` and
 * `deviceMemory`. Every read is defensive — a browser that lacks a field, throws from it, or answers
 * something odd reads as "offers nothing" — because a signal that cannot be read must lower the speed,
 * never break dictation. The WebGPU adapter request is the only asynchronous one; it is bounded by
 * {@link GPU_PROBE_MS} so a driver that never answers cannot hold Settings.
 */

import type { SpeedSignals } from './speed-plan.ts';

/** The slice of the page this module reads. */
export interface SpeedGlobalLike {
  readonly crossOriginIsolated?: unknown;
  readonly navigator?: {
    readonly gpu?: { requestAdapter(): Promise<unknown> } | undefined;
    readonly hardwareConcurrency?: unknown;
    readonly deviceMemory?: unknown;
  };
}

/** Longest the adapter request is waited for. */
export const GPU_PROBE_MS = 1_500;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;

const memory = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const attempt = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/** Everything except the GPU, which needs a round trip. Synchronous and total. */
export const readSyncSpeedSignals = (global: SpeedGlobalLike): SpeedSignals => ({
  webgpuAdapter: false,
  crossOriginIsolated: attempt(() => global.crossOriginIsolated === true, false),
  hardwareConcurrency: attempt(() => count(global.navigator?.hardwareConcurrency), null),
  deviceMemoryGb: attempt(() => memory(global.navigator?.deviceMemory), null),
});

/** Whether `navigator.gpu` hands out an adapter, within {@link GPU_PROBE_MS}. Never rejects. */
export const probeWebGpuAdapter = async (global: SpeedGlobalLike): Promise<boolean> => {
  const gpu = attempt(() => global.navigator?.gpu, undefined);
  if (gpu === undefined || typeof gpu.requestAdapter !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), GPU_PROBE_MS);
  });
  try {
    return (await Promise.race([gpu.requestAdapter().catch(() => null), timeout])) !== null;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
