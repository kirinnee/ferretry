import { describe, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  CODEX_DISCOVERY_BACKSTOP_MS,
  CODEX_DISCOVERY_EAGER_MS,
  CODEX_DISCOVERY_INTERVAL_MS,
  CodexDiscoveryPacer,
} from '../../../../src/lib/session/transcript/index.ts';

const START = Date.parse('2026-10-20T10:00:00.000Z');

/** A clock the test moves by hand. */
const manualClock = () => {
  let now = START;
  return {
    now: () => new Date(now).toISOString(),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const undiscovered: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.codex',
  identity: 'undiscovered',
  baseline: ['rollout-old'],
  correlationToken: '/state/sessions/session-1',
};

const resolved: TranscriptProvenance = {
  ...undiscovered,
  harnessSessionId: 'rollout-new',
  identity: 'correlated',
  file: '/home/agent/.codex/sessions/new.jsonl',
  resolvedAt: '2026-10-20T10:00:00.000Z',
};

/** A discovery that never finds anything, counting how often it was asked. */
const nothing = () => {
  const counter = {
    runs: 0,
    discover: async (): Promise<TranscriptProvenance | undefined> => {
      counter.runs += 1;
      return undefined;
    },
  };
  return counter;
};

describe('CodexDiscoveryPacer', () => {
  it('should discover on every read while the eager window is open', async () => {
    // Arrange: a session found quickly must not wait for anything.
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    const probe = nothing();

    // Act
    for (let read = 0; read < 10; read += 1) {
      await subject.pace('session-1', undiscovered, undefined, probe.discover);
      clock.advance(2_000);
    }

    // Assert
    should(probe.runs).equal(10);
  });

  it('should answer a found rollout from the first read', async () => {
    // Arrange
    const subject = new CodexDiscoveryPacer(manualClock());

    // Act
    const answer = await subject.pace('session-1', undiscovered, undefined, async () => resolved);

    // Assert
    should(answer).equal(resolved);
  });

  it('should discover at most once an interval once the eager window has closed', async () => {
    // Arrange: two minutes of finding nothing.
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    const probe = nothing();
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    clock.advance(CODEX_DISCOVERY_EAGER_MS);
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    const runsWhenTheWindowClosed = probe.runs;

    // Act: a read every two seconds for one interval and a little more.
    const answers = [];
    for (let elapsed = 0; elapsed <= CODEX_DISCOVERY_INTERVAL_MS; elapsed += 2_000) {
      clock.advance(2_000);
      answers.push(await subject.pace('session-1', undiscovered, undefined, probe.discover));
    }

    // Assert: the reads in between answered "not yet" without discovering.
    should(runsWhenTheWindowClosed).equal(2);
    should(probe.runs).equal(3);
    should(answers.every(answer => answer === undefined)).be.true();
  });

  it('should open the eager window again when the home listing changes', async () => {
    // Arrange: the pace is long past eager when a new rollout appears.
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    const probe = nothing();
    let changes = 0;
    const changeCount = () => changes;
    await subject.pace('session-1', undiscovered, changeCount, probe.discover);
    clock.advance(CODEX_DISCOVERY_EAGER_MS + 1);
    await subject.pace('session-1', undiscovered, changeCount, probe.discover);
    clock.advance(2_000);
    await subject.pace('session-1', undiscovered, changeCount, probe.discover);
    const runsBeforeTheChange = probe.runs;

    // Act
    changes += 1;
    for (let read = 0; read < 5; read += 1) {
      clock.advance(2_000);
      await subject.pace('session-1', undiscovered, changeCount, probe.discover);
    }

    // Assert: paced before the change, every read after it.
    should(runsBeforeTheChange).equal(2);
    should(probe.runs).equal(7);
  });

  describe('while the home is watched', () => {
    /** A watch whose event count the test moves by hand; `undefined` is a watch that cannot vouch. */
    const watch = () => {
      let events: number | undefined = 0;
      return {
        heard: () => events,
        event: () => {
          events = (events ?? 0) + 1;
        },
        unknown: () => {
          events = undefined;
        },
      };
    };

    it('should not walk a quiet home again, even inside the eager window', async () => {
      // Arrange: a session that has just started, read every two seconds, in a home nothing touches.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const home = watch();

      // Act
      for (let read = 0; read < 10; read += 1) {
        await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
        clock.advance(2_000);
      }

      // Assert: the first read looked; nothing since could have changed its answer.
      should(probe.runs).equal(1);
    });

    it('should walk on the next read after an event, inside the window and the interval', async () => {
      // Arrange
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const home = watch();
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);

      // Act: a rollout appears inside the eager window, then another once it has closed.
      clock.advance(2_000);
      home.event();
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
      const eager = probe.runs;
      clock.advance(CODEX_DISCOVERY_EAGER_MS);
      home.event();
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
      clock.advance(2_000);
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
      clock.advance(2_000);
      home.event();
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
      const paced = probe.runs;
      clock.advance(CODEX_DISCOVERY_INTERVAL_MS);
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);

      // Assert: at once while eager; once paced, the event waits out the interval and is never dropped.
      should(eager).equal(2);
      should(paced).equal(3);
      should(probe.runs).equal(4);
    });

    it('should walk a quiet home once a backstop, for a change no watch could hear', async () => {
      // Arrange
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const home = watch();
      await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);

      // Act: ten minutes of reads every two seconds, and not one event.
      for (let read = 0; read < 300; read += 1) {
        clock.advance(2_000);
        await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
      }

      // Assert: the first look, then one per backstop.
      should(probe.runs).equal(1 + (300 * 2_000) / CODEX_DISCOVERY_BACKSTOP_MS);
    });

    it('should count an event that arrived during the walk as unseen', async () => {
      // Arrange: the rollout lands while the first walk is listing the directory.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const home = watch();
      let runs = 0;
      const discover = async (): Promise<TranscriptProvenance | undefined> => {
        runs += 1;
        if (runs === 1) home.event();
        return undefined;
      };

      // Act
      await subject.pace('session-1', undiscovered, undefined, discover, undefined, home.heard);
      clock.advance(2_000);
      await subject.pace('session-1', undiscovered, undefined, discover, undefined, home.heard);
      clock.advance(2_000);
      await subject.pace('session-1', undiscovered, undefined, discover, undefined, home.heard);

      // Assert: looked again for that event, then quiet.
      should(runs).equal(2);
    });

    it('should let the clock decide while the watch cannot vouch for the home', async () => {
      // Arrange: a directory the hub polls, or one that does not exist yet.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const home = watch();
      home.unknown();

      // Act
      for (let read = 0; read < 5; read += 1) {
        await subject.pace('session-1', undiscovered, undefined, probe.discover, undefined, home.heard);
        clock.advance(2_000);
      }

      // Assert: eager, every read, as without a watch.
      should(probe.runs).equal(5);
    });

    it('should walk after a listing change another walk saw, which may lie outside the watch', async () => {
      // Arrange: a quiet watched home, long past eager.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const home = watch();
      let changes = 0;
      await subject.pace('session-1', undiscovered, () => changes, probe.discover, undefined, home.heard);
      clock.advance(CODEX_DISCOVERY_EAGER_MS + 1);
      await subject.pace('session-1', undiscovered, () => changes, probe.discover, undefined, home.heard);
      const quiet = probe.runs;

      // Act: some other session's walk found a new rollout in an old day directory.
      changes += 1;
      clock.advance(2_000);
      await subject.pace('session-1', undiscovered, () => changes, probe.discover, undefined, home.heard);

      // Assert
      should(quiet).equal(1);
      should(probe.runs).equal(2);
    });
  });

  it('should start afresh for a provenance the session recorded anew', async () => {
    // Arrange: a relaunch records a new baseline, and its rollout is about to appear.
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    const probe = nothing();
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    clock.advance(CODEX_DISCOVERY_EAGER_MS + 1);
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    clock.advance(2_000);

    // Act
    await subject.pace(
      'session-1',
      { ...undiscovered, baseline: ['rollout-old', 'rollout-mid'] },
      undefined,
      probe.discover,
    );

    // Assert
    should(probe.runs).equal(3);
  });

  it('should pace each session on its own', async () => {
    // Arrange
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    const probe = nothing();
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    clock.advance(CODEX_DISCOVERY_EAGER_MS + 1);
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    clock.advance(2_000);

    // Act
    await subject.pace('session-1', undiscovered, undefined, probe.discover);
    await subject.pace('session-2', undiscovered, undefined, probe.discover);

    // Assert: session-1 is paced; session-2 has only just started looking.
    should(probe.runs).equal(3);
  });

  it('should share one discovery between readers asking at once', async () => {
    // Arrange
    const subject = new CodexDiscoveryPacer(manualClock());
    let runs = 0;
    let finish: (value: TranscriptProvenance) => void = () => undefined;
    const discover = () => {
      runs += 1;
      return new Promise<TranscriptProvenance>(resolve => {
        finish = resolve;
      });
    };

    // Act
    const reads = [0, 1, 2].map(() => subject.pace('session-1', undiscovered, undefined, discover));
    finish(resolved);
    const answers = await Promise.all(reads);

    // Assert
    should(runs).equal(1);
    should(answers).eql([resolved, resolved, resolved]);
  });

  it('should forget a session once it resolves', async () => {
    // Arrange: resolved, then — a record that was overwritten, say — asked about again.
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock);
    await subject.pace('session-1', undiscovered, undefined, async () => resolved);
    clock.advance(CODEX_DISCOVERY_EAGER_MS + 1);
    const probe = nothing();

    // Act
    await subject.pace('session-1', undiscovered, undefined, probe.discover);

    // Assert: a fresh first look, not a paced one.
    should(probe.runs).equal(1);
  });

  it('should discover again when the clock moves backwards', async () => {
    // Arrange
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock, { eagerMs: 0, intervalMs: 60_000 });
    const probe = nothing();
    await subject.pace('session-1', undiscovered, undefined, probe.discover);

    // Act
    clock.advance(-1_000);
    await subject.pace('session-1', undiscovered, undefined, probe.discover);

    // Assert: an interval measured against a clock that went back would never end.
    should(probe.runs).equal(2);
  });

  it('should let a failed discovery fail its readers and pace the next one', async () => {
    // Arrange
    const clock = manualClock();
    const subject = new CodexDiscoveryPacer(clock, { eagerMs: 0, intervalMs: 60_000 });
    const probe = nothing();

    // Act
    const failure = await subject
      .pace('session-1', undiscovered, undefined, async () => {
        throw new Error('the claims could not be read');
      })
      .catch((error: unknown) => error);
    clock.advance(1_000);
    await subject.pace('session-1', undiscovered, undefined, probe.discover);

    // Assert
    should(failure).be.instanceOf(Error);
    should(probe.runs).equal(0);
  });

  describe('anchored to the session start', () => {
    it('should look once and then pace a session that started long before the daemon looked', async () => {
      // Arrange: a daemon restart finds a session that has been undiscovered for hours.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const startedAt = async () => '2026-10-20T06:00:00.000Z';

      // Act: a read every two seconds for the first minute after boot.
      for (let read = 0; read < 30; read += 1) {
        await subject.pace('session-1', undiscovered, undefined, probe.discover, startedAt);
        clock.advance(2_000);
      }

      // Assert: the first read, then once 30 s later — no eager window re-opened by the restart.
      should(probe.runs).equal(2);
    });

    it('should stay eager until two minutes after a recent start, not after the first look', async () => {
      // Arrange: the session started 100 s before the daemon first looked.
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      const probe = nothing();
      const startedAt = async () => new Date(START - 100_000).toISOString();

      // Act: fifteen reads two seconds apart, crossing the 120 s mark after the start.
      for (let read = 0; read < 15; read += 1) {
        await subject.pace('session-1', undiscovered, undefined, probe.discover, startedAt);
        clock.advance(2_000);
      }

      // Assert: reads at 100…118 s after the start are eager (10); 120…128 s are paced (none due).
      should(probe.runs).equal(10);
    });

    it('should read the start once per pace, not on every read', async () => {
      // Arrange
      const clock = manualClock();
      const subject = new CodexDiscoveryPacer(clock);
      let asked = 0;
      const startedAt = async () => {
        asked += 1;
        return '2026-10-20T06:00:00.000Z';
      };

      // Act
      for (let read = 0; read < 5; read += 1) {
        await subject.pace('session-1', undiscovered, undefined, nothing().discover, startedAt);
        clock.advance(2_000);
      }

      // Assert
      should(asked).equal(1);
    });

    it('should fall back to the first look when the start is unknown, unreadable or in the future', async () => {
      // Arrange
      const clock = manualClock();
      const starts: Array<() => Promise<string | undefined>> = [
        async () => undefined,
        async () => {
          throw new Error('the state could not be read');
        },
        async () => '2027-01-01T00:00:00.000Z',
      ];

      // Act
      const runs: number[] = [];
      for (const startedAt of starts) {
        const subject = new CodexDiscoveryPacer(clock);
        const probe = nothing();
        for (let read = 0; read < 5; read += 1) {
          await subject.pace('session-1', undiscovered, undefined, probe.discover, startedAt);
          clock.advance(2_000);
        }
        runs.push(probe.runs);
      }

      // Assert: eager from the first look in every case.
      should(runs).eql([5, 5, 5]);
    });

    it('should share a discovery that began while the start was being read', async () => {
      // Arrange: one reader is still reading the start when another begins discovering.
      const subject = new CodexDiscoveryPacer(manualClock());
      let runs = 0;
      let release: (value: string | undefined) => void = () => undefined;
      const slowStart = () =>
        new Promise<string | undefined>(resolve => {
          release = resolve;
        });
      let finish: (value: TranscriptProvenance) => void = () => undefined;
      const discover = () => {
        runs += 1;
        return new Promise<TranscriptProvenance>(resolve => {
          finish = resolve;
        });
      };

      // Act
      const slow = subject.pace('session-1', undiscovered, undefined, discover, slowStart);
      const quick = subject.pace('session-1', undiscovered, undefined, discover);
      release(undefined);
      // Every pending continuation runs before a timer, so the slow reader has resumed by now.
      await new Promise(resolve => setTimeout(resolve, 0));
      finish(resolved);
      const [fast, late] = await Promise.all([quick, slow]);

      // Assert: the slow reader was answered by the discovery the fast one ran.
      should(fast).equal(resolved);
      should(late).equal(resolved);
      should(runs).equal(1);
    });
  });
});
