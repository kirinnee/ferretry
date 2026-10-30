import { describe, it } from 'bun:test';
import should from 'should';
import type { WardenRuntimeState } from '../../../src/lib/warden/index.ts';
import { investigationsOffMessage, WardenRequestError } from '../../../src/lib/warden/index.ts';
import {
  at,
  enabled,
  escalated,
  harness,
  JEV_INVESTIGATE,
  JEV_SKIP,
  journalTypes,
  session,
  triageable,
  unattended,
} from './sweep-harness.ts';

/**
 * The tiers between the free sweep and the investigation: rules, the Jev guard and the daily caps; what
 * an investigation's verdict does; the owner's own request; and the "who needs you" feed.
 */

/** Both layers: Jev in front of the investigation. */
const jev = (overrides: Parameters<typeof enabled>[0] = {}) =>
  enabled({ layers: { jev: true, llm: true }, ...overrides });

/** An assignment whose warden has finished, with the report it left. */
const finished = (kind = 'unattended_question'): Partial<WardenRuntimeState> => ({
  assignments: {
    s1: {
      wardenId: 'w0',
      spawnedAt: at(-30),
      capability: 'c',
      kinds: [kind as 'unattended_question'],
      reportPath: '/r.md',
    },
  },
  investigations: [
    {
      id: 'w0',
      scope: 'session',
      origin: 'jev',
      targetId: 's1',
      anomalyKind: 'unattended_question',
      startedAt: at(-30),
      reportPath: '/r.md',
    },
  ],
});

const report = (verdict: string, action: string): string =>
  `Verdict: ${verdict}\n\n# Warden report — s1 (teammate :s1, -)\n\n- **Anomaly kind:** unattended_question\n\n## Summary\n- **Recommended action:** ${action}\n- **Outcome:** done\n`;

describe('rules only — the default', () => {
  it('should flag, count and spend nothing', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1'), triageable('s2')] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.anomalies).have.length(2);
    should(actual.message).equal('investigations are off: 1 flag waits for you and nothing is spent on it');
    should(subject.spawns).be.empty();
    should(subject.guarded).be.empty();
    should(subject.state().triageDay?.flags).equal(2);
  });

  it('should count a flag once, not every sweep it persists', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1')] });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().triageDay?.flags).equal(1);
  });

  it('should drop flags an AI triage queued once the owner switched to rules', async () => {
    // Arrange
    const subject = harness({
      fleet: [unattended('s1')],
      state: {
        assignedQueue: [{ kind: 'unattended_question', sessionId: 's1', status: 'awaiting_user', detail: 'd' }],
        queueMeta: { s1: { queuedAt: at(-5), origin: 'jev' } },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().assignedQueue).deepEqual([]);
    should(subject.state().queueMeta).deepEqual({});
  });
});

