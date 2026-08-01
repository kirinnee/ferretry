import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';

/**
 * The whole filesystem surface the task store is allowed to use. Narrow on purpose: it is injected
 * so fault tests can make any single step fail, and so nothing else about the host is reachable.
 */
export interface TaskFileOperations {
  /** Returns null when the file is absent; any other failure propagates. */
  read(path: string): Promise<string | null>;
  /** Creates the containing directory (and parents) with a private mode where supported. */
  ensureDirectory(path: string, mode: number): Promise<void>;
  /** Exclusively creates, writes, and flushes a new scratch file. A failed write cleans up only its own file. */
  write(path: string, contents: string, mode: number): Promise<void>;
  /** Same-directory rename — the step that makes the replacement atomic. */
  replace(from: string, to: string): Promise<void>;
  /** Flushes directory metadata after a rename so the new name is durable across a crash. */
  syncDirectory(path: string): Promise<void>;
  /** Best-effort scratch removal; a missing file is not an error. */
  discard(path: string): Promise<void>;
}

/** Distinguishes "no file yet" from a real IO fault without stringly-typed error matching. */
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';

/** The production collaborator: plain `node:fs/promises`, no caching, no hidden state. */
export class NodeTaskFileOperations implements TaskFileOperations {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
  }

  async write(path: string, contents: string, mode: number): Promise<void> {
    let created = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // `wx` proves this writer owns the scratch path. A colliding token must never overwrite or
      // delete another writer's temporary document.
      handle = await open(path, 'wx', mode);
      created = true;
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        handle = undefined;
      }
      if (created) await rm(path, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async replace(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async discard(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

/** Names the scratch file for one write. Injected so a test can force a collision or pin a name. */
export interface TempNameSource {
  next(): string;
}

/** Random, collision-resistant, and filesystem-safe — never derived from caller input. */
export class RandomTempNameSource implements TempNameSource {
  next(): string {
    return randomBytes(8).toString('hex');
  }
}

/** Supplies the timestamps the store stamps onto a snapshot. Injected to keep tests deterministic. */
export interface InstantSource {
  now(): string;
}

export class SystemInstantSource implements InstantSource {
  now(): string {
    return new Date().toISOString();
  }
}
