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
  resolveStateHome,
  type NameClaim,
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

  it('should re-derive the pool from the fleet when the ledger on disk is damaged', async () => {
    // Refusing every start over an unreadable reservation file would be worse than losing the
    // reservations: the durable ownership is in the session documents either way.
    // Arrange
    const held = DEFAULT_CALLSIGN_POOL[0]!;
    const subject = await fixture([claim(held, 'session-live')]);
    await mkdir(dirname(subject.file), { recursive: true });
    await writeFile(subject.file, 'not json at all', { mode: 0o600 });

    // Act
    const claims = await subject.store.listClaims();
    const allocated = await subject.allocator.allocate({ ownerId: 'session-a', nowMs: NOW });

    // Assert
    should(claims.map(row => row.callsign)).deepEqual([held]);
    // The live session's name is still not offered, which is the fact that actually matters.
    should(allocated.ok ? allocated.claim.callsign : '').equal(DEFAULT_CALLSIGN_POOL[1]);
  });
});