describe('the Jev guard', () => {
  it('should bless a flag it is sure about instead of investigating it', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [unattended('s1')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).be.empty();
    should(subject.state().blessings?.s1).match({ kinds: ['unattended_question'], status: 'awaiting_user', by: 'jev' });
    should(subject.state().actions?.[0]).match({
      sessionId: 's1',
      action: 'bless',
      outcome: 'done',
      by: 'jev',
      confidence: 0.96,
    });
    should(subject.state().triageDay).match({ jevDecisions: 1, jevSkips: 1, jevUsd: 0.001 });
    should(journalTypes(subject)).containEql('fleet.warden_guarded');
  });

  it('should show Jev a redacted snapshot built with the settings in warden.yaml', async () => {
    // Arrange
    const subject = harness({
      config: jev({ guard: { threshold: 0.9, model: 'jev-2', usdPerMillionInputTokens: 1 } }),
      fleet: [unattended('s1')],
      evidence: async () => ({ recentTurns: ['token sk-live-1'], paneTail: 'sk-live-1' }),
      redact: text => text.replaceAll('sk-live-1', '[redacted:KEY]'),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guardSettings).deepEqual([{ threshold: 0.9, model: 'jev-2', usdPerMillionInputTokens: 1 }]);
    should(subject.guarded[0]?.anomaly).equal('unattended_question');
    should(JSON.stringify(subject.guarded)).not.containEql('sk-live-1');
  });

  it('should investigate what Jev sends on, recording that Jev sent it', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.assignedWardens).deepEqual(['w0']);
    should(subject.spawns[0]?.effort).equal('low');
    should(subject.state().investigations?.[0]).match({ id: 'w0', scope: 'session', origin: 'jev', targetId: 's1' });
  });

  it('should investigate a skip it is not sure enough about', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [unattended('s1')], guard: [{ ...JEV_SKIP, confidence: 0.8 }] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).have.length(1);
    should(subject.state().blessings ?? {}).deepEqual({});
  });

  it('should never send a snapshot it could not redact, and investigate instead', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      redact: () => {
        throw new Error('vault damaged');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).be.empty();
    should(subject.spawns).have.length(1);
    should(subject.state().guard?.lastFailure?.code).equal('unredacted');
    should(journalTypes(subject)).containEql('fleet.warden_guard_unredacted');
  });

  it('should investigate when the guard itself throws, or the evidence cannot be read', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      guard: [new Error('socket hang up')],
      evidence: async () => {
        throw new Error('no transcript');
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).have.length(1);
    should(subject.guarded[0]?.recentTurns).deepEqual([]);
    should(subject.state().guard?.lastFailure?.code).equal('provider_error');
  });

  it('should not call the guard while it backs off, and investigate', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [unattended('s1')], state: { guard: { backoffUntil: at(5) } } });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).be.empty();
    should(subject.spawns).have.length(1);
  });

  it('should merge a new skip into a blessing the ferret already holds', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      state: {
        blessings: {
          s1: {
            sessionId: 's1',
            kinds: ['sus_thinking'],
            status: 'awaiting_user',
            blessedAt: at(-1),
            expiresAt: at(10),
          },
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().blessings?.s1?.kinds).deepEqual(['sus_thinking', 'unattended_question']);
  });

  it('should not ask again about a flag already waiting in the queue', async () => {
    // Arrange: one slot, held by a live warden, so the second flag queues.
    const subject = harness({ config: jev(), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });
    await subject.service.run({ force: false });
    subject.setFleet([unattended('s1'), session({ id: 'w0', label: 'fleet-warden' }), unattended('s2')]);

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded.map(snapshot => snapshot.anomaly)).have.length(2);
    should(subject.state().assignedQueue?.map(anomaly => anomaly.sessionId)).deepEqual(['s2']);
    should(subject.state().queueMeta?.s2?.origin).equal('jev');
  });

  it('should pass the rest on to investigations, unasked, once the Jev cap is reached mid-sweep', async () => {
    // Arrange
    const subject = harness({
      config: jev({ caps: { jevUsdPerDay: 0.01, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 } }),
      fleet: [unattended('s1'), unattended('s2')],
      guard: [{ ...JEV_INVESTIGATE, costUsd: 0.02 }],
    });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.guarded).have.length(1);
    should(subject.spawns.map(spawn => spawn.name)).deepEqual(['Investigate s1']);
    should(subject.state().assignedQueue?.map(anomaly => anomaly.sessionId)).deepEqual(['s2']);
    should(status.triage.jev).deepEqual({ configured: true, active: false, reason: 'jev_cap' });
    should(status.triage.llm).deepEqual({ configured: true, active: true, reason: 'configured' });
  });

  it('should keep a queued flag waiting while the investigation cap holds investigations off', async () => {
    // Arrange
    const queued = {
      kind: 'unattended_question' as const,
      sessionId: 's1',
      status: 'awaiting_user' as const,
      detail: 'd',
    };
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      state: {
        assignedQueue: [queued],
        investigations: [
          { id: 'r', scope: 'fleet', origin: 'sweep', startedAt: at(-50), reportPath: '/r.md', costUsd: 5 },
        ],
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).be.empty();
    should(subject.guarded).be.empty();
    should(subject.state().assignedQueue?.map(anomaly => anomaly.sessionId)).deepEqual(['s1']);
  });

  it('should still start a queued flag while only the Jev cap is reached', async () => {
    // Arrange
    const queued = {
      kind: 'unattended_question' as const,
      sessionId: 's1',
      status: 'awaiting_user' as const,
      detail: 'd',
    };
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      state: {
        triageDay: { day: '2026-07-31', flags: 0, jevDecisions: 9, jevSkips: 0, jevUsd: 0.5 },
        assignedQueue: [queued],
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).be.empty();
    should(subject.spawns.map(spawn => spawn.name)).deepEqual(['Investigate s1']);
  });
});

