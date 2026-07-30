import { Database } from 'bun:sqlite';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  decideIndexSchema,
  type EventPointer,
  type FileSystemPort,
  type FoundationPaths,
  type IndexedSession,
  indexFiles,
  type JournalFingerprint,
  parseSessionId,
  type RebuildPlan,
  type SessionId,
  type SessionIndex,
  type SessionIndexFactory,
} from '../../lib/index.ts';

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

const SESSION_COLUMNS = `id, status, created_at, updated_at, last_sequence, journal_line,
  journal_device, journal_inode, journal_size, journal_mtime_ms`;

const EXPECTED_INDEX_TABLES = ['events', 'sessions'] as const;
const EXPECTED_SESSION_COLUMNS = [
  'id',
  'status',
  'created_at',
  'updated_at',
  'last_sequence',
  'journal_line',
  'journal_device',
  'journal_inode',
  'journal_size',
  'journal_mtime_ms',
] as const;
const EXPECTED_EVENT_COLUMNS = ['session_id', 'sequence', 'time', 'type', 'byte_offset', 'byte_length'] as const;

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function indexSchemaShape(database: Database): { readonly hasTables: boolean; readonly expected: boolean } {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(row => row.name);
  const columns = (table: 'sessions' | 'events'): readonly string[] =>
    database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map(row => row.name);
  return {
    hasTables: tables.length > 0,
    expected:
      sameNames(tables, EXPECTED_INDEX_TABLES) &&
      sameNames(columns('sessions'), EXPECTED_SESSION_COLUMNS) &&
      sameNames(columns('events'), EXPECTED_EVENT_COLUMNS),
  };
}

export class BunSqliteIndex implements SessionIndex {
  constructor(private readonly database: Database) {}

  private insertSession(session: IndexedSession): void {
    this.database
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

  private insertEvent(event: EventPointer): void {
    this.database
      .query(
        `INSERT INTO events (session_id, sequence, time, type, byte_offset, byte_length)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.sessionId, event.sequence, event.time, event.type, event.byteOffset, event.byteLength);
  }

  replaceAll(plan: RebuildPlan): void {
    this.database.transaction(() => {
      this.database.exec('DELETE FROM events');
      this.database.exec('DELETE FROM sessions');
      for (const session of plan.sessions) this.insertSession(session);
      for (const event of plan.events) this.insertEvent(event);
    })();
  }

  replaceSession(session: IndexedSession, events: readonly EventPointer[]): void {
    this.database.transaction(() => {
      this.database.query('DELETE FROM sessions WHERE id = ?').run(session.id);
      this.insertSession(session);
      for (const event of events) this.insertEvent(event);
    })();
  }

  appendEvent(session: IndexedSession, event: EventPointer): void {
    this.appendEvents(session, [event]);
  }

  /** Upserts the metadata row alone; every existing event pointer is preserved. */
  refreshSession(session: IndexedSession): void {
    this.insertSession(session);
  }

  /**
   * Upserts the metadata row and inserts the supplied tail pointers in one transaction, preserving
   * pointers already stored. Any conflict rolls back the metadata together with every new pointer.
   */
  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void {
    this.database.transaction(() => {
      this.insertSession(session);
      for (const event of events) this.insertEvent(event);
    })();
  }

  findSession(id: SessionId): IndexedSession | undefined {
    const row = this.database
      .query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id);
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(): readonly IndexedSession[] {
    return this.database
      .query<SessionRow, []>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         ORDER BY COALESCE(updated_at, created_at, id) DESC, id ASC`,
      )
      .all()
      .map(sessionFromRow);
  }

  eventPointers(id: SessionId, afterSequence: number, limit: number): readonly EventPointer[] {
    return this.database
      .query<EventRow, [string, number, number]>(
        `SELECT session_id, sequence, time, type, byte_offset, byte_length
           FROM events WHERE session_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
      )
      .all(id, afterSequence, limit)
      .map(eventFromRow);
  }

  /** Exact number of event pointers currently stored for the session; zero when it is absent. */
  countEvents(id: SessionId): number {
    return (
      this.database
        .query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM events WHERE session_id = ?')
        .get(id)?.total ?? 0
    );
  }

  removeSession(id: SessionId): void {
    this.database.query('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void {
    try {
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.database.close();
    }
  }
}

function configure(database: Database): void {
  database.exec('PRAGMA journal_mode = WAL');
  // Journals are fsynced before index writes, so the disposable index can safely use NORMAL.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
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
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      time TEXT NOT NULL,
      type TEXT NOT NULL CHECK (length(type) > 0),
      byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      PRIMARY KEY (session_id, sequence),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS sessions_activity_idx
      ON sessions(COALESCE(updated_at, created_at, id) DESC, id ASC);
    PRAGMA user_version = ${CURRENT_INDEX_SCHEMA_VERSION};
  `);
}

/**
 * SQLite opens the main database and its `-wal`/`-shm` sidecars by itself, outside the port, so every
 * one of those paths must clear the port's rules before the engine can read or mutate whatever they
 * point at. `information` walks each component under the state home and throws on a symbolic link —
 * including the final component — or on a path outside the home, which is exactly the refusal we
 * need. Opening only ever happens through this function so no call site can skip the preflight.
 */
async function openDatabase(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<Database> {
  for (const file of indexFiles(paths)) await fileSystem.information(file);
  return new Database(paths.sessionIndex, { create: true, strict: true });
}

export class BunSqliteIndexFactory implements SessionIndexFactory {
  async open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<SessionIndex> {
    await fileSystem.ensureDirectory(paths.index, 0o700);
    let database: Database | undefined;
    try {
      database = await openDatabase(paths, fileSystem);
      const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
      const shape = indexSchemaShape(database);
      if (decideIndexSchema(version, shape.hasTables, shape.expected) === 'drop-and-rebuild') {
        const obsolete = database;
        database = undefined;
        obsolete.close();
        for (const file of indexFiles(paths)) await fileSystem.removeFile(file);
        database = await openDatabase(paths, fileSystem);
      }
      configure(database);
      for (const file of indexFiles(paths)) {
        if ((await fileSystem.information(file)) !== undefined) await fileSystem.setMode(file, 0o600);
      }
      return new BunSqliteIndex(database);
    } catch (error) {
      database?.close();
      throw error;
    }
  }
}
