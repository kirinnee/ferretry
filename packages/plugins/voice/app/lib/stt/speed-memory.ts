/**
 * SOLE OWNER of the `fy:voice:speed-memory` browser-storage key: what this DEVICE has learned about which
 * execution path failed for which speech model (`speed-plan.ts`).
 *
 * It is device-lifetime on purpose — a GPU driver that refused a shader, or a browser that ran out of
 * memory with four threads, is a fact about THIS device, and a second paired machine changes nothing
 * about it. Only FAILURES are stored. A success is not remembered: the plan is a pure function of the
 * signals, so a path that works is simply chosen again, and one that stops working is recorded the
 * moment it fails.
 *
 * The same rules as `fy:voice:stt-settings` (`stt-settings.ts`):
 *   - VERSIONED. A payload from a version this build does not know is discarded, not half-read.
 *   - CAPPED. At most {@link MAX_FAILURES} entries, newest kept; one entry per model and path. Nothing
 *     here grows, and a hostile or corrupt payload cannot make it.
 *   - NEVER THROWS. Malformed, oversized or wrong-shaped storage reads as "nothing learned", field by
 *     field; storage that is denied (private windows, quota) leaves the memory in this page only.
 *   - NO WORDS. A failure names a model id, a path and a time — never audio, a transcript or an error
 *     message.
 */

import { z } from 'zod';
import { ON_DEVICE_MODEL_IDS } from './model-catalog.ts';
import { FAILURE_FORGET_MS, NO_MEMORY, SPEED_PATH_ORDER, type SpeedFailure, type SpeedMemory } from './speed-plan.ts';
import { SPEED_MEMORY_STORAGE_KEY } from '../storage-names.ts';

export const SPEED_MEMORY_KEY = SPEED_MEMORY_STORAGE_KEY;
export const SPEED_MEMORY_VERSION = 1;
/** Eight models, three paths: more entries than this can only be junk. */
export const MAX_FAILURES = 24;
/** A payload larger than this is not read. */
const MAX_PAYLOAD_CHARS = 8_192;

const FailureSchema = z.strictObject({
  model: z.enum(ON_DEVICE_MODEL_IDS),
  path: z.enum(SPEED_PATH_ORDER as unknown as [string, ...string[]]),
  at: z.number().finite().nonnegative(),
});

/** Parse one entry, or `null`. A bad entry never costs a good one. */
const entryOf = (raw: unknown): SpeedFailure | null => {
  const parsed = FailureSchema.safeParse(raw);
  return parsed.success ? (parsed.data as SpeedFailure) : null;
};

/** The newest entry per model and path, newest first, at most {@link MAX_FAILURES}. */
const normalise = (failures: readonly SpeedFailure[]): SpeedFailure[] => {
  const newestFirst = [...failures].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const kept: SpeedFailure[] = [];
  for (const failure of newestFirst) {
    const key = `${failure.model}:${failure.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(failure);
    if (kept.length >= MAX_FAILURES) break;
  }
  return kept;
};

/** Storage text → memory. Total: anything unreadable is {@link NO_MEMORY}. */
export const parseSpeedMemory = (raw: string | null): SpeedMemory => {
  if (raw === null || raw.length > MAX_PAYLOAD_CHARS) return NO_MEMORY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_MEMORY;
  }
  if (typeof value !== 'object' || value === null) return NO_MEMORY;
  const record = value as { v?: unknown; failures?: unknown };
  if (record.v !== SPEED_MEMORY_VERSION || !Array.isArray(record.failures)) return NO_MEMORY;
  const failures = record.failures.slice(0, MAX_FAILURES * 2).flatMap(item => {
    const entry = entryOf(item);
    return entry === null ? [] : [entry];
  });
  return { failures: normalise(failures) };
};

/** Memory → storage text. */
export const serialiseSpeedMemory = (memory: SpeedMemory): string =>
  JSON.stringify({ v: SPEED_MEMORY_VERSION, failures: normalise(memory.failures) });

/** `localStorage`, or anything shaped like it; `null` where the browser has none. */
export interface SpeedMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The memory as an object with injected storage, like `SttSettingsStore`, so a test never touches a real
 * `localStorage`. Reads re-parse storage each time (it is tiny), so a failure recorded in another tab is
 * seen at the next plan.
 */
export class SpeedMemoryStore {
  readonly #storage: SpeedMemoryStorage | null;
  #fallback: SpeedMemory = NO_MEMORY;
  /** The last write was refused: `#fallback` holds failures storage does not, so reads must include them. */
  #unpersisted = false;

  constructor(storage: SpeedMemoryStorage | null) {
    this.#storage = storage;
  }

  read(): SpeedMemory {
    if (this.#storage === null) return this.#fallback;
    let persisted: SpeedMemory;
    try {
      persisted = parseSpeedMemory(this.#storage.getItem(SPEED_MEMORY_KEY));
    } catch {
      return this.#fallback;
    }
    // After a refused write (quota) what this page learned is held only here: merge it with what storage
    // says, newest per model and path, so a failure never vanishes from the next plan.
    return this.#unpersisted ? { failures: normalise([...persisted.failures, ...this.#fallback.failures]) } : persisted;
  }

  /** Record that `path` failed for `model` at `now` (epoch ms). Returns whether storage took it. */
  recordFailure(model: SpeedFailure['model'], path: SpeedFailure['path'], now: number): boolean {
    const fresh = this.read().failures.filter(
      failure => now - failure.at < FAILURE_FORGET_MS && !(failure.model === model && failure.path === path),
    );
    const next: SpeedMemory = { failures: normalise([{ model, path, at: now }, ...fresh]) };
    this.#fallback = next;
    if (this.#storage === null) return false;
    try {
      this.#storage.setItem(SPEED_MEMORY_KEY, serialiseSpeedMemory(next));
      this.#unpersisted = false;
      return true;
    } catch {
      this.#unpersisted = true;
      return false;
    }
  }
}