describe('the investigation budget', () => {
  it('should queue rather than spawn once today’s investigation cap is reached', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1')],
      state: {
        investigations: [
          {
            id: 'old',
            scope: 'session',
            origin: 'sweep',
            startedAt: at(-120),
            finishedAt: at(-100),
            reportPath: '/o.md',
            costUsd: 2.5,
          },
        ],
      },
    });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.spawns).be.empty();
    should(status.spend.capsHit).deepEqual(['investigation']);
    should(status.triage.llm).deepEqual({ configured: true, active: false, reason: 'investigation_cap' });
  });

  it('should hold investigations over the hourly limit in the queue', async () => {
    // Arrange
    const recent = Array.from({ length: 2 }, (_, index) => ({
      id: `r${index}`,
      scope: 'session' as const,
      origin: 'sweep' as const,
      startedAt: at(-10),
      finishedAt: at(-5),
      reportPath: `/r${index}.md`,
      costUsd: 0,
    }));
    const subject = harness({
      config: enabled({
        maxAssignedWardens: 3,
        caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 3 },
      }),
      fleet: [unattended('s1'), unattended('s2')],
      state: { investigations: recent },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).have.length(1);
    should(subject.state().assignedQueue).have.length(1);
  });

  it('should let an operator’s forced run past the budget', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 1 } }),
      fleet: [unattended('s1')],
      state: {
        investigations: [
          { id: 'r', scope: 'session', origin: 'sweep', startedAt: at(-5), reportPath: '/r.md', costUsd: 3 },
        ],
      },
    });

    // Act
    await subject.service.run({ force: true });

    // Assert
    should(subject.spawns.length).be.above(0);
  });
});

