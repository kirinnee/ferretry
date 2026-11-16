/**
 * What `fy daemon profile` needs to print v4's read/write system-call line and its "Hot functions" (ledger V-0235): the
 * process gauges' `/proc` reading through the kernel's host facts, JavaScriptCore's sampler read as stack samples, and a
 * sampler that goes to the recording window and is otherwise drained unread.
 */
import { describe, expect, it } from 'bun:test';
import type { SelfCountersPort } from '@ferretry/kernel/contract';
import { JscStackSampler, jscSamples } from '../../../daemon/adapters/performance/jsc-stack-sampler.ts';
import {
  ProcessGauges,
  procIoSyscalls,
  procStatChildrenCpuMs,
} from '../../../daemon/adapters/performance/process-gauges.ts';
import { PerformanceRecorder } from '../../../daemon/lib/performance/recorder.ts';
import { ProfileStackSampling } from '../../../daemon/lib/performance/stack-sampling.ts';
import type { StackSamplerPort } from '../../../daemon/lib/performance/samples.ts';

const IO = 'rchar: 10\nwchar: 20\nsyscr: 1500\nsyscw: 700\nread_bytes: 0\nwrite_bytes: 0\n';
// pid (comm with a space and a paren) state ppid ... utime stime cutime cstime: cutime=300 cstime=200 -> 5000 ms
const STAT = `4242 (fy d) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 6 300 200 20 0 4 0 12345 1000 100 18446744073709551615`;

const host = (platform: string, files: Record<string, string>): SelfCountersPort => {
  const read = async (file: string): Promise<string> => {
    const text = files[file];
    if (text === undefined) throw new Error('ENOENT');
    return text;
  };
  return { platform, io: async () => await read('io'), stat: async () => await read('stat') };
};

describe('ProcessGauges', () => {
  it('reads read and write system calls and the children’s CPU on Linux', async () => {
    const reading = await new ProcessGauges(host('linux', { io: IO, stat: STAT })).read();
    expect(reading.syscalls).toEqual({ reads: 1500, writes: 700 });
    expect(reading.childrenCpuMs).toBe(5_000);
    expect(reading.rssBytes).toBeGreaterThan(0);
  });

  it('leaves both out where /proc cannot be read, and off Linux', async () => {
    const unreadable = await new ProcessGauges(host('linux', {})).read();
    expect(unreadable.syscalls).toBeUndefined();
    expect(unreadable.childrenCpuMs).toBeUndefined();
    const mac = await new ProcessGauges(host('darwin', { io: IO, stat: STAT })).read();
    expect(mac.syscalls).toBeUndefined();
  });

  it('refuses a half-written counter file rather than inventing a number', () => {
    expect(procIoSyscalls('syscr: 5\n')).toBeUndefined();
    expect(procStatChildrenCpuMs('garbage')).toBeUndefined();
  });
});

describe('JscStackSampler', () => {
  const report = {
    traces: [
      { frames: [{ name: 'hot', sourceURL: '/x/packages/plugins/usage/daemon/a.ts', line: 7 }, { name: '' }] },
      { frames: [{ name: 'cold', line: 4_294_967_295 }] },
    ],
  };

  it('reads the runtime’s traces as stack samples, innermost first, unknown positions dropped', () => {
    expect(jscSamples(report)).toEqual([
      { frames: [{ name: 'hot', url: '/x/packages/plugins/usage/daemon/a.ts', line: 7 }, { name: '' }] },
      { frames: [{ name: 'cold' }] },
    ]);
    expect(jscSamples(undefined)).toEqual([]);
  });

  it('starts the runtime’s profiler once, and is no sampler where the runtime has none', async () => {
    let started = 0;
    const sampler = await JscStackSampler.start(async () => ({
      startSamplingProfiler: () => {
        started += 1;
      },
      samplingProfilerStackTraces: () => report,
    }));
    expect(started).toBe(1);
    expect(sampler?.drain()).toHaveLength(2);
    expect(await JscStackSampler.start(async () => ({}))).toBeUndefined();
    expect(
      await JscStackSampler.start(async () => {
        throw new Error('no bun:jsc');
      }),
    ).toBeUndefined();
  });
});

describe('ProfileStackSampling', () => {
  const SAMPLE = { frames: [{ name: 'hot', url: '/x/packages/plugins/usage/daemon/a.ts', line: 7 }] };
  const harness = (sampler: StackSamplerPort | undefined) => {
    const recorder = new PerformanceRecorder();
    const ticks: (() => void)[] = [];
    let started = 0;
    const sampling = new ProfileStackSampling({
      start: async () => {
        started += 1;
        return sampler;
      },
      probe: recorder,
      every: (_ms, tick) => {
        ticks.push(tick);
        return () => undefined;
      },
    });
    return { recorder, sampling, ticks, started: () => started };
  };

  it('hands the samples to a window that is recording, and they become Hot functions', async () => {
    const { recorder, sampling, ticks } = harness({ drain: () => [SAMPLE], discard: () => undefined });
    await sampling.ensure();
    expect(sampling.available).toBe(true);
    const window = recorder.open(0);
    for (const tick of ticks) tick();
    recorder.close(window);
    const { cpuProfile } = window.tables(1_000);
    expect(cpuProfile.samples).toBe(1);
    expect(cpuProfile.self[0]?.frame).toContain('hot');
  });

  it('drops the samples unread when no window records, so the runtime never piles them up', async () => {
    let discarded = 0;
    const { sampling, ticks } = harness({
      drain: () => [SAMPLE],
      discard: () => {
        discarded += 1;
      },
    });
    await sampling.ensure();
    for (const tick of ticks) tick();
    expect(discarded).toBe(1);
  });

  it('starts once however many profiles ask, and says plainly when the runtime has no sampler', async () => {
    const withSampler = harness({ drain: () => [], discard: () => undefined });
    await withSampler.sampling.ensure();
    await withSampler.sampling.ensure();
    expect(withSampler.started()).toBe(1);
    expect(withSampler.ticks).toHaveLength(1);
    const without = harness(undefined);
    await without.sampling.ensure();
    expect(without.sampling.available).toBe(false);
    expect(without.ticks).toHaveLength(0);
  });
});
