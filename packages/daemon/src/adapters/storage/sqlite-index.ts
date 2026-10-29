import { Database } from 'bun:sqlite';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  decideIndexSchema,
  type EventPointer,
  type FileSystemPort,
  type FoundationPaths,
  type IndexedSession,
  type IndexPersister,
  type IndexWrite,
  indexFiles,
  type JournalFingerprint,
  parseSessionId,
  type RebuildPlan,
  type SessionId,
  type SessionIndex,
  type SessionIndexFactory,
} from '../../lib/index.ts';
import { InlineIndexPersister } from './index-persisters.ts';
import { applyIndexWrite, configureIndexConnection, SESSION_COLUMNS } from './sqlite-index-statements.ts';
import { WriteBehindSessionIndex, type WriteBehindSessionIndexOptions } from './write-behind-index.ts';

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

/**
 * The session index over one SQLite connection: in the daemon, a copy held in memory.
 *
 * Every write runs in its own transaction in {@link IndexWriteMode} `strict`, so a conflict rolls the
 * whole write back exactly as the file did; {@link WriteBehindSessionIndex} persists what succeeded.
 */
export class BunSqliteIndex implements SessionIndex {
  constructor(private readonly database: Database) {}

  #write(write: IndexWrite): void {
    this.database.transaction(() => applyIndexWrite(this.database, write, 'strict'))();
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
   * Upserts the metadata row and inserts the supplied tail pointers in one transaction, preserving
   * pointers already stored. Any conflict rolls back the metadata together with every new pointer.
   */
  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void {
    this.#write({ kind: 'append-events', session, events });
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

  fleetEventPointers(limit: number): readonly EventPointer[] {
    // Bounded in SQLite, before one journal byte is read. Loading every event and slicing in memory
    // made one fleet socket proportional to the lifetime of the whole daemon.
    return this.database
      .query<EventRow, [number]>(
        `SELECT session_id, sequence, time, type, byte_offset, byte_length
           FROM events
           ORDER BY time DESC, session_id DESC, sequence DESC
           LIMIT ?`,
      )
      .all(limit)
      .map(eventFromRow)
      .reverse();
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
    this.#write({ kind: 'remove-session', id });
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

function configure(database: Database): void {
  database.exec('PRAGMA journal_mode = WAL');
  configureIndexConnection(database);
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
    CREATE INDEX IF NOT EXISTS events_time_idx
      ON events(time DESC, session_id DESC, sequence DESC);
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

/**
 * The file's whole content as a database in memory, read once at open.
 *
 * Bytes 18 and 19 of a database header are its read and write format versions, and 2 means WAL: a copy
 * in memory refuses to open in that mode, so the copy is marked as the rollback journal it then is.
 * The index is two small tables (a few megabytes on the owner's fleet), so holding it costs little.
 */
function inMemoryCopy(database: Database): Database {
  const bytes = database.serialize();
  bytes[18] = 1;
  bytes[19] = 1;
  const memory = Database.deserialize(bytes, { strict: true });
  memory.exec('PRAGMA foreign_keys = ON');
  return memory;
}

/** Who persists one opened index file, given the connection its open already holds. */
export interface IndexPersisterFactory {
  create(file: string, connection: Database): IndexPersister;
}

/** The writes made on the main thread, through the connection the open used: the fallback, and tests. */
export const INLINE_INDEX_PERSISTERS: IndexPersisterFactory = {
  create: (_file, connection) => new InlineIndexPersister(connection),
};

/**
 * Opens the index file, then answers from a copy in memory and persists behind it.
 *
 * NO READ OR WRITE OF THE INDEX TOUCHES THE DISK ON THE EVENT LOOP after this open. A commit to the file
 * ends, sooner or later, in SQLite's checkpoint — an `fsync` of the log and of the database — and on a
 * saturated disk that `fsync` measured over a second here and 38 s on the owner's machine, with the
 * whole daemon frozen behind it. The file is still written: by {@link IndexPersisterFactory}, in
 * batches, on the thread the daemon gives it.
 */
export class BunSqliteIndexFactory implements SessionIndexFactory {
  constructor(
    private readonly persisters: IndexPersisterFactory = INLINE_INDEX_PERSISTERS,
    private readonly options: WriteBehindSessionIndexOptions = {},
  ) {}

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
      const memory = new BunSqliteIndex(inMemoryCopy(database));
      return new WriteBehindSessionIndex(memory, this.persisters.create(paths.sessionIndex, database), this.options);
    } catch (error) {
      database?.close();
      throw error;
    }
  }
}