describe('what a verdict does', () => {
  it('should nudge on NUDGE, in the report’s words, and record it', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('NUDGE', 'NUDGE — it went quiet') },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).deepEqual([
      {
        action: 'nudge',
        sessionId: 's1',
        detail:
          'The Warden checked on you: it went quiet. If you are blocked, say exactly what you need; otherwise carry on and post a short status.',
      },
    ]);
    should(subject.state().actions?.[0]).match({ action: 'nudge', outcome: 'done', by: 'warden', reportPath: '/r.md' });
    should(subject.state().investigations?.[0]).match({ id: 'w0', finishedAt: at(0), verdict: 'nudged' });
  });

  it('should hold a stop for the owner unless they allowed it', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('KILL', 'STOP — looping on a failing hook') },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });
    const feed = await subject.service.agenda();

    // Assert
    should(subject.remedies).be.empty();
    should(subject.state().actions?.[0]).match({ action: 'stop', outcome: 'held' });
    // A held act becomes a Warden card only while its flag still stands; this ferret is no longer flagged.
    should(feed.items).be.empty();
    should(journalTypes(subject)).containEql('fleet.warden_action_held');
  });

  it('should stop when the owner allowed it', async () => {
    // Arrange
    const subject = harness({
      config: enabled({
        mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: true, closeLeftovers: true },
      }),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('KILL', 'STOP — looping') },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).deepEqual([{ action: 'stop', sessionId: 's1', detail: 'Warden verdict: looping' }]);
    should(journalTypes(subject)).containEql('fleet.warden_acted');
  });

  it('should restart a frozen ferret on RESTART, and hold it when the owner did not allow restarts', async () => {
    // Arrange
    const allowed = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('RESUME', 'RESTART — the process is frozen') },
      state: finished(),
    });
    const held = harness({
      config: enabled({
        mayActAlone: { nudge: true, resume: true, restart: false, failover: true, stop: false, closeLeftovers: true },
      }),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('RESUME', 'RESTART — the process is frozen') },
      state: finished(),
    });

    // Act
    await allowed.service.run({ force: false });
    await held.service.run({ force: false });

    // Assert
    should(allowed.remedies).deepEqual([{ action: 'restart', sessionId: 's1', detail: '' }]);
    should(allowed.state().actions?.[0]).match({
      action: 'restart',
      outcome: 'done',
      detail: 'Restarted with its conversation intact: the process is frozen.',
    });
    should(held.remedies).deepEqual([]);
    should(held.state().actions?.[0]).match({ action: 'restart', outcome: 'held' });
  });

  it('should resume on RESUME and fail over on a MIGRATE that names the login', async () => {
    // Arrange
    const resumed = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'failed_resumable' as 'running' })],
      reports: { '/r.md': report('RESUME', 'RESUME — the pane died') },
      state: finished(),
    });
    const moved = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'rate_limited' })],
      reports: { '/r.md': report('NUDGE', 'MIGRATE (claude-work) — quota is out') },
      state: finished(),
    });

    // Act
    await resumed.service.run({ force: false });
    await moved.service.run({ force: false });

    // Assert
    should(resumed.remedies.map(entry => entry.action)).deepEqual(['resume']);
    should(moved.remedies).deepEqual([{ action: 'failover', sessionId: 's1', detail: 'claude-work' }]);
    should(moved.state().actions?.[0]).match({ action: 'failover', agent: 'claude-work' });
  });

  it('should record an act that did not take', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('NUDGE', 'NUDGE — quiet') },
      state: finished(),
      remedyFails: 'nudge',
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().actions?.[0]).match({
      action: 'nudge',
      outcome: 'failed',
      detail: 'Nudged did not take: nudge refused.',
    });
    should(journalTypes(subject)).containEql('fleet.warden_action_failed');
  });

  it('should hold a nudge the owner did not let it send alone', async () => {
    // Arrange
    const subject = harness({
      config: enabled({
        mayActAlone: { nudge: false, resume: true, restart: true, failover: true, stop: false, closeLeftovers: true },
      }),
      fleet: [session({ id: 's1', status: 'running' })],
      reports: { '/r.md': report('NUDGE', 'NUDGE — quiet') },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.state().actions?.[0]).match({ action: 'nudge', outcome: 'held' });
  });

  it.each([
    ['prose with no verdict marker', 'The ferret should be killed, it is looping forever.', 'running'],
    ['a ferret that has finished since', report('KILL', 'STOP — looping'), 'stopped'],
  ] as const)('should do nothing on %s', async (_label, text, status) => {
    // Arrange
    const subject = harness({
      config: enabled({
        mayActAlone: { nudge: true, resume: true, restart: true, failover: true, stop: true, closeLeftovers: true },
      }),
      fleet: [session({ id: 's1', status })],
      reports: { '/r.md': text },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).be.empty();
    should(subject.state().actions ?? []).deepEqual([]);
  });

  it('should record a cleared verdict as the warden’s blessing', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1', status: 'awaiting_user' })],
      reports: { '/r.md': report('LEAVE', 'LEAVE — it is fine') },
      state: finished(),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().actions?.[0]).match({ action: 'bless', by: 'warden', anomalyKind: 'unattended_question' });
    should(subject.state().blessings?.s1?.by).equal('warden');
  });
});

