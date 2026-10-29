import { Database } from 'bun:sqlite';
import {
  type EventPointer,
  type FileSystemPort,
  type FoundationPaths,
  type IndexedSession,
  type IndexWrite,
  indexFiles,
  type JournalFingerprint,
  parseSessionId,
  type RebuildPlan,
  type SessionId,
  type SessionIndex,
  type SessionIndexFactory,
} from '../../lib/index.ts';
import { INLINE_INDEX_FILES, type IndexFile, type IndexFileFactory } from './index-persisters.ts';
import type { IndexLoad } from './sqlite-index-schema.ts';
import { applyIndexWrite, SESSION_COLUMNS } from './sqlite-index-statements.ts';
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

/**
 * SQLite opens the main database and its `-wal`/`-shm` sidecars by itself, outside the port, so every
 * one of those paths must clear the port's rules before the engine can read or mutate whatever they
 * point at. `information` walks each component under the state home and throws on a symbolic link —
 * including the final component — or on a path outside the home, which is exactly the refusal we
 * need. Loading only ever happens through this function so no call site can skip the preflight.
 */
async function preflightThenLoad(
  paths: FoundationPaths,
  fileSystem: FileSystemPort,
  file: IndexFile,
): Promise<IndexLoad> {
  for (const path of indexFiles(paths)) await fileSystem.information(path);
  return await file.load();
}

/**
 * The file's whole content, as a database in memory.
 *
 * Bytes 18 and 19 of a database header are its read and write format versions, and 2 means WAL: a copy
 * in memory refuses to open in that mode, so the copy is marked as the rollback journal it then is.
 * The index is two small tables (a few megabytes on the owner's fleet), so holding it costs little.
 */
function inMemoryCopy(bytes: Uint8Array): Database {
  bytes[18] = 1;
  bytes[19] = 1;
  const memory = Database.deserialize(bytes, { strict: true });
  memory.exec('PRAGMA foreign_keys = ON');
  return memory;
}

/**
 * Loads the index file, then answers from a copy in memory and persists behind it.
 *
 * NO READ OR WRITE OF THE INDEX TOUCHES THE DISK ON THE EVENT LOOP — not even the open. A commit to the
 * file ends, sooner or later, in SQLite's checkpoint — an `fsync` of the log and of the database — and on
 * a saturated disk that `fsync` measured over a second here and 38 s on the owner's machine, with the
 * whole daemon frozen behind it; creating and checking the file at boot stalled CI's owner-scale boot
 * past 200 ms. The {@link IndexFileFactory} the daemon gives does both on the index writer's thread, and
 * the main thread receives bytes.
 */
export class BunSqliteIndexFactory implements SessionIndexFactory {
  constructor(
    private readonly files: IndexFileFactory = INLINE_INDEX_FILES,
    private readonly options: WriteBehindSessionIndexOptions = {},
  ) {}

  async open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<SessionIndex> {
    await fileSystem.ensureDirectory(paths.index, 0o700);
    const file = this.files.create(paths.sessionIndex);
    try {
      let load = await preflightThenLoad(paths, fileSystem, file);
      if (load.kind === 'drop') {
        for (const path of indexFiles(paths)) await fileSystem.removeFile(path);
        load = await preflightThenLoad(paths, fileSystem, file);
        if (load.kind === 'drop') throw new Error('the session index was recreated and is still not current');
      }
      for (const path of indexFiles(paths)) {
        if ((await fileSystem.information(path)) !== undefined) await fileSystem.setMode(path, 0o600);
      }
      return new WriteBehindSessionIndex(new BunSqliteIndex(inMemoryCopy(load.bytes)), file, this.options);
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}
