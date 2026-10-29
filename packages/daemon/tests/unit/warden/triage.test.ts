import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG } from '@ferretry/protocol';
import should from 'should';
import type { TriageDecision } from '../../../src/lib/speedups/jev.ts';
import {
  averageInvestigationUsd,
  DEFAULT_GUARD_BACKOFF_MS,
  effectiveLayers,
  forgetPassedOn,
  passedOnKey,
  prunePassedOn,
  guardBackingOff,
  guardHealthAfter,
  investigationsInLastHour,
  jevJudges,
  jevUsdThisHour,
  jevWithinBudget,
  newFlagCount,
  recordGuardDecision,
  redactTriageSnapshot,
  triageDayFor,
  triageSnapshotOf,
  utcDay,
  type WardenAnomaly,
  type WardenInvestigationRecord,
  wardenSavings,
  wardenSpend,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const CAPS = DEFAULT_WARDEN_CONFIG.caps;
const TODAY = { day: '2026-10-16', flags: 3, jevDecisions: 2, jevSkips: 1, jevUsd: 0.1 };

const record = (overrides: Partial<WardenInvestigationRecord> = {}): WardenInvestigationRecord => ({
  id: 'w1',
  scope: 'session',
  origin: 'jev',
  startedAt: at(-10),
  reportPath: '/r.md',
  ...overrides,
});

const decision = (overrides: Partial<TriageDecision> = {}): TriageDecision => ({
  verdict: 'leave',
  confidence: 0.9,
  model: 'jev-latest',
  inputTokens: 400,
  latencyMs: 80,
  costUsd: 0.002,
  ...overrides,
});

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'thinking for 14 minutes with no output',
  ...overrides,
});

describe('the day a cap counts against', () => {
  it('should be the UTC calendar day', () => {
    // Act / Assert
    should(utcDay(Date.parse('2026-10-16T23:59:59.000Z'))).equal('2026-10-16');
    should(utcDay(Date.parse('2026-10-17T00:00:00.000Z'))).equal('2026-10-17');
  });

  it('should keep today’s counters and start a new day afresh', () => {
    // Act
    const kept = triageDayFor(TODAY, NOW);
    const fresh = triageDayFor({ ...TODAY, day: '2026-10-15' }, NOW);
    const none = triageDayFor(undefined, NOW);

    // Assert
    should(kept).equal(TODAY);
    should(fresh).deepEqual({ day: '2026-10-16', flags: 0, jevDecisions: 0, jevSkips: 0, jevUsd: 0 });
    should(none).deepEqual(fresh);
  });
});

describe('today’s spend', () => {
  it('should count only investigations started today, and the unpriced ones as pending', () => {
    // Arrange
    const records = [
      record({ id: 'a', costUsd: 0.4 }),
      record({ id: 'b' }),
      record({ id: 'c', startedAt: '2026-10-15T10:00:00.000Z', costUsd: 9 }),
      record({ id: 'd', startedAt: 'not an instant', costUsd: 9 }),
    ];

    // Act
    const actual = wardenSpend({ caps: CAPS, today: TODAY, records, nowMs: NOW });

    // Assert
    should(actual).deepEqual({
      day: '2026-10-16',
      jevUsd: 0.1,
      jevCapUsd: 0.5,
      investigationUsd: 0.4,
      investigationCapUsd: 2,
      pendingInvestigations: 1,
      capsHit: [],
      investigationsLastHour: 2,
      maxInvestigationsPerHour: 6,
    });
  });

  it('should gate an unpriced investigation at the average priced one', () => {
    // Arrange
    const records = [record({ id: 'a', costUsd: 1.5 }), record({ id: 'b' })];

    // Act
    const actual = wardenSpend({ caps: CAPS, today: TODAY, records, average: { count: 2, totalUsd: 1 }, nowMs: NOW });

    // Assert
    should(actual.capsHit).deepEqual(['investigation']);
    should(actual.investigationUsd).equal(1.5);
  });

  it('should report both caps when both are reached: each stops its own layer', () => {
    // Act
    const actual = wardenSpend({
      caps: CAPS,
      today: { ...TODAY, jevUsd: 0.5 },
      records: [record({ costUsd: 5 })],
      nowMs: NOW,
    });

    // Assert
    should(actual.capsHit).deepEqual(['jev', 'investigation']);
  });

  it('should count investigations inside the last hour only', () => {
    // Act
    const actual = investigationsInLastHour(
      [record({ startedAt: at(-59) }), record({ startedAt: at(-61) }), record({ startedAt: at(1) })],
      NOW,
    );

    // Assert
    should(actual).equal(1);
  });

  it('should have no average until an investigation is priced', () => {
    // Act / Assert
    should(averageInvestigationUsd(undefined)).be.undefined();
    should(averageInvestigationUsd({ count: 0, totalUsd: 0 })).be.undefined();
    should(averageInvestigationUsd({ count: 4, totalUsd: 1.2 })).be.approximately(0.3, 1e-9);
  });
});

