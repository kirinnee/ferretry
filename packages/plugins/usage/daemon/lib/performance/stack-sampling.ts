import type { PerformanceProbe } from './recorder.ts';
import { teeStackSampler } from './sampler-tee.ts';
import type { StackSamplerPort } from './samples.ts';

/** How often the sampler is emptied: JavaScriptCore keeps every sample until it is handed over. */
const DRAIN_INTERVAL_MS = 1_000;

/**
 * The stack sampler a profile's "Hot functions" are read from. It is started by the FIRST profile (a daemon nobody profiles
 * never starts it) and then drained on a timer for as long as the daemon runs, because JavaScriptCore has no stop and would
 * otherwise hold every sample: while a window records the samples go to it, otherwise they are dropped unread.
 * A runtime with no sampler leaves `available` false and the profile says so.
 */
export class ProfileStackSampling {
  #started = false;
  #sampler: StackSamplerPort | undefined;

  constructor(
    private readonly deps: {
      readonly start: () => Promise<StackSamplerPort | undefined>;
      readonly probe: PerformanceProbe;
      readonly every: (intervalMs: number, tick: () => void) => () => void;
    },
  ) {}

  /** Whether a sampler is running (false before the first profile and on a runtime without one). */
  get available(): boolean {
    return this.#sampler !== undefined;
  }

  /** Begin sampling, once. Never rejects: a sampler that cannot start is a profile without stacks. */
  async ensure(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const sampler = await this.deps.start().catch(() => undefined);
    if (sampler === undefined) return;
    this.#sampler = sampler;
    const teed = teeStackSampler(sampler, this.deps.probe);
    this.deps.every(DRAIN_INTERVAL_MS, () => {
      try {
        teed.discard();
      } catch {
        // A sampler that failed once is a window with fewer samples, never a daemon that stops answering.
      }
    });
  }
}
