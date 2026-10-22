import { describe, it } from 'bun:test';
import should from 'should';
import { NO_PERFORMANCE_PROBE, type PerformanceProbe } from '../../../src/lib/performance/recorder.ts';
import { teeStackSampler } from '../../../src/lib/performance/sampler-tee.ts';
import type { StackSample } from '../../../src/lib/runtime/liveness.ts';

const SAMPLES: readonly StackSample[] = [{ frames: [{ name: 'a' }] }, { frames: [{ name: 'b' }] }];

function probeOf(recording: boolean, seen: (readonly StackSample[])[]): PerformanceProbe {
  return { ...NO_PERFORMANCE_PROBE, recording, samples: samples => void seen.push(samples) };
}

describe('teeStackSampler', () => {
  it('should hand every drained sample to a recording probe and still return them', () => {
    // Arrange
    const seen: (readonly StackSample[])[] = [];
    const subject = teeStackSampler({ drain: () => SAMPLES, discard: () => undefined }, probeOf(true, seen));

    // Act
    const actual = subject.drain();

    // Assert
    should(actual).equal(SAMPLES);
    should(seen).deepEqual([SAMPLES]);
  });

  it('should return the samples without touching a probe that is not recording', () => {
    // Arrange
    const seen: (readonly StackSample[])[] = [];
    const subject = teeStackSampler({ drain: () => SAMPLES, discard: () => undefined }, probeOf(false, seen));

    // Act
    const actual = subject.drain();

    // Assert
    should(actual).equal(SAMPLES);
    should(seen).deepEqual([]);
  });

  it('should drain the underlying sampler exactly once per drain', () => {
    // Arrange
    let drains = 0;
    const subject = teeStackSampler(
      {
        drain: () => {
          drains += 1;
          return [];
        },
        discard: () => undefined,
      },
      probeOf(true, []),
    );

    // Act
    subject.drain();
    subject.drain();

    // Assert
    should(drains).equal(2);
  });

  it('should fold a discarded window only while the probe records, and otherwise discard it unread', () => {
    // Arrange
    const calls: string[] = [];
    const sampler = {
      drain: () => {
        calls.push('drain');
        return SAMPLES;
      },
      discard: () => void calls.push('discard'),
    };
    const seen: (readonly StackSample[])[] = [];

    // Act
    teeStackSampler(sampler, probeOf(true, seen)).discard();
    teeStackSampler(sampler, probeOf(false, seen)).discard();

    // Assert — a profile wants every window; the meter alone wants none it discards.
    should(calls).deepEqual(['drain', 'discard']);
    should(seen).deepEqual([SAMPLES]);
  });
});
