import { describe, it } from 'bun:test';
import { SessionStatusSchema } from '@ferretry/protocol';
import should from 'should';
import {
  EMPTY_WARDEN_STATE,
  jevHandoffKey,
  parseWardenRuntimeState,
  recordJevHandoff,
  recordSweepFingerprint,
  spawnSuppressionKey,
  WARDEN_ANOMALY_KINDS,
  WARDEN_JEV_HANDOFF_LIMIT,
  wardenMayStop,
  type WardenRuntimeState,
} from '../../../src/lib/warden/index.ts';

const AT = '2026-07-31T12:00:00.000Z';

const assignment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  wardenId: 'w1',
  spawnedAt: AT,
  capability: 'secret-capability',
  kinds: ['sus_thinking'],
  reportPath: '/state/warden/reports/r1.md',
  ...overrides,
});

const full = (): Record<string, unknown> => ({
  lastSweepAt: AT,
  lastSpawnAt: AT,
  lastFingerprint: 'sus_thinking:s1',
  lastSpawnFingerprint: '0:sus_thinking:s1',
  recoveryGeneration: 2,
  blessings: {
    s1: { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', blessedAt: AT, expiresAt: AT, wardenId: 'w1' },
  },
  assignments: { s1: assignment() },
  assignedCooldowns: { s2: AT },
  assignedQueue: [{ kind: 'sus_subprocess', sessionId: 's2', status: 'running', detail: 'a long subprocess' }],
  failover: {
    rrCursor: 1,
    strikes: { a: { count: 2, lastAt: AT, lastReason: 'launch failed' } },
    demotedUntil: { a: AT },
    lastSelection: { agent: 'b', policy: 'fallback', at: AT, reason: 'failover' },
    exhaustedSince: AT,
  },
});

describe('the anomaly kinds the persisted queue accepts', () => {
  it('should cover every kind the detector produces', () => {
    // Arrange / Act / Assert
    should(WARDEN_ANOMALY_KINDS).containDeep([
      'sus_thinking',
      'sus_subprocess',
      'dead_monitor',
      'provider_unavailable',
    ]);
  });
});

describe('reading the durable warden state', () => {
  it('should round-trip a complete document', () => {
    // Arrange
    const document = full();

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual).deepEqual(document as unknown as WardenRuntimeState);
  });

  it('should read an absent document as remembering nothing', () => {
    // Arrange / Act / Assert
    should(parseWardenRuntimeState(undefined)).deepEqual(EMPTY_WARDEN_STATE);
  });

  it.each([
    { label: 'a null document', value: null },
    { label: 'a string document', value: 'corrupt' },
    { label: 'a numeric document', value: 7 },
  ])('should read $label as remembering nothing rather than throwing', ({ value }) => {
    // Arrange / Act / Assert
    should(parseWardenRuntimeState(value)).deepEqual(EMPTY_WARDEN_STATE);
  });

  it('should keep the failover strikes when one blessing is corrupt', () => {
    // Arrange: dropping strikes would send the next spawn back at a broken account.
    const document = { ...full(), blessings: { s1: { sessionId: 's1' } } };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual.failover?.strikes?.a?.count).equal(2);
    should(actual.blessings).be.undefined();
  });

  it('should drop only the queued anomaly of an unknown kind', () => {
    // Arrange
    const document = {
      ...full(),
      assignedQueue: [{ kind: 'invented_kind', sessionId: 's2', status: 'running', detail: 'x' }],
    };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual.assignedQueue).be.undefined();
    should(actual.assignments?.s1?.wardenId).equal('w1');
  });

  it.each(SessionStatusSchema.options.map(status => ({ status })))(
    'should keep a queued anomaly for a session that is $status',
    ({ status }) => {
      // Arrange: the warden reads the protocol's statuses, so none of them may drop a queued anomaly.
      const document = {
        ...full(),
        assignedQueue: [{ kind: 'sus_subprocess', sessionId: 's2', status, detail: 'a long subprocess' }],
      };

      // Act
      const actual = parseWardenRuntimeState(document);

      // Assert
      should(actual.assignedQueue?.[0]?.status).equal(status);
    },
  );

  it('should drop an assignment that lost its capability, so no warden inherits authority', () => {
    // Arrange
    const document = { ...full(), assignments: { s1: assignment({ capability: undefined }) } };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual.assignments).be.undefined();
  });

  it('should ignore fields the state does not declare', () => {
    // Arrange
    const document = { ...full(), someLaterFieldWeDoNotKnow: true };

    // Act
    const actual = parseWardenRuntimeState(document);

    // Assert
    should(actual).not.have.property('someLaterFieldWeDoNotKnow');
    should(actual.lastSweepAt).equal(AT);
  });

  it('should salvage nothing from a document whose every section is corrupt', () => {
    // Arrange / Act
    const actual = parseWardenRuntimeState({ lastSweepAt: 5, recoveryGeneration: -1 });

    // Assert
    should(actual).deepEqual(EMPTY_WARDEN_STATE);
  });
});

describe('the escalation suppression key', () => {
  it('should qualify the fingerprint with the recovery generation', () => {
    // Arrange / Act / Assert
    should(spawnSuppressionKey({ recoveryGeneration: 3 }, 'sus_thinking:s1')).equal('3:sus_thinking:s1');
  });

  it('should treat a state with no generation as generation zero', () => {
    // Arrange / Act / Assert
    should(spawnSuppressionKey(EMPTY_WARDEN_STATE, 'x')).equal('0:x');
  });

  it('should make the same anomaly set after a recovery a different key', () => {
    // Arrange
    const before = { lastFingerprint: 'sus_thinking:s1' };
    const key = spawnSuppressionKey(before, 'sus_thinking:s1');

    // Act: the fleet went clean, then the same anomaly came back.
    const after = recordSweepFingerprint(before, '');

    // Assert
    should(spawnSuppressionKey(after, 'sus_thinking:s1')).not.equal(key);
  });
});