describe('pricing finished investigations', () => {
  it('should price a finished warden, keep the running average, and leave a live one alone', async () => {
    // Arrange
    const subject = harness({
      fleet: [session({ id: 'live', label: 'fleet-warden' })],
      cost: async id => (id === 'done' ? 0.3 : id === 'weird' ? Number.NaN : undefined),
      state: {
        costAverage: { count: 1, totalUsd: 0.5 },
        investigations: [
          { id: 'live', scope: 'session', origin: 'jev', startedAt: at(-5), reportPath: '/l.md' },
          { id: 'done', scope: 'fleet', origin: 'sweep', startedAt: at(-20), reportPath: '/d.md' },
          { id: 'weird', scope: 'fleet', origin: 'sweep', startedAt: at(-20), reportPath: '/w.md' },
          {
            id: 'stale',
            scope: 'fleet',
            origin: 'sweep',
            startedAt: at(-3000),
            finishedAt: at(-2990),
            reportPath: '/s.md',
          },
        ],
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    const records = subject.state().investigations ?? [];
    should(records.find(record => record.id === 'live')).not.have.property('finishedAt');
    should(records.find(record => record.id === 'done')).match({ finishedAt: at(0), costUsd: 0.3 });
    should(records.find(record => record.id === 'weird')).not.have.property('costUsd');
    should(subject.state().costAverage).deepEqual({ count: 2, totalUsd: 0.8 });
  });

  it('should leave no average while nothing has been priced', async () => {
    // Arrange
    const subject = harness({
      state: {
        investigations: [{ id: 'x', scope: 'fleet', origin: 'sweep', startedAt: at(-20), reportPath: '/x.md' }],
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state()).not.have.property('costAverage');
  });
});

describe('the fleet warden under Jev', () => {
  it('should not spawn when Jev judged every flag healthy, nor ask again next sweep', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [triageable('s1')] });

    // Act
    const first = await subject.service.run({ force: false });
    const second = await subject.service.run({ force: false });

    // Assert
    should(first.message).equal('Jev settled every flag; nothing to investigate');
    should(second.message).equal('no anomalies to escalate');
    should(subject.guarded).have.length(1);
    should(subject.spawns).be.empty();
  });

  it('should send on only what Jev wants investigated, and remember what it covers', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [triageable('s1'), triageable('s2')],
      guard: [JEV_SKIP, JEV_INVESTIGATE],
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(subject.spawns[0]?.prompt).containEql('s2');
    should(subject.state().sweepCoverage).match({
      wardenId: 'w0',
      anomalies: [{ sessionId: 's2', kind: 'quota_reset_passed' }],
    });
    should(subject.state().investigations?.[0]).match({ id: 'w0', scope: 'fleet', origin: 'jev' });
  });

  it('should pass the rest on to the investigation, unasked, once the Jev cap is reached', async () => {
    // Arrange
    const subject = harness({
      config: jev({ caps: { jevUsdPerDay: 0.01, investigationUsdPerDay: 2, maxInvestigationsPerHour: 6 } }),
      fleet: [triageable('s1'), triageable('s2')],
      guard: [{ ...JEV_SKIP, costUsd: 0.02 }],
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(subject.guarded).have.length(1);
    should(subject.state().sweepCoverage?.anomalies).deepEqual([{ sessionId: 's2', kind: 'quota_reset_passed' }]);
  });

  it('should still let Jev answer first past the hourly limit, and hold back only the investigation', async () => {
    // Arrange
    const subject = harness({
      config: jev({ caps: { jevUsdPerDay: 0.5, investigationUsdPerDay: 2, maxInvestigationsPerHour: 1 } }),
      fleet: [triageable('s1')],
      guard: [JEV_INVESTIGATE],
      state: {
        investigations: [
          {
            id: 'r',
            scope: 'fleet',
            origin: 'sweep',
            startedAt: at(-5),
            finishedAt: at(-1),
            reportPath: '/r.md',
            costUsd: 0,
          },
        ],
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('hourly investigation limit reached (1 per hour)');
    should(subject.guarded).have.length(1);
    should(subject.spawns).be.empty();
  });

  it('should send every flag straight to the investigation while the Jev cap holds Jev off', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [triageable('s1')],
      state: { triageDay: { day: '2026-07-31', flags: 0, jevDecisions: 1, jevSkips: 0, jevUsd: 0.6 } },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.spawned).equal('w0');
    should(subject.guarded).be.empty();
    should(subject.state().investigations?.[0]).match({ scope: 'fleet', origin: 'sweep' });
  });

  it('should say an investigation cap leaves the flags for the owner', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [triageable('s1')],
      state: {
        investigations: [
          { id: 'r', scope: 'fleet', origin: 'sweep', startedAt: at(-50), reportPath: '/r.md', costUsd: 5 },
        ],
      },
    });

    // Act
    const actual = await subject.service.run({ force: false });

    // Assert
    should(actual.message).equal('today’s investigation cap is reached: 1 flag waits for you until midnight UTC');
  });
});

describe('the owner asking for an investigation', () => {
  it.each([
    ['the Warden is off', enabled({ enabled: false }), [unattended('s1')], 'off'],
    ['the ferret does not exist', enabled(), [], 'not_found'],
    ['the ferret has finished', enabled(), [session({ id: 's1', status: 'completed' })], 'finished'],
  ] as const)('should refuse when %s', async (_label, config, fleet, failure) => {
    // Arrange
    const subject = harness({ config, fleet });

    // Act
    const error: unknown = await subject.service.requestInvestigation('s1').catch((cause: unknown) => cause);

    // Assert
    should(error).be.instanceOf(WardenRequestError).and.have.property('failure', failure);
  });

  it('should refuse once today’s investigation cap is reached', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1' })],
      state: {
        investigations: [
          { id: 'r', scope: 'fleet', origin: 'sweep', startedAt: at(-50), reportPath: '/r.md', costUsd: 5 },
        ],
      },
    });

    // Act
    const error: unknown = await subject.service.requestInvestigation('s1').catch((cause: unknown) => cause);

    // Assert
    should(error).be.instanceOf(WardenRequestError).and.have.property('failure', 'cap');
    should((error as Error).message).startWith('Today’s investigation cap ($2.00) is reached.');
  });

  it('should refuse until the next hour once this hour’s share of the cap is spent, and say when', async () => {
    // Arrange — $0.60 this hour against a $2 day: past the $0.50 hourly share, far from the day's cap.
    const subject = harness({
      config: enabled(),
      fleet: [session({ id: 's1' })],
      state: {
        investigations: [
          { id: 'r', scope: 'fleet', origin: 'sweep', startedAt: at(0), reportPath: '/r.md', costUsd: 0.6 },
        ],
      },
    });

    // Act
    const error: unknown = await subject.service.requestInvestigation('s1').catch((cause: unknown) => cause);

    // Assert
    should(error).be.instanceOf(WardenRequestError).and.have.property('failure', 'cap');
    should((error as Error).message).equal(
      'This hour’s share of the investigation cap ($0.50 of $2.00 a day) is spent. Try again at 13:00 UTC.',
    );
  });

  it('should tell a paced investigation layer apart from a spent day in the run’s own words', () => {
    // Arrange
    const on = { configured: true, active: true, reason: 'configured' } as const;
    const layers = { jev: on, llm: { configured: true, active: false, reason: 'investigation_cap' } } as const;

    // Act
    const paced = investigationsOffMessage(layers, 2, {
      capsPaced: ['investigation'],
      pacedUntil: '2026-07-31T13:00:00.000Z',
    });
    const unknownHour = investigationsOffMessage(layers, 1, { capsPaced: ['investigation'] });

    // Assert
    should(paced).equal(
      'this hour’s share of the investigation cap is spent: 2 flags Jev did not clear wait until 13:00 UTC',
    );
    should(unknownHour).endWith('waits until the next hour');
  });

  it('should answer "already running" for a ferret under investigation', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [session({ id: 's1' })], state: finished() });

    // Act
    const actual = await subject.service.requestInvestigation('s1');

    // Assert
    should(actual).deepEqual({
      sessionId: 's1',
      state: 'running',
      wardenSession: 'w0',
      message: 'A warden is already investigating this ferret.',
    });
  });

  it('should queue behind earlier requests and ahead of the sweep’s own flags', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ maxAssignedWardens: 2 }),
      fleet: [session({ id: 's1' }), session({ id: 's2' }), session({ id: 's3' })],
      state: {
        assignedQueue: [
          { kind: 'owner_request', sessionId: 's2', status: 'running', detail: 'look' },
          { kind: 'sus_thinking', sessionId: 's3', status: 'running', detail: 'think' },
        ],
        queueMeta: { s2: { queuedAt: at(-1), origin: 'owner' } },
      },
    });

    // Act
    const actual = await subject.service.requestInvestigation('s1', 'CI went red');

    // Assert
    should(actual).deepEqual({
      sessionId: 's1',
      state: 'queued',
      position: 2,
      message: 'Queued. 2 investigations run at a time.',
    });
    should(subject.state().assignedQueue?.map(anomaly => anomaly.sessionId)).deepEqual(['s2', 's1', 's3']);
    should(subject.state().queueMeta?.s1).deepEqual({ queuedAt: at(0), origin: 'owner', note: 'CI went red' });
    should(journalTypes(subject)).containEql('fleet.warden_investigation_requested');
  });

  it('should start it on the next sweep, even under rules, skipping Jev and the cooldown', async () => {
    // Arrange
    const subject = harness({
      fleet: [session({ id: 's1', state: { teammate: 'Kofi' } as never })],
      state: { assignedCooldowns: { s1: at(-1) } },
    });
    const queued = await subject.service.requestInvestigation('s1');

    // Act
    await subject.service.run({ force: false });
    const after = await subject.service.investigationStatus('s1');

    // Assert
    should(queued).match({ state: 'queued', position: 1, message: 'Queued. One investigation runs at a time.' });
    should(subject.guarded).be.empty();
    should(subject.spawns[0]?.prompt).containEql('The OWNER asked for this investigation');
    should(subject.state().investigations?.[0]).match({ origin: 'owner', anomalyKind: 'owner_request' });
    should(after).deepEqual({
      sessionId: 's1',
      state: 'running',
      wardenSession: 'w0',
      message: 'A warden is investigating it now.',
    });
  });

  it('should keep the owner’s request ahead of a fresh flag on the same ferret', async () => {
    // Arrange: no slot is free, so both wait — and the request must not be overwritten by the flag.
    const subject = harness({
      config: enabled(),
      fleet: [unattended('s1'), session({ id: 'busy', label: 'fleet-warden' })],
    });
    await subject.service.requestInvestigation('s1', 'please look');

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.investigationStatus('s1');

    // Assert
    should(subject.state().assignedQueue).match([{ kind: 'owner_request', sessionId: 's1' }]);
    should(status).match({ state: 'queued', position: 1 });
  });

  it('should answer a ferret nobody queued as queued with no place', async () => {
    // Arrange
    const subject = harness();

    // Act
    const actual = await subject.service.investigationStatus('ghost');

    // Assert
    should(actual).deepEqual({
      sessionId: 'ghost',
      state: 'queued',
      message: 'Queued: it starts when a slot is free.',
    });
  });
});

