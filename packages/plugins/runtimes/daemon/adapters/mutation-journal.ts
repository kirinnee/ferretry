/**
 * A reverse-order undo log for one batch of fleet-folder mutations, over the kernel's `fleet` root.
 *
 * A batch that threw on its tenth write used to leave the first nine landed with nothing said about them. This journal
 * closes that gap: a caller records what it is about to destroy immediately before destroying it, and can then put
 * every entry back in the opposite order.
 *
 * Evidence is captured by **moving the existing entry aside** (`RootHandle.rename`), never by copying it. A rename is
 * atomic, costs nothing for a large skills folder, and moves a link AS A LINK (it is never followed, so the credential
 * a runtime home links to is never read or copied); the backup is a sibling of the entry it replaces, so a restore is a
 * rename back and can never fail for want of space.
 *
 * Honest limits, stated because the alternative is an unearned transactional claim:
 *
 *  - The boundary covers a thrown error, not a killed task. A daemon that dies mid-apply leaves its backups under their
 *    reserved prefix and its claim on disk, named; nothing recovers them on its own (`ports-pending.json`).
 *  - A restore is refused when the folder it was in stopped being the folder the capture used (it is identified when
 *    first used and compared every time after), and when what is at the name is no longer what this batch wrote. The
 *    seal that proves it is the entry's size, time and mode (and its bytes, for a file), not its inode or change time,
 *    which a root does not show: an edit that keeps all of them the same is not noticed.
 *  - The rename that restores refuses a name that has been taken since (a look then the move, the kernel's declared GAP):
 *    it reports the entry instead of replacing what arrived.
 */
import { randomUUID } from 'node:crypto';
import type { RootEntry } from '@ferretry/kernel/contract';
import type { DisplacedState, UnrestoredPath } from '../lib/provisioning.ts';
import type { FleetDisk } from './fleet-disk.ts';
import type { MutationJournal } from './ports.ts';

/** What a destination looked like right after this batch wrote it, or that it was left absent. */
type Seal = { readonly present: false } | { readonly present: true; readonly fingerprint: string | undefined };

/** How many entries a tree seal describes before it refuses to claim knowledge. A bound on work, not on memory. */
const MAX_SEAL_ENTRIES = 200_000;
/** How large a file may be before its seal rests on size and time rather than content. */
const MAX_DIGEST_BYTES = 4 * 1024 * 1024;
const PERMISSION_BITS = 0o7777;

interface JournalEntryBase {
  readonly path: string;
  /** The folder holding `path`, as first used; every later step must find the same one. */
  folder?: string;
  /** Set once the operation that claimed this path has finished writing it. */
  seal?: Seal;
}

type JournalEntry = JournalEntryBase &
  (
    | { readonly kind: 'restore'; readonly backup: string }
    | { readonly kind: 'remove' }
    /** `mode` is the prior mode to put back; `left` is the mode this apply set. */
    | { readonly kind: 'mode'; readonly mode: number; left?: number }
    | { readonly kind: 'rmdir' }
  );

/** Moved-aside evidence: a sweep that removes managed files must skip these, or it destroys the only copy. */
const BACKUP_PREFIX = '.fy-fleet-backup-';
/** State a rollback moved out of the way instead of deleting. */
const DISPLACED_PREFIX = '.fy-fleet-displaced-';
/** A replacement built beside its destination before it is published. */
export const STAGE_PREFIX = '.fy-fleet-staged-';

const RESERVED_PREFIXES = [BACKUP_PREFIX, DISPLACED_PREFIX, STAGE_PREFIX] as const;