describe('recording what a sweep saw', () => {
  it('should bump the recovery generation on the anomalies-to-none edge', () => {
    // Arrange / Act
    const actual = recordSweepFingerprint({ lastFingerprint: 'a:1', recoveryGeneration: 1 }, '');

    // Assert
    should(actual).deepEqual({ lastFingerprint: '', recoveryGeneration: 2 });
  });

  it('should start the generation at one when none was recorded', () => {
    // Arrange / Act
    const actual = recordSweepFingerprint({ lastFingerprint: 'a:1' }, '');

    // Assert
    should(actual.recoveryGeneration).equal(1);
  });

  it('should not bump when the fleet stays clean', () => {
    // Arrange / Act
    const actual = recordSweepFingerprint({ lastFingerprint: '', recoveryGeneration: 1 }, '');

    // Assert
    should(actual.recoveryGeneration).equal(1);
  });

  it('should not bump when there was never a previous sweep', () => {
    // Arrange / Act
    const actual = recordSweepFingerprint(EMPTY_WARDEN_STATE, '');

    // Assert
    should(actual.recoveryGeneration).be.undefined();
  });

  it('should not bump when the fleet gains anomalies', () => {
    // Arrange / Act
    const actual = recordSweepFingerprint({ lastFingerprint: '', recoveryGeneration: 4 }, 'a:1');

    // Assert
    should(actual).deepEqual({ lastFingerprint: 'a:1', recoveryGeneration: 4 });
  });
});

describe('what a warden capability authorizes', () => {
  const state: WardenRuntimeState = parseWardenRuntimeState(full());

  it('should authorize the target its assignment names', () => {
    // Arrange / Act / Assert
    should(wardenMayStop(state, 'secret-capability', 's1')).be.true();
  });

  it('should refuse a different target', () => {
    // Arrange / Act / Assert
    should(wardenMayStop(state, 'secret-capability', 's2')).be.false();
  });

  it('should refuse the wrong secret', () => {
    // Arrange / Act / Assert
    should(wardenMayStop(state, 'guessed', 's1')).be.false();
  });

  it('should refuse every capability once the assignment is reconciled away', () => {
    // Arrange / Act / Assert
    should(wardenMayStop(EMPTY_WARDEN_STATE, 'secret-capability', 's1')).be.false();
  });

  it('should refuse an empty secret even against an assignment that somehow holds one', () => {
    // Arrange
    const blank: WardenRuntimeState = { assignments: { s1: { ...assignment(), capability: '' } as never } };

    // Act / Assert
    should(wardenMayStop(blank, '', 's1')).be.false();
  });
});

describe('why Jev handed each flag on', () => {
  const handoff = (at: string) => ({ at, status: 'thinking' as const, why: 'unsure', confidence: 0.4 });

  it('should replace the earlier hand-on of the same flag and keep the others', () => {
    // Arrange
    const store = recordJevHandoff({}, { sessionId: 's1', kind: 'sus_thinking' }, handoff('2026-10-29T10:00:00.000Z'));

    // Act
    const actual = recordJevHandoff(
      recordJevHandoff(store, { sessionId: 's2', kind: 'sus_thinking' }, handoff('2026-10-29T10:05:00.000Z')),
      { sessionId: 's1', kind: 'sus_thinking' },
      handoff('2026-10-29T11:00:00.000Z'),
    );

    // Assert
    should(Object.keys(actual)).deepEqual([jevHandoffKey('s1', 'sus_thinking'), jevHandoffKey('s2', 'sus_thinking')]);
    should(actual[jevHandoffKey('s1', 'sus_thinking')]?.at).equal('2026-10-29T11:00:00.000Z');
  });

  it('should keep only the newest, bounded', () => {
    // Arrange
    let store = {};
    for (let index = 0; index < WARDEN_JEV_HANDOFF_LIMIT + 5; index += 1)
      store = recordJevHandoff(
        store,
        { sessionId: `s${index}`, kind: 'sus_thinking' },
        handoff(new Date(Date.UTC(2026, 9, 29, 0, index)).toISOString()),
      );

    // Assert
    should(Object.keys(store)).have.length(WARDEN_JEV_HANDOFF_LIMIT);
    should(store).not.have.property(jevHandoffKey('s0', 'sus_thinking'));
    should(store).have.property(jevHandoffKey(`s${WARDEN_JEV_HANDOFF_LIMIT + 4}`, 'sus_thinking'));
  });

  it('should read them back from the state document, and drop a malformed one with its section', () => {
    // Act
    const good = parseWardenRuntimeState({ jevHandoffs: { 's1|sus_thinking': handoff('2026-10-29T10:00:00.000Z') } });
    const bad = parseWardenRuntimeState({ jevHandoffs: { 's1|sus_thinking': { why: 'unsure' } }, lastSweepAt: 'x' });

    // Assert
    should(good.jevHandoffs?.['s1|sus_thinking']?.confidence).equal(0.4);
    should(bad.jevHandoffs).be.undefined();
    should(bad.lastSweepAt).equal('x');
  });
});
