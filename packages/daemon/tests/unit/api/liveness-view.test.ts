import { describe, it } from 'bun:test';
import { LivenessViewSchema } from '@ferretry/protocol';
import should from 'should';
import { livenessView } from '../../../src/lib/api/routes/health.ts';
import type { EventLoopView, LoopStall } from '../../../src/lib/runtime/liveness.ts';

const clock = { now: () => 10_000 };
const IO = { someAvg10: 52, fullAvg10: 46, saturated: true };

const source = (loop: EventLoopView) => ({
  pid: 77,
  boot: () => ({ phase: 'ready' as const, step: 'ready', stepElapsedMs: 0, bootElapsedMs: 0 }),
  loop: () => loop,
});

const stall = (extra: Partial<LoopStall> = {}): LoopStall => ({
  atMs: 5_000,
  durationMs: 3_000,
  during: ['fleet refresh'],
  innermost: ['fleet refresh'],
  stacks: [],
  ...extra,
});

describe('the liveness view of the event loop', () => {
  it('should carry the disk pressure now and the cause of a stall that was the disk', () => {
    // Arrange
    const disk = stall({ cause: 'disk', io: IO });

    // Act
    const actual = livenessView(
      clock,
      0,
      source({ lagMs: 0, maxLagMs: 3_000, stalls: 1, lastStall: disk, worstStall: disk, io: IO }),
    );

    // Assert
    should(LivenessViewSchema.safeParse(actual).success).be.true();
    should(actual.eventLoop?.io).deepEqual(IO);
    should(actual.eventLoop?.lastStall?.cause).equal('disk');
    should(actual.eventLoop?.worstStall?.io).deepEqual(IO);
  });

  it('should add nothing where the host reports no pressure', () => {
    // Act
    const actual = livenessView(
      clock,
      0,
      source({ lagMs: 0, maxLagMs: 3_000, stalls: 1, lastStall: stall(), worstStall: stall() }),
    );

    // Assert
    should(actual.eventLoop).not.have.property('io');
    should(actual.eventLoop?.lastStall).not.have.property('cause');
    should(actual.eventLoop?.lastStall).not.have.property('io');
  });
});
