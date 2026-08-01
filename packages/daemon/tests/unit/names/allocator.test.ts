import { describe, it } from 'bun:test';
import should from 'should';
import {
  NameAllocator,
  type NameClaim,
  type NameClaimAttempt,
  type NameClaimStore,
  type NameRandomSource,
} from '../../../src/lib/names/index.ts';

class MemoryClaimStore implements NameClaimStore {
  readonly claims: NameClaim[];
  failure: unknown;

  constructor(claims: readonly NameClaim[] = []) {
    this.claims = [...claims];
  }

  async listClaims(): Promise<readonly NameClaim[]> {
    if (this.failure !== undefined) throw this.failure;
    return [...this.claims];
  }

  async tryClaim(claim: NameClaim): Promise<NameClaimAttempt> {
    if (this.failure !== undefined) throw this.failure;
    const conflict = this.claims.find(
      current => current.callsign === claim.callsign && current.expiresAtMs > claim.claimedAtMs,
    );
    if (conflict !== undefined) return { claimed: false, conflict };
    this.claims.push(claim);
    return { claimed: true, claim };
  }

  async release(callsign: string, ownerId: string): Promise<void> {
    const index = this.claims.findIndex(claim => claim.callsign === callsign && claim.ownerId === ownerId);
    if (index >= 0) this.claims.splice(index, 1);
  }
}

const firstIndex: NameRandomSource = { nextIndex: () => 0 };