describe('the layers in effect', () => {
  const on = { configured: true, active: true, reason: 'configured' } as const;
  const off = { configured: false, active: false, reason: 'configured' } as const;
  const stopped = (reason: string) => ({ configured: true, active: false, reason });

  it.each([
    ['the Warden off', { jev: true, llm: true }, false, [], true, stopped('disabled'), stopped('disabled')],
    ['both layers off', { jev: false, llm: false }, true, ['jev', 'investigation'], true, off, off],
    ['the Jev cap, which stops only Jev', { jev: true, llm: true }, true, ['jev'], true, stopped('jev_cap'), on],
    [
      'the investigation cap, which stops only investigations',
      { jev: true, llm: true },
      true,
      ['investigation'],
      true,
      on,
      stopped('investigation_cap'),
    ],
    ['no login, which Jev does not need', { jev: true, llm: true }, true, [], false, on, stopped('no_login')],
    ['nothing in the way', { jev: false, llm: true }, true, [], true, off, on],
  ] as const)('should answer %s', (_label, layers, enabled, capsHit, hasLogin, jev, llm) => {
    // Act
    const actual = effectiveLayers(layers, enabled, { capsHit: [...capsHit] }, hasLogin);

    // Assert
    should(actual).deepEqual({ jev, llm });
  });
});

describe('the flags Jev passed on', () => {
  const flag = (sessionId: string, status: 'awaiting_user' | 'running' = 'awaiting_user') =>
    ({ kind: 'unattended_question', sessionId, status, detail: 'd' }) as const;

  it('should keep only the flags that still stand in the same status', () => {
    // Arrange
    const passed = [passedOnKey(flag('s1')), passedOnKey(flag('s2')), passedOnKey(flag('s3'))];

    // Act
    const actual = prunePassedOn(passed, [flag('s1'), flag('s2', 'running')]);

    // Assert
    should(actual).deepEqual([passedOnKey(flag('s1'))]);
  });

  it('should forget one ferret and keep the others', () => {
    // Arrange
    const passed = [passedOnKey(flag('s1')), passedOnKey(flag('s12'))];

    // Act
    const actual = forgetPassedOn(passed, 's1');

    // Assert
    should(actual).deepEqual([passedOnKey(flag('s12'))]);
  });
});

