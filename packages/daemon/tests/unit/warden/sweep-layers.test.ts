import { describe, it } from 'bun:test';
import should from 'should';
import { WardenRequestError } from '../../../src/lib/warden/index.ts';
import {
  at,
  enabled,
  harness,
  JEV_INVESTIGATE,
  JEV_SKIP,
  journalTypes,
  NOW,
  session,
  triageable,
  unattended,
} from './sweep-harness.ts';

/**
 * The layers on top of the free rules, each switched on alone: Jev clearing flags with investigations
 * off, investigations rotating across logins, the growing cooldown a cleared flag earns, and the owner
 * leaving a ferret alone for longer.
 */

const jevOnly = (overrides: Parameters<typeof enabled>[0] = {}) =>
  enabled({ layers: { jev: true, llm: false }, ...overrides });
const both = (overrides: Parameters<typeof enabled>[0] = {}) =>
  enabled({ layers: { jev: true, llm: true }, ...overrides });

const MINUTE = 60_000;

/** A clock a test can move. */
const clock = (): { now: () => number; advance: (minutes: number) => void } => {
  let now = NOW;
  return {
    now: () => now,
    advance: minutes => {
      now += minutes * MINUTE;
    },
  };
};

describe('Jev with investigations off', () => {
  it('should clear what it is sure about and show the owner the rest, never spawning', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [unattended('s1'), unattended('s2')],
      guard: [JEV_SKIP, JEV_INVESTIGATE],
    });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.agenda();
    const status = await subject.service.status();

    // Assert
    should(subject.spawns).be.empty();
    should(subject.state().blessings?.s1).match({ by: 'jev' });
    should(subject.state().assignedQueue ?? []).deepEqual([]);
    should(feed.items.map(item => item.sessionId)).deepEqual(['s2']);
    should(status.triage.jev).deepEqual({ configured: true, active: true, reason: 'configured' });
    should(status.triage.llm).deepEqual({ configured: false, active: false, reason: 'configured' });
  });

  it('should ask Jev once about a flag that stands, not every sweep it waits for the owner', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(1);
    should(subject.state().passedOn).deepEqual(['unattended_question\u0000s1\u0000awaiting_user']);
  });

  it('should ask again once the flag went away and came back', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });
    await subject.service.run({ force: false });
    subject.setFleet([session({ id: 's1', status: 'running' })]);
    await subject.service.run({ force: false });
    subject.setFleet([unattended('s1')]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(2);
  });

  it('should ask again after a failure: only a real answer is remembered', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [unattended('s1')],
      guard: [new Error('socket hang up'), JEV_INVESTIGATE],
    });

    // Act
    await subject.service.run({ force: false });
    const remembered = subject.state().passedOn ?? [];
    await subject.service.run({ force: false });

    // Assert
    should(remembered).deepEqual([]);
    should(subject.guarded).have.length(2);
  });

  it('should say the fleet flags Jev did not clear wait for the owner', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [triageable('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal(
      'investigations are off: 1 flag Jev did not clear waits for you and nothing is spent on it',
    );
    should(subject.spawns).be.empty();
  });

  it('should go to the owner unasked once the Jev cap is reached, still spawning nothing', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [triageable('s1'), triageable('s2')],
      state: { triageDay: { day: '2026-07-31', flags: 0, jevDecisions: 1, jevSkips: 0, jevUsd: 0.6 } },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('investigations are off: 2 flags wait for you and nothing is spent on them');
    should(subject.guarded).be.empty();
    should(subject.spawns).be.empty();
  });

  it('should still start an investigation the owner asked for', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [session({ id: 's1' })] });
    await subject.service.requestInvestigation('s1');

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).deepEqual(['w0']);
    should(subject.guarded).be.empty();
  });

  it('should drop the sweep’s queued flags once investigations are switched off', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [unattended('s1')],
      guard: [JEV_INVESTIGATE],
      state: {
        assignedQueue: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'd' }],
        queueMeta: { s1: { queuedAt: at(-5), origin: 'jev' } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue).deepEqual([]);
    should(subject.spawns).be.empty();
  });
});

