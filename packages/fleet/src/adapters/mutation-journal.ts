/**
 * A reverse-order undo log for one batch of filesystem mutations.
 *
 * Provisioning writes each file atomically, so no reader ever observes half a wrapper — but a batch
 * that threw on its tenth write used to leave the first nine landed with nothing said about them.
 * This journal closes that gap: a caller records what it is about to destroy immediately before
 * destroying it, and can then put every entry back in the opposite order.
 *
 * Evidence is captured by **moving the existing entry aside**, never by copying it. A rename is
 * atomic, costs nothing for a large skills directory, and preserves a symlink as a symlink; the
 * backup is a sibling of the entry it replaces, so it is always on the same filesystem and a
 * restore can never fail for want of space. Undoing is therefore a rename back.
 *
 * Two honest limits, stated because the alternative is an unearned transactional claim:
 *
 * - The boundary covers a thrown error, not a killed task. Nothing here survives a host losing
 *   power mid-apply; the backups would simply be left on disk under their reserved prefix.
 * - A restore is refused when the destination has stopped being writable — an entry whose ancestor
 *   became a link out of the allowed roots is reported as unrestored rather than followed.
 */
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { DisplacedState, UnrestoredPath } from '../lib/provisioning.ts';

/**
 * What a destination looked like immediately after this batch wrote it, or that it was left absent.
 *
 * A directory is summarised by everything beneath it, not by the directory itself. Its own inode
 * and timestamp do not move when a file two levels down is edited, so a root-only seal would call
 * a tree unchanged while somebody's work sat inside it — and the rollback would then delete that
 * work recursively while reporting the host fully restored.
 *
 * `fingerprint: undefined` means the destination could not be summarised within its bound. It never
 * compares equal, so an unsummarisable tree is reported rather than removed on a guess.
 */
type Seal = { readonly present: false } | { readonly present: true; readonly fingerprint: string | undefined };

/** How many entries a tree seal will describe before it gives up and refuses to claim knowledge. */
const MAX_SEAL_ENTRIES = 2000;
/** How large a file may be before its identity rests on size and timestamps rather than content. */
const MAX_DIGEST_BYTES = 4 * 1024 * 1024;

interface JournalEntryBase {
  readonly path: string;
  /** Set once the operation that claimed this path has finished writing it. */
  seal?: Seal;
}

type JournalEntry = JournalEntryBase &
  (
    | { readonly kind: 'restore'; readonly backup: string }
    | { readonly kind: 'remove' }
    /**
     * `mode` is the prior mode to put back; `left` is the mode this apply set. Only the directory's
     * own permissions are recorded, never its contents: later operations write inside it by design,
     * so a content-aware seal here would report every ordinary apply as changed.
     */
    | { readonly kind: 'mode'; readonly mode: number; left?: number }
    | { readonly kind: 'rmdir' }
  );

/**
 * Reserved basename prefix for moved-aside evidence. A sweep that removes managed files has to skip
 * these: a backup of a managed wrapper still carries the managed marker, and deleting it would
 * destroy the only copy of what the sweep is meant to be able to undo.
 */
const BACKUP_PREFIX = '.fy-fleet-backup-';

/** Reserved basename prefix for state a rollback moved out of the way instead of deleting. */
const DISPLACED_PREFIX = '.fy-fleet-displaced-';

/** Whether a directory entry is this journal's own moved-aside evidence. */
export function isMutationBackupName(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX) || name.startsWith(DISPLACED_PREFIX);
}

const PERMISSION_BITS = 0o7777;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enough of one entry to notice any edit to it: identity, size, timestamp and permissions. */
function fingerprintOf(relative: string, information: Stats): string {
  // `ctimeMs` moves on a chmod and a chown as well as on a write, so it catches changes that leave
  // content and timestamps alone — but it also moves when the entry itself is renamed. The root of
  // a summary is exactly the entry rollback renames aside before re-examining it, so its ctime is
  // left out there and every entry beneath it, which a parent rename does not touch, keeps it.
  // What the root loses is made up by hashing its content: see `contentDigest`.
  const changed = relative === '' ? '' : `:${information.ctimeMs}`;
  return `${relative}:${information.ino}:${information.size}:${information.mtimeMs}${changed}:${information.mode}`;
}

