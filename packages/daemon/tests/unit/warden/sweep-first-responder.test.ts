import { describe, it } from 'bun:test';
import should from 'should';
import { NUDGE_MESSAGES, TRIAGE_CRITERIA, type TriageDecision } from '../../../src/lib/speedups/jev.ts';
import { jevNudgeMessage } from '../../../src/lib/warden/index.ts';
import { WARDEN_TERMINAL_STATUSES } from '../../../src/lib/warden/types.ts';
import { enabled, harness, JEV_SKIP, journalTypes, NOW, session, triageable } from './sweep-harness.ts';

/**
 * The sweep with Jev as first responder, end to end through the real service: a confident Jev acts at
 * once through the same remedies an investigation uses; anything short of that goes to an
 * investigation when that layer is on and to the owner's Needs you when it is off; and Jev acts on one
 * situation once.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const clock = (): { now: () => number; advance: (minutes: number) => void } => {
  let now = NOW;
  return {
    now: () => now,
    advance: minutes => {
      now += minutes * MINUTE;
    },
  };
};

/** A ferret whose one command has run 20 minutes with nothing moving — `sus_subprocess` as of `nowMs`. */
const stuck = (nowMs: number, command = 'pid:40') =>
  session({
    id: 's1',
    status: 'running',
    state: {
      turn: 4,
      turnState: 'working',
      startedAt: iso(nowMs - 86_400_000),
      lastSubprocessAt: iso(nowMs - 5_000),
      subprocessSince: iso(nowMs - 20 * MINUTE),
      subprocessKey: command,
    },
  });

const jev = (verdict: TriageDecision['verdict'], confidence: number, extra: Partial<TriageDecision> = {}) => ({
  ...JEV_SKIP,
  verdict,
  confidence,
  reason: TRIAGE_CRITERIA[verdict],
  ...(verdict === 'nudge'
    ? { nudge: { id: 'stuck_command' as const, message: NUDGE_MESSAGES.stuck_command, confidence } }
    : {}),
  ...extra,
});

const layers = (llm: boolean) => enabled({ layers: { jev: true, llm } });

describe('Jev acting as first responder', () => {
  it('should nudge at once, through the remedies, as Jev — and buy no investigation', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [stuck(NOW)], guard: [jev('nudge', 0.93)] });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.spawns).be.empty();
    should(subject.remedies).deepEqual([
      { action: 'nudge', sessionId: 's1', detail: jevNudgeMessage(NUDGE_MESSAGES.stuck_command) },
    ]);
    should(subject.state().actions?.[0]).match({
      action: 'nudge',
      outcome: 'done',
      by: 'jev',
      confidence: 0.93,
      reason: TRIAGE_CRITERIA.nudge,
      anomalyKind: 'sus_subprocess',
    });
    should(subject.state().actions?.[0]?.detail).startWith('Jev nudged it (93% sure)');
    should(subject.journal.find(entry => entry.type === 'fleet.warden_acted')?.data).match({
      targetId: 's1',
      action: 'nudge',
      by: 'jev',
      confidence: 0.93,
    });
    should(status.savings.jevActions).equal(1);
  });

  it('should hand a confident stop to an investigation, because stop is not the Warden’s to do alone', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [stuck(NOW)], guard: [jev('stop', 0.99)] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.spawns).have.length(1);
    should(subject.state().investigations?.[0]).match({ origin: 'jev', targetId: 's1' });
  });

  it('should put a confident stop in front of the owner as Jev’s recommendation when investigations are off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [stuck(NOW)], guard: [jev('stop', 0.99)] });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.attention();

    // Assert
    should(subject.spawns).be.empty();
    should(subject.remedies).be.empty();
    should(subject.state().actions?.[0]).match({ action: 'stop', outcome: 'held', by: 'jev', confidence: 0.99 });
    should(subject.state().actions?.[0]?.detail).startWith('Jev recommends stopping it (99% sure)');
    should(feed.items.map(item => item.source)).containEql('warden-action');
  });

  it('should leave an unsure flag to the owner when investigations are off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [stuck(NOW)], guard: [jev('unsure', 0.9)] });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.attention();

    // Assert
    should(subject.spawns).be.empty();
    should(subject.remedies).be.empty();
    should(subject.state().actions ?? []).be.empty();
    should(feed.items.map(item => item.sessionId)).containEql('s1');
  });

  it('should investigate when Jev fails, and when Jev’s act does not take', async () => {
    // Arrange
    const down = harness({ config: layers(true), fleet: [stuck(NOW)], guard: [new Error('socket hang up')] });
    const refused = harness({
      config: layers(true),
      fleet: [stuck(NOW)],
      guard: [jev('nudge', 0.95)],
      remedyFails: 'nudge',
    });

    // Act
    await down.service.run({ force: false });
    await refused.service.run({ force: false });

    // Assert
    should(down.spawns).have.length(1);
    should(refused.spawns).have.length(1);
    should(refused.state().actions?.[0]).match({ action: 'nudge', outcome: 'failed', by: 'jev' });
    should(refused.state().investigations?.[0]).match({ origin: 'jev' });
  });

  it('should leave a failed Jev to the owner when investigations are off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [stuck(NOW)], guard: [new Error('down')] });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.attention();

    // Assert
    should(subject.spawns).be.empty();
    should(feed.items.map(item => item.sessionId)).containEql('s1');
  });

  it('should act on a fleet flag too: a ferret whose quota came back is resumed', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [triageable('q1')], guard: [jev('resume', 0.95)] });

    // Act
    const run = await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).deepEqual([{ action: 'resume', sessionId: 'q1', detail: '' }]);
    should(subject.spawns).be.empty();
    should(run.message).equal('Jev settled every flag; nothing to investigate');
  });

  it('should act on nothing when the Warden may not do the act alone, even at full confidence', async () => {
    // Arrange
    const config = enabled({
      layers: { jev: true, llm: false },
      mayActAlone: { ...enabled().mayActAlone, nudge: false },
    });
    const subject = harness({ config, fleet: [stuck(NOW)], guard: [jev('nudge', 1)] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.state().actions?.[0]).match({ action: 'nudge', outcome: 'held', by: 'jev' });
    should(journalTypes(subject)).containEql('fleet.warden_action_held');
  });
});