describe('Jev in front of investigations', () => {
  it('should forget what Jev said once an investigation starts, so a flag that outlives it is asked afresh', async () => {
    // Arrange
    const subject = harness({ config: both(), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.name)).deepEqual(['Investigate s1']);
    should(subject.state().passedOn).deepEqual([]);
    should(subject.state().investigations?.[0]).match({ origin: 'jev' });
  });

  it('should take a flag Jev already passed on straight to the investigation', async () => {
    // Arrange
    const subject = harness({
      config: both(),
      fleet: [triageable('s1')],
      state: { passedOn: ['quota_reset_passed\u0000s1\u0000rate_limited'] },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(subject.guarded).be.empty();
  });
});

describe('an investigation that fails to start', () => {
  const two = { accounts: [{ agent: 'claude-a' }, { agent: 'claude-b' }] };
  const installed = async (): Promise<readonly string[]> => ['claude-a', 'claude-b'];
  const failFirst = async (request: { readonly agent: string }, call: number) => {
    if (call === 0) throw new Error(`launch of ${request.agent} failed`);
    return {
      sessionId: `w${call}`,
      createdAt: at(0),
      agent: request.agent,
      harness: 'claude' as const,
      model: 'm',
      modelSource: 'configured' as const,
    };
  };

  it('should hand an assigned spawn to the next login within the same sweep', async () => {
    // Arrange
    const subject = harness({ config: enabled(two), fleet: [unattended('s1')], installed, spawn: failFirst });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-a', 'claude-b']);
    should(actual.assignedWardens).deepEqual(['w1']);
    should(subject.state().failover?.strikes?.['claude-a']).match({ count: 1 });
    should(subject.journal.find(entry => entry.type === 'fleet.warden_spawn_failed')?.data).match({
      targetId: 's1',
      agent: 'claude-a',
      attempt: 1,
    });
  });

  it('should hand the fleet warden to the next login within the same sweep', async () => {
    // Arrange
    const subject = harness({ config: enabled(two), fleet: [triageable('s1')], installed, spawn: failFirst });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-a', 'claude-b']);
    should(actual.spawned).equal('w1');
  });

  it('should stop after every login failed once, without calling that exhaustion', async () => {
    // Arrange
    const subject = harness({
      config: enabled(two),
      fleet: [triageable('s1')],
      installed,
      spawn: async request => {
        throw new Error(`launch of ${request.agent} failed`);
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).have.length(2);
    should(actual.message).equal('warden spawn failed: launch of claude-b failed');
    should(journalTypes(subject)).not.containEql('fleet.warden_exhausted');
    should(subject.state().failover).not.have.property('exhaustedSince');
  });

  it('should stop quietly when the only other login is not installed on this host', async () => {
    // Arrange — claude-b is configured but missing, so once claude-a has failed there is nothing left to try
    const subject = harness({
      config: enabled(two),
      fleet: [triageable('s1')],
      installed: async () => ['claude-a'],
      spawn: async request => {
        throw new Error(`launch of ${request.agent} failed`);
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert — a failed start is not exhaustion, so nothing is journalled or raised as one
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-a']);
    should(actual.message).equal('warden spawn failed: launch of claude-a failed');
    should(journalTypes(subject)).not.containEql('fleet.warden_exhausted');
    should(subject.state().failover).not.have.property('exhaustedSince');
  });

  it('should try at most three logins in one sweep', async () => {
    // Arrange
    const many = { accounts: ['a', 'b', 'c', 'd'].map(agent => ({ agent: `claude-${agent}` })) };
    const subject = harness({
      config: enabled(many),
      fleet: [triageable('s1')],
      installed: async () => many.accounts.map(account => account.agent),
      spawn: async () => {
        throw new Error('no');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns.map(spawn => spawn.agent)).deepEqual(['claude-a', 'claude-b', 'claude-c']);
  });
});

describe('the growing cooldown', () => {
  it('should leave a cleared flag alone until its subject changes, instead of re-asking when the blessing lapses', async () => {
    // Arrange
    const time = clock();
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], now: time.now });

    // Act — six sweeps an hour apart: long after the first blessing's fifteen minutes ran out.
    for (let round = 0; round < 6; round += 1) {
      await subject.service.run({ force: false });
      time.advance(60);
    }

    // Assert — one Jev decision, held against the same turn ever since.
    should(subject.guarded).have.length(1);
    should(subject.state().backoff?.['s1|unattended_question']).match({
      subject: /^turn:\?\|since:/u,
      count: 1,
      cleared: true,
    });
    should(subject.state().actions?.at(-1)?.detail).equal(
      'Jev was 96% sure it is healthy, so this flag is left alone until its situation changes — a new turn or a different command — for 24 h at most.',
    );
  });

  it('should ask again when the ferret went quiet a second time in the same turn', async () => {
    // Arrange — cleared, then it moved again, and now it has been idle long enough to flag once more.
    const time = clock();
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], now: time.now });
    await subject.service.run({ force: false });
    time.advance(120);
    const lastActivityAt = new Date(time.now() - 40 * MINUTE).toISOString();
    subject.setFleet([session({ id: 's1', status: 'awaiting_user', state: { lastActivityAt } })]);

    // Act
    await subject.service.run({ force: false });

    // Assert — a new episode is a new subject: a clearance of the last one never hides it.
    should(subject.guarded).have.length(2);
    should(subject.state().backoff?.['s1|unattended_question']?.subject).equal(`turn:?|since:${lastActivityAt}`);
  });

  it('should ask again at once when the ferret moves to a new turn', async () => {
    // Arrange
    const time = clock();
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], now: time.now });
    await subject.service.run({ force: false });
    time.advance(60);
    subject.setFleet([session({ id: 's1', status: 'awaiting_user', state: { lastActivityAt: at(-600), turn: 2 } })]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).have.length(2);
    should(subject.state().backoff?.['s1|unattended_question']).match({ subject: /^turn:2\|since:/u, count: 1 });
  });

  it('should forget the streak of a flag that stopped being raised while nothing blessed it', async () => {
    // Arrange
    const time = clock();
    const subject = harness({ config: jevOnly(), fleet: [unattended('s1')], now: time.now });
    await subject.service.run({ force: false });
    time.advance(15);
    subject.setFleet([session({ id: 's1', status: 'awaiting_user', state: { lastActivityAt: at(14) } })]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().clearStreaks).deepEqual({});
  });

  it('should grow an investigation’s clear the same way', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      reports: {
        '/r.md':
          'Verdict: LEAVE\n\n# Warden report — s1 (teammate :s1, -)\n\n- **Anomaly kind:** unattended_question\n\n## Summary\n- **Recommended action:** LEAVE — it is fine\n- **Outcome:** done\n',
      },
      state: {
        assignments: {
          s1: {
            wardenId: 'w0',
            spawnedAt: at(-30),
            capability: 'c',
            kinds: ['unattended_question'],
            reportPath: '/r.md',
          },
        },
        clearStreaks: { s1: { status: 'awaiting_user', counts: { unattended_question: 2 } } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings?.s1).match({ by: 'warden', streak: 2 });
    should(Date.parse(subject.state().blessings?.s1?.expiresAt ?? '') - NOW).equal(60 * MINUTE);
    should(subject.state().actions?.[0]?.detail).equal(
      'The investigation found it healthy, so this flag is left alone for 1 h — cleared 3 times in a row, so it is left alone longer each time.',
    );
  });
});

