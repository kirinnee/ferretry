import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '../../daemon/lib/protocol.ts';
import {
  EMPTY_REVIVE_STATE,
  planRevives,
  type ReviveEvent,
  type ReviveState,
  type ReviveSubject,
  type WardenReviveNotice,
  WardenReviveService,
  type WardenSessionView,
} from '../../daemon/lib/index.ts';

// Everything here runs on a virtual clock: `at` is the instant of a sweep, never a real wait.
const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A short cooldown, so the hourly cap is the rule that decides (the default 30 minutes would stop a 4th first). */
const config = (cooldownMinutes = 1, enabled = true): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  enabled,
  revive: { ...DEFAULT_WARDEN_CONFIG.revive, cooldownMinutes, windowMinutes: 15 },
});

const view = (id: string, finishedAt: string): WardenSessionView =>
  ({
    config: { id, mode: 'auto' },
    state: { status: 'failed', finishedAt },
    hasLiveMonitor: false,
  }) as WardenSessionView;

const gone = (time: string): ReviveEvent => ({
  type: 'session.exited',
  time,
  data: { status: 'failed', pane: 'gone', exitCode: null },
});

interface Rig {
  readonly service: WardenReviveService;
  readonly resumed: string[];
  readonly notices: WardenReviveNotice[];
  readonly journal: { type: string; data: unknown }[];
}

const rig = (autoResume: () => boolean | undefined = () => true): Rig => {
  const resumed: string[] = [];
  const notices: WardenReviveNotice[] = [];
  const journal: { type: string; data: unknown }[] = [];
  // The one journal of deaths: a session's last terminal event is whatever the test says died last.
  const deaths = new Map<string, string>();
  const service = new WardenReviveService({
    events: {
      read: async id => [gone(deaths.get(id) ?? iso(T0))],
      emit: async () => {},
    },
    resume: async id => {
      resumed.push(id);
      return { ok: true };
    },
    tmuxReady: async () => true,
    sleep: async () => {},
    notifyOwner: async notice => {
      notices.push(notice);
    },
    autoResume: async () => autoResume(),
    journal: { record: (type, data) => journal.push({ type, data }) },
  });
  // Teach the rig when a ferret died, through the one event the revive reads.
  const original = service.run.bind(service);
  service.run = async (input, persist) => {
    for (const entry of input.fleet) deaths.set(entry.config.id, entry.state.finishedAt as string);
    return await original(input, persist);
  };
  return { service, resumed, notices, journal };
};

const sweep = async (r: Rig, id: string, at: number, state: ReviveState | undefined, cfg = config()) =>
  await r.service.run({ fleet: [view(id, iso(at - 30_000))], config: cfg, revive: state, nowMs: at }, async () => {});

describe('automatic revive obeys the machine auto-resume switch', () => {
  it('should revive nothing while auto-resume is off, and say nothing', async () => {
    // Arrange
    const r = rig(() => false);

    // Act
    const result = await sweep(r, 'a', T0, undefined);

    // Assert
    should(r.resumed).deepEqual([]);
    should(result.actions).deepEqual([]);
    should(r.notices).deepEqual([]);
    should(result.revive).equal(EMPTY_REVIVE_STATE);
  });

  it('should treat a switch that cannot be read as off (fail closed)', async () => {
    // Arrange
    const r = rig(() => undefined);

    // Act
    await sweep(r, 'a', T0, undefined);

    // Assert
    should(r.resumed).deepEqual([]);
  });

  it('should revive again once the switch is back on', async () => {
    // Arrange
    let on = false;
    const r = rig(() => on);
    await sweep(r, 'a', T0, undefined);
    on = true;

    // Act
    await sweep(r, 'a', T0 + MINUTE, undefined);

    // Assert
    should(r.resumed).deepEqual(['a']);
  });
});

