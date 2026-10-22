import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityScopePort, StackFrame, StackSample, StackSamplerPort } from '../../lib/runtime/liveness.ts';

/**
 * The activity the running code belongs to, carried across every `await` by the runtime's own
 * asynchronous context — the only thing that can follow a continuation back to the work that began it.
 */
export class AsyncActivityScope<T> implements ActivityScopePort<T> {
  readonly #storage = new AsyncLocalStorage<T>();

  current(): T | undefined {
    return this.#storage.getStore();
  }

  within<R>(value: T, work: () => R): R {
    return this.#storage.run(value, work);
  }

  outside<R>(work: () => R): R {
    return this.#storage.exit(work);
  }
}

/** The variable that switches the stack sampler off: `0` for a person who wants the loop unobserved. */
export const STACK_SAMPLER_VARIABLE = 'FYD_STACK_SAMPLER';

/** Whether this `FYD_STACK_SAMPLER` value leaves the sampler on: anything but `0` does. */
export function stackSamplerEnabled(raw: string | undefined): boolean {
  return raw?.trim() !== '0';
}

/** What JavaScriptCore reports for a line or column it does not know. */
const UNKNOWN_POSITION = 4_294_967_295;

interface JscFrame {
  readonly name?: string;
  readonly sourceURL?: string;
  readonly line?: number;
}

interface JscTraces {
  readonly traces?: ReadonlyArray<{ readonly frames?: readonly JscFrame[] }>;
}

interface JscProfiler {
  readonly startSamplingProfiler: () => void;
  readonly samplingProfilerStackTraces: () => unknown;
}

/**
 * The main thread's stack, sampled by JavaScriptCore's own sampling profiler.
 *
 * THE PROFILER SAMPLES FROM ITS OWN THREAD, which is the whole reason it can see a stall: the event
 * loop cannot look at itself while it is the thing that is stuck, and a timer on it only learns, late,
 * THAT it was stuck. It samples only while JavaScript runs, at the period `BUN_JSC_sampleInterval` sets
 * when the VM starts — every 10 ms under the service definitions `fy` writes, every millisecond
 * otherwise — so an idle daemon pays nothing. Handing samples back costs JavaScriptCore about 13 µs
 * each whatever is done with them, which is why the period matters more than anything here. The meter
 * empties it every tick, which keeps what it holds to one tick's worth.
 *
 * `bun:jsc` is loaded lazily, so a runtime without it is a daemon without stacks rather than one that
 * cannot start.
 */
export class JscStackSampler implements StackSamplerPort {
  readonly #profiler: JscProfiler;

  private constructor(profiler: JscProfiler) {
    this.#profiler = profiler;
    profiler.startSamplingProfiler();
  }

  /**
   * A started sampler, or `undefined` where the runtime has no sampling profiler. `load` is the
   * runtime's own module unless a test stands in a runtime without one.
   */
  static async start(
    load: () => Promise<unknown> = async () => await import('bun:jsc'),
  ): Promise<JscStackSampler | undefined> {
    try {
      const profiler = (await load()) as JscProfiler;
      if (typeof profiler.startSamplingProfiler !== 'function') return undefined;
      return new JscStackSampler(profiler);
    } catch {
      return undefined;
    }
  }

  drain(): readonly StackSample[] {
    return jscSamples(this.#profiler.samplingProfilerStackTraces());
  }

  /** JavaScriptCore has no cheaper way to forget its samples than handing them over, so they are dropped unread. */
  discard(): void {
    this.#profiler.samplingProfilerStackTraces();
  }
}

/** The samples in JavaScriptCore's report, innermost frame first; anything unrecognised is no samples. */
export function jscSamples(report: unknown): readonly StackSample[] {
  const traces = (report as JscTraces | undefined)?.traces;
  if (!Array.isArray(traces)) return [];
  return traces.map(trace => ({ frames: (trace.frames ?? []).map(jscFrame) }));
}

function jscFrame(frame: JscFrame): StackFrame {
  const line = frame.line === undefined || frame.line === UNKNOWN_POSITION ? undefined : frame.line;
  return {
    name: frame.name ?? '',
    ...(frame.sourceURL === undefined || frame.sourceURL === '' ? {} : { url: frame.sourceURL }),
    ...(line === undefined ? {} : { line }),
  };
}
