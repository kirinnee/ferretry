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
    const subject = teeStackSampler({ drain: () => SAMPLES }, probeOf(true, seen));

    // Act
    const actual = subject.drain();

    // Assert
    should(actual).equal(SAMPLES);
    should(seen).deepEqual([SAMPLES]);
  });

  it('should return the samples without touching a probe that is not recording', () => {
    // Arrange
    const seen: (readonly StackSample[])[] = [];
    const subject = teeStackSampler({ drain: () => SAMPLES }, probeOf(false, seen));

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
      },
      probeOf(true, []),
    );

    // Act
    subject.drain();
    subject.drain();

    // Assert
    should(drains).equal(2);
  });
});