describe('the guard’s health', () => {
  it('should clear the last failure on a real answer', () => {
    // Act
    const actual = guardHealthAfter({ lastFailure: { code: 'timeout', at: at(-5) } }, decision(), NOW);

    // Assert
    should(actual).deepEqual({});
  });

  it('should back off for as long as the provider asked', () => {
    // Act
    const actual = guardHealthAfter({}, decision({ failure: { code: 'rate_limited', retryAfterMs: 30_000 } }), NOW);

    // Assert
    should(actual).deepEqual({ lastFailure: { code: 'rate_limited', at: at(0) }, backoffUntil: at(0.5) });
  });

  it('should back off for a minute when an overloaded provider named no time', () => {
    // Act
    const actual = guardHealthAfter({}, decision({ failure: { code: 'overloaded' } }), NOW);

    // Assert
    should(actual.backoffUntil).equal(new Date(NOW + DEFAULT_GUARD_BACKOFF_MS).toISOString());
  });

  it('should record a failure that asks for no back-off without starting one', () => {
    // Act
    const actual = guardHealthAfter({}, decision({ failure: { code: 'not_set' } }), NOW);

    // Assert
    should(actual).deepEqual({ lastFailure: { code: 'not_set', at: at(0) } });
  });

  it('should say whether a back-off is still running', () => {
    // Act / Assert
    should(guardBackingOff({ backoffUntil: at(1) }, NOW)).be.true();
    should(guardBackingOff({ backoffUntil: at(-1) }, NOW)).be.false();
    should(guardBackingOff({}, NOW)).be.false();
  });
});

describe('counting a decision', () => {
  it('should count a real answer, a skip and its cost', () => {
    // Act
    const actual = recordGuardDecision(TODAY, decision(), { kind: 'leave', confidence: 0.9 }, NOW);

    // Assert
    should(actual).match({ day: TODAY.day, flags: 3, jevDecisions: 3, jevSkips: 2, jevHour: '2026-10-16T12' });
    should(actual.jevUsd).be.approximately(0.102, 1e-9);
    should(actual.jevHourUsd).be.approximately(0.002, 1e-9);
  });

  it('should start this hour’s spend afresh when the stored hour is an earlier one', () => {
    // Arrange
    const lastHour = { ...TODAY, jevHour: '2026-10-16T11', jevHourUsd: 0.12 };

    // Act
    const actual = recordGuardDecision(lastHour, decision(), { kind: 'leave', confidence: 0.9 }, NOW);

    // Assert
    should(actual.jevHourUsd).be.approximately(0.002, 1e-9);
    should(jevUsdThisHour(lastHour, NOW)).equal(0);
  });

  it('should not count a failure as a decision, nor an unpriced one as spend', () => {
    // Act
    const actual = recordGuardDecision(
      TODAY,
      decision({ failure: { code: 'timeout' }, costUsd: undefined }),
      { kind: 'escalate', why: 'failed', confidence: 0 },
      NOW,
    );

    // Assert
    should(actual).deepEqual({ ...TODAY, jevHour: '2026-10-16T12', jevHourUsd: 0 });
  });
});

describe('counting flags', () => {
  it('should count a flag once, on the sweep it first appears', () => {
    // Act
    const actual = newFlagCount(
      [anomaly(), anomaly({ sessionId: 's2' })],
      [anomaly(), anomaly({ sessionId: 's2', kind: 'unattended_question' }), anomaly({ sessionId: 's3' })],
    );

    // Assert
    should(actual).equal(2);
  });
});

describe('the savings line', () => {
  it('should say what Jev saved once an investigation has been priced', () => {
    // Act
    const actual = wardenSavings(
      { ...TODAY, jevSkips: 37, jevUsd: 0.03 },
      [record({ costUsd: 0.3 }), record({ id: 'old', startedAt: '2026-10-15T08:00:00.000Z' })],
      { count: 4, totalUsd: 1.2 },
    );

    // Assert
    should(actual).match({ day: '2026-10-16', flags: 3, jevSkips: 37, investigations: 1 });
    should(actual.averageInvestigationUsd).be.approximately(0.3, 1e-9);
    should(actual.savedUsd).be.approximately(11.07, 1e-9);
  });

  it('should never invent a saving before any investigation was priced', () => {
    // Act
    const actual = wardenSavings(TODAY, [], undefined);

    // Assert
    should(actual).not.have.property('savedUsd');
    should(actual).not.have.property('averageInvestigationUsd');
  });

  it('should not report a negative saving', () => {
    // Act
    const actual = wardenSavings({ ...TODAY, jevSkips: 0, jevUsd: 0.4 }, [], { count: 1, totalUsd: 0.3 });

    // Assert
    should(actual.savedUsd).equal(0);
  });
});