describe('the status', () => {
  it('should carry the triage, the spend, the savings line and the lists', async () => {
    // Arrange
    const subject = harness({
      config: jev(),
      fleet: [unattended('s1')],
      state: {
        costAverage: { count: 2, totalUsd: 0.6 },
        guard: { lastFailure: { code: 'timeout', at: at(-1) }, backoffUntil: at(3) },
      },
    });
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.status('2026-07-31T12:02:00.000Z');

    // Assert
    should(actual.nextSweepAt).equal('2026-07-31T12:02:00.000Z');
    should(actual.triage).match({
      jev: { configured: true, active: true, reason: 'configured' },
      llm: { configured: true, active: true, reason: 'configured' },
      guardBackoffUntil: at(3),
    });
    should(actual.spend).match({ day: '2026-07-31', jevCapUsd: 0.5, investigationCapUsd: 2 });
    should(actual.savings).match({ flags: 1, investigations: 1, averageInvestigationUsd: 0.3 });
    should(actual.investigations[0]).match({ state: 'running', origin: 'jev' });
    should(actual.blessings).deepEqual([]);
  });

  it('should leave the guard out of a triage that never asks it, and the timer out before it is armed', async () => {
    // Arrange
    const subject = harness({ config: enabled(), state: { guard: { lastFailure: { code: 'not_set', at: at(-1) } } } });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.triage).deepEqual({
      jev: { configured: false, active: false, reason: 'configured' },
      llm: { configured: true, active: true, reason: 'configured' },
    });
    should(actual).not.have.property('nextSweepAt');
  });

  it('should list a Jev blessing and its action', async () => {
    // Arrange
    const subject = harness({ config: jev(), fleet: [unattended('s1')] });
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.status();

    // Assert
    should(actual.blessings).match([{ sessionId: 's1', by: 'jev', kinds: ['unattended_question'] }]);
    should(actual.actions).match([{ action: 'bless', by: 'jev' }]);
    should(actual.triage).not.have.property('guardFailure');
  });
});

