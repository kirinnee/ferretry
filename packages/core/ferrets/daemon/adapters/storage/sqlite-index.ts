import type { SqliteHandle } from '@ferretry/kernel/contract';
import type { IndexWrite } from '../../lib/index-writes.ts';
import type { SessionIndex } from '../../lib/ports.ts';
import { parseSessionId, type SessionId } from '../../lib/session-id.ts';
import type { EventPointer, IndexedSession, JournalFingerprint, RebuildPlan } from '../../lib/storage-types.ts';

/**
 * THE SESSION INDEX, ON THE CONTRACT'S `FerretIndexFile` (`index.sqlite`, a `sqlite-cache`).
 *
 * Today's `sqlite-index.ts`, `sqlite-index-statements.ts` and the table half of `sqlite-index-schema.ts`, over the
 * kernel's SQLite handle. What went: the in-memory copy, the write-behind queue and the index-writer thread (the
 * kernel owns the file and its transactions), the schema-version check and the move-or-drop decision (a
 * `sqlite-cache` is dropped and rebuilt by the kernel on a format mismatch), and the preflight of the file's
 * sidecars (the kernel confines its own files). The SQL and the strict-write rule are today's.
 */

const SESSION_COLUMNS = `id, status, created_at, updated_at, last_sequence, journal_line,
  journal_device, journal_inode, journal_size, journal_mtime_ms`;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      journal_line INTEGER NOT NULL CHECK (journal_line >= 1),
      journal_device TEXT,
      journal_inode TEXT,
      journal_size INTEGER CHECK (journal_size IS NULL OR journal_size >= 0),
      journal_mtime_ms INTEGER,
      CHECK ((journal_device IS NULL AND journal_inode IS NULL AND journal_size IS NULL AND journal_mtime_ms IS NULL)
          OR (journal_device IS NOT NULL AND journal_inode IS NOT NULL AND journal_size IS NOT NULL AND journal_mtime_ms IS NOT NULL))
    )`,
  `CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      time TEXT NOT NULL,
      type TEXT NOT NULL CHECK (length(type) > 0),
      byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      PRIMARY KEY (session_id, sequence),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )`,
  `CREATE INDEX IF NOT EXISTS sessions_activity_idx
      ON sessions(COALESCE(updated_at, created_at, id) DESC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS events_time_idx
      ON events(time DESC, session_id DESC, sequence DESC)`,
] as const;

interface SessionRow {
  readonly id: string;
  readonly status: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly last_sequence: number;
  readonly journal_line: number;
  readonly journal_device: string | null;
  readonly journal_inode: string | null;
  readonly journal_size: number | null;
  readonly journal_mtime_ms: number | null;
}

interface EventRow {
  readonly session_id: string;
  readonly sequence: number;
  readonly time: string;
  readonly type: string;
  readonly byte_offset: number;
  readonly byte_length: number;
}

interface StoredPointer {
  readonly sequence: number;
  readonly time: string;
  readonly type: string;
  readonly byte_offset: number;
  readonly byte_length: number;
}

function journalFromRow(row: SessionRow): JournalFingerprint | null {
  if (
    row.journal_device === null ||
    row.journal_inode === null ||
    row.journal_size === null ||
    row.journal_mtime_ms === null
  ) {
    return null;
  }
  return {
    device: row.journal_device,
    inode: row.journal_inode,
    size: row.journal_size,
    modifiedAtMs: row.journal_mtime_ms,
  };
}

function sessionFromRow(row: SessionRow): IndexedSession {
  return {
    id: parseSessionId(row.id),
    status: row.status ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    lastSequence: row.last_sequence,
    journalLine: row.journal_line,
    journal: journalFromRow(row),
  };
}

function eventFromRow(row: EventRow): EventPointer {
  return {
    sessionId: parseSessionId(row.session_id),
    sequence: row.sequence,
    time: row.time,
    type: row.type,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
  };
}

function upsertSession(database: SqliteHandle, session: IndexedSession): void {
  database.run(
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
    [
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
    ],
  );
}

/** Strict: a pointer that is already stored is a conflict, and the whole write rolls back. */
function insertEvent(database: SqliteHandle, event: EventPointer): void {
  database.run(
    `INSERT INTO events
         (session_id, sequence, time, type, byte_offset, byte_length)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [event.sessionId, event.sequence, event.time, event.type, event.byteOffset, event.byteLength],
  );
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
 * The session's row and exactly `events`, by DIFFERENCE: only the pointers that changed are deleted and written.
 *
 * A rescan replaces a session whose journal grew by one line, and deleting and re-inserting all of its hundreds of
 * pointers each time was most of what the index wrote. What is left afterwards is what the delete-and-insert left.
 */