/**
 * A rename-stable identity for the content of a regular file.
 *
 * Dropping `ctimeMs` from the root of a fingerprint is what lets a displaced entry be compared with
 * the seal taken before it was renamed — but it also drops the one field that would notice a
 * same-size, same-mtime rewrite in place. Hashing the bytes restores that, and a hash does not care
 * that the file has been renamed.
 *
 * Bounded: past the limit the size and timestamps stand alone, and the comment above is the honest
 * statement of what that leaves unproven.
 */
async function contentDigest(target: string, size: number): Promise<string> {
  if (size > MAX_DIGEST_BYTES) return `unhashed:${size}`;
  return new Bun.CryptoHasher('sha256').update(await readFile(target)).digest('hex');
}

/** Describe everything beneath a directory, or report that it is larger than the bound allows. */
async function summarise(directory: string, prefix: string, parts: string[]): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (parts.length >= MAX_SEAL_ENTRIES) return true;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const child = path.join(directory, entry.name);
    const information = await lstat(child);
    parts.push(fingerprintOf(relative, information));
    if (information.isDirectory() && (await summarise(child, relative, parts))) return true;
  }
  return false;
}

export class FileMutationJournal {
  readonly #entries: JournalEntry[] = [];
  readonly #captured = new Set<string>();
  readonly #displaced: DisplacedState[] = [];

  /**
   * @param assertWritable Containment check re-run at restore time. It must not follow the final
   *   component, so an entry replaced by a link is judged on where it sits, not on where it points.
   */
  constructor(private readonly assertWritable: (target: string) => Promise<void>) {}

  /** Mark where the next operation's captures begin, so they can be sealed together. */
  beginOperation(): number {
    return this.#entries.length;
  }

  /**
   * Where the entry captured from `target` was moved to, or `undefined` when nothing was there.
   *
   * This is how a caller inspects what it displaced without racing anybody: the capture already
   * renamed it out of reach, so the backup cannot change under the inspection.
   */
  backupOf(target: string): string | undefined {
    const resolved = path.resolve(target);
    const entry = this.#entries.findLast(candidate => candidate.path === resolved);
    return entry?.kind === 'restore' ? entry.backup : undefined;
  }

  /**
   * Record what each destination this operation claimed now looks like. Rollback compares against
   * these seals and refuses to touch anything that has changed since — a destination that someone
   * else has rewritten holds their evidence, not ours, and undoing over it would be a second loss
   * on top of the failure being recovered from.
   */
  async sealOperation(from: number): Promise<void> {
    for (const entry of this.#entries.slice(from)) {
      if (entry.kind === 'rmdir') continue;
      if (entry.kind === 'mode') {
        entry.left = await this.modeOf(entry.path);
        continue;
      }
      entry.seal = await this.identify(entry.path);
    }
  }

  private async modeOf(target: string): Promise<number | undefined> {
    try {
      return (await lstat(target)).mode & PERMISSION_BITS;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return undefined;
    }
  }

