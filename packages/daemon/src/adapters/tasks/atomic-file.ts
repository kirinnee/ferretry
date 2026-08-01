import { dirname, isAbsolute, join } from 'node:path';
import { TaskError } from '../../lib/tasks/task-error.ts';
import type { TaskFileOperations, TempNameSource } from './file-operations.ts';
import { NodeTaskFileOperations, RandomTempNameSource } from './file-operations.ts';

/** Private by default: the board holds the human's asks, so nothing is group- or world-readable. */
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Scratch names are constructed here, never taken from a caller, and always live beside the target. */
const SAFE_TEMP_TOKEN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Writes one file so that a reader never observes a partial document: the payload lands in a scratch
 * file in the *same* directory, is flushed, then renamed over the target before the directory entry
 * is flushed. Scratch creation is exclusive, so a token collision cannot alter another writer's
 * file. Placement is not this class's business — it is handed an absolute path and nothing else.
 */
export class AtomicFileWriter {
  private readonly files: TaskFileOperations;
  private readonly tempNames: TempNameSource;

  constructor(
    files: TaskFileOperations = new NodeTaskFileOperations(),
    tempNames: TempNameSource = new RandomTempNameSource(),
  ) {
    this.files = files;
    this.tempNames = tempNames;
  }

  /** Reads the file, or null when it does not exist yet. */
  async read(path: string): Promise<string | null> {
    return await this.files.read(this.requireAbsolute(path));
  }

  /**
   * Replaces `path` atomically. Any failure leaves the previous contents intact and removes the
   * scratch file, so a crashed write never degrades into a truncated or empty board.
   */
  async write(path: string, contents: string): Promise<void> {
    const target = this.requireAbsolute(path);
    const directory = dirname(target);
    await this.files.ensureDirectory(directory, PRIVATE_DIRECTORY_MODE);
    const scratch = this.scratchFor(target);
    let ownsScratch = false;
    try {
      await this.files.write(scratch, contents, PRIVATE_FILE_MODE);
      ownsScratch = true;
      await this.files.replace(scratch, target);
      await this.files.syncDirectory(directory);
    } catch (error) {
      // `write` only resolves once its exclusive create succeeded. Before then the name may belong
      // to another writer, so cleanup would be destructive; after then this writer owns it.
      if (ownsScratch) await this.files.discard(scratch).catch(() => undefined);
      throw error;
    }
  }

  /** The scratch path for a target: hidden, same directory, unique per attempt. */
  scratchFor(target: string): string {
    const token = this.tempNames.next();
    if (!SAFE_TEMP_TOKEN.test(token)) {
      throw new TaskError('invalid', `unsafe scratch token: ${JSON.stringify(token)}`);
    }
    const directory = dirname(target);
    return join(directory, `.${target.slice(directory.length + 1)}.${token}.tmp`);
  }

  /** An adapter that resolves relative paths against a process cwd would be a hidden dependency. */
  private requireAbsolute(path: string): string {
    if (path.length === 0 || !isAbsolute(path)) {
      throw new TaskError('invalid', `snapshot path must be absolute: ${JSON.stringify(path)}`);
    }
    return path;
  }
}
