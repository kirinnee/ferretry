import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import { NUDGE_MESSAGES } from '../../../src/lib/speedups/jev.ts';
import { jevLeafReason, jevNudgeMessage } from '../../../src/lib/warden/index.ts';
import { WARDEN_TERMINAL_STATUSES } from '../../../src/lib/warden/types.ts';
import {
  enabled,
  harness,
  JEV_INVESTIGATE,
  type JevScript,
  journalTypes,
  NOW,
  no,
  session,
  triageable,
  yes,
} from './sweep-harness.ts';

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

/**
 * The same stuck command, but its transcript moved 12 minutes ago — inside the 15-minute "changed lately"
 * window, outside the 10-minute stuck-command one — so the tree asks whether it is repeating itself.
 */
const looping = (nowMs: number, command = 'pid:40') => {
  const base = stuck(nowMs, command);
  return { ...base, state: { ...base.state, lastTranscriptAt: iso(nowMs - 12 * MINUTE) } };
};

/** An investigation already nudged s1 about this stuck command an hour ago. */
const nudgedBefore: WardenAction = {
  at: iso(NOW - 60 * MINUTE),
  sessionId: 's1',
  action: 'nudge',
  outcome: 'done',
  by: 'warden',
  anomalyKind: 'sus_subprocess',
  detail: 'Nudged: it looked wedged.',
};

/**
 * Jev's yes/no answers that walk the tree to `act` for the ferret in front of it:
 *
 * - nudge, restart: `stuck` — running, no output lately — so "waiting on something real?" opens it;
 * - stop: `looping`, already nudged — "doing new things?" answered no;
 * - resume: `triageable`, parked on its quota — "finished on purpose?" answered no.
 */
const jev = (act: 'nudge' | 'restart' | 'stop' | 'resume', confidence: number): JevScript => {
  switch (act) {
    case 'nudge':
      return {
        answers: { waiting_on_real: yes(confidence), wait_reasonable: no(confidence) },
        nudge: { id: 'stuck_command', confidence },
      };
    case 'restart':
      return { answers: { waiting_on_real: no(confidence) } };
    case 'stop':
      return { answers: { doing_new_things: no(confidence) } };
    case 'resume':
      return { answers: { finished_on_purpose: no(confidence) } };
  }
};

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
      reason: jevLeafReason('nudge_wait'),
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
    const subject = harness({
      config: layers(true),
      fleet: [looping(NOW)],
      state: { actions: [nudgedBefore] },
      guard: [jev('stop', 0.99)],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.spawns).have.length(1);
    should(subject.state().investigations?.[0]).match({ origin: 'jev', targetId: 's1' });
  });

  it('should put a confident stop in front of the owner as Jev’s recommendation when investigations are off', async () => {
    // Arrange
    const subject = harness({
      config: layers(false),
      fleet: [looping(NOW)],
      state: { actions: [nudgedBefore] },
      guard: [jev('stop', 0.99)],
    });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.agenda();

    // Assert
    should(subject.spawns).be.empty();
    should(subject.remedies).be.empty();
    should(subject.state().actions?.[0]).match({ action: 'stop', outcome: 'held', by: 'jev', confidence: 0.99 });
    should(subject.state().actions?.[0]?.detail).startWith('Jev recommends stopping it (99% sure)');
    should(subject.jevChecks[0]?.path).deepEqual([
      { node: 'running', kind: 'fact', answer: 'yes' },
      { node: 'output_changed', kind: 'fact', answer: 'yes' },
      { node: 'doing_new_things', kind: 'judgement', answer: 'no', confidence: 0.99 },
      { node: 'already_nudged', kind: 'fact', answer: 'yes' },
    ]);
    // The held act is a real Warden card, recommending the act it holds.
    should(feed.items.map(item => item.raisedByName)).deepEqual(['Warden']);
    should(subject.raises.at(-1)?.request).match({ reason: 'held', subject: /The Warden recommends stopping it/u });
  });

  it('should leave a flag Jev is not sure of to the owner when investigations are off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [stuck(NOW)], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.agenda();

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
    const feed = await subject.service.agenda();

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
    const whileLanding = await subject.service.agenda();
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
    const feed = await subject.service.agenda();

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
    /** The ferret each act's path runs through: a stop needs one that loops after a nudge. */
    const scene = (act: (typeof acts)[number]) => (act === 'stop' ? looping(NOW) : stuck(NOW));
    const after = (
      act: (typeof acts)[number],
    ): readonly (readonly [string, () => readonly ReturnType<typeof stuck>[]])[] => [
      ['missing from the fleet', () => []],
      ...WARDEN_TERMINAL_STATUSES.map(
        status => [status, () => [{ ...scene(act), state: { ...scene(act).state, status } }]] as const,
      ),
    ];
    const run = async (act: (typeof acts)[number], fleetAtAct?: () => readonly ReturnType<typeof stuck>[]) => {
      let subject: ReturnType<typeof harness> | undefined;
      subject = harness({
        config: allowed,
        fleet: [scene(act)],
        ...(act === 'stop' ? { state: { actions: [nudgedBefore] } } : {}),
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

      for (const [label, fleetAtAct] of after(act)) {
        it(`should run no ${act} and hand the flag on as it stands when the target is ${label}`, async () => {
          // Arrange / Act
          const subject = await run(act, fleetAtAct);

          // Assert
          should(subject.guarded).have.length(1);
          should(subject.remedies).be.empty();
          should((subject.state().actions ?? []).filter(action => action.by === 'jev')).be.empty();
          should(journalTypes(subject)).not.containEql('fleet.warden_acted');
          should(journalTypes(subject)).not.containEql('fleet.warden_action_failed');
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
    const feed = await subject.service.agenda();

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