describe('who needs you', () => {
  it('should list the Warden card a flag nothing could look at raised, and none for one Jev blessed', async () => {
    // Arrange
    const rules = harness({ fleet: [unattended('s1')] });
    const guarded = harness({ config: jev(), fleet: [unattended('s1')] });
    await rules.service.run({ force: false });
    await guarded.service.run({ force: false });

    // Act
    const shown = await rules.service.agenda();
    const quiet = await guarded.service.agenda();

    // Assert
    should(shown.items).match([
      { sessionId: 's1', source: 'agent-raised', raisedByName: 'Warden', anomalyKind: 'unattended_question' },
    ]);
    should(quiet.items).deepEqual([]);
    should(quiet.outcome).equal('clean-sweep');
  });

  it('should list only the Warden’s own cards, never a ferret’s own ask, and skip finished ferrets and wardens', async () => {
    // Arrange
    const row = {
      id: 'A1',
      source: 'question' as const,
      subject: 'Which fallback?',
      why: 'It asked which relay fallback to use.',
      waitingSince: at(-41),
      howToResolve: 'Answer it.',
      raisedBy: 'agent' as const,
    };
    const card = {
      ...row,
      id: 'A2',
      source: 'agent-raised' as const,
      raisedBy: 'daemon' as const,
      sourceRef: 'warden:ask:agent_frozen',
    };
    const subject = harness({
      fleet: [
        session({ id: 's1' }),
        session({ id: 'done', status: 'completed' }),
        session({ id: 'w', label: 'fleet-warden' }),
      ],
      feedBoards: {
        s1: { sessionId: 's1', parseErrors: 0, items: [row, card] },
        done: { sessionId: 'done', parseErrors: 0, items: [{ ...card, id: 'A9' }] },
      },
    });
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(actual.items).match([{ sessionId: 's1', id: 'A2', anomalyKind: 'agent_frozen' }]);
    should(actual.items).have.length(1);
  });

  it('should raise no card for a flag the fleet warden is looking at', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [triageable('s1')] });
    await subject.service.run({ force: false });
    subject.setFleet([triageable('s1'), session({ id: 'w0', label: 'fleet-warden' })]);
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(subject.raises).be.empty();
    should(actual.items).be.empty();
  });

  it('should say the feed is degraded when the reports cannot be read', async () => {
    // Arrange
    const subject = harness({ verdicts: async () => undefined });
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(actual.outcome).equal('degraded');
    should(actual.wardenDegraded?.reason).match(/could not be read/u);
  });

  it('should keep the cards it has when the reports cannot be read', async () => {
    // Arrange
    const subject = harness({ fleet: [unattended('s1')], verdicts: async () => undefined });
    subject.seedBoard('s1', [escalated('unattended_question')]);
    await subject.service.run({ force: false });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(actual.outcome).equal('items');
    should(actual.items).have.length(1);
  });

  it('should keep the louder exhausted banner over the unreadable-reports one', async () => {
    // Arrange: every account exhausted is the louder, more specific fact.
    const subject = harness({
      verdicts: async () => undefined,
      state: { failover: { exhaustedSince: at(-10) }, lastSweepAt: at(-1) },
    });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(actual.wardenDegraded?.reason).match(/exhausted/u);
  });

  it('should say a board the feed cannot read may hide a card, rather than that nothing waits', async () => {
    // Arrange
    const subject = harness({ fleet: [session({ id: 's1' })], feedBoards: {} });

    // Act
    const actual = await subject.service.agenda();

    // Assert
    should(actual.outcome).equal('degraded');
    should(actual.wardenDegraded?.reason).match(/may be hidden/u);
  });
});

describe('the settings in effect', () => {
  it('should read them without touching the fleet or the accounts', async () => {
    // Arrange
    const subject = harness({ config: jev({ events: { turnEnd: false, question: true, paneDied: true } }) });

    // Act
    const actual = await subject.service.currentConfig();

    // Assert
    should(actual.layers).deepEqual({ jev: true, llm: true });
    should(actual.events.turnEnd).be.false();
  });
});