describe('Jev’s one try at a situation', () => {
  it('should wait for its nudge to land, then send the same stuck command to an investigation unasked', async () => {
    // Arrange
    const time = clock();
    const subject = harness({
      config: layers(true),
      fleet: [stuck(time.now())],
      guard: [jev('nudge', 0.95)],
      now: time.now,
    });

    // Act — the nudge, a look while it lands, and a look once it should have landed.
    await subject.service.run({ force: false });
    time.advance(10);
    subject.setFleet([stuck(time.now())]);
    await subject.service.run({ force: false });
    const whileLanding = await subject.service.attention();
    const spawnsWhileLanding = subject.spawns.length;
    time.advance(25);
    subject.setFleet([stuck(time.now())]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(1);
    should(subject.remedies.map(remedy => remedy.action)).deepEqual(['nudge']);
    should(spawnsWhileLanding).equal(0);
    should(whileLanding.items.map(item => item.sessionId)).not.containEql('s1');
    should(subject.spawns).have.length(1);
    should(subject.state().investigations?.[0]).match({ origin: 'jev', targetId: 's1' });
  });

  it('should hand the same stuck command to the owner once its nudge had its time, with investigations off', async () => {
    // Arrange
    const time = clock();
    const subject = harness({
      config: layers(false),
      fleet: [stuck(time.now())],
      guard: [jev('nudge', 0.95)],
      now: time.now,
    });

    // Act
    await subject.service.run({ force: false });
    time.advance(35);
    subject.setFleet([stuck(time.now())]);
    await subject.service.run({ force: false });
    const feed = await subject.service.attention();

    // Assert
    should(subject.guarded).have.length(1);
    should(subject.remedies).have.length(1);
    should(feed.items.map(item => item.sessionId)).containEql('s1');
  });

  it('should send a different stuck command to an investigation unasked within a day of Jev’s act', async () => {
    // Arrange — the nudge starts the ferret moving, and it gets stuck again on a new command.
    const time = clock();
    const subject = harness({
      config: layers(true),
      fleet: [stuck(time.now())],
      guard: [jev('nudge', 0.95)],
      now: time.now,
    });

    // Act
    await subject.service.run({ force: false });
    time.advance(35);
    subject.setFleet([stuck(time.now(), 'pid:77')]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(1);
    should(subject.remedies.map(remedy => remedy.action)).deepEqual(['nudge']);
    should(subject.spawns).have.length(1);
    should(journalTypes(subject)).containEql('fleet.warden_jev_handed_on');
  });

  it('should let Jev act again on the same ferret a day later', async () => {
    // Arrange
    const time = clock();
    const subject = harness({
      config: layers(true),
      fleet: [stuck(time.now())],
      guard: [jev('nudge', 0.95)],
      now: time.now,
    });

    // Act
    await subject.service.run({ force: false });
    time.advance(24 * 60 + 5);
    subject.setFleet([stuck(time.now(), 'pid:77')]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(2);
    should(subject.remedies.map(remedy => remedy.action)).deepEqual(['nudge', 'nudge']);
    should(subject.spawns).be.empty();
  });

  describe('when the ferret is gone or finished by the time Jev acts', () => {
    const acts = ['nudge', 'restart', 'stop'] as const;
    const allowed = enabled({
      layers: { jev: true, llm: true },
      mayActAlone: { ...enabled().mayActAlone, nudge: true, restart: true, stop: true },
    });
    const after: readonly (readonly [string, () => readonly ReturnType<typeof stuck>[]])[] = [
      ['missing from the fleet', () => []],
      ...WARDEN_TERMINAL_STATUSES.map(
        status => [status, () => [{ ...stuck(NOW), state: { ...stuck(NOW).state, status } }]] as const,
      ),
    ];
    const run = async (act: (typeof acts)[number], fleetAtAct?: () => readonly ReturnType<typeof stuck>[]) => {
      let subject: ReturnType<typeof harness> | undefined;
      subject = harness({
        config: allowed,
        fleet: [stuck(NOW)],
        guard: [jev(act, 0.99)],
        evidence: async () => {
          if (fleetAtAct !== undefined) subject?.setFleet(fleetAtAct());
          return { recentTurns: ['turn one'], paneTail: 'screen' };
        },
      });
      await subject.service.run({ force: false });
      return subject;
    };

    for (const act of acts) {
      it(`should carry out Jev's ${act} while the ferret is still there`, async () => {
        // Arrange / Act
        const subject = await run(act);

        // Assert
        should(subject.remedies.map(remedy => remedy.action)).deepEqual([act]);
        should(subject.spawns).be.empty();
      });

      for (const [label, fleetAtAct] of after) {
        it(`should run no ${act} and settle the flag when the target is ${label}`, async () => {
          // Arrange / Act
          const subject = await run(act, fleetAtAct);

          // Assert
          should(subject.guarded).have.length(1);
          should(subject.remedies).be.empty();
          should(subject.state().actions ?? []).be.empty();
          should(journalTypes(subject)).not.containEql('fleet.warden_acted');
          should(journalTypes(subject)).not.containEql('fleet.warden_action_failed');
          should(subject.spawns).be.empty();
        });
      }
    }
  });
});

describe('one act per ferret at a time', () => {
  /** Parked on a peer that is gone, past its own deadline: two kinds of flag on one ferret, both nudgeable. */
  const parkedOnAGhost = () =>
    session({
      id: 's1',
      status: 'running',
      state: { turnState: 'your-turn', waiting: { until: iso(NOW - 60 * MINUTE), peer: 'gone' } },
    });

  it('should not act twice on one ferret in one sweep, and hold its other flags while the act lands', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [parkedOnAGhost()], guard: [jev('nudge', 0.95)] });

    // Act
    const run = await subject.service.run({ force: false });
    const feed = await subject.service.attention();

    // Assert
    should(run.anomalies.map(anomaly => anomaly.kind).toSorted()).deepEqual([
      'declared_wait_overdue',
      'peer_wait_unanswerable',
    ]);
    should(subject.remedies).have.length(1);
    should(subject.guarded).have.length(1);
    should(subject.spawns).be.empty();
    should(feed.items.map(item => item.sessionId)).not.containEql('s1');
  });

  it('should not ask Jev about a ferret an assigned warden is investigating', async () => {
    // Arrange
    const subject = harness({
      config: layers(true),
      fleet: [triageable('q1'), session({ id: 'w9', label: 'warden' })],
      guard: [jev('resume', 0.95)],
      state: {
        assignments: {
          q1: {
            wardenId: 'w9',
            spawnedAt: iso(NOW - MINUTE),
            capability: 'cap',
            kinds: ['sus_thinking'],
            reportPath: '/r.md',
          },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).be.empty();
    should(subject.remedies).be.empty();
  });
});