describe('the snapshot Jev is shown', () => {
  it('should carry the kind, the sweep’s sentence, scalar facts and the evidence', () => {
    // Act
    const actual = triageSnapshotOf(
      anomaly({
        idleMinutes: 14,
        since: at(-14),
        affectedSessionIds: ['s1', 's2'],
        provider: 'anthropic',
      }),
      { recentTurns: ['one', 'two'], paneTail: 'screen' },
    );

    // Assert
    should(actual).deepEqual({
      anomaly: 'sus_thinking',
      summary: 'thinking for 14 minutes with no output',
      facts: {
        subject: 'Session may be stuck thinking',
        status: 'thinking',
        idleMinutes: 14,
        since: at(-14),
        affectedSessions: 2,
        provider: 'anthropic',
      },
      recentTurns: ['one', 'two'],
      paneTail: 'screen',
    });
  });

  it('should leave out what it does not know', () => {
    // Act
    const actual = triageSnapshotOf(anomaly(), { recentTurns: [] });

    // Assert
    should(actual.facts).deepEqual({ subject: 'Session may be stuck thinking', status: 'thinking' });
    should(actual).not.have.property('paneTail');
  });

  it('should pass every string through the redactor before it leaves the machine', async () => {
    // Arrange
    const snapshot = triageSnapshotOf(anomaly({ idleMinutes: 3, detail: 'token sk-1' }), {
      recentTurns: ['used sk-1'],
      paneTail: 'export KEY=sk-1',
    });
    const redactor = {
      batch: async <T>(work: (scrub: { text(text: string): string }) => T) =>
        work({ text: text => text.replaceAll('sk-1', '[redacted:KEY]') }),
    };

    // Act
    const actual = await redactTriageSnapshot(snapshot, redactor);

    // Assert
    should(JSON.stringify(actual)).not.containEql('sk-1');
    should(actual.facts.idleMinutes).equal(3);
    should(actual.paneTail).equal('export KEY=[redacted:KEY]');
  });

  it('should keep a snapshot with no screen without one', async () => {
    // Act
    const actual = await redactTriageSnapshot(triageSnapshotOf(anomaly(), { recentTurns: [] }), {
      batch: async work => work({ text: text => text }),
    });

    // Assert
    should(actual).not.have.property('paneTail');
  });

  it('should refuse to produce a snapshot it could not scrub', async () => {
    // Act
    const act = redactTriageSnapshot(triageSnapshotOf(anomaly(), { recentTurns: [] }), {
      batch: async () => {
        throw new Error('the vault is damaged');
      },
    });

    // Assert
    await should(act).be.rejectedWith('the vault is damaged');
  });
});

