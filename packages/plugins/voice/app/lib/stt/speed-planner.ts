/**
 * THE SPEED PLANNER — the one object that turns "this device" into a {@link SpeedPlan} for a model, and
 * remembers what failed (`speed-plan.ts`, `speed-memory.ts`, `speed-signals.ts`).
 *
 * The engines ask it for a thread count and tell it when threads failed; Settings asks it for the plan
 * to print one read-only line. It holds no state of its own beyond the device signals it read: what
 * failed lives in {@link SpeedMemoryStore}, so two tabs agree.
 */

import type { OnDeviceModelId } from './model-catalog.ts';
import { SpeedMemoryStore, type SpeedMemoryStorage } from './speed-memory.ts';
import { chooseSpeedPlan, NO_SIGNALS, type SpeedPlan, type SpeedSignals } from './speed-plan.ts';
import { probeWebGpuAdapter, readSyncSpeedSignals, type SpeedGlobalLike } from './speed-signals.ts';

export interface SpeedPlannerOptions {
  readonly signals: SpeedSignals;
  readonly memory: SpeedMemoryStore;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

export class SpeedPlanner {
  readonly #memory: SpeedMemoryStore;
  readonly #now: () => number;
  #signals: SpeedSignals;

  constructor(options: SpeedPlannerOptions) {
    this.#signals = options.signals;
    this.#memory = options.memory;
    this.#now = options.now;
  }

  /** The plan for `model` with what is known now. Synchronous; the GPU is known after {@link probe}. */
  planFor(model: OnDeviceModelId): SpeedPlan {
    return chooseSpeedPlan(model, this.#signals, this.#memory.read(), this.#now());
  }

  /** Threads to ask the runtime for, for `model`. */
  threadsFor(model: OnDeviceModelId): number {
    return this.planFor(model).threads;
  }

  /** Several threads failed for `model` on this device. */
  threadsFailed(model: OnDeviceModelId): void {
    this.#memory.recordFailure(model, 'wasm-threads', this.#now());
  }

  /** Ask the page for a WebGPU adapter (the one asynchronous signal). Never rejects. */
  async probe(global: SpeedGlobalLike): Promise<void> {
    const webgpuAdapter = await probeWebGpuAdapter(global);
    this.#signals = { ...this.#signals, webgpuAdapter };
  }
}

/** A planner bound to this page: its signals, its `localStorage`, its clock. */
function browserSpeedPlanner(global: SpeedGlobalLike & { readonly localStorage?: SpeedMemoryStorage }): SpeedPlanner {
  let storage: SpeedMemoryStorage | null = null;
  try {
    storage = global.localStorage ?? null;
  } catch {
    // Accessing storage at all throws when the browser has blocked it.
  }
  return new SpeedPlanner({
    signals: readSyncSpeedSignals(global),
    memory: new SpeedMemoryStore(storage),
    now: () => Date.now(),
  });
}

/** A planner for a page that offers nothing: tests, and the floor. */
export const flatSpeedPlanner = (): SpeedPlanner =>
  new SpeedPlanner({ signals: NO_SIGNALS, memory: new SpeedMemoryStore(null), now: () => 0 });

const planners = new WeakMap<object, SpeedPlanner>();

/**
 * The planner of a page, built once per global so the voices and Settings share one. Keyed by the global
 * object itself, so a test's fake global gets its own.
 */
export function speedPlannerFor(
  global: SpeedGlobalLike & { readonly localStorage?: SpeedMemoryStorage },
): SpeedPlanner {
  const known = planners.get(global);
  if (known !== undefined) return known;
  const made = browserSpeedPlanner(global);
  planners.set(global, made);
  return made;
}
