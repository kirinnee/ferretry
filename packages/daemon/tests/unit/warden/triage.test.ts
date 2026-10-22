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
  guardOutcome,
  investigationsInLastHour,
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
  verdict: 'skip',
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

describe('what the guard’s answer means', () => {
  it('should believe a skip at or above the threshold', () => {
    // Act / Assert
    should(guardOutcome(decision({ confidence: 0.85 }), 0.85)).deepEqual({ kind: 'skip', confidence: 0.85 });
  });

  it('should count a skip below the threshold as investigate: unsure fails toward looking', () => {
    // Act / Assert
    should(guardOutcome(decision({ confidence: 0.84 }), 0.85)).deepEqual({ kind: 'investigate', confidence: 0.84 });
  });

  it('should investigate whatever it answers investigate', () => {
    // Act / Assert
    should(guardOutcome(decision({ verdict: 'investigate', confidence: 0.99 }), 0.7)).deepEqual({
      kind: 'investigate',
      confidence: 0.99,
    });
  });

  it('should investigate on any failure, naming it', () => {
    // Act
    const actual = guardOutcome(decision({ verdict: 'investigate', confidence: 0, failure: { code: 'timeout' } }), 0.7);

    // Assert
    should(actual).deepEqual({ kind: 'investigate', confidence: 0, failure: 'timeout' });
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
    const actual = recordGuardDecision(TODAY, decision(), { kind: 'skip', confidence: 0.9 });

    // Assert
    should(actual).match({ day: TODAY.day, flags: 3, jevDecisions: 3, jevSkips: 2 });
    should(actual.jevUsd).be.approximately(0.102, 1e-9);
  });

  it('should not count a failure as a decision, nor an unpriced one as spend', () => {
    // Act
    const actual = recordGuardDecision(TODAY, decision({ failure: { code: 'timeout' }, costUsd: undefined }), {
      kind: 'investigate',
      confidence: 0,
    });

    // Assert
    should(actual).deepEqual(TODAY);
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
