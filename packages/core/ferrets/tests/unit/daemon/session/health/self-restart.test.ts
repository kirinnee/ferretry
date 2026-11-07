import { describe, it } from 'bun:test';
import should from 'should';
import {
  decideSelfRestart,
  defaultSessionHealthSettings,
  selfRestartMessage,
  SelfRestartCoordinator,
  unhealablePreview,
  type SelfRestartHandler,
  type SelfRestartInput,
  type SelfRestartStamp,
  type SelfRestartStampStore,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;
const NOW = '2026-07-31T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function input(overrides: Partial<SelfRestartInput> = {}): SelfRestartInput {
  return { escalate: true, requested: false, stamp: undefined, stampUnreadable: false, nowMs: NOW_MS, ...overrides };
}

class RecordingStampStore implements SelfRestartStampStore {
  written: SelfRestartStamp | undefined;
  cleared = 0;

  constructor(
    private readonly stamp: SelfRestartStamp | undefined,
    private readonly failRead = false,
    private readonly failWrites = false,
  ) {}

  async read(): Promise<SelfRestartStamp | undefined> {
    if (this.failRead) throw new Error('stamp is corrupt');
    return this.stamp;
  }

  async write(stamp: SelfRestartStamp): Promise<void> {
    if (this.failWrites) throw new Error('state home is read-only');
    this.written = stamp;
  }

  async clear(): Promise<void> {
    this.cleared += 1;
    if (this.failWrites) throw new Error('state home is read-only');
  }
}

class StubHandler implements SelfRestartHandler {
  calls = 0;

  constructor(private readonly answer: boolean | Error) {}

  async restart(): Promise<boolean> {
    this.calls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function context(unhealable: readonly string[] = ['a']) {
  return { consecutive: 3, unhealable, nowMs: NOW_MS, at: NOW };
}

describe('self-restart decision', () => {
  it('should do nothing when the index was healed', () => {
    // Act
    const actual = decideSelfRestart(input({ escalate: false }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'not-needed' });
  });

  it('should not hand over a second restart from one process', () => {
    // Act
    const actual = decideSelfRestart(input({ requested: true }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'already-requested' });
  });

  it('should restart when nothing has been stamped', () => {
    // Act
    const actual = decideSelfRestart(input(), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'restart' });
  });

  it('should restart once the cooldown has genuinely elapsed', () => {
    // Arrange
    const old = new Date(NOW_MS - SETTINGS.selfRestartCooldownMs).toISOString();

    // Act
    const actual = decideSelfRestart(input({ stamp: { at: old, sessions: [] } }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'restart' });
  });

  it('should suppress a restart inside the cooldown', () => {
    // Arrange
    const recent = new Date(NOW_MS - 60_000).toISOString();

    // Act
    const actual = decideSelfRestart(input({ stamp: { at: recent, sessions: [] } }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'cooling', block: 'recent-restart' });
  });

  it('should suppress a restart when the stamp cannot be read, which is what a restart loop looks like', () => {
    // Arrange — the ancestor read an unparseable stamp as "no stamp" and restarted anyway.
    const broken = input({ stampUnreadable: true });

    // Act
    const actual = decideSelfRestart(broken, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'cooling', block: 'unreadable-stamp' });
  });

  it('should suppress a restart it cannot age against a stamp from the future', () => {
    // Arrange
    const ahead = new Date(NOW_MS + 60_000).toISOString();

    // Act
    const actual = decideSelfRestart(input({ stamp: { at: ahead, sessions: [] } }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'cooling', block: 'future-stamp' });
  });

  it('should suppress a restart when its own clock reading is unusable', () => {
    // Arrange
    const stamp = { at: new Date(NOW_MS - 60_000).toISOString(), sessions: [] };

    // Act
    const actual = decideSelfRestart(input({ stamp, nowMs: Number.NaN }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'cooling', block: 'unreadable-stamp' });
  });

  it('should ignore a stamp whose instant does not parse and fall back to the readable path', () => {
    // Act
    const actual = decideSelfRestart(input({ stamp: { at: 'never', sessions: [] } }), SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'restart' });
  });
});

describe('self-restart announcements', () => {
  it('should name a bounded preview of unhealable sessions and summarize the rest', () => {
    // Arrange
    const ids = Array.from({ length: 13 }, (_, index) => `s${index}`);

    // Act
    const actual = unhealablePreview(ids, SETTINGS);

    // Assert
    should(actual).equal('s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, +3 more');
  });

  it('should describe each outcome distinctly', () => {
    // Arrange
    const outcomes = ['restarting', 'cooling', 'unsupervised', 'declined', 'none'] as const;

    // Act
    const actual = outcomes.map(outcome =>
      selfRestartMessage(outcome, { consecutive: 3, unhealable: ['a'] }, SETTINGS),
    );

    // Assert
    should(new Set(actual).size).equal(outcomes.length);
    should(actual[1]).containEql('within 30m');
    should(actual[0]).containEql('1 session(s) invisible to listings; ids: a');
  });
});

