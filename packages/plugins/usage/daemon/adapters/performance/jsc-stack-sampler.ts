import type { StackFrame, StackSample, StackSamplerPort } from '../../lib/performance/samples.ts';

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
 * The main thread's stack, sampled by JavaScriptCore's own sampling profiler: what fills a profile's "Hot functions".
 *
 * IT SAMPLES FROM ITS OWN THREAD, only while JavaScript runs, at the period `BUN_JSC_sampleInterval` sets when the VM
 * starts, so an idle daemon pays nothing; handing samples back costs about 13 µs each. JavaScriptCore has no stop and keeps
 * what it sampled until it is handed over, so whoever starts one must drain it on a timer (`ProfileStackSampling`).
 *
 * `bun:jsc` is loaded lazily: a runtime without it is a profile without stacks, never a daemon that cannot start.
 */
export class JscStackSampler implements StackSamplerPort {
  readonly #profiler: JscProfiler;

  private constructor(profiler: JscProfiler) {
    this.#profiler = profiler;
    profiler.startSamplingProfiler();
  }

  /** A started sampler, or `undefined` where the runtime has none. `load` is the runtime's own module unless a test stands in. */
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
