import { describe, it } from 'bun:test';
import should from 'should';
import { LedgerNameClaimStore, stateClaimLedger } from '../../../../daemon/adapters/names/name-claim-store.ts';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { NamesDocumentSchema } from '../../../../contract/state.ts';
import {
  CALLSIGN_WINDOW_MS,
  DEFAULT_CALLSIGN_POOL,
  NameAllocator,
  type NameClaim,
} from '../../../../daemon/lib/names/index.ts';

/**
 * The callsign ledger over `names.json` and the REAL allocator above it (F-0232). The allocation policy, the window
 * arithmetic and the pool order are production code; only the state port (decoding a stored document as the kernel
 * does, with the file's own schema) and the live fleet are the test's.
 */

const NOW = 1_780_000_000_000;

function fixture(live: readonly NameClaim[] = [], stored?: unknown) {
  const disk = { raw: stored as unknown, writes: 0 };
  const state = {
    read: async () => {
      if (disk.raw === undefined) return { ok: true, value: undefined };
      const parsed = NamesDocumentSchema.safeParse(disk.raw);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: { file: 'names.json', reason: 'schema', sentence: 'names.json is damaged' } };
    },
    write: async (_file: unknown, value: unknown) => {
      disk.writes += 1;
      disk.raw = value;
    },
  } as never;
  const store = new LedgerNameClaimStore(stateClaimLedger(state), new KeyedSerialExecutor(), async () => live);
  // A fixed start index, so a case can assert exactly which callsign the pool hands over.
  return { disk, store, allocator: new NameAllocator(store, { nextIndex: () => 0 }) };
}

const claims = (disk: { raw: unknown }) => (disk.raw as { claims: NameClaim[] }).claims;

function claim(callsign: string, ownerId: string, claimedAtMs = NOW): NameClaim {
  return { callsign, ownerId, claimedAtMs, expiresAtMs: claimedAtMs + CALLSIGN_WINDOW_MS };
}

