import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

/**
 * The whole filesystem surface the task store is allowed to use. Narrow on purpose: it is injected
 * so fault tests can make any single step fail, and so nothing else about the host is reachable.
 */
export interface TaskFileOperations {
  /** Returns null when the file is absent; any other failure propagates. */
  read(path: string): Promise<string | null>;
  /** Creates the containing directory (and parents) with a private mode where supported. */
  ensureDirectory(path: string, mode: number): Promise<void>;
  write(path: string, contents: string, mode: number): Promise<void>;
  /** Same-directory rename — the step that makes the replacement atomic. */
  replace(from: string, to: string): Promise<void>;
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
    await writeFile(path, contents, { encoding: 'utf8', mode });
  }

  async replace(from: string, to: string): Promise<void> {
    await rename(from, to);
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
