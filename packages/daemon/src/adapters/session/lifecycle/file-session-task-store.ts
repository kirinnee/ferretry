/**
 * Turn-one storage inside the session's own private directory.
 *
 * DURABLE BEFORE IT ANSWERS, because of what happens immediately after it. The lifecycle writes this
 * document, then hands the agent its first turn, and the durable effect that records "turn one was
 * delivered" is begun the instant the launcher is about to touch the pane. A document that had only
 * reached the page cache leaves a power cut able to produce the one combination nothing downstream
 * can repair: a durable imported receipt and a durable begun effect, naming a turn-one file that is
 * not there. The replay skips the import because the receipt says it happened, and refuses the
 * effect because it began — so the session exists, holds a conversation, and can never be given the
 * assignment it was created for. So the bytes, the file's own directory entry and the entry naming
 * that directory are all persisted before this returns.
 *
 * AN EXACT REPLAY IS SYNCED, NOT REWRITTEN. A retried launch and a fork's replay both arrive with
 * byte-identical content — the fork deliberately renders this document and the transfer brief from
 * one function so they cannot disagree — and replacing the inode under an identical file is not
 * free: anything holding the old one keeps reading a file no name points at, and the agent may be
 * mid-read of the very document it was told to open. So identical bytes are proved durable in place,
 * on one held inode, and the path is proved to still reach that inode before the call returns — a
 * concurrent writer that published over the name during the directory sync is a refusal, never a
 * silent claim about a document nothing points at.
 */

import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionId } from '../../../lib/index.ts';
import type { SessionTaskStore } from '../../../lib/session/lifecycle/index.ts';

/** The directory a session's turn documents live in, beneath the session's own directory. */
const TURNS_DIRECTORY = 'turns';

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

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
 * Persists one directory's own entries.
 *
 * A directory fsync is not universally supported, so the three errnos the state filesystem already
 * tolerates are tolerated here too — from the OPEN as well as the sync — and everything else
 * propagates, because a turn document that could not be made durable for any other reason has not
 * been written. The FILE fsync stays strict.
 */
