/**
 * THE SESSION INDEX'S SQL, SHARED BY THE COPY IN MEMORY AND THE THREAD THAT WRITES THE FILE.
 *
 * Both run exactly these statements, so the file on disk holds what the reads were answered from. This
 * module imports nothing at run time but `bun:sqlite`: the index-writer thread loads it, and a worker that
 * dragged the domain barrel (and zod with it) in would cost several times its own size in memory.
 *
 * Two modes, because the two copies are asked different questions. The copy in memory is the index's
 * truth and keeps every refusal the index always had — a pointer that already exists is a conflict, and
 * the whole write rolls back. The file is written behind it, by batches a replaced thread may already
 * have committed, so there a write that already landed must land again as a no-op.
 */
import type { Database } from 'bun:sqlite';
import type { IndexWrite } from '../../lib/index-writes.ts';
import type { EventPointer, IndexedSession } from '../../lib/storage-types.ts';

/** `strict` refuses a pointer that is already stored; `idempotent` overwrites it with the same one. */
export type IndexWriteMode = 'strict' | 'idempotent';

export const SESSION_COLUMNS = `id, status, created_at, updated_at, last_sequence, journal_line,
  journal_device, journal_inode, journal_size, journal_mtime_ms`;

interface StoredPointer {
  readonly sequence: number;
  readonly time: string;
  readonly type: string;
  readonly byte_offset: number;
  readonly byte_length: number;
}

function upsertSession(database: Database, session: IndexedSession): void {
  database
    .query(
      `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         last_sequence = excluded.last_sequence,
         journal_line = excluded.journal_line,
         journal_device = excluded.journal_device,
         journal_inode = excluded.journal_inode,
         journal_size = excluded.journal_size,
         journal_mtime_ms = excluded.journal_mtime_ms`,
    )
    .run(
      session.id,
      session.status ?? null,
      session.createdAt ?? null,
      session.updatedAt ?? null,
      session.lastSequence,
      session.journalLine,
      session.journal?.device ?? null,
      session.journal?.inode ?? null,
      session.journal?.size ?? null,
      session.journal?.modifiedAtMs ?? null,
    );
}

function insertEvent(database: Database, event: EventPointer, mode: IndexWriteMode): void {
  database
    .query(
      `INSERT ${mode === 'idempotent' ? 'OR REPLACE ' : ''}INTO events
         (session_id, sequence, time, type, byte_offset, byte_length)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(event.sessionId, event.sequence, event.time, event.type, event.byteOffset, event.byteLength);
}

function samePointer(stored: StoredPointer, event: EventPointer): boolean {
  return (
    stored.time === event.time &&
    stored.type === event.type &&
    stored.byte_offset === event.byteOffset &&
    stored.byte_length === event.byteLength
  );
}

/**
 * The session's row and exactly `events`, by DIFFERENCE: only the pointers that changed are deleted and
 * written.
 *
 * A rescan replaces a session whose journal grew by one line, and deleting and re-inserting all of its
 * hundreds of pointers each time was most of what the index wrote — every byte of it later checkpointed
 * and `fsync`ed. What is left afterwards is what the delete-and-insert left.
 */
export function replaceSessionRows(
  database: Database,
  session: IndexedSession,
  events: readonly EventPointer[],
  mode: IndexWriteMode,
): void {
  const stored = database
    .query<
      StoredPointer,
      [string]
    >('SELECT sequence, time, type, byte_offset, byte_length FROM events WHERE session_id = ?')
    .all(session.id);
  const kept = new Map(stored.map(pointer => [pointer.sequence, pointer]));
  const unchanged = new Set<number>();
  for (const event of events) {
    const pointer = event.sessionId === session.id ? kept.get(event.sequence) : undefined;
    if (pointer !== undefined && samePointer(pointer, event)) unchanged.add(event.sequence);
  }
  upsertSession(database, session);
  const remove = database.query('DELETE FROM events WHERE session_id = ? AND sequence = ?');
  for (const pointer of stored) if (!unchanged.has(pointer.sequence)) remove.run(session.id, pointer.sequence);
  for (const event of events) {
    if (event.sessionId === session.id && unchanged.delete(event.sequence)) continue;
    insertEvent(database, event, mode);
  }
}

/** One write, outside any transaction: the caller decides how many writes one commit carries. */
export function applyIndexWrite(database: Database, write: IndexWrite, mode: IndexWriteMode): void {
  switch (write.kind) {
    case 'replace-all':
      database.exec('DELETE FROM events');
      database.exec('DELETE FROM sessions');
      for (const session of write.sessions) upsertSession(database, session);
      for (const event of write.events) insertEvent(database, event, mode);
      return;
    case 'replace-session':
      replaceSessionRows(database, write.session, write.events, mode);
      return;
    case 'refresh-session':
      upsertSession(database, write.session);
      return;
    case 'append-events':
      upsertSession(database, write.session);
      for (const event of write.events) insertEvent(database, event, mode);
      return;
    case 'remove-session':
      database.query('DELETE FROM sessions WHERE id = ?').run(write.id);
      return;
  }
}

/** A batch from the queue, as one transaction on the file: every write in it lands, or none does. */
export function applyIndexWrites(database: Database, writes: readonly IndexWrite[]): void {
  database.transaction(() => {
    for (const write of writes) applyIndexWrite(database, write, 'idempotent');
  })();
}

/**
 * The settings each connection to the index holds for itself (journal mode is the file's own).
 *
 * `synchronous = NORMAL` is safe because the index is disposable: every journal is `fsync`ed before its
 * pointer is written, and a boot reconciles an index that is behind its journals. `foreign_keys` makes a
 * removed session take its pointers with it.
 */
export function configureIndexConnection(database: Database): void {
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
}