describe('revive at most three times per rolling hour', () => {
  const subject = (id: string, diedAt: string): ReviveSubject => ({
    id,
    mode: 'auto',
    cause: { kind: 'terminal_gone' },
    diedAt,
  });
  const recent = (...minutesAgo: number[]): ReviveState => ({
    ...EMPTY_REVIVE_STATE,
    sessions: {
      a: {
        revivedAt: iso(T0 - Math.min(...minutesAgo) * MINUTE),
        attempts: minutesAgo.length,
        crashRevives: 0,
        recent: minutesAgo.map(minutes => iso(T0 - minutes * MINUTE)),
      },
    },
  });

  it('should refuse the 4th death inside the hour, naming the cap', () => {
    // Act
    const plan = planRevives(
      [subject('a', iso(T0 - 30_000))],
      [{ id: 'a', status: 'failed' }],
      recent(50, 25, 5),
      T0,
      config().revive,
    );

    // Assert
    should(plan.waves).deepEqual([]);
    should(plan.refused.map(entry => entry.why)).deepEqual(['hourly_cap']);
  });

  it('should count only revives inside the rolling hour', () => {
    // Act: the oldest of the three is 61 minutes ago, so only two count.
    const plan = planRevives(
      [subject('a', iso(T0 - 30_000))],
      [{ id: 'a', status: 'failed' }],
      recent(61, 25, 5),
      T0,
      config().revive,
    );

    // Assert
    should(plan.refused).deepEqual([]);
    should(plan.waves.flat().map(entry => entry.id)).deepEqual(['a']);
  });

  it('should count the cap per ferret', () => {
    // Act
    const plan = planRevives(
      [subject('b', iso(T0 - 30_000))],
      [{ id: 'b', status: 'failed' }],
      recent(50, 25, 5),
      T0,
      config().revive,
    );

    // Assert
    should(plan.refused).deepEqual([]);
  });

  it('should leave the 4th death dead with one sentence, and not repeat it on the next death', async () => {
    // Arrange: three revives already inside the hour (5, 25 and 50 minutes ago).
    const r = rig();

    // Act
    const fourth = await sweep(r, 'a', T0, recent(50, 25, 5));
    const fifth = await sweep(r, 'a', T0 + MINUTE, fourth.revive);

    // Assert: nothing started; exactly one notice, a single sentence, no agenda item per death.
    should(r.resumed).deepEqual([]);
    should(fourth.actions).deepEqual([]);
    should(fifth.actions).deepEqual([]);
    should(r.notices).have.length(1);
    should(r.notices[0]?.sessionId).equal('a');
    should(r.notices[0]?.subject).match(/3 times in the last hour/u);
    should(r.notices[0]?.subject).not.match(/\n/u);
    should(r.journal.filter(entry => entry.type === 'fleet.warden_revive_refused')).have.length(2);
  });

  it('should revive again once the hour has rolled past the oldest of the three', async () => {
    // Arrange
    const r = rig();
    const capped = await sweep(r, 'a', T0, recent(50, 25, 5));

    // Act: 11 minutes later they were 61, 36 and 16 minutes ago, so two count.
    const later = await sweep(r, 'a', T0 + 11 * MINUTE, capped.revive);

    // Assert
    should(r.resumed).deepEqual(['a']);
    should([...later.revived]).deepEqual(['a']);
    should(later.revive.sessions.a?.recent).have.length(3);
  });

  it('should record each revive, and keep only the last hour of them', async () => {
    // Arrange: one revive 90 minutes ago, one 20 minutes ago.
    const r = rig();

    // Act
    const result = await sweep(r, 'a', T0, recent(90, 20));

    // Assert
    should(result.revive.sessions.a?.recent).deepEqual([iso(T0 - 20 * MINUTE), iso(T0)]);
  });

  it('should leave a death alone that the cooldown already holds, with no cap notice', async () => {
    // Arrange: a 30-minute cooldown and one revive 5 minutes ago: the cooldown holds it, not the cap.
    const r = rig();

    // Act
    await sweep(r, 'a', T0, recent(5), config(30));

    // Assert
    should(r.resumed).deepEqual([]);
    should(r.notices).deepEqual([]);
  });
});