function replaceSessionRows(database: SqliteHandle, session: IndexedSession, events: readonly EventPointer[]): void {
  const stored = database.query<StoredPointer>(
    'SELECT sequence, time, type, byte_offset, byte_length FROM events WHERE session_id = ?',
    [session.id],
  );
  const kept = new Map(stored.map(pointer => [pointer.sequence, pointer]));
  const unchanged = new Set<number>();
  for (const event of events) {
    const pointer = event.sessionId === session.id ? kept.get(event.sequence) : undefined;
    if (pointer !== undefined && samePointer(pointer, event)) unchanged.add(event.sequence);
  }
  upsertSession(database, session);
  for (const pointer of stored)
    if (!unchanged.has(pointer.sequence))
      database.run('DELETE FROM events WHERE session_id = ? AND sequence = ?', [session.id, pointer.sequence]);
  for (const event of events) {
    if (event.sessionId === session.id && unchanged.delete(event.sequence)) continue;
    insertEvent(database, event);
  }
}

/** One write, outside any transaction: the caller decides how many writes one commit carries. */
function applyIndexWrite(database: SqliteHandle, write: IndexWrite): void {
  switch (write.kind) {
    case 'replace-all':
      database.run('DELETE FROM events');
      database.run('DELETE FROM sessions');
      for (const session of write.sessions) upsertSession(database, session);
      for (const event of write.events) insertEvent(database, event);
      return;
    case 'replace-session':
      replaceSessionRows(database, write.session, write.events);
      return;
    case 'refresh-session':
      upsertSession(database, write.session);
      return;
    case 'append-events':
      upsertSession(database, write.session);
      for (const event of write.events) insertEvent(database, event);
      return;
    case 'remove-session':
      // Explicitly, not only by the cascade: a connection without `foreign_keys` would keep the pointers.
      database.run('DELETE FROM events WHERE session_id = ?', [write.id]);
      database.run('DELETE FROM sessions WHERE id = ?', [write.id]);
      return;
  }
}

/**
 * The session index over the kernel's SQLite handle on `index.sqlite`.
 *
 * Every write runs in its own transaction, so a conflict rolls the whole write back exactly as the file did.
 */
export class StateSqliteIndex implements SessionIndex {
  constructor(private readonly database: SqliteHandle) {
    database.run('PRAGMA foreign_keys = ON');
    database.transaction(() => {
      for (const statement of TABLES) database.run(statement);
    });
  }

  #write(write: IndexWrite): void {
    this.database.transaction(() => applyIndexWrite(this.database, write));
  }

  replaceAll(plan: RebuildPlan): void {
    this.#write({ kind: 'replace-all', sessions: plan.sessions, events: plan.events });
  }

  replaceSession(session: IndexedSession, events: readonly EventPointer[]): void {
    this.#write({ kind: 'replace-session', session, events });
  }

  appendEvent(session: IndexedSession, event: EventPointer): void {
    this.appendEvents(session, [event]);
  }

  /** Upserts the metadata row alone; every existing event pointer is preserved. */
  refreshSession(session: IndexedSession): void {
    this.#write({ kind: 'refresh-session', session });
  }

  /**
   * Upserts the metadata row and inserts the supplied tail pointers in one transaction, preserving pointers already
   * stored. Any conflict rolls back the metadata together with every new pointer.
   */
  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void {
    this.#write({ kind: 'append-events', session, events });
  }

  findSession(id: SessionId): IndexedSession | undefined {
    const row = this.database.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, [id])[0];
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(): readonly IndexedSession[] {
    return this.database
      .query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         ORDER BY COALESCE(updated_at, created_at, id) DESC, id ASC`,
      )
      .map(sessionFromRow);
  }

  eventPointers(id: SessionId, afterSequence: number, limit: number): readonly EventPointer[] {
    return this.database
      .query<EventRow>(
        `SELECT session_id, sequence, time, type, byte_offset, byte_length
           FROM events WHERE session_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        [id, afterSequence, limit],
      )
      .map(eventFromRow);
  }

  fleetEventPointers(limit: number): readonly EventPointer[] {
    // Bounded in SQLite, before one journal line is read. Loading every event and slicing in memory made one fleet
    // socket proportional to the lifetime of the whole daemon.
    return this.database
      .query<EventRow>(
        `SELECT session_id, sequence, time, type, byte_offset, byte_length
           FROM events
           ORDER BY time DESC, session_id DESC, sequence DESC
           LIMIT ?`,
        [limit],
      )
      .map(eventFromRow)
      .reverse();
  }

  /** Exact number of event pointers currently stored for the session; zero when it is absent. */
  countEvents(id: SessionId): number {
    return (
      this.database.query<{ total: number }>('SELECT COUNT(*) AS total FROM events WHERE session_id = ?', [id])[0]
        ?.total ?? 0
    );
  }

  removeSession(id: SessionId): void {
    this.#write({ kind: 'remove-session', id });
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
