import { Database } from 'bun:sqlite';
import type { FileSystemPort, FoundationPaths, HomeLockFactory, HomeLockLease } from '../../lib/index.ts';

export class StateHomeLockedError extends Error {
  constructor(readonly lockFile: string) {
    super(`state home is already owned by another daemon: ${lockFile}`);
    this.name = 'StateHomeLockedError';
  }
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

export class SqliteHomeLockFactory implements HomeLockFactory {
  async acquire(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<HomeLockLease> {
    await fileSystem.information(paths.daemonLock);
    const database = new Database(paths.daemonLock, { create: true, strict: true });
    try {
      // The database carries no state: its lifetime transaction is only an OS-backed lock.
      // A memory journal keeps that transaction crash-releasable without adding root sidecars.
      database.exec('PRAGMA journal_mode = MEMORY');
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('BEGIN EXCLUSIVE');
      await fileSystem.setMode(paths.daemonLock, 0o600);
      return new SqliteHomeLockLease(database);
    } catch (error) {
      const locked = String(error).toLowerCase().includes('locked');
      try {
        database.close();
      } catch {
        // Preserve the acquisition failure; the database never escaped this scope.
      }
      if (locked) throw new StateHomeLockedError(paths.daemonLock);
      throw error;
    }
  }
}