  private async identify(target: string): Promise<Seal> {
    let information: Awaited<ReturnType<typeof lstat>>;
    try {
      information = await lstat(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { present: false };
    }
    if (information.isFile()) {
      return {
        present: true,
        fingerprint: `${fingerprintOf('', information)}:${await contentDigest(target, information.size)}`,
      };
    }
    if (!information.isDirectory()) return { present: true, fingerprint: fingerprintOf('', information) };

    const parts = [fingerprintOf('', information)];
    const overflowed = await summarise(target, '', parts);
    return { present: true, fingerprint: overflowed ? undefined : parts.toSorted().join('\n') };
  }

  /** Whether a destination still holds exactly what this batch left there. */
  private async isUnchanged(entry: JournalEntry): Promise<boolean> {
    const current = await this.identify(entry.path);
    const seal = entry.seal;
    // Unsealed means the operation that claimed this path threw part-way through, so this batch
    // never learned what it left behind. An absent path is unambiguously safe to reclaim; anything
    // present might have been put there by someone else in the meantime, and guessing wrong
    // destroys their evidence. Refuse, and let it be reported.
    if (seal === undefined) return !current.present;
    if (!seal.present || !current.present) return seal.present === current.present;
    // An unsummarisable tree never matches: not knowing is not the same as knowing it is ours.
    return seal.fingerprint !== undefined && seal.fingerprint === current.fingerprint;
  }

  /**
   * Record what currently occupies `target`, then clear it out of the way. The first capture of a
   * path wins: a later operation in the same batch overwrites something this batch already wrote,
   * and rollback has to reach the state the batch started from, not an intermediate one.
   */
  async capture(target: string): Promise<boolean> {
    const resolved = path.resolve(target);
    // Already captured by an earlier operation in this batch, so whatever occupies the path now is
    // this batch's own work. The caller is told, because clearing it is then safe and clearing
    // anything else would be destroying a stranger's file.
    if (this.#captured.has(resolved)) return false;
    this.#captured.add(resolved);

    try {
      await lstat(resolved);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.#entries.push({ kind: 'remove', path: resolved });
      return true;
    }

    const backup = path.join(path.dirname(resolved), `${BACKUP_PREFIX}${randomUUID()}`);
    await rename(resolved, backup);
    this.#entries.push({ kind: 'restore', path: resolved, backup });
    return true;
  }

  /**
   * Record the directories a recursive create is about to bring into existence, and the mode an
   * already-present directory is about to lose. Ancestors are recorded outermost-first so the
   * reverse-order undo removes the deepest one first.
   */
  async captureDirectory(target: string, mode?: number): Promise<void> {
    const resolved = path.resolve(target);
    const created: string[] = [];
    let cursor = resolved;

    for (;;) {
      try {
        const information = await lstat(cursor);
        if (cursor === resolved && mode !== undefined && information.isDirectory()) {
          this.#entries.push({ kind: 'mode', path: resolved, mode: information.mode & PERMISSION_BITS });
        }
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        created.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }

    for (const directory of created.toReversed()) this.#entries.push({ kind: 'rmdir', path: directory });
  }

  /**
   * Put every captured entry back, newest first, and report the ones that could not be verified.
   * A failure on one entry never stops the rest: partial restoration of a host is strictly better
   * than abandoning it, and the paths left behind are named rather than summarised.
   *
   * Nothing is cleaned up here. A successful restore consumes its own backup — the rename moves it
   * back — so the only backups still on disk afterwards are the ones belonging to paths that could
   * not be restored, and those are the sole surviving copy of the original. Deleting them to tidy
   * up would turn "unknown state, here is where your data is" into plain data loss.
   */
  async rollback(): Promise<{
    readonly unrestored: readonly UnrestoredPath[];
    readonly displaced: readonly DisplacedState[];
  }> {
    const unrestored: UnrestoredPath[] = [];
    for (const entry of this.#entries.toReversed()) {
      try {
        await this.assertWritable(entry.path);
        await this.undo(entry);
      } catch (error) {
        unrestored.push({
          path: entry.path,
          reason: reasonOf(error),
          ...(entry.kind === 'restore' ? { backup: entry.backup } : {}),
        });
      }
    }
    return { unrestored, displaced: [...this.#displaced] };
  }

  /**
   * Drop the moved-aside evidence, once the batch it protects has committed.
   *
   * Best-effort by construction: the batch has already succeeded, so a backup that resists removal
   * is an inert file under a reserved prefix, not a reason to report the commit as a failure.
   */
  async discard(): Promise<readonly string[]> {
    const remaining: string[] = [];
    for (const entry of this.#entries) {
      if (entry.kind !== 'restore') continue;
      try {
        await rm(entry.backup, { recursive: true, force: true });
      } catch {
        remaining.push(entry.backup);
      }
    }
    return remaining;
  }

  private async undo(entry: JournalEntry): Promise<void> {
    if (entry.kind === 'restore') {
      if (!(await this.isUnchanged(entry))) {
        throw new Error(
          `refusing to overwrite ${entry.path}: it changed after this apply wrote it, so the original was left at ${entry.backup}`,
        );
      }
      await this.clear(entry);
      await rename(entry.backup, entry.path);
      return;
    }
    if (entry.kind === 'remove') {
      if (!(await this.isUnchanged(entry))) {
        throw new Error(`refusing to remove ${entry.path}: it changed after this apply created it`);
      }
      await this.clear(entry);
      return;
    }
    if (entry.kind === 'mode') {
      // `chmod` follows a link. If the directory whose mode was captured is now a symlink, applying
      // the old mode would land on whatever it points at — possibly outside the allowed roots — so
      // the entry is reported unverified instead.
      const information = await lstat(entry.path);
      if (!information.isDirectory()) {
        throw new Error(`refusing to restore the mode of an entry that is no longer a directory: ${entry.path}`);
      }
      // Undoing a mode change is only ours to undo while the mode is still the one this apply set.
      // Somebody who has since chosen their own is not corrected by a rollback.
      if (entry.left !== undefined && (information.mode & PERMISSION_BITS) !== entry.left) {
        throw new Error(`refusing to restore the mode of ${entry.path}: it changed after this apply set it`);
      }
      await chmod(entry.path, entry.mode);
      return;
    }
    await this.removeCreatedDirectory(entry.path);
  }

  /**
   * Free a destination without ever deleting live state.
   *
   * The seal was checked a moment ago, and a moment is enough for a writer to change the tree —
   * a recursive delete decided on a stale digest is the same data loss the digest exists to
   * prevent. So the entry is *renamed* out of the way first, which is atomic and unreachable to
   * anyone else afterwards, and only then re-examined: if the displaced copy is still exactly what
   * this apply wrote, it is dropped; if it is not, it is kept and named.
   */
  private async clear(entry: JournalEntry): Promise<void> {
    const displaced = path.join(path.dirname(entry.path), `${DISPLACED_PREFIX}${randomUUID()}`);
    try {
      await rename(entry.path, displaced);
    } catch (error) {
      // Already gone, which is the state this was trying to reach.
      if (isMissing(error)) return;
      throw error;
    }
    // Recorded the instant the rename succeeds, before anything that can fail. State that has been
    // moved and not reported is state nobody can find; the record is withdrawn below only once it
    // is proven to be this apply's own work and actually removed.
    this.#displaced.push({ path: entry.path, movedTo: displaced });

    const settled = await this.identify(displaced);
    const seal = entry.seal;
    if (seal === undefined || !seal.present || !settled.present || seal.fingerprint !== settled.fingerprint) return;
    await rm(displaced, { recursive: true, force: true });
    this.#displaced.pop();
  }

  /**
   * Remove a directory this batch created, but only while it is still empty. Anything that arrived
   * inside it since is someone else's, and reverting a fleet write is never a licence to delete it.
   *
   * Refusing to delete it is still a failure to restore, though, and it is reported as one: the
   * host had no such directory before this apply and now has one. Swallowing that would let a
   * rollback claim the host is exactly as it was while a directory — and whatever a concurrent
   * writer put in it — remains.
   */
  private async removeCreatedDirectory(target: string): Promise<void> {
    try {
      await rmdir(target);
    } catch (error) {
      if (isMissing(error)) return;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new Error(`refusing to remove ${target}: this apply created it but it is no longer empty`);
      }
      if (code === 'ENOTDIR') {
        throw new Error(`refusing to remove ${target}: this apply created a directory and it is no longer one`);
      }
      throw error;
    }
  }
}