export async function fsyncTaskDirectory(
  path: string,
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
    handle = await openDirectory(path);
  } catch (error) {
    // TOLERATED AT THE OPEN TOO, which is where a filesystem that cannot sync directories usually
    // says so: it refuses the read-only open of a directory rather than failing the fsync behind it.
    // Tolerating only the sync left the promise this helper's contract makes untrue on exactly the
    // platforms it was written for.
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
 * The directories whose entries must be persisted for a file beneath `leaf` to be reachable.
 *
 * ALWAYS AT LEAST `[dirname(leaf), leaf]`, whatever this call created. Stopping at `leaf` when the
 * `mkdir` created nothing is the same mistake one level down: creating a directory is not atomic with
 * persisting its name, so a retry can find `turns/` already there — visible but not yet durable,
 * because the attempt that created it has not reached its own sync — and would then persist the
 * document into a directory whose own name a power cut can still erase. The durable anchor at this
 * boundary is the SESSION directory, so every call persists that entry on its own behalf.
 *
 * Anything the `mkdir` did create is a contiguous chain down to `leaf`, and each link's entry lives in
 * the link above, so the walk climbs to `dirname(firstCreated)` when there is one.
 */
function directoriesToPersist(firstCreated: string | undefined, leaf: string): readonly string[] {
  const top = dirname(firstCreated ?? leaf);
  const chain: string[] = [];
  for (let directory = leaf; ; directory = dirname(directory)) {
    chain.push(directory);
    if (directory === top || dirname(directory) === directory) break;
  }
  return chain.reverse();
}

export class FileSessionTaskStore implements SessionTaskStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
    /** A seam solely so the sync ORDER can be proved; nothing else varies it. */
    private readonly syncDirectory: (path: string) => Promise<void> = fsyncTaskDirectory,
  ) {}

  file(id: SessionId): string {
    return join(this.sessionDirectory(id), TURNS_DIRECTORY, 'turn-001.md');
  }

  async writeAssignedTask(id: SessionId, document: string): Promise<string> {
    const file = this.file(id);
    const turns = dirname(file);
    const created = await mkdir(turns, { recursive: true, mode: 0o700 });
    // Parent first, and before the document: a file synced into a directory whose own name is not
    // durable is a file a power cut can take whole.
    for (const directory of directoriesToPersist(created, turns)) await this.syncDirectory(directory);

    // An exact replay proves what is already there rather than replacing it — and holds the inode it
    // proved until the very end, because the claim is about the file this path NAMES when the call
    // returns, not about the one it named a moment ago.
    const proved = await this.provePublished(file, document);
    if (proved !== undefined) {
      try {
        await this.syncDirectory(turns);
        await this.assertStillNames(file, proved);
      } finally {
        await proved.close();
      }
      return file;
    }

    const temporary = `${file}.${this.uniqueId()}.tmp`;
    // OUTSIDE the cleanup below, deliberately. `wx` fails when the name is taken, and a name this
    // call did not create belongs to another writer — unlinking it in a `finally` would delete a
    // stranger's in-flight document on the way out. Losing the exclusive create means this call owns
    // nothing to clean up, so the failure simply propagates.
    const handle = await open(temporary, 'wx', 0o600);
    // Ownership of the temporary NAME. It ends the instant the rename succeeds: the name is free
    // again from that moment, and the directory sync below is an await during which another writer
    // can legitimately create its own temporary at the same reused name. Unlinking after that point
    // would delete a stranger's in-flight document.
    let owns = true;
    try {
      try {
        await handle.writeFile(document, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The bytes are durable in an inode; the rename is what makes the NAME reach them, and the
      // directory sync is what makes that name survive.
      await rename(temporary, file);
      owns = false;
      await this.syncDirectory(turns);
    } finally {
      if (owns) await unlink(temporary).catch(() => undefined);
    }
    return file;
  }

  /**
   * Whether the published file already holds exactly these bytes — compared and persisted on ONE
   * read-only handle.
   *
   * ONE HANDLE, NOT A READ THEN A REOPEN. Reading by path and syncing by path are two lookups of a
   * name that a concurrent writer republishes by rename, so the compare could pass against the
   * document that is there now while the fsync persisted the one that replaced it — this call would
   * then report an exact replay it had never made durable. Holding the inode across both closes it.
   *
   * Opened for READING deliberately: an `open` for write would truncate or re-time the inode, and
   * the point of this path is that a document an agent may be mid-read of stays exactly where it is.
   * Differing bytes return before the sync, because they are about to be replaced anyway.
   */
  private async provePublished(file: string, document: string): Promise<FileHandle | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      // Differing bytes close and return BEFORE the sync: that document is about to be replaced, and
      // the caller takes the publish path instead.
      if ((await handle.readFile('utf8')) !== document) {
        await handle.close();
        return undefined;
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    // Handed back OPEN. The caller keeps this inode pinned across its directory sync and then proves
    // the path still reaches it.
    return handle;
  }

  /**
   * Refuses if the path stopped naming the inode this call proved.
   *
   * WHY THE COMPARE IS AT THE END. Everything before it is true of an inode; the promise this method
   * makes is about a PATH — that `turns/turn-001.md` holds these exact bytes, durably, when the call
   * returns. A concurrent writer publishing by rename during the directory sync substitutes the file
   * underneath without touching the handle, so a caller told "your identical replay is durable" would
   * be holding a guarantee about a document nothing points at any more.
   *
   * It REFUSES rather than falling through to the replace path. Reaching here means somebody else
   * just published a document at this name, and overwriting it would destroy a write that won a race
   * this call did not know it was in. A refusal fails the launch, which the lifecycle already records
   * and a retry re-drives against whatever is genuinely there.
   */
  private async assertStillNames(file: string, proved: FileHandle): Promise<void> {
    const [held, named] = await Promise.all([proved.stat(), stat(file).catch(() => undefined)]);
    if (named !== undefined && named.dev === held.dev && named.ino === held.ino) return;
    throw new Error(
      `${file} stopped naming the turn-one document this write proved: another writer published over ` +
        'it, so this call refuses rather than overwriting a document it never read',
    );
  }
}
