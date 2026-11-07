import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretIndexFile } from '../../../contract/index.ts';
import { ListedSessionIndex } from '../../../daemon/adapters/storage/listed-session-index.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import { parseSessionId, type SessionId } from '../../../daemon/lib/session-id.ts';
import type { EventPointer, IndexedSession } from '../../../daemon/lib/storage-types.ts';

/**
 * The listing snapshot over the REAL index (the contract's `index.sqlite`, through the kernel test host's state):
 * whatever sequence of writes lands, the snapshot's list and lookups must be exactly what the index itself would
 * answer — same rows, same order.
 */

function memoryIndex(): StateSqliteIndex {
  return new StateSqliteIndex(new MemoryStateFolder().port([FerretIndexFile]).sqlite(FerretIndexFile));
}

const id = (n: number): SessionId => parseSessionId(`session-${String(n).padStart(3, '0')}`);

function session(n: number, overrides: Partial<IndexedSession> = {}): IndexedSession {
  return { id: id(n), status: 'running', lastSequence: 0, journalLine: 1, journal: null, ...overrides };
}

function pointer(n: number, sequence: number): EventPointer {
  return {
    sessionId: id(n),
    sequence,
    time: `2026-11-05T10:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    type: 'session.output',
    byteOffset: sequence * 10,
    byteLength: 10,
  };
}

/** A deterministic stream of numbers, so a failing sequence of writes can be replayed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('ListedSessionIndex', () => {
  it('should list and find exactly what the index holds after any sequence of writes', () => {
    // Arrange
    const reference = memoryIndex();
    const subject = new ListedSessionIndex(memoryIndex());
    const random = seeded(7);
    const sequences = new Map<number, number>();
    const stamp = (): string | undefined =>
      random() < 0.2
        ? undefined
        : `2026-11-0${String(1 + Math.floor(random() * 5))}T0${String(Math.floor(random() * 10))}:00:00.000Z`;
    subject.listSessions();

    // Act
    for (let step = 0; step < 400; step += 1) {
      const n = Math.floor(random() * 25);
      const roll = random();
      const next = (sequences.get(n) ?? 0) + 1;
      const row = session(n, { updatedAt: stamp(), createdAt: stamp(), lastSequence: next, journalLine: next + 1 });
      for (const index of [reference, subject]) {
        if (roll < 0.45) index.appendEvents(row, [pointer(n, next)]);
        else if (roll < 0.7) index.refreshSession(row);
        else if (roll < 0.85) index.replaceSession(row, [pointer(n, next)]);
        else index.removeSession(id(n));
      }
      if (roll < 0.45 || (roll >= 0.7 && roll < 0.85)) sequences.set(n, next);
      else if (roll >= 0.85) sequences.delete(n);
      if (step % 37 === 0) should(subject.listSessions()).deepEqual(reference.listSessions());
    }

    // Assert
    should(subject.listSessions()).deepEqual(reference.listSessions());
    for (let n = 0; n < 25; n += 1) should(subject.findSession(id(n))).deepEqual(reference.findSession(id(n)));
  });

  it('should hand back the same objects for sessions no write touched', () => {
    // Arrange
    const subject = new ListedSessionIndex(memoryIndex());
    subject.refreshSession(session(1, { updatedAt: '2026-11-05T01:00:00.000Z' }));
    subject.refreshSession(session(2, { updatedAt: '2026-11-05T02:00:00.000Z' }));
    const before = subject.listSessions();

    // Act
    subject.refreshSession(session(1, { updatedAt: '2026-11-05T03:00:00.000Z' }));
    const after = subject.listSessions();

    // Assert
    should(after.map(row => row.id)).deepEqual([id(1), id(2)]);
    should(after[1]).equal(before[0]);
    should(after[0]).not.equal(before[1]);
    should(subject.listSessions()).equal(after);
    should(Object.isFrozen(after)).be.true();
  });

  it('should leave the snapshot as it was when the index refuses a write', () => {
    // Arrange
    const subject = new ListedSessionIndex(memoryIndex());
    subject.appendEvents(session(1, { lastSequence: 1 }), [pointer(1, 1)]);
    const before = subject.listSessions();

    // Act
    const refused = (): void =>
      subject.appendEvents(session(1, { lastSequence: 9, status: 'stopped' }), [pointer(1, 1)]);

    // Assert
    should(refused).throw();
    should(subject.listSessions()).equal(before);
    should(subject.findSession(id(1))?.status).equal('running');
  });

  it('should pass every event read, a single appended event and its close to the index beneath', async () => {
    // Arrange
    const inner = memoryIndex();
    const subject = new ListedSessionIndex(inner);
    subject.listSessions();

    // Act
    subject.appendEvent(session(1, { lastSequence: 1 }), pointer(1, 1));
    subject.appendEvent(session(1, { lastSequence: 2 }), pointer(1, 2));

    // Assert
    should(subject.listSessions().map(row => row.lastSequence)).deepEqual([2]);
    should(subject.eventPointers(id(1), 0, 10)).deepEqual(inner.eventPointers(id(1), 0, 10));
    should(subject.fleetEventPointers(10)).deepEqual(inner.fleetEventPointers(10));
    should(subject.countEvents(id(1))).equal(2);
    await subject.close();
  });

  it('should answer a lookup from the index beneath until the first listing', () => {
    // Arrange
    const subject = new ListedSessionIndex(memoryIndex());

    // Act
    subject.refreshSession(session(4));

    // Assert
    should(subject.findSession(id(4))?.id).equal(id(4));
    should(subject.findSession(id(5))).be.undefined();
  });

  it('should reload everything after the whole index is replaced', () => {
    // Arrange
    const subject = new ListedSessionIndex(memoryIndex());
    subject.refreshSession(session(1));
    subject.listSessions();

    // Act
    subject.replaceAll({ sessions: [session(2), session(3)], events: [], problems: [] });

    // Assert
    should(subject.listSessions().map(row => row.id)).deepEqual([id(3), id(2)]);
    should(subject.findSession(id(1))).be.undefined();
  });
});