describe('self-restart coordinator', () => {
  it('should stamp before handing over, so an exiting handler cannot lose the cooldown', async () => {
    // Arrange
    const stamps = new RecordingStampStore(undefined);
    const handler = new StubHandler(true);
    const coordinator = new SelfRestartCoordinator(stamps, handler, SETTINGS);

    // Act
    const actual = await coordinator.request(true, context(['a', 'b']));

    // Assert
    should(actual.outcome).equal('restarting');
    should(stamps.written).deepEqual({ at: NOW, sessions: ['a', 'b'] });
    should(stamps.cleared).equal(0);
    should(coordinator.restartRequested).be.true();
  });

  it('should bound the session list it stamps', async () => {
    // Arrange
    const stamps = new RecordingStampStore(undefined);
    const coordinator = new SelfRestartCoordinator(stamps, new StubHandler(true), {
      ...SETTINGS,
      selfRestartStampSessionLimit: 2,
    });

    // Act
    await coordinator.request(true, context(['a', 'b', 'c']));

    // Assert
    should(stamps.written?.sessions).deepEqual(['a', 'b']);
  });

  it('should take the latch and the stamp back when nothing would re-spawn the daemon', async () => {
    // Arrange
    const stamps = new RecordingStampStore(undefined);
    const coordinator = new SelfRestartCoordinator(stamps, new StubHandler(false), SETTINGS);

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('unsupervised');
    should(stamps.cleared).equal(1);
    should(coordinator.restartRequested).be.false();
  });

  it('should treat a throwing handler as a decline rather than a restart', async () => {
    // Arrange
    const stamps = new RecordingStampStore(undefined);
    const coordinator = new SelfRestartCoordinator(
      stamps,
      new StubHandler(new Error('no unit owns this pid')),
      SETTINGS,
    );

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('declined');
    should(coordinator.restartRequested).be.false();
    should(stamps.cleared).equal(1);
  });

  it('should never call the handler while cooling', async () => {
    // Arrange
    const recent = { at: new Date(NOW_MS - 60_000).toISOString(), sessions: [] };
    const handler = new StubHandler(true);
    const coordinator = new SelfRestartCoordinator(new RecordingStampStore(recent), handler, SETTINGS);

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('cooling');
    should(handler.calls).equal(0);
    should(actual.event?.data.block).equal('recent-restart');
  });

  it('should treat an unreadable stamp store as evidence of a restart loop', async () => {
    // Arrange
    const handler = new StubHandler(true);
    const coordinator = new SelfRestartCoordinator(new RecordingStampStore(undefined, true), handler, SETTINGS);

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('cooling');
    should(handler.calls).equal(0);
  });

  it('should announce once per outcome, but announce again when the outcome changes', async () => {
    // Arrange — the ancestor latched forever, so a daemon that once answered "unsupervised" went
    // permanently silent about a broken index even after a service manager adopted it.
    const handler = new StubHandler(false);
    const coordinator = new SelfRestartCoordinator(new RecordingStampStore(undefined), handler, SETTINGS);

    // Act
    const first = await coordinator.request(true, context());
    const repeat = await coordinator.request(true, context());
    const supervised = await new SelfRestartCoordinator(
      new RecordingStampStore(undefined),
      new StubHandler(true),
      SETTINGS,
    ).request(true, context());

    // Assert
    should(first.event?.data.outcome).equal('unsupervised');
    should(repeat.event).be.undefined();
    should(supervised.event?.data.outcome).equal('restarting');
  });

  it('should still hand the restart over when the cooldown stamp could not be persisted', async () => {
    // Arrange — a state home that refuses writes must not block the repair it was only recording.
    const stamps = new RecordingStampStore(undefined, false, true);
    const coordinator = new SelfRestartCoordinator(stamps, new StubHandler(true), SETTINGS);

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('restarting');
    should(stamps.written).be.undefined();
  });

  it('should survive a clear that fails while taking the latch back', async () => {
    // Arrange
    const stamps = new RecordingStampStore(undefined, false, true);
    const coordinator = new SelfRestartCoordinator(stamps, new StubHandler(false), SETTINGS);

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual.outcome).equal('unsupervised');
    should(coordinator.restartRequested).be.false();
  });

  it('should report nothing at all when no restart was required', async () => {
    // Arrange
    const handler = new StubHandler(true);
    const coordinator = new SelfRestartCoordinator(new RecordingStampStore(undefined), handler, SETTINGS);

    // Act
    const actual = await coordinator.request(false, context());

    // Assert
    should(actual).deepEqual({ outcome: 'none', decision: { kind: 'not-needed' }, event: undefined });
    should(handler.calls).equal(0);
  });

  it('should refuse a second hand-over from a process that already restarted', async () => {
    // Arrange
    const coordinator = new SelfRestartCoordinator(new RecordingStampStore(undefined), new StubHandler(true), SETTINGS);
    await coordinator.request(true, context());

    // Act
    const actual = await coordinator.request(true, context());

    // Assert
    should(actual).deepEqual({ outcome: 'none', decision: { kind: 'already-requested' }, event: undefined });
  });
});
