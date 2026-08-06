import { describe, it } from 'bun:test';
import should from 'should';
import { readTaskBoardFleet } from '../../../src/lib/task-boards/fleet-read.ts';

/**
 * The one way the task-board domain walks every session.
 *
 * Both callers — the aggregate `/v1/tasks` route and `StorageTaskBoardSessionDirectory` — depend on
 * three properties this decision owns, and each of them is a defect somewhere else if it is wrong:
 * the ORDER a fleet board renders in, the SESSION ceiling that keeps a fleet walk from growing with
 * the fleet, and the fail-closed rule that a session nobody can read makes the whole answer
 * unavailable rather than quietly shortening it.
 *
 * The ceiling is counted in SESSION CALLBACKS, never in documents or descriptors — one caller reads
 * one document per callback and the other reads two, so a document number stated here would be
 * false for one of them. What the directory's own physical cost is belongs to the directory's
 * integration test, and is asserted there.
 *
 * The bound itself is deliberately not exported, so these tests measure it — peak simultaneous
 * callbacks — rather than reading a number back out of the module and comparing it with itself.
 */

/** Every read that is currently running, so a case can assert the ceiling instead of assuming it. */
function concurrencyMeter(): {
  readonly peak: () => number;
  readonly started: () => number;
  readonly inFlight: () => number;
  readonly wrap: <T>(read: (id: string) => Promise<T>) => (id: string) => Promise<T>;
} {
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  return {
    peak: () => peak,
    started: () => started,
    inFlight: () => inFlight,
    wrap: read => async id => {
      inFlight += 1;
      started += 1;
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

  describe('the session callback bound', () => {
    it('should never run more than sixty-four session callbacks at once, however large the fleet', async () => {
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

      // Assert — the ported kteam ceiling in session callbacks, measured rather than read back out
      // of the module.
      should(read).have.length(300);
      should(meter.peak()).equal(64);
    });

    it('should refill a freed slot rather than waiting for a whole batch to finish', async () => {
      // Arrange — hold one callback from the first 64 open while every sibling answers. A batching
      // walk cannot start s64 until that callback is released; a pool starts it as soon as any other
      // slot frees. This gate distinguishes those shapes without a wall-clock threshold that both
      // could satisfy.
      const meter = concurrencyMeter();
      const ids = sessions(65);
      let releaseSlow!: () => void;
      const slow = new Promise<void>(resolve => {
        releaseSlow = resolve;
      });
      let lastStarted = false;

      // Act
      const pending = readTaskBoardFleet(
        ids,
        meter.wrap(async id => {
          if (id === 's0') await slow;
          if (id === 's64') lastStarted = true;
          return id;
        }),
      );
      // Let the immediately resolved callbacks drain through their worker continuations. A real pool
      // has claimed s64 by the next event-loop turn, while a batch still waits on the unresolved s0.
      await Bun.sleep(0);
      const refilledWhileSlow = lastStarted;
      releaseSlow();
      const read = await pending;

      // Assert — the 65th callback overlapped the slow one instead of queueing after the whole batch.
      should(read).eql(ids);
      should(meter.peak()).equal(64);
      should(refilledWhileSlow).be.true();
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

    it('should claim no further session once a read has failed, however many are left unread', async () => {
      // A rejected walk that keeps reading is a daemon still doing work for an answer nobody will
      // ever receive — and in the session directory each newly claimed session starts TWO more
      // document reads. The first version of this module let `Promise.all` reject and left every
      // other worker in its loop: a 10,000-session reproduction stood at 64 started reads when the
      // caller got its error and 2,496 fifty milliseconds later. 200 sessions against a 64-wide
      // pool is the smallest fleet that tells the two apart, because a pool that never refills
      // cannot reach 65.
      // Arrange — `s0` fails on the very first turn, so the pool has claimed exactly its initial
      // 64 sessions and no more when the failure is recorded.
      const meter = concurrencyMeter();
      const ids = sessions(200);

      // Act
      const raised = await readTaskBoardFleet(
        ids,
        meter.wrap(async id => {
          if (id === 's0') throw new Error('s0 is damaged');
          await Bun.sleep(5);
          return id;
        }),
      ).catch((error: unknown) => error);
      const startedAtRejection = meter.started();
      await Bun.sleep(50);

      // Assert — the pool's first fill and nothing after it, both at the moment the caller was told
      // and long enough afterwards that a still-running walk would have shown itself.
      should(raised).be.an.Error();
      should(startedAtRejection).equal(64);
      should(meter.started()).equal(64);
    });

    it('should settle every read it started before handing the failure back', async () => {
      // The caller is entitled to "the walk is over", not merely "the walk is doomed". A route that
      // has already answered 503 must not still be holding reads open behind the response.
      // Arrange — one session fails at once while its siblings are mid-read, so a walk that threw
      // eagerly would return with 63 reads still outstanding.
      const meter = concurrencyMeter();

      // Act
      const raised = await readTaskBoardFleet(
        sessions(200),
        meter.wrap(async id => {
          if (id === 's0') throw new Error('s0 is damaged');
          await Bun.sleep(20);
          return id;
        }),
      ).catch((error: unknown) => error);

      // Assert — nothing is in flight at the instant the caller is told.
      should(raised).be.an.Error();
      should(meter.peak()).equal(64);
      should(meter.inFlight()).equal(0);
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
