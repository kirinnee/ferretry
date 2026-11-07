/**
 * The few shapes a profile reads from the runtime's own sampling, copied from the daemon runtime that takes them. The
 * recorder and the profiler are pure over these; whatever takes the samples (the kernel host) hands them in.
 */

/** Milliseconds from a monotonic clock. */
export interface MillisecondClockPort {
  now(): number;
}

/** One stack frame of a sample, as the runtime's profiler reported it. */
export interface StackFrame {
  readonly name: string;
  /** The script it is in; absent for the runtime's own native frames. */
  readonly url?: string;
  readonly line?: number;
}

/** One sample of the JavaScript stack, innermost frame first. */
export interface StackSample {
  readonly frames: readonly StackFrame[];
}

/** Samples of the main thread's JavaScript stack, taken by the runtime while the loop runs. */
export interface StackSamplerPort {
  drain(): readonly StackSample[];
  discard(): void;
}

/** One distinct stack a stall spent its samples in, and the share of the samples it holds. */
export interface StallStack {
  readonly stack: string;
  readonly share: number;
}

/** The disk's pressure as a stall was recorded, where the host reports it. */
export interface IoPressureView {
  readonly someAvg10: number;
  readonly saturated: boolean;
}

/** One frame as a report names it: `name (daemon/src/lib/transcript/claude.ts:300)`. */
export function describeFrame(frame: StackFrame): string {
  const name = frame.name === '' ? '(anonymous)' : frame.name;
  if (frame.url === undefined || frame.url === '') return name;
  const packages = frame.url.lastIndexOf('packages/');
  const file = packages >= 0 ? frame.url.slice(packages + 'packages/'.length) : frame.url;
  return frame.line === undefined ? `${name} (${file})` : `${name} (${file}:${String(frame.line)})`;
}

/** One period during which the event loop could not run anything. */
export interface LoopStall {
  readonly atMs: number;
  readonly durationMs: number;
  /** The work that was running at some instant of the stall: the suspects, oldest first. */
  readonly during: readonly string[];
  /** The deepest of those labels — the step rather than the loop around it. */
  readonly innermost: readonly string[];
  /** Where the sampled stack spent the stall, hottest first; empty without a sampler. */
  readonly stacks: readonly StallStack[];
  readonly cause?: 'disk';
  readonly io?: IoPressureView;
}
