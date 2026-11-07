import { describe, it } from 'bun:test';
import should from 'should';
import {
  beginSessionEffect,
  parseSessionEffectRecord,
  SESSION_EFFECT_PHASES,
  type SessionEffectKey,
  SessionEffectLedgerError,
  SessionEffectRecordSchema,
  sessionEffectStanding,
  settleSessionEffect,
} from '../../../../src/lib/session/effects/index.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * The durable effect record's own rules, with no filesystem anywhere near them.
 *
 * Every assertion here is about a decision a RETRY makes after a crash: whether an act was ever
 * attempted, whether it finished, and whether the record it is reading is even about the act it is
 * asking after. Those are exactly the questions a damaged or foreign document answers wrongly, so
 * the refusals matter as much as the acceptances.
 */

const BEGUN_AT = '2026-08-06T09:00:00.000Z';
const SETTLED_AT = '2026-08-06T09:00:04.000Z';
const SESSION = parseSessionId('20260806-target');
const OTHER_SESSION = parseSessionId('20260806-other');
const EFFECT = 'plan-fork-1:startup-runtime';
const FINGERPRINT = 'effort:high';

const key: SessionEffectKey = { sessionId: SESSION, effectId: EFFECT };

/** One document in the shape the ledger writes, with the field under test overridden. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    v: 1,
    sessionId: SESSION,
    effectId: EFFECT,
    fingerprint: FINGERPRINT,
    phase: 'begun',
    begunAt: BEGUN_AT,
    ...overrides,
  };
  for (const [field, value] of Object.entries(record)) if (value === undefined) delete record[field];
  return record;
}

function refusal(read: () => unknown): SessionEffectLedgerError {
  try {
    read();
  } catch (error) {
    if (error instanceof SessionEffectLedgerError) return error;
    throw error;
  }
  throw new Error('expected the record to be refused, but it parsed');
}

describe('SessionEffectRecordSchema', () => {
  it('should tie the settled instant to the settled phase in both directions', () => {
    // Act
    const begun = parseSessionEffectRecord(document(), key);
    const settled = parseSessionEffectRecord(document({ phase: 'settled', settledAt: SETTLED_AT }), key);
    const halfSettled = refusal(() => parseSessionEffectRecord(document({ settledAt: SETTLED_AT }), key));
    const unstamped = refusal(() => parseSessionEffectRecord(document({ phase: 'settled' }), key));

    // Assert: a record carrying one without the other cannot say whether keystrokes reached an
    // agent, which is the single question a replay is reading it to answer.
    should(begun.settledAt).equal(undefined);
    should(settled.settledAt).equal(SETTLED_AT);
    for (const refused of [halfSettled, unstamped])
      should(refused.message).match(/records when it settled exactly once it has settled, and never before/u);
  });

  it('should be exactly the two phases, in the order they may be reached', () => {
    // Assert: the array IS the ordering — `begun` precedes `settled`, and there is no third state
    // on disk, because "never attempted" is the absence of a record rather than a phase.
    should(SESSION_EFFECT_PHASES).eql(['begun', 'settled']);
    should(SessionEffectRecordSchema.safeParse(document({ phase: 'unclaimed' })).success).equal(false);
  });
});

describe('parseSessionEffectRecord', () => {
  it('should refuse a record that is unusable, or that belongs to another session or act', () => {
    // Arrange: the filename is a HASH of the effect id, so a collision, a hand-edited file or a
    // record copied between sessions is the case the key check exists for.
    const foreignSession = document({ sessionId: OTHER_SESSION });
    const foreignEffect = document({ effectId: 'plan-fork-1:turn-1' });

    // Act
    const empty = refusal(() => parseSessionEffectRecord({}, key));
    const unversioned = refusal(() => parseSessionEffectRecord(document({ v: 2 }), key));
    const extra = refusal(() => parseSessionEffectRecord(document({ note: 'hand edited' }), key));
    const blank = refusal(() => parseSessionEffectRecord(document({ fingerprint: '' }), key));
    const elsewhere = refusal(() => parseSessionEffectRecord(foreignSession, key));
    const otherAct = refusal(() => parseSessionEffectRecord(foreignEffect, key));

    // Assert: strict, so a field nobody wrote is evidence the document is not this daemon's, and
    // the version is refused rather than coerced.
    for (const refused of [empty, unversioned, extra, blank]) should(refused.message).match(/is not a usable one/u);
    // Answering one act's retry with another act's outcome would make it skip keystrokes it still
    // owed, or repeat ones it did not — so the key is re-proved from the document, not the lookup.
    should(elsewhere.message).match(/belonging to "plan-fork-1:startup-runtime" on session 20260806-other/u);
    should(otherAct.message).match(/belonging to "plan-fork-1:turn-1" on session 20260806-target/u);
    // Every refusal names the act and the session it was asked about, because a reader holding a
    // damaged ledger needs to know which effect it can no longer decide.
    should(empty.message).match(/"plan-fork-1:startup-runtime" on session 20260806-target/u);
    should(empty.key).eql(key);
  });
});

describe('sessionEffectStanding', () => {
  it('should separate a conflict from an act in flight and an act that finished', () => {
    // Arrange
    const begun = parseSessionEffectRecord(document(), key);
    const settled = parseSessionEffectRecord(document({ phase: 'settled', settledAt: SETTLED_AT }), key);

    // Act & assert: the fingerprint is authorization, so it is checked BEFORE the phase — an id
    // presented for a different act must not be answered from this act's outcome, settled or not.
    should(sessionEffectStanding(begun, FINGERPRINT)).equal('unsettled');
    should(sessionEffectStanding(settled, FINGERPRINT)).equal('settled');
    should(sessionEffectStanding(begun, 'model:gpt-5.6-terra')).equal('conflict');
    should(sessionEffectStanding(settled, 'model:gpt-5.6-terra')).equal('conflict');
  });
});

describe('beginSessionEffect', () => {
  it('should produce the whole record an attempt writes before it touches anything', () => {
    // Act
    const begun = beginSessionEffect(key, FINGERPRINT, BEGUN_AT);

    // Assert: complete, so the record on disk names the act rather than merely reserving a filename.
    should(begun).eql({
      v: 1,
      sessionId: SESSION,
      effectId: EFFECT,
      fingerprint: FINGERPRINT,
      phase: 'begun',
      begunAt: BEGUN_AT,
    });
    should(Object.hasOwn(begun, 'settledAt')).equal(false);
  });
});

describe('settleSessionEffect', () => {
  it('should keep the instant the attempt began and add the one it finished at', () => {
    // Arrange
    const begun = beginSessionEffect(key, FINGERPRINT, BEGUN_AT);

    // Act
    const settled = settleSessionEffect(begun, SETTLED_AT);

    // Assert: restamping `begunAt` would erase how long the act was in flight, which is the only
    // evidence an operator has about a crash that happened inside one.
    should(settled).eql({
      v: 1,
      sessionId: SESSION,
      effectId: EFFECT,
      fingerprint: FINGERPRINT,
      phase: 'settled',
      begunAt: BEGUN_AT,
      settledAt: SETTLED_AT,
    });
    // The source record is untouched: settling produces the next value rather than mutating one a
    // caller may still be holding.
    should(begun.phase).equal('begun');
  });
});
