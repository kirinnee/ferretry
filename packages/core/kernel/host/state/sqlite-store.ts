import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteHandle, StateDamage, StateFileDef } from '../../contract/index.ts';
import { StoreDamagedError } from './errors.ts';
import { damageOf, describeFault } from './format.ts';

/**
 * A `sqlite` / `sqlite-cache` file (§9.2): its format is in `PRAGMA user_version`, a reader accepts exactly it, and a
 * CACHE that does not match — or is not a database at all — is dropped and rebuilt (a cache rule). State that
 * is not a cache is damaged instead and nothing is touched.
 *
 * The handle is synchronous, so the few file operations it needs are their own small seam.
 */
export interface SqliteFiles {
  ensureDirectory(path: string, mode: number): void;
  /** Removes the database and its `-wal` / `-shm` sidecars. */
  removeDatabase(path: string): void;
  setMode(path: string, mode: number): void;
  exists(path: string): boolean;
}

export const nodeSqliteFiles: SqliteFiles = {
  ensureDirectory: (path, mode) => void mkdirSync(path, { recursive: true, mode }),
  removeDatabase: path => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  },
  setMode: (path, mode) => chmodSync(path, mode),
  exists: path => existsSync(path),
};

const DEFAULT_MODE = 0o600;

interface Opened {
  readonly database: Database;
  readonly version: number;
  readonly empty: boolean;
}

function inspect(path: string, readonly: boolean): Opened {
  const database = new Database(path, readonly ? { readonly: true, strict: true } : { create: true, strict: true });
  try {
    const version = (database.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    const tables = (
      database.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    ).n;
    return { database, version, empty: tables === 0 };
  } catch (error) {
    database.close();
    throw error;
  }
}

/** The damage a database's format says, or undefined when it is this definition's format (or a fresh file). */
function formatDamage(def: StateFileDef, label: string, version: number, empty: boolean): StateDamage | undefined {
  if (version === def.format) return undefined;
  if (version === 0) return empty ? undefined : damageOf(label, 'no_format');
  return version < def.format
    ? damageOf(label, 'lower_format', `format ${version}; this release reads ${def.format}`)
    : damageOf(label, 'higher_format', String(version));
}

/** Boot's look at one SQLite state file: its damage, or undefined. A cache never damages (it is rebuilt on open). */
export function checkSqlite(
  def: StateFileDef,
  path: string,
  label: string,
  files: SqliteFiles,
): StateDamage | undefined {
  if (def.store === 'sqlite-cache' || !files.exists(path)) return undefined;
  try {
    const opened = inspect(path, true);
    opened.database.close();
    return formatDamage(def, label, opened.version, opened.empty);
  } catch (error) {
    return damageOf(label, 'unparsable', describeFault(error));
  }
}

export function openSqlite(def: StateFileDef, path: string, label: string, files: SqliteFiles): SqliteHandle {
  files.ensureDirectory(dirname(path), 0o700);
  const cache = def.store === 'sqlite-cache';
  let opened: Opened;
  try {
    opened = inspect(path, false);
  } catch (error) {
    if (!cache) throw new StoreDamagedError(damageOf(label, 'unparsable', describeFault(error)));
    files.removeDatabase(path);
    opened = inspect(path, false);
  }
  const damage = formatDamage(def, label, opened.version, opened.empty);
  if (damage !== undefined) {
    opened.database.close();
    if (!cache) throw new StoreDamagedError(damage);
    files.removeDatabase(path);
    opened = inspect(path, false);
  }
  const { database } = opened;
  database.exec(`PRAGMA user_version = ${def.format}`);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  files.setMode(path, def.mode ?? DEFAULT_MODE);
  return {
    query: <Row>(sql: string, params: readonly unknown[] = []) =>
      database.query(sql).all(...(params as never[])) as Row[],
    run: (sql, params = []) => ({ changes: database.run(sql, params as never[]).changes }),
    transaction: fn => database.transaction(fn)(),
    close: () => database.close(),
  };
}