describe('NameAllocator', () => {
  it('should atomically claim a normalized requested callsign without consulting randomness', async () => {
    // Arrange
    const store = new MemoryClaimStore();
    const random: NameRandomSource = { nextIndex: () => 99 };
    const subject = new NameAllocator(store, random, ['ada']);

    // Act
    const actual = await subject.allocate({ ownerId: 'session-1', nowMs: 1_000, requested: ' Ada ', windowMs: 50 });

    // Assert
    should(actual).deepEqual({
      ok: true,
      source: 'requested',
      claim: { callsign: 'ada', ownerId: 'session-1', claimedAtMs: 1_000, expiresAtMs: 1_050 },
    });
  });

  it('should return an explicit validation error for an invalid requested callsign', async () => {
    // Arrange
    const subject = new NameAllocator(new MemoryClaimStore(), firstIndex, ['ada']);

    // Act
    const actual = await subject.allocate({ ownerId: 'session-1', nowMs: 0, requested: 'not valid' });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) should(actual.error.code).equal('invalid_callsign');
  });

  it('should report the conflicting durable claim when fallback is disabled', async () => {
    // Arrange
    const conflict = { callsign: 'ada', ownerId: 'existing', claimedAtMs: 0, expiresAtMs: 100 };
    const subject = new NameAllocator(new MemoryClaimStore([conflict]), firstIndex, ['ada', 'bert']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 50, requested: 'ada' });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) {
      should(actual.error.code).equal('callsign_taken');
      should(actual.error.conflict).deepEqual(conflict);
    }
  });

  it('should atomically fall back after a requested-name collision', async () => {
    // Arrange
    const conflict = { callsign: 'ada', ownerId: 'existing', claimedAtMs: 0, expiresAtMs: 100 };
    const subject = new NameAllocator(new MemoryClaimStore([conflict]), firstIndex, ['ada', 'bert']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 50, requested: 'ada', fallback: true });

    // Assert
    should(actual.ok).be.true();
    if (actual.ok) {
      should(actual.source).equal('fallback');
      should(actual.claim.callsign).equal('bert');
    }
  });

  it('should give concurrent automatic allocations distinct callsigns after an atomic race', async () => {
    // Arrange
    const store = new MemoryClaimStore();
    const subject = new NameAllocator(store, firstIndex, ['ada', 'bert']);

    // Act
    const actual = await Promise.all([
      subject.allocate({ ownerId: 'one', nowMs: 10 }),
      subject.allocate({ ownerId: 'two', nowMs: 10 }),
    ]);

    // Assert
    should(actual.every(result => result.ok)).be.true();
    const callsigns = actual.flatMap(result => (result.ok ? [result.claim.callsign] : []));
    should(new Set(callsigns).size).equal(2);
  });

  it('should reuse an expired claim and enforce a positive claim window', async () => {
    // Arrange
    const expired = { callsign: 'ada', ownerId: 'old', claimedAtMs: 0, expiresAtMs: 10 };
    const subject = new NameAllocator(new MemoryClaimStore([expired]), firstIndex, ['ada']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 10, windowMs: 0 });

    // Assert
    should(actual.ok).be.true();
    if (actual.ok) should(actual.claim.expiresAtMs).equal(11);
  });

  it('should refuse to reuse an active name when the pool is exhausted', async () => {
    // Arrange
    const active = { callsign: 'ada', ownerId: 'old', claimedAtMs: 0, expiresAtMs: 100 };
    const subject = new NameAllocator(new MemoryClaimStore([active]), firstIndex, ['ada']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 50 });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) should(actual.error.code).equal('pool_exhausted');
  });

  it('should reject an empty configured pool', async () => {
    // Arrange
    const subject = new NameAllocator(new MemoryClaimStore(), firstIndex, []);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 0 });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) should(actual.error.message).equal('no callsigns are configured');
  });

  it.each([
    { random: { nextIndex: () => -1 }, message: 'invalid index' },
    { random: { nextIndex: () => 2 }, message: 'invalid upper bound' },
  ])('should reject a random source with an $message', async ({ random }) => {
    // Arrange
    const subject = new NameAllocator(new MemoryClaimStore(), random, ['ada', 'bert']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 0 });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) should(actual.error.code).equal('random_source_failed');
  });

  it('should map a throwing random source to an explicit failure', async () => {
    // Arrange
    const random: NameRandomSource = {
      nextIndex: () => {
        throw new Error('entropy unavailable');
      },
    };
    const subject = new NameAllocator(new MemoryClaimStore(), random, ['ada']);

    // Act
    const actual = await subject.allocate({ ownerId: 'new', nowMs: 0 });

    // Assert
    should(actual.ok).be.false();
    if (!actual.ok) should(actual.error.message).containEql('entropy unavailable');
  });

  it('should answer a fixed, path-free message for store failures from reads and claims', async () => {
    // The adapter's own error carries the ledger path and decode detail; the allocator is the boundary
    // that scrubs it, so neither reaches the public result a route would write into a response body.
    // Arrange — store failures whose messages carry the kind of detail the API must not leak.
    const readStore = new MemoryClaimStore();
    readStore.failure = new Error(
      'invalid callsign claim ledger /home/operator/.fy/state/callsigns.json: malformed JSON',
    );
    const claimStore = new MemoryClaimStore();
    claimStore.failure = new Error('invalid callsign claim for /home/operator/.fy/state/callsigns.json: bad row');

    // Act
    const readActual = await new NameAllocator(readStore, firstIndex, ['ada']).allocate({ ownerId: 'one', nowMs: 0 });
    const claimActual = await new NameAllocator(claimStore, firstIndex, ['ada']).allocate({
      ownerId: 'two',
      nowMs: 0,
      requested: 'ada',
    });

    // Assert — both are store failures with the SAME fixed, path-free message; the verbatim diagnostic
    // (and the absolute path it carried) never enters the public message.
    should(readActual.ok).be.false();
    should(claimActual.ok).be.false();
    if (!readActual.ok) {
      should(readActual.error.code).equal('claim_store_failed');
      should(readActual.error.message).equal('callsign persistence failed');
      should(readActual.error.message).not.containEql('/home/operator');
      should(readActual.error.message).not.containEql('malformed JSON');
    }
    if (!claimActual.ok) {
      should(claimActual.error.code).equal('claim_store_failed');
      should(claimActual.error.message).equal('callsign persistence failed');
      should(claimActual.error.message).not.containEql('/home/operator');
    }
  });

  it('should allocate from the default pool when no pool is injected', async () => {
    // Arrange
    const subject = new NameAllocator(new MemoryClaimStore(), firstIndex);

    // Act
    const actual = await subject.allocate({ ownerId: 'default', nowMs: 0 });

    // Assert
    should(actual.ok).be.true();
  });
});
