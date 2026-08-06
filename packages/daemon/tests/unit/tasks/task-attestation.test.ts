import { describe, it } from 'bun:test';
import { ACTOR_AUTHORITY_SPLIT_SEMANTICS, type TaskActivity } from '@ferretry/protocol';
import should from 'should';
import { ACTOR_AUTHORITY_SPLIT_LANDED_AT, markLegacyAttestations } from '../../../src/lib/tasks/task-attestation.ts';

/** Before the documented date. */
const EARLY = '2026-08-01T09:00:00.000Z';
/** After it — the instant old code goes on writing conflated records from an un-upgraded host. */
const LATE = '2027-03-04T09:00:00.000Z';

const status = (time: string, data: Record<string, unknown>): TaskActivity =>
  ({
    v: 1,
    seq: 1,
    time,
    actor: 'peer:session-alpha',
    actorName: null,
    type: 'status',
    data: { from: 'live', to: 'done', phaseFrom: 'live', phaseTo: 'done', reason: 'shipped', ...data },
  }) as TaskActivity;

/** What this code writes: the attestation and the positive declaration of its semantics. */
const stamped = (time: string, data: Record<string, unknown>): TaskActivity =>
  status(time, { ...data, attestationSemantics: ACTOR_AUTHORITY_SPLIT_SEMANTICS });

const note = (time: string): TaskActivity =>
  ({ v: 1, seq: 1, time, actor: 'operator', actorName: null, type: 'note', data: { text: 'a note' } }) as TaskActivity;

const marker = (activity: TaskActivity): unknown => (activity.data as Record<string, unknown>).legacyAttestation;

describe('legacy completion attestations', () => {
  it.each([
    // THE HOLE A DATE CUTOFF LEFT. Old code kept running after the fix was authored, so a conflated
    // record can carry any timestamp at all. Trust follows the stamp, never the clock.
    {
      name: 'an old-code verification timestamped long AFTER the documented date',
      input: status(LATE, { verifiedByHuman: true }),
      marked: true,
    },
    {
      name: 'an old-code approval timestamped long AFTER the documented date',
      input: status(LATE, { approvedByHuman: true }),
      marked: true,
    },
    // The positive stamp is the whole of the classifier, in both directions.
    {
      name: 'a stamped human verification',
      input: stamped(LATE, { verifiedByHuman: true }),
      marked: false,
    },
    { name: 'a stamped human approval', input: stamped(LATE, { approvedByHuman: true }), marked: false },
    // A stamped record predating the documented date is still trustworthy: only code that draws the
    // distinction writes the stamp, so when it was written cannot matter.
    {
      name: 'a stamped verification predating the documented date',
      input: stamped(EARLY, { verifiedByHuman: true }),
      marked: false,
    },
    { name: 'an unstamped early verification', input: status(EARLY, { verifiedByHuman: true }), marked: true },
    { name: 'an unstamped early approval', input: status(EARLY, { approvedByHuman: true }), marked: true },
    // Nothing else is touched: no human claim, nothing to be unreliable about.
    { name: 'a move claiming no attestation', input: status(EARLY, {}), marked: false },
    {
      name: 'an unstamped top-agent completion',
      input: status(EARLY, { verifiedByTopAgent: true }),
      marked: false,
    },
    { name: 'a note of any age', input: note(EARLY), marked: false },
    // An unreadable stamp is not a reason to trust anything, and is not consulted either way.
    {
      name: 'an unreadable time with no semantics stamp',
      input: status('not-an-instant', { verifiedByHuman: true }),
      marked: true,
    },
  ])('should mark $name: $marked', ({ input, marked }) => {
    // Act
    const [actual] = markLegacyAttestations([input]);

    // Assert
    if (marked) {
      should(marker(actual as TaskActivity)).deepEqual({
        reason: 'predates-actor-authority-split',
        splitLandedAt: ACTOR_AUTHORITY_SPLIT_LANDED_AT,
      });
    } else {
      should(marker(actual as TaskActivity)).be.undefined();
    }
  });

  it('should date the marker without ever using that date to classify', () => {
    // Arrange — the same claim on both sides of the documented instant, neither one stamped.
    const before = status(EARLY, { verifiedByHuman: true });
    const after = status(LATE, { verifiedByHuman: true });

    // Act
    const actual = markLegacyAttestations([before, after]);

    // Assert — both marked, both carrying the same orientation date.
    should(actual.map(entry => (marker(entry) as { splitLandedAt: string } | undefined)?.splitLandedAt)).deepEqual([
      ACTOR_AUTHORITY_SPLIT_LANDED_AT,
      ACTOR_AUTHORITY_SPLIT_LANDED_AT,
    ]);
  });

  it('should leave every unaffected entry identical rather than rebuilt', () => {
    // Arrange
    const untouched = stamped(LATE, { verifiedByTopAgent: true });

    // Act
    const [actual] = markLegacyAttestations([untouched]);

    // Assert — the same object, so a reader can trust that nothing silently re-derived the record.
    should(actual).equal(untouched);
  });

  it('should be idempotent, because the marker is derived and never stored', () => {
    // Arrange
    const activity = [status(EARLY, { verifiedByHuman: true })];

    // Act
    const once = markLegacyAttestations(activity);
    const twice = markLegacyAttestations(once);

    // Assert
    should(twice).deepEqual(once);
  });
});
