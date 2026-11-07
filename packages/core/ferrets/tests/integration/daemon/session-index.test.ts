/**
 * THE INDEX SQL, on the contract's `index.sqlite` through the kernel test host's state.
 *
 * The surviving assertions of today's `session-index-write-behind.test.ts`: the write-behind queue, the index-writer
 * thread and the file loader are gone (the kernel owns the file), and the `idempotent` write mode went with them.
 */
import { describe, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { FerretIndexFile } from '../../../contract/index.ts';
import { StateSqliteIndex } from '../../../daemon/adapters/storage/sqlite-index.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';
import type { EventPointer, IndexedSession } from '../../../daemon/lib/storage-types.ts';

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');

function session(id = A, lastSequence = 1): IndexedSession {
  return { id, status: 'running', lastSequence, journalLine: lastSequence + 1, journal: null };
}

function pointer(sequence: number, id = A, byteLength = 10): EventPointer {
  return {
    sessionId: id,
    sequence,
    time: `2026-10-29T06:00:0${String(sequence)}.000Z`,
    type: 'session.output',
    byteOffset: sequence * 10,
    byteLength,
  };
}

const pointers = (count: number, id = A): readonly EventPointer[] =>
  Array.from({ length: count }, (_, index) => pointer(index + 1, id));

/** The index and the database beneath it, so a test can count what a write changed. */
function indexFile(): { readonly index: StateSqliteIndex; readonly database: Database } {
  const folder = new MemoryStateFolder();
  const index = new StateSqliteIndex(folder.port([FerretIndexFile]).sqlite(FerretIndexFile));
  const database = folder.databases.get(FerretIndexFile.path);
  if (database === undefined) throw new Error('the index opened no database');
  return { index, database };
}

function sequencesIn(database: Database, id = A): readonly number[] {
  return database
    .query<{ sequence: number }, [string]>('SELECT sequence FROM events WHERE session_id = ? ORDER BY sequence')
    .all(id)
    .map(row => row.sequence);
}

const totalChanges = (database: Database): number =>
  database.query<{ changes: number }, []>('SELECT total_changes() AS changes').get()?.changes ?? 0;

describe('the index SQL', () => {
  it('should replace a session by difference, rewriting only the pointers that changed', () => {
    // Arrange
    const { index, database } = indexFile();
    index.replaceSession(session(A, 4), pointers(4));
    const before = totalChanges(database);

    // Act — 1 and 2 unchanged, 3 changed, 4 gone, 5 new.
    index.replaceSession(session(A, 5), [pointer(1), pointer(2), pointer(3, A, 99), pointer(5)]);
    const after = totalChanges(database);
    const third = database
      .query<{ byte_length: number }, []>(
        "SELECT byte_length FROM events WHERE session_id = 'session-a' AND sequence = 3",
      )
      .get()?.byte_length;

    // Assert — the session row, two deletions (3 and 4) and two insertions (3 and 5).
    should(sequencesIn(database)).deepEqual([1, 2, 3, 5]);
    should(third).equal(99);
    should(after - before).equal(5);
  });

  it('should refuse a repeated pointer and roll the whole write back', () => {
    // Arrange
    const { index, database } = indexFile();
    index.appendEvents(session(A, 1), [pointer(1)]);

    // Act
    const repeated = (): void => index.appendEvents({ ...session(A, 2), status: 'stopped' }, [pointer(2), pointer(1)]);

    // Assert
    should(repeated).throw();
    should(sequencesIn(database)).deepEqual([1]);
    should(index.findSession(A)?.status).equal('running');
  });

  it('should write a pointer another session owns as it is given', () => {
    // Arrange
    const { index, database } = indexFile();
    index.refreshSession(session(B, 1));

    // Act
    index.replaceSession(session(A, 1), [pointer(1), pointer(1, B)]);

    // Assert
    should(sequencesIn(database, A)).deepEqual([1]);
    should(sequencesIn(database, B)).deepEqual([1]);
  });

  it('should take a removed session pointers with it', () => {
    // Arrange
    const { index, database } = indexFile();
    index.appendEvents(session(A, 2), pointers(2));

    // Act
    index.removeSession(A);

    // Assert
    should(index.findSession(A)).be.undefined();
    should(sequencesIn(database)).deepEqual([]);
    should(index.countEvents(A)).equal(0);
  });
});
