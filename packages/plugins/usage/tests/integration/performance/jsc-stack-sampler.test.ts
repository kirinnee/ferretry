/**
 * The stack sampler over JavaScriptCore (`daemon/adapters/performance/jsc-stack-sampler.ts`): the runtime's own sampling
 * profiler on this very thread, with no stand-in for `bun:jsc` in the first test. JavaScriptCore cannot stop a profiler, so
 * the sampler this file starts stays on for the rest of the process; it only samples while JavaScript runs and the process
 * ends with the run.
 */
import { describe, expect, it } from 'bun:test';
import { JscStackSampler, jscSamples } from '../../../daemon/adapters/performance/jsc-stack-sampler.ts';

/** Busy JavaScript for a while, so the profiler has a stack to take. */
function spin(milliseconds: number): number {
  const until = performance.now() + milliseconds;
  let total = 0;
  while (performance.now() < until) total += Math.sqrt(total + 1);
  return total;
}

describe('JscStackSampler on the real runtime', () => {
  it('starts from the runtime’s own bun:jsc, reports stacks it sampled, and forgets them once drained or discarded', async () => {
    const sampler = await JscStackSampler.start();
    expect(sampler).toBeDefined();
    spin(150);

    const drained = sampler?.drain() ?? [];

    expect(drained.length).toBeGreaterThan(0);
    for (const sample of drained) expect(Array.isArray(sample.frames)).toBe(true);
    expect(() => sampler?.discard()).not.toThrow();
  });
});

describe('JscStackSampler over a stand-in runtime', () => {
  const report = {
    traces: [
      { frames: [{ name: 'hot', sourceURL: '/x/packages/plugins/usage/daemon/a.ts', line: 7 }, { name: '' }] },
      { frames: [{ name: 'cold', line: 4_294_967_295 }, { sourceURL: '' }] },
    ],
  };

  it('starts the profiler once, drains the report as samples and discards by taking it unread', async () => {
    let started = 0;
    let taken = 0;
    const sampler = await JscStackSampler.start(async () => ({
      startSamplingProfiler: () => {
        started += 1;
      },
      samplingProfilerStackTraces: () => {
        taken += 1;
        return report;
      },
    }));

    expect(started).toBe(1);
    expect(sampler?.drain()).toEqual([
      { frames: [{ name: 'hot', url: '/x/packages/plugins/usage/daemon/a.ts', line: 7 }, { name: '' }] },
      { frames: [{ name: 'cold' }, { name: '' }] },
    ]);
    sampler?.discard();
    expect(taken).toBe(2);
    expect(started).toBe(1);
  });

  it('is no sampler where the runtime has no profiler, or its module cannot be loaded', async () => {
    expect(await JscStackSampler.start(async () => ({}))).toBeUndefined();
    expect(
      await JscStackSampler.start(async () => {
        throw new Error('no bun:jsc');
      }),
    ).toBeUndefined();
    expect(
      await JscStackSampler.start(async () => ({
        startSamplingProfiler: () => {
          throw new Error('the profiler refused to start');
        },
        samplingProfilerStackTraces: () => report,
      })),
    ).toBeUndefined();
  });

  it('reads anything unrecognised as no samples, and a trace with no frames as an empty stack', () => {
    expect(jscSamples(undefined)).toEqual([]);
    expect(jscSamples({ traces: 'none' })).toEqual([]);
    expect(jscSamples({ traces: [{}] })).toEqual([{ frames: [] }]);
  });
});