describe('leaving a ferret alone longer', () => {
  it.each([
    ['the ferret does not exist', [], 'not_found'],
    ['the ferret has finished', [session({ id: 's1', status: 'completed' })], 'finished'],
    ['nothing is flagged or cleared', [session({ id: 's1' })], 'not_flagged'],
  ] as const)('should refuse when %s', async (_label, fleet, failure) => {
    // Arrange
    const subject = harness({ config: enabled(), fleet });

    // Act
    const error: unknown = await subject.service.leaveAlone('s1', '4h').catch((cause: unknown) => cause);

    // Assert
    should(error).be.instanceOf(WardenRequestError).and.have.property('failure', failure);
  });

  it('should cover the flags raised now and those already cleared, for the time the owner chose', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      state: {
        lastAnomalies: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'd' }],
        blessings: {
          s1: {
            sessionId: 's1',
            kinds: ['declared_wait_overdue'],
            status: 'awaiting_user',
            blessedAt: at(-1),
            expiresAt: at(10),
            by: 'jev',
          },
        },
      },
    });

    // Act
    const actual = await subject.service.leaveAlone('s1', '4h');

    // Assert
    should(actual.blessing).deepEqual({
      sessionId: 's1',
      kinds: ['declared_wait_overdue', 'unattended_question'],
      expiresAt: at(240),
      by: 'owner',
    });
    should(actual.message).equal(
      'Left alone for 4 h. A new kind of trouble, or a change of status, still raises a flag.',
    );
    should(subject.state().actions?.[0]).match({
      action: 'bless',
      by: 'owner',
      detail: 'You asked the Warden to leave it alone for 4 h.',
    });
    should(journalTypes(subject)).containEql('fleet.warden_left_alone');
  });

  it('should leave it alone until its status changes, and end then', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      state: {
        lastAnomalies: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'd' }],
      },
    });
    const actual = await subject.service.leaveAlone('s1', 'until_change');
    subject.setFleet([session({ id: 's1', status: 'running' })]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(actual.blessing).match({ untilChange: true, expiresAt: at(7 * 24 * 60) });
    should(actual.message).startWith('Left alone until its status changes.');
    should(subject.state().blessings).deepEqual({});
  });

  it('should never shorten a longer blessing already in force', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      state: {
        blessings: {
          s1: {
            sessionId: 's1',
            kinds: ['unattended_question'],
            status: 'awaiting_user',
            blessedAt: at(-1),
            expiresAt: at(200),
            by: 'warden',
            streak: 4,
          },
        },
      },
    });

    // Act
    const actual = await subject.service.leaveAlone('s1', '1h');

    // Assert
    should(actual.blessing.expiresAt).equal(at(200));
    should(actual.message).startWith('Left alone for 3.3 h.');
  });

  it('should take the ferret out of the investigation queue', async () => {
    // Arrange
    const queued = {
      kind: 'unattended_question' as const,
      sessionId: 's1',
      status: 'awaiting_user' as const,
      detail: 'd',
    };
    const subject = harness({
      config: enabled({ maxAssignedWardens: 1 }),
      fleet: [unattended('s1'), session({ id: 'w9', label: 'warden' })],
      state: {
        lastAnomalies: [queued],
        assignedQueue: [queued],
        queueMeta: { s1: { queuedAt: at(-5), origin: 'sweep' } },
      },
    });

    // Act
    await subject.service.leaveAlone('s1', '1h');
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue).deepEqual([]);
    should(subject.spawns).be.empty();
  });
});

