import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** `<home>/run/daemon.lock` — the one file whose OS-backed lock says "this home has a daemon" (§9.2). */
export const homeLockPath = (home: string): string => join(home, 'run', 'daemon.lock');

/** The refusal G57 names: a daemon that cannot claim its home says what to do about it, with the real command. */
export function homeLockedSentence(home: string, lockFile: string, binary: string): string {
  return (
    `${home} is already claimed by another daemon (${lockFile}), so this one will not start.\n` +
    `Stop that daemon, or run \`${binary} daemon adopt\` to take the home over.`
  );
}

export class StateHomeLockedError extends Error {
  constructor(
    readonly lockFile: string,
    sentence: string,
  ) {
    super(sentence);
    this.name = 'StateHomeLockedError';
  }
}

export interface HomeLockLease {
  release(): Promise<void>;
}

export interface HomeLockOptions {
  readonly home: string;
  /** The binary's name, from the one place that owns it; the refusal quotes `<binary> daemon adopt`. */
  readonly binary: string;
  /** Narrows the lock file's mode after the lock is taken; a seam so a test can fail that one step. */
  readonly setMode?: (path: string, mode: number) => void;
}

class SqliteHomeLockLease implements HomeLockLease {
  private database: Database | undefined;

  constructor(database: Database) {
    this.database = database;
  }

  async release(): Promise<void> {
    const database = this.database;
    if (database === undefined) return;
    this.database = undefined;
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  }
}

/**
 * Takes the home lock. The lock database carries no state: its lifetime transaction is only an OS-backed lock, so a
 * crash releases it. A memory journal keeps that transaction crash-releasable without adding sidecar files. Anything
 * that fails for another reason surfaces as itself, never as a claim that another daemon owns the home.
 */
export async function acquireHomeLock(options: HomeLockOptions): Promise<HomeLockLease> {
  const lockFile = homeLockPath(options.home);
  mkdirSync(join(options.home, 'run'), { recursive: true, mode: 0o700 });
  const database = new Database(lockFile, { create: true, strict: true });
  try {
    database.exec('PRAGMA journal_mode = MEMORY');
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
    (options.setMode ?? chmodSync)(lockFile, 0o600);
    return new SqliteHomeLockLease(database);
  } catch (error) {
    const locked = String(error).toLowerCase().includes('locked');
    try {
      database.close();
    } catch {
      // Preserve the acquisition failure; the database never escaped this scope.
    }
    if (locked) throw new StateHomeLockedError(lockFile, homeLockedSentence(options.home, lockFile, options.binary));
    throw error;
  }
}
