import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileNameClaimStore } from '../../../src/adapters/names/index.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import {
  CALLSIGN_WINDOW_MS,
  createFoundationPaths,
  DEFAULT_CALLSIGN_POOL,
  NameAllocator,
  type NameClaim,
  resolveStateHome,
} from '../../../src/lib/index.ts';

/**
 * The callsign ledger, over a real state home and the REAL allocator above it.
 *
 * The allocation policy, the window arithmetic and the pool order are production code — only the fleet
 * the store reads is the test's — so a case that passes here asserts what a start would actually
 * claim.
 */

const NOW = 1_780_000_000_000;

const homes = new Set<string>();

async function fixture(live: readonly NameClaim[] = []): Promise<{
  readonly file: string;
  readonly store: FileNameClaimStore;
  readonly allocator: NameAllocator;
}> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-callsigns-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const file = join(paths.state, 'callsigns.json');
  const store = new FileNameClaimStore(file, new StateFileSystem(paths), new KeyedSerialExecutor(), async () => live);
  // A fixed start index, so a case can assert exactly which callsign the pool hands over. Production
  // rotates it; the ORDER it walks from there is the same either way.
  return { file, store, allocator: new NameAllocator(store, { nextIndex: () => 0 }) };
}

function claim(callsign: string, ownerId: string, claimedAtMs = NOW): NameClaim {
  return { callsign, ownerId, claimedAtMs, expiresAtMs: claimedAtMs + CALLSIGN_WINDOW_MS };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('FileNameClaimStore', () => {
  it('should let exactly one of two concurrent starts claim the same callsign', async () => {
    // This is the whole reason the ledger exists: without it both starts see the name free, both take
    // it, and a bare callsign then resolves to two sessions.
    // Arrange
    const subject = await fixture();
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
    should(refused?.ok).be.false();
    should(refused !== undefined && !refused.ok ? refused.error.code : '').equal('callsign_taken');
    // One reservation on disk, not two.
    should(JSON.parse(await readFile(subject.file, 'utf8')) as NameClaim[]).have.length(1);
  });

  it('should fall back to a free pool name for a caller who allows one', async () => {
    // Arrange
    const taken = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = await fixture([claim(taken, 'session-live')]);

    // Act
    const refused = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: taken });
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-b',
      nowMs: NOW,
      requested: taken,
      fallback: true,
    });

    // Assert
    // A live session holds the name, so the name is not free even though the ledger has never seen it.
    should(refused.ok).be.false();
    should(allocated.ok).be.true();
    should(allocated.ok ? allocated.source : '').equal('fallback');
    should(allocated.ok ? allocated.claim.callsign : '').equal(DEFAULT_CALLSIGN_POOL[1]);
  });

  it('should offer a callsign again once its claim has aged out of the window', async () => {
    // Arrange
    const wanted = DEFAULT_CALLSIGN_POOL[0]!;
    const expired = NOW - CALLSIGN_WINDOW_MS - 1;
    const subject = await fixture([claim(wanted, 'session-old', expired)]);

    // Act
    const allocated = await subject.allocator.allocate({ ownerId: 'session-new', nowMs: NOW, requested: wanted });

    // Assert
    should(allocated.ok).be.true();
    should(allocated.ok ? allocated.claim.callsign : '').equal(wanted);
  });

  it('should let one owner re-claim the name it already holds', async () => {
    // A retried start of the same session must not be refused its own callsign.
    // Arrange
    const subject = await fixture();
    const wanted = DEFAULT_CALLSIGN_POOL[3]!;

    // Act
    const first = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: wanted });
    const again = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: wanted });

    // Assert
    should([first.ok, again.ok]).deepEqual([true, true]);
    should(JSON.parse(await readFile(subject.file, 'utf8')) as NameClaim[]).have.length(1);
  });

  it('should free a reservation a start released and hold every other one', async () => {
    // Arrange
    const subject = await fixture();
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
    // A release that names a callsign nobody holds is not an error; there is simply nothing to remove.
    await subject.store.release('nobody-holds-this', 'session-z');
  });

  it('should refuse a claim and preserve the evidence when the ledger JSON is damaged', async () => {
    // A live session can be re-derived, but an in-flight reservation exists only in this file. If a
    // damaged file read as empty, a second start could claim the first start's callsign.
    // Arrange
    const held = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = await fixture([claim(held, 'session-live')]);
    await mkdir(dirname(subject.file), { recursive: true });
    const damaged = 'not json at all';
    await writeFile(subject.file, damaged, { mode: 0o600 });

    // Act
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-a',
      nowMs: NOW,
      requested: DEFAULT_CALLSIGN_POOL[1],
    });

    // Assert
    should(allocated.ok).be.false();
    const failure = allocated.ok ? null : allocated.error;
    should(failure?.code).equal('claim_store_failed');
    // The allocator's public message is fixed and path-free; the absolute ledger path never reaches it.
    should(failure?.message).equal('callsign persistence failed');
    should(failure?.message).not.containEql(subject.file);
    // The adapter still carries the diagnostic internally — only the allocator's public message is scrubbed.
    await should(subject.store.listClaims()).be.rejectedWith(/invalid callsign claim ledger/u);
    should(await readFile(subject.file, 'utf8')).equal(damaged);
  });

  it('should refuse the whole ledger rather than drop one malformed reservation', async () => {
    // Arrange — the valid first row represents a start whose session document does not exist yet.
    const subject = await fixture();
    const pending = claim(DEFAULT_CALLSIGN_POOL[0]!, 'session-pending');
    const damaged = JSON.stringify([
      pending,
      { callsign: 'NOT-CANONICAL', ownerId: 'session-damaged', claimedAtMs: NOW, expiresAtMs: NOW + 1 },
    ]);
    await mkdir(dirname(subject.file), { recursive: true });
    await writeFile(subject.file, damaged, { mode: 0o600 });

    // Act
    const allocated = await subject.allocator.allocate({
      ownerId: 'session-racing',
      nowMs: NOW,
      requested: pending.callsign,
    });

    // Assert — a partial decode must not make the valid in-flight reservation disappear.
    should(allocated.ok).be.false();
    should(allocated.ok ? '' : allocated.error.code).equal('claim_store_failed');
    should(await readFile(subject.file, 'utf8')).equal(damaged);
  });

  it('should refuse a claim its own decoder would reject and leave the ledger untouched', async () => {
    // tryClaim must not persist a caller-supplied NameClaim the store could not read back. The type
    // system still admits claims the schema rejects — a non-canonical callsign, an empty owner id,
    // an expiry at or before its creation — and writing one would poison every later read, so writes
    // are guarded by the same decoder that guards reads.
    // Arrange — a valid reservation already on disk, captured byte-for-byte.
    const subject = await fixture();
    // Three pool entries, guarded once so the case needs no non-null assertion: the seeded name plus
    // two free ones the malformed claims target.
    const [held, freeOne, freeTwo] = DEFAULT_CALLSIGN_POOL;
    if (held === undefined || freeOne === undefined || freeTwo === undefined)
      throw new Error('DEFAULT_CALLSIGN_POOL must expose at least three entries');
    const seeded = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW, requested: held });
    should(seeded.ok).be.true();
    const before = await readFile(subject.file, 'utf8');

    // Act + Assert — each malformed claim is refused before any write, and the valid ledger never moves.
    const malformed: readonly NameClaim[] = [
      // A free name whose expiry is at its creation: with no conflict this is exactly the row that,
      // unguarded, would land on disk and throw on the next read.
      { callsign: freeOne, ownerId: 'session-b', claimedAtMs: NOW, expiresAtMs: NOW },
      // A non-canonical callsign the decoder rejects.
      { callsign: 'NOT-CANONICAL', ownerId: 'session-b', claimedAtMs: NOW, expiresAtMs: NOW + CALLSIGN_WINDOW_MS },
      // An empty owner id, which the schema forbids.
      { callsign: freeTwo, ownerId: '', claimedAtMs: NOW, expiresAtMs: NOW + CALLSIGN_WINDOW_MS },
    ];
    for (const bad of malformed) {
      await should(subject.store.tryClaim(bad)).be.rejectedWith(/invalid callsign claim/u);
      should(await readFile(subject.file, 'utf8')).equal(before);
    }

    // The store still reads back, and none of the bad claims reached the ledger.
    const listed = await subject.store.listClaims();
    should(listed.some(row => row.ownerId === 'session-b')).be.false();
  });
});