describe('pacing the caps through the day', () => {
  it('should stop calling Jev once a quarter of its day is spent this hour, and again next hour', () => {
    // Arrange — $0.50 a day is $0.125 an hour.
    const caps = { ...CAPS, jevUsdPerDay: 0.5 };
    const spent = { ...TODAY, jevUsd: 0.2, jevHour: '2026-10-16T12', jevHourUsd: 0.125 };

    // Act / Assert
    should(jevWithinBudget(spent, caps, NOW)).be.false();
    should(jevWithinBudget(spent, caps, NOW + 3_600_000)).be.true();
    should(jevWithinBudget({ ...spent, jevHourUsd: 0.12 }, caps, NOW)).be.true();
    should(jevWithinBudget({ ...spent, jevUsd: 0.5, jevHourUsd: 0 }, caps, NOW)).be.false();
  });

  it('should report a cap reached only for this hour as paced, back at the top of the next hour', () => {
    // Arrange — two $0.30 investigations this hour against a $2 day ($0.50 an hour).
    const caps = { ...CAPS, investigationUsdPerDay: 2, jevUsdPerDay: 0.5 };
    const records = [
      record({ id: 'a', costUsd: 0.3, startedAt: at(0) }),
      record({ id: 'b', costUsd: 0.3, startedAt: at(0) }),
    ];
    const today = { ...TODAY, jevUsd: 0.2, jevHour: '2026-10-16T12', jevHourUsd: 0.13 };

    // Act
    const actual = wardenSpend({ caps, today, records, nowMs: NOW });

    // Assert
    should(actual.capsHit).deepEqual(['jev', 'investigation']);
    should(actual.capsPaced).deepEqual(['jev', 'investigation']);
    should(actual.pacedUntil).equal('2026-10-16T13:00:00.000Z');
  });

  it('should not call a cap reached for the whole day paced', () => {
    // Arrange
    const caps = { ...CAPS, investigationUsdPerDay: 0.5 };
    const records = [record({ id: 'a', costUsd: 0.6 })];

    // Act
    const actual = wardenSpend({ caps, today: TODAY, records, nowMs: NOW });

    // Assert
    should(actual.capsHit).deepEqual(['investigation']);
    should(actual.capsPaced).be.undefined();
    should(actual.pacedUntil).be.undefined();
  });

  it('should gate an unpriced investigation this hour at the average one', () => {
    // Arrange — one unpriced investigation at a $0.60 average is past the $0.50 hour.
    const caps = { ...CAPS, investigationUsdPerDay: 2 };

    // Act
    const actual = wardenSpend({
      caps,
      today: TODAY,
      records: [record({ startedAt: at(0) })],
      average: { count: 1, totalUsd: 0.6 },
      nowMs: NOW,
    });

    // Assert
    should(actual.capsPaced).deepEqual(['investigation']);
  });

  it('should replay 2026-10-29: the burst that burnt both caps by 11:00 is held to a quarter per hour', () => {
    // Arrange — 39 Jev calls at $0.005 in the 06:00 hour, and 4 investigations at ~$0.26 in the 01:00 hour.
    const caps = { ...CAPS, jevUsdPerDay: 0.5, investigationUsdPerDay: 2 };
    const base = Date.parse('2026-10-29T06:01:37.000Z');
    let calls = 0;
    let state = triageDayFor(undefined, base);
    for (let flag = 0; flag < 39; flag += 1) {
      const nowMs = base + flag * 10_000;
      if (!jevWithinBudget(state, caps, nowMs)) continue;
      calls += 1;
      state = recordGuardDecision(
        state,
        decision({ costUsd: 0.005 }),
        { kind: 'escalate', why: 'unsure', confidence: 0.5 },
        nowMs,
      );
    }
    const investigations = [0, 1, 2, 3].map(index =>
      record({
        id: `w${index}`,
        costUsd: 0.26,
        startedAt: new Date(Date.parse('2026-10-29T01:00:56.000Z') + index * 360_000).toISOString(),
      }),
    );

    // Act
    const spend = wardenSpend({
      caps,
      today: state,
      records: investigations.slice(0, 2),
      nowMs: Date.parse('2026-10-29T01:09:30.000Z'),
    });

    // Assert — 25 calls ($0.125) this hour and the rest wait; the third investigation waits for 02:00.
    should(calls).equal(25);
    should(state.jevUsd).be.approximately(0.125, 1e-9);
    should(spend.capsPaced).deepEqual(['investigation']);
    should(spend.pacedUntil).equal('2026-10-29T02:00:00.000Z');
  });
});

describe('which flags Jev is asked about', () => {
  it('should never ask Jev about a fact of the daemon it cannot see from the turn', () => {
    // Act / Assert
    should(jevJudges({ kind: 'dead_monitor' })).be.false();
    should(jevJudges({ kind: 'owner_request' })).be.false();
    should(jevJudges({ kind: 'sus_subprocess' })).be.true();
    should(jevJudges({ kind: 'unattended_question' })).be.true();
  });
});
