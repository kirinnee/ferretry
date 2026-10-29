/**
 * THE SESSION INDEX FILE'S SHAPE, AND LOADING IT: checked, created or migrated, then read whole.
 *
 * Run by whichever thread owns the file — the index writer in the daemon, the main thread only as the
 * fallback — so opening the index at boot costs the event loop no SQLite at all. Measured on CI: a boot
 * over the owner-scale fleet stalled 208 and 263 ms inside this open, run on the main thread, because a
 * fresh file is switched to WAL (an `fsync`), given its tables, and stamped with its version. Like the
 * index's SQL, this imports nothing at run time but `bun:sqlite` and one pure decision.
 */
import { Database } from 'bun:sqlite';
import { CURRENT_INDEX_SCHEMA_VERSION, decideIndexSchema } from '../../lib/reconciliation.ts';
import { configureIndexConnection } from './sqlite-index-statements.ts';

/** What loading found: a file to delete and load again, or the whole database as bytes. */
export type IndexLoad = { readonly kind: 'drop' } | { readonly kind: 'loaded'; readonly bytes: Uint8Array };

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
 * The file in WAL mode with the current tables, written only where it is not already: a boot over a
 * current file writes nothing. `synchronous` is set first, so even a new file's switch to WAL is not
 * `fsync`ed the way the default (`FULL`) would.
 */
function configure(database: Database, version: number): void {
  configureIndexConnection(database);
  database.exec('PRAGMA journal_mode = WAL');
  if (version === CURRENT_INDEX_SCHEMA_VERSION && indexSchemaShape(database).expected) return;
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
    PRAGMA user_version = ${String(CURRENT_INDEX_SCHEMA_VERSION)};
  `);
}

/**
 * Checks, creates or migrates the file `database` is open on, and returns its whole content.
 *
 * An obsolete or foreign file is answered with `drop` and left as it is: deleting it goes through the
 * daemon's confined filesystem port, which the caller holds, and the caller then loads again.
 */
export function loadIndexFile(database: Database): IndexLoad {
  const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  const shape = indexSchemaShape(database);
  if (decideIndexSchema(version, shape.hasTables, shape.expected) === 'drop-and-rebuild') return { kind: 'drop' };
  configure(database, version);
  return { kind: 'loaded', bytes: database.serialize() };
}

/** Opens the index file for its owning thread, creating it when it is missing. */
export function openIndexFile(file: string): Database {
  return new Database(file, { create: true, strict: true });
}