/** Whether a directory entry is the mutation machinery's own: moved-aside evidence, displaced state or a staged copy. */
export function isMutationReservedName(name: string): boolean {
  return RESERVED_PREFIXES.some(prefix => name.startsWith(prefix));
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')));

/** Enough of one entry to notice an edit to it: kind, size, time, mode. */
const fingerprintOf = (relative: string, found: Pick<RootEntry, 'kind' | 'size' | 'modified' | 'mode'>): string =>
  `${relative}:${found.kind}:${found.size}:${found.modified}:${found.mode & PERMISSION_BITS}`;

export class FileMutationJournal implements MutationJournal {
  readonly #entries: JournalEntry[] = [];
  readonly #captured = new Set<string>();
  readonly #displaced: DisplacedState[] = [];

  /**
   * @param assertWritable Containment re-run at restore time, so an entry judged on where it sits.
   */
  constructor(
    private readonly disk: FleetDisk,
    private readonly assertWritable: (target: string) => Promise<void>,
  ) {}

  /** Mark where the next operation's captures begin, so they can be sealed together. */
  beginOperation(): number {
    return this.#entries.length;
  }

  /**
   * Runs `read` with what the capture of `target` moved aside: the folder it is in (to read THROUGH) and its name
   * there. `undefined` when nothing was there. The backup cannot change under the inspection: the capture already
   * moved it out of everyone's reach.
   */
  async withBackup<T>(target: string, read: (backup: string) => Promise<T>): Promise<T | undefined> {
    const entry = this.#entries.findLast(candidate => candidate.path === target);
    if (entry?.kind !== 'restore') return undefined;
    await this.#sameFolder(entry);
    return await read(entry.backup);
  }

  /** The folder of `entry` must be the folder first used for it. */
  async #sameFolder(entry: JournalEntry): Promise<void> {
    const folder = dirname(entry.path);
    const now = await this.disk.identity(folder);
    if (entry.folder === undefined) {
      if (now !== undefined) entry.folder = now;
      return;
    }
    if (now !== entry.folder) {
      throw new Error(`refusing to touch ${entry.path}: the folder it is in was replaced after this apply wrote there`);
    }
  }

  /** Record what each destination this operation claimed now looks like. Rollback compares against these seals. */
  async sealOperation(from: number): Promise<void> {
    for (const entry of this.#entries.slice(from)) {
      if (entry.kind === 'rmdir') continue;
      if (entry.kind === 'mode') {
        entry.left = (await this.disk.lstat(entry.path))?.mode;
        continue;
      }
      await this.#sameFolder(entry);
      entry.seal = await this.#identify(entry.path);
    }
  }

  /** What `target` holds. A tree is summarised by everything beneath it; a file by its bytes too. */
  async #identify(target: string): Promise<Seal> {
    const found = await this.disk.lstat(target);
    if (found === undefined) return { present: false };
    if (found.kind === 'file') {
      const digest =
        found.size > MAX_DIGEST_BYTES
          ? `unhashed:${found.size}`
          : new Bun.CryptoHasher('sha256').update(await this.disk.readBytes(target, MAX_DIGEST_BYTES)).digest('hex');
      return { present: true, fingerprint: `${fingerprintOf('', found)}:${digest}` };
    }
    if (found.kind !== 'directory') return { present: true, fingerprint: fingerprintOf('', found) };
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(`${fingerprintOf('', found)}\n`);
    const walk = { visited: 0 };
    const overflowed = await this.#summarise(target, '', hasher, walk);
    return { present: true, fingerprint: overflowed ? undefined : hasher.digest('hex') };
  }

  /** Folds everything beneath a folder into the running seal; `true` when the work bound was reached. */
  async #summarise(
    directory: string,
    prefix: string,
    hasher: Bun.CryptoHasher,
    walk: { visited: number },
  ): Promise<boolean> {
    const found = await this.disk.entries(directory);
    for (const entry of found.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (walk.visited >= MAX_SEAL_ENTRIES) return true;
      walk.visited += 1;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      hasher.update(`${fingerprintOf(relative, entry)}\n`);
      if (entry.kind === 'directory' && (await this.#summarise(`${directory}/${entry.name}`, relative, hasher, walk)))
        return true;
    }
    return false;
  }

  /** Whether a destination still holds exactly what this batch left there. */
  async #isUnchanged(entry: JournalEntry): Promise<boolean> {
    const current = await this.#identify(entry.path);
    const seal = entry.seal;
    // Unsealed: the operation that claimed this path threw part-way. An absent path is safe to reclaim; anything
    // present might be somebody else's. Refuse, and let it be reported.
    if (seal === undefined) return !current.present;
    if (!seal.present || !current.present) return seal.present === current.present;
    // An unsummarisable tree never matches: not knowing is not the same as knowing it is ours.
    return seal.fingerprint !== undefined && seal.fingerprint === current.fingerprint;
  }

  /**
   * Record what currently occupies `target`, then move it out of the way. The first capture of a path wins: a later
   * operation in the same batch overwrites something this batch already wrote, and a rollback has to reach the state
   * the batch started from. Answers `false` when the path was already captured (what is there is this batch's own).
   */
  async capture(target: string): Promise<boolean> {
    if (this.#captured.has(target)) return false;
    const record = (entry: JournalEntry): true => {
      this.#entries.push(entry);
      this.#captured.add(target);
      return true;
    };
    const folder = await this.disk.identity(dirname(target));
    const base = folder === undefined ? {} : { folder };
    if ((await this.disk.lstat(target)) === undefined) return record({ kind: 'remove', path: target, ...base });
    const backup = `${dirname(target)}/${BACKUP_PREFIX}${randomUUID()}`;
    await this.disk.rename(target, backup);
    return record({ kind: 'restore', path: target, backup, ...base });
  }

  /**
   * Record the folders a create is about to bring into existence, and the mode an already-present folder is about to
   * lose. Ancestors are recorded outermost-first so the reverse-order undo removes the deepest one first.
   *
   * A link in the final position is refused whenever a mode is being set: the kernel never follows it, and neither
   * does the undo.
   */
  async captureDirectory(target: string, mode?: number): Promise<void> {
    const created: string[] = [];
    let cursor = target;
    for (;;) {
      const found = await this.disk.lstat(cursor);
      if (found !== undefined) {
        if (cursor === target && mode !== undefined) {
          if (found.kind === 'symlink') {
            throw new Error(
              `refusing to set the mode of ${target}: it is a symbolic link, and the mode would change what it points at`,
            );
          }
          if (found.kind === 'directory')
            this.#entries.push({ kind: 'mode', path: target, mode: found.mode & PERMISSION_BITS });
        }
        break;
      }
      created.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor || !this.disk.contains(parent)) break;
      cursor = parent;
    }
    for (const directory of created.toReversed()) this.#entries.push({ kind: 'rmdir', path: directory });
  }

  /**
   * Put every captured entry back, newest first, and report the ones that could not be verified. A failure on one entry
   * never stops the rest: partial restoration is strictly better than abandoning the host, and the paths left behind are
   * named. Nothing is cleaned up here: the backups still on disk afterwards belong to paths that could not be restored,
   * and are the sole surviving copy of the original.
   */
  async rollback(): Promise<{
    readonly unrestored: readonly UnrestoredPath[];
    readonly displaced: readonly DisplacedState[];
  }> {
    const unrestored: UnrestoredPath[] = [];
    for (const entry of this.#entries.toReversed()) {
      try {
        await this.assertWritable(entry.path);
        await this.#undo(entry);
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
   * Drop the moved-aside evidence once the batch it protects has committed. Best effort by construction: the batch has
   * succeeded, so a backup that resists removal is an inert file under a reserved prefix, not a failed commit. Each is
   * removed from the folder it was moved aside in, and only after that folder is checked to be the recorded one.
   */
  async discard(): Promise<readonly string[]> {
    const remaining: string[] = [];
    for (const entry of this.#entries) {
      if (entry.kind !== 'restore') continue;
      try {
        await this.#sameFolder(entry);
        await this.disk.remove(entry.backup);
      } catch {
        remaining.push(entry.backup);
      }
    }
    return remaining;
  }

  async #undo(entry: JournalEntry): Promise<void> {
    if (entry.kind === 'restore') {
      await this.#sameFolder(entry);
      if (!(await this.#isUnchanged(entry))) {
        throw new Error(
          `refusing to overwrite ${entry.path}: it changed after this apply wrote it, so the original was left at ${entry.backup}`,
        );
      }
      await this.#clear(entry);
      await this.disk.rename(entry.backup, entry.path);
      return;
    }
    if (entry.kind === 'remove') {
      await this.#sameFolder(entry);
      if (!(await this.#isUnchanged(entry))) {
        throw new Error(`refusing to remove ${entry.path}: it changed after this apply created it`);
      }
      await this.#clear(entry);
      return;
    }
    if (entry.kind === 'mode') {
      const found = await this.disk.lstat(entry.path);
      if (found === undefined) throw new Error(`${entry.path} is gone`);
      // A link or a file where a folder was is not what the mode was taken from; the root would not follow it anyway.
      if (found.kind !== 'directory') {
        throw new Error(`refusing to restore the mode of an entry that is no longer a directory: ${entry.path}`);
      }
      // Undoing a mode change is only ours while the mode is still the one this apply set.
      if (entry.left !== undefined && found.mode !== entry.left) {
        throw new Error(`refusing to restore the mode of ${entry.path}: it changed after this apply set it`);
      }
      await this.disk.setMode(entry.path, entry.mode);
      return;
    }
    await this.#removeCreatedDirectory(entry.path);
  }

  /**
   * Take a path out of the live tree, then decide whether what was taken may be destroyed. THIS IS THE ONLY SHAPE IN
   * WHICH ANYTHING HERE IS DELETED, and the order is the whole point: checking a live path and then removing it has a gap,
   * and a writer who lands in it has their work deleted by a decision made about somebody else's bytes. Renaming first is
   * one atomic step, and what follows examines something no new writer can arrive at.
   *
   * That is unreachability, not immutability: a process that already holds a descriptor keeps it across the rename.
   *
   * `isOwnWork` answers the only question that licenses removal: is this still exactly what we put there? A `false`, or
   * a check that cannot tell, keeps the copy and leaves it named.
   */
  async displace(target: string, isOwnWork: (moved: string) => Promise<boolean>): Promise<void> {
    if ((await this.disk.lstat(target)) === undefined) return;
    const displaced = `${dirname(target)}/${DISPLACED_PREFIX}${randomUUID()}`;
    try {
      await this.disk.rename(target, displaced);
    } catch (error) {
      // Gone between the look and the move, which is the state this was trying to reach.
      if ((await this.disk.lstat(target)) === undefined) return;
      throw error;
    }
    this.#displaced.push({ path: target, movedTo: displaced });
    if (!(await isOwnWork(displaced))) return;
    await this.disk.remove(displaced);
    this.#displaced.splice(
      this.#displaced.findIndex(state => state.movedTo === displaced),
      1,
    );
  }

  /** Free a destination without ever deleting live state: `displace` with the seal as its evidence. */
  async #clear(entry: JournalEntry): Promise<void> {
    await this.displace(entry.path, async displaced => {
      // No seal, or a seal saying nothing was here, is not evidence that what was just moved is ours.
      const seal = entry.seal;
      if (seal === undefined || !seal.present) return false;
      const settled = await this.#identify(displaced);
      // Both fingerprints absent is two admissions of not knowing; `undefined === undefined` must not license a delete.
      return settled.present && seal.fingerprint !== undefined && seal.fingerprint === settled.fingerprint;
    });
  }

  /**
   * Remove a folder this batch created, but only while it is still empty. Anything that arrived inside it since is
   * someone else's. Refusing is still a failure to restore and is reported as one.
   */
  async #removeCreatedDirectory(target: string): Promise<void> {
    const found = await this.disk.lstat(target);
    if (found === undefined) return;
    if (found.kind !== 'directory') {
      throw new Error(`refusing to remove ${target}: this apply created a directory and it is no longer one`);
    }
    // Taken out of the live tree first, then judged empty: the root removes a tree whole, so the emptiness is decided
    // on a folder nobody can reach by its old name, and a folder with anything in it goes back where it was.
    const aside = `${dirname(target)}/${DISPLACED_PREFIX}${randomUUID()}`;
    await this.disk.rename(target, aside);
    if ((await this.disk.entries(aside)).length === 0) {
      await this.disk.remove(aside);
      return;
    }
    await this.disk.rename(aside, target).catch(() => {
      this.#displaced.push({ path: target, movedTo: aside });
    });
    throw new Error(`refusing to remove ${target}: this apply created it but it is no longer empty`);
  }
}