describe('LedgerNameClaimStore (F-0232)', () => {
  it('should let exactly one of two concurrent starts claim the same callsign', async () => {
    // Arrange
    const subject = fixture();
    const wanted = DEFAULT_CALLSIGN_POOL[0]!;

    // Act
    const [first, second] = await Promise.all([
      subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: wanted }),
      subject.allocator.allocate({ ownerId: 'session-b', nowMs: NOW, requested: wanted }),
    ]);

    // Assert
    const outcomes = [first, second];
    should(outcomes.filter(result => result.ok && result.claim.callsign === wanted)).have.length(1);
    const refused = outcomes.find(result => !result.ok);
    should(refused !== undefined && !refused.ok ? refused.error.code : '').equal('callsign_taken');
    should(claims(subject.disk)).have.length(1);
  });

  it('should fall back to a free pool name for a caller who allows one', async () => {
    // Arrange
    const taken = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = fixture([claim(taken, 'ferret-live')]);

    // Act
    const refused = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: taken });
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-b',
      nowMs: NOW,
      requested: taken,
      fallback: true,
    });

    // Assert
    should(refused.ok).be.false();
    should(allocated.ok ? allocated.source : '').equal('fallback');
    should(allocated.ok ? allocated.claim.callsign : '').equal(DEFAULT_CALLSIGN_POOL[1]);
  });

  it('should offer a callsign again once its claim has aged out of the window', async () => {
    // Arrange
    const wanted = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = fixture([claim(wanted, 'ferret-old', NOW - CALLSIGN_WINDOW_MS - 1)]);

    // Act
    const allocated = await subject.allocator.allocate({ ownerId: 'session-new', nowMs: NOW, requested: wanted });

    // Assert
    should(allocated.ok ? allocated.claim.callsign : '').equal(wanted);
  });

  it('should let one owner re-claim the name it already holds', async () => {
    // Arrange
    const subject = fixture();
    const wanted = DEFAULT_CALLSIGN_POOL[3]!;

    // Act
    const first = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: wanted });
    const again = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: wanted });

    // Assert
    should([first.ok, again.ok]).deepEqual([true, true]);
    should(claims(subject.disk)).have.length(1);
  });

  it('should free a reservation a start released and hold every other one', async () => {
    // Arrange
    const subject = fixture();
    const mine = DEFAULT_CALLSIGN_POOL[0]!;
    const theirs = DEFAULT_CALLSIGN_POOL[1]!;
    await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: mine });
    await subject.allocator.allocate({ ownerId: 'session-b', nowMs: NOW, requested: theirs });

    // Act
    await subject.store.release(mine, 'session-a');
    const reclaimed = await subject.allocator.allocate({ ownerId: 'session-c', nowMs: NOW, requested: mine });
    const stillHeld = await subject.allocator.allocate({ ownerId: 'session-d', nowMs: NOW, requested: theirs });

    // Assert
    should(reclaimed.ok).be.true();
    should(stillHeld.ok).be.false();
    await subject.store.release('nobody-holds-this', 'session-z');
  });

  it('should refuse a claim and preserve the evidence when the ledger is damaged', async () => {
    // Arrange: a damaged ledger must not read as empty, or a second start could claim an in-flight callsign.
    const held = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = fixture([claim(held, 'ferret-live')], 'not a ledger');

    // Act
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-a',
      nowMs: NOW,
      requested: DEFAULT_CALLSIGN_POOL[1],
    });

    // Assert
    const failure = allocated.ok ? null : allocated.error;
    should(failure?.code).equal('claim_store_failed');
    should(failure?.message).equal('callsign persistence failed');
    await should(subject.store.listClaims()).be.rejectedWith(/invalid callsign claim ledger/u);
    should(subject.disk.raw).equal('not a ledger');
    should(subject.disk.writes).equal(0);
  });

  it('should refuse the whole ledger rather than drop one malformed reservation', async () => {
    // Arrange
    const pending = claim(DEFAULT_CALLSIGN_POOL[0]!, 'session-pending');
    const damaged = {
      claims: [
        pending,
        { callsign: 'NOT-CANONICAL', ownerId: 'session-damaged', claimedAtMs: NOW, expiresAtMs: NOW + 1 },
      ],
    };
    const subject = fixture([], damaged);

    // Act
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-racing',
      nowMs: NOW,
      requested: pending.callsign,
    });

    // Assert
    should(allocated.ok ? '' : allocated.error.code).equal('claim_store_failed');
    should(subject.disk.raw).equal(damaged);
  });

  it('should refuse a ledger row carrying an unknown field and leave the file unchanged', async () => {
    // Arrange: strip mode would drop the field and rewrite the row on the next claim, hiding the tampering.
    const [pending, free] = DEFAULT_CALLSIGN_POOL;
    const withExtra = { claims: [{ ...claim(pending!, 'session-pending'), unexpected: 'strip mode would drop me' }] };
    const subject = fixture([], withExtra);

    // Act
    const allocated = await subject.allocator.allocate({ ownerId: 'session-racing', nowMs: NOW, requested: free });

    // Assert
    should(allocated.ok ? '' : allocated.error.code).equal('claim_store_failed');
    should(subject.disk.raw).equal(withExtra);
    should(subject.disk.writes).equal(0);
  });

  it('should refuse a claim its own decoder would reject and leave the ledger untouched', async () => {
    // Arrange
    const [held, freeOne, freeTwo] = DEFAULT_CALLSIGN_POOL;
    const subject = fixture();
    await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: held });
    const before = structuredClone(subject.disk.raw);

    // Act + Assert
    const malformed: readonly NameClaim[] = [
      { callsign: freeOne!, ownerId: 'session-b', claimedAtMs: NOW, expiresAtMs: NOW },
      { callsign: 'NOT-CANONICAL', ownerId: 'session-b', claimedAtMs: NOW, expiresAtMs: NOW + CALLSIGN_WINDOW_MS },
      { callsign: freeTwo!, ownerId: '', claimedAtMs: NOW, expiresAtMs: NOW + CALLSIGN_WINDOW_MS },
    ];
    for (const bad of malformed) {
      await should(subject.store.tryClaim(bad)).be.rejectedWith(/invalid callsign claim/u);
      should(subject.disk.raw).deepEqual(before);
    }
    should((await subject.store.listClaims()).some(row => row.ownerId === 'session-b')).be.false();
  });
});
