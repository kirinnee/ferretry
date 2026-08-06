import { describe, it } from 'bun:test';
import should from 'should';
import { readTaskBoardFleet } from '../../../src/lib/task-boards/fleet-read.ts';

/**
 * The one way the task-board domain walks every session.
 *
 * Both callers — the aggregate `/v1/tasks` route and `StorageTaskBoardSessionDirectory` — depend on
 * three properties this decision owns, and each of them is a defect somewhere else if it is wrong:
 * the ORDER a fleet board renders in, the DESCRIPTOR ceiling a long-lived daemon lives under, and
 * the fail-closed rule that a session nobody can read makes the whole answer unavailable rather than
 * quietly shortening it.
 *
 * The bound itself is deliberately not exported, so these tests measure it — peak simultaneous reads
 * — rather than reading a number back out of the module and comparing it with itself.
 */

/** Every read that is currently running, so a case can assert the ceiling instead of assuming it. */
function concurrencyMeter(): {
  readonly peak: () => number;
  readonly wrap: <T>(read: (id: string) => Promise<T>) => (id: string) => Promise<T>;
} {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    wrap: read => async id => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await read(id);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

const sessions = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `s${index}`);

describe('the task board fleet read', () => {
  describe('order', () => {
    it('should answer in the order it was asked, not the order the reads finished', async () => {
      // Arrange — inverted latency: the LAST session answers first and the first answers last, so a
      // gather that appended on completion would return the fleet exactly reversed.
      const ids = ['s0', 's1', 's2', 's3'];
      const delays: Record<string, number> = { s0: 40, s1: 30, s2: 20, s3: 10 };

      // Act
      const read = await readTaskBoardFleet(ids, async id => {
        await Bun.sleep(delays[id] as number);
        return id;
      });

      // Assert
      should(read).eql(ids);
    });

    it('should keep the order when the fleet is larger than the bound and latency is random', async () => {
      // Arrange — 200 sessions is more than three pool-fulls, so a slot mix-up cannot hide.
      const ids = sessions(200);

      // Act
      const read = await readTaskBoardFleet(ids, async id => {
        await Bun.sleep(Number(id.slice(1)) % 7);
        return id;
      });

      // Assert
      should(read).eql(ids);
    });
  });

  describe('the descriptor bound', () => {
    it('should never run more than sixty-four reads at once, however large the fleet', async () => {
      // Arrange
      const meter = concurrencyMeter();
      const ids = sessions(300);

      // Act
      const read = await readTaskBoardFleet(
        ids,
        meter.wrap(async id => {
          await Bun.sleep(2);
          return id;
        }),
      );

      // Assert — the ported kteam ceiling, measured rather than read back out of the module.
      should(read).have.length(300);
      should(meter.peak()).equal(64);
    });

    it('should refill a freed slot rather than waiting for a whole batch to finish', async () => {
      // Arrange — one session far slower than the rest. A batching walk would stall the remaining
      // 65 behind it; a pool starts them the moment any other slot frees.
      const meter = concurrencyMeter();
      const ids = sessions(65);

      // Act
      const started = performance.now();
      await readTaskBoardFleet(
        ids,
        meter.wrap(async id => {
          await Bun.sleep(id === 's0' ? 120 : 2);
          return id;
        }),
      );
      const elapsed = performance.now() - started;

      // Assert — the 65th read overlapped the slow one instead of queueing after it.
      should(meter.peak()).equal(64);
      should(elapsed).be.below(120 + 60);
    });

    it('should start only as many reads as there are sessions when the fleet is smaller than the bound', async () => {
      // Arrange
      const meter = concurrencyMeter();

      // Act
      await readTaskBoardFleet(
        sessions(5),
        meter.wrap(async id => {
          await Bun.sleep(5);
          return id;
        }),
      );

      // Assert
      should(meter.peak()).equal(5);
    });

    it('should read nothing and answer with the empty fleet when the daemon holds no sessions', async () => {
      // Arrange
      let reads = 0;

      // Act
      const read = await readTaskBoardFleet([], async id => {
        reads += 1;
        return id;
      });

      // Assert
      should(read).be.empty();
      should(reads).equal(0);
    });
  });

  describe('failure', () => {
    it('should reject the whole walk rather than answer with a fleet that is short one session', async () => {
      // Arrange
      const failure = new Error('board s2 is damaged');

      // Act
      const outcome = await readTaskBoardFleet(sessions(10), async id => {
        if (id === 's2') throw failure;
        return id;
      }).then(
        read => ({ read }),
        (error: unknown) => ({ error }),
      );

      // Assert — fail-closed: the caller is told, and never handed the nine readable sessions.
      should(outcome).have.property('error', failure);
    });

    it('should handle a second failure that arrives after the first has already rejected the walk', async () => {
      // Arrange — s1 fails LATE, well after s0's rejection has settled the returned promise. Every
      // read is subscribed to before any of them runs, so the late one is a handled rejection; were
      // it not, Bun would fail this test on the unhandled rejection rather than on an assertion.
      const readFleet = readTaskBoardFleet(sessions(4), async id => {
        if (id === 's0') throw new Error('s0 is damaged');
        if (id === 's1') {
          await Bun.sleep(30);
          throw new Error('s1 is damaged too');
        }
        return id;
      });

      // Act
      const error = await readFleet.catch((raised: unknown) => raised);
      await Bun.sleep(60);

      // Assert
      should(error).be.an.Error();
      should((error as Error).message).equal('s0 is damaged');
    });

    it('should raise the failure the caller can act on rather than wrapping it', async () => {
      // Arrange — both callers classify the raised error themselves (`unreadableFleetBoard` turns a
      // domain refusal into daemon unavailability), so an identity-preserving raise is the contract.
      class BoardDamaged extends Error {}
      const failure = new BoardDamaged('unreadable');

      // Act
      const raised = await readTaskBoardFleet(['s0'], async () => {
        throw failure;
      }).catch((error: unknown) => error);

      // Assert
      should(raised).equal(failure);
      should(raised).be.instanceof(BoardDamaged);
    });
  });
});
