import type { StackSamplerPort } from '../runtime/liveness.ts';
import type { PerformanceProbe } from './recorder.ts';

/**
 * The lag meter's stack sampler, with every drained sample also handed to the probe.
 *
 * The meter drains the runtime's sampler on every tick and keeps only a stalled window's samples. A
 * profile wants ALL of them — where an idle daemon spends its CPU is the question, not only where a
 * stall did — so the samples are teed here, once, rather than drained by a second reader that would
 * steal them from the meter.
 */
export function teeStackSampler(sampler: StackSamplerPort, probe: PerformanceProbe): StackSamplerPort {
  return {
    drain: () => {
      const samples = sampler.drain();
      if (probe.recording) probe.samples(samples);
      return samples;
    },
    // A window the meter has no use for is still the profile's, so it is folded only while one records.
    discard: () => {
      if (probe.recording) probe.samples(sampler.drain());
      else sampler.discard();
    },
  };
}