describe('the liveness reflex', () => {
  const assessment = { verdict: 'nudge' as const, quietSeconds: 330, strongQuietSeconds: 330 };

  it('should nudge a quiet ferret when the owner lets the Warden nudge, and list it', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })] });

    // Act
    const actual = await subject.service.reflex([{ sessionId: 's1', kind: 'nudge', assessment }]);

    // Assert
    should(actual).deepEqual({ frozen: false });
    should(subject.remedies).match([{ action: 'nudge', sessionId: 's1' }]);
    should(subject.state().actions?.[0]).match({
      action: 'nudge',
      outcome: 'done',
      by: 'warden',
      detail: 'Nudged: no output, screen change or subprocess for 5 min.',
    });
    should(journalTypes(subject)).containEql('fleet.warden_reflex_nudged');
  });

  it('should not nudge while the Warden is off or may not nudge alone, nor for nothing', async () => {
    // Arrange
    const off = harness({ config: enabled({ enabled: false }), fleet: [session({ id: 's1' })] });
    const held = harness({
      config: enabled({
        mayActAlone: { nudge: false, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
      }),
      fleet: [session({ id: 's1' })],
    });

    // Act
    await off.service.reflex([{ sessionId: 's1', kind: 'nudge', assessment }]);
    await held.service.reflex([{ sessionId: 's1', kind: 'nudge', assessment }]);
    const nothing = await held.service.reflex([]);

    // Assert
    should(off.remedies).deepEqual([]);
    should(held.remedies).deepEqual([]);
    should(nothing).deepEqual({ frozen: false });
  });

  it('should record a nudge that did not take', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })], remedyFails: 'nudge' });

    // Act
    await subject.service.reflex([{ sessionId: 's1', kind: 'nudge', assessment }]);

    // Assert
    should(subject.state().actions?.[0]).match({ outcome: 'failed', detail: 'The nudge did not take: nudge refused.' });
  });

  it('should only journal a frozen ferret and say so, leaving the flag to the next sweep', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })] });

    // Act
    const actual = await subject.service.reflex([
      { sessionId: 's1', kind: 'frozen', assessment: { ...assessment, verdict: 'frozen' } },
    ]);

    // Assert
    should(actual).deepEqual({ frozen: true });
    should(subject.remedies).deepEqual([]);
    should(journalTypes(subject)).containEql('fleet.warden_frozen');
  });

  it('should flag a frozen working ferret for one assigned warden', async () => {
    // Arrange
    const frozen = { ...session({ id: 's1' }), frozenAt: at(-1) };
    const subject = harness({ config: enabled(), fleet: [frozen] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies).match([{ kind: 'agent_frozen', sessionId: 's1', since: at(-1), assignedWarden: true }]);
    should(subject.spawns.map(spawn => spawn.name)).deepEqual(['Investigate s1']);
    should(subject.spawns[0]?.prompt).containEql('recommend RESTART');
  });
});
