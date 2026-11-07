import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SessionId } from '../../../lib/index.ts';
import type { SessionEnvironmentStore } from '../../../lib/session/lifecycle/index.ts';

/**
 * The environment is a flat string map, parsed rather than asserted: this file holds the only copy
 * of a session's credential, and a document that has been corrupted must fail loudly instead of
 * launching an agent with half an environment.
 */
const EnvironmentDocumentSchema = z.record(z.string().min(1), z.string());

/**
 * Whether an error means this platform cannot sync a directory at all.
 *
 * Exactly the three the state filesystem tolerates, and no more — a directory sync that failed for
 * any other reason has not happened, and the durability this file promises would be a lie.
 */
function unsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM';
}

/**
 * Flushes a renamed directory entry, tolerating only platforms that cannot sync directories.
 *
 * The tolerance covers the OPEN as well as the sync: such a platform usually refuses the read-only
 * open of a directory rather than failing the fsync behind it. Every other error propagates — this
 * file holds the only copy of a session's credential, and a failure to make it durable for any other
 * reason must not be swallowed.
 */
export async function fsyncEnvironmentDirectory(
  directory: string,
  /**
   * Opens the directory to be synced.
   *
   * A parameter rather than a constructor port, and defaulted to the real call, because the ONLY
   * thing a test needs to vary is which errno the open produces — and that cannot be produced from
   * outside on a filesystem that supports directory opens. Nothing else about the helper varies.
   */
  openDirectory: (path: string) => Promise<FileHandle> = path => open(path, 'r'),
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openDirectory(directory);
  } catch (error) {
    // TOLERATED AT THE OPEN TOO, which is where a filesystem that cannot sync directories usually
    // says so: it refuses the read-only open of a directory rather than failing the fsync behind it.
    if (!unsupportedDirectorySync(error)) throw error;
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * The per-session environment on disk, inside the session's own private directory.
 *
 * `0o600` on the file and `0o700` on the directory are the whole access control: this is where a
 * session's plaintext capability lives, and nothing in the API projects it. The temporary file is
 * synced before rename and the directory afterwards: lifecycle creation publishes the capability's
 * hash only after this method returns, so mere call ordering without power-loss durability would
 * still be able to leave a hash whose plaintext vanished after a crash.
 *
 * IT SYNCS ONE DIRECTORY, NOT THE CHAIN ABOVE IT, and that is a stated precondition rather than an
 * oversight. In production every caller reaches this only after `SessionLifecycleService.create` has
 * run `repository.reserve`, which is the boundary that persists the session directory's own entry in
 * `<sessions>` — deliberately, so one owner holds that barrier. Repeating it here would be a second
 * owner of the same fact, and the two would eventually disagree about which of them guarantees it.
 * What this method owes is the entry for the file it just published, and that is what it syncs.
 */
export class FileSessionEnvironmentStore implements SessionEnvironmentStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
    /**
     * Persists one directory's entries.
     *
     * A seam solely so the moment BETWEEN the rename and this sync can be entered by a test: that
     * await is the window in which the temporary name is free again and another writer may take it,
     * and it cannot be reached from outside. Nothing else varies it, and it is not a general IO port.
     */
    private readonly syncDirectory: (path: string) => Promise<void> = fsyncEnvironmentDirectory,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), 'environment.json');
  }

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    const file = this.file(id);
    const directory = dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    const document = `${JSON.stringify(EnvironmentDocumentSchema.parse(environment), undefined, 2)}\n`;
    // OPENED BEFORE THE CLEANUP IS ARMED. `wx` fails when the name is already taken, and a name this
    // call did not create belongs to another writer — removing it on the way out would destroy a
    // stranger's in-flight document, and this file is the only place a session's plaintext
    // credential lives. Losing the exclusive create means there is nothing here to clean up.
    const handle: FileHandle = await open(temporary, 'wx', 0o600);
    let closed = false;
    // Ownership of the temporary NAME, not of the bytes. It ends the instant the rename succeeds,
    // because the name is free again from that moment — and the directory sync that follows is an
    // await, during which another writer can legitimately create its own temporary at the same
    // reused name. Cleaning up after that point would delete a stranger's in-flight credential.
    let owns = true;
    try {
      await handle.writeFile(document, 'utf8');
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(temporary, file);
      owns = false;
      // The file's own entry. The entry NAMING this directory is the lifecycle reservation's, and is
      // established before any environment is written — see the class comment.
      await this.syncDirectory(directory);
    } catch (error) {
      if (!closed) await handle.close().catch(() => undefined);
      if (owns) await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch (error) {
      // A session that was never given an environment is the normal case, not a fault: it launches
      // with none. Any OTHER read failure is real and must not be flattened into "no secret".
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return EnvironmentDocumentSchema.parse(JSON.parse(raw));
  }
}
