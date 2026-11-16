import { describe, expect, it } from 'bun:test';
import { PerformanceRecorder } from '../../../daemon/lib/performance/recorder.ts';
import type { StackSamplerPort } from '../../../daemon/lib/performance/samples.ts';
import { ProfileStackSampling } from '../../../daemon/lib/performance/stack-sampling.ts';

describe('ProfileStackSampling when the sampler fails', () => {
  it('survives a drain that throws, keeps draining on later ticks, and stays available', async () => {
    let discards = 0;
    const sampler: StackSamplerPort = {
      drain: () => [],
      discard: () => {
        discards += 1;
        if (discards === 1) throw new Error('the sampler went away');
      },
    };
    const ticks: (() => void)[] = [];
    const sampling = new ProfileStackSampling({
      start: async () => sampler,
      probe: new PerformanceRecorder(),
      every: (_ms, tick) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    await sampling.ensure();

    for (const tick of ticks) expect(tick).not.toThrow();
    for (const tick of ticks) tick();

    expect(discards).toBe(2);
    expect(sampling.available).toBe(true);
  });

  it('treats a sampler that cannot start as a profile without stacks, and does not try again', async () => {
    let attempts = 0;
    const sampling = new ProfileStackSampling({
      start: async () => {
        attempts += 1;
        throw new Error('no profiler here');
      },
      probe: new PerformanceRecorder(),
      every: () => () => undefined,
    });

    await sampling.ensure();
    await sampling.ensure();

    expect(sampling.available).toBe(false);
    expect(attempts).toBe(1);
  });
});
