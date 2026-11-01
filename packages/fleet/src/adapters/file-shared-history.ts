import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, readSync, writeSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessKind } from '../lib/manifest.ts';
import {
  type ConversationHolderStanding,
  type ConversationId,
  type ConversationLeaseClaim,
  type ConversationLeaseRecord,
  ConversationLeaseRecordSchema,
  type ConversationLeaseStore,
  ConversationLeaseUnavailableError,
  ConversationIdSchema,
  conversationLeaseDirectory,
  decideConversationLease,
  SharedHistoryAccessRefusedError,
  SharedHistoryUnavailableError,
  type SharedHistoryFileSystem,
  type SharedHistoryNode,
  type SharedHistorySymbolicLinkNode,
} from '../lib/shared-history.ts';
import type { FileIdentity, FolderDisk, GuardDisk, GuardedFolder } from '../lib/state-home-guard.ts';
import { DestinationFolders, readFolderFile } from './destination-folders.ts';
import { resolveSourceFence, type SourceFence } from './fenced-source.ts';
import { type FileLock, loadFileLock } from './link-syscall.ts';
import { NodeGuardDisk } from './node-guard-disk.ts';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A missing ancestor and an ancestor that is not a directory both end canonical resolution. */
function endsResolution(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The canonical form of a directory, or of its nearest existing ancestor plus the missing tail. */
async function canonicalDirectory(directory: string): Promise<string> {
  const parent = path.dirname(directory);
  if (parent === directory) return directory;
  try {
    return await realpath(directory);
  } catch (error) {
    if (!endsResolution(error)) throw error;
    return path.join(await canonicalDirectory(parent), path.basename(directory));
  }
}

/**
 * The canonical form of `target`, whose own final component is never followed.
 *
 * Containment has to be decided on real paths. Every ancestor is resolved through its symbolic
 * links, so a link planted anywhere above the final component cannot smuggle an operation out of an
 * allowed root, and a path that does not exist yet is still confined by the deepest ancestor that
 * does. The final component stays lexical because these operations act on a link itself — creating,
 * inspecting or removing it — rather than on whatever it points at.
 */
async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(await canonicalDirectory(parent), path.basename(resolved));
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith(`..${path.sep}`) && fromRoot !== '..' && !path.isAbsolute(fromRoot));
}

/**
 * Keeping the inode is the only legal move: a copy would hand every open reader a different one.
 *
 * Two errno values need translating rather than surfacing raw. EXDEV is the one that tempts a caller
 * into copy-then-delete; the planner already refuses a cross-device move from observed device
 * evidence before anything is written, and this is the last-resort guard for a mount that appeared
 * in between. EEXIST is the atomic no-clobber that `link(2)` gives a regular file, and it is phrased
 * exactly like the observation that precedes it so a caller cannot tell whether the collision was
 * seen a moment early or refused by the kernel.
 *
 * Exported because provoking either for real needs a second filesystem or an injected race that no
 * test can assume: the decision is proved here, and `move` is proved to route its failures through
 * it by the failures it passes on.
 */
export function sharedHistoryMoveRefusal(error: unknown, source: string, destination: string): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') return new Error(`shared-history move destination already exists: ${destination}`);
  if (code !== 'EXDEV') return error;
  return new Error(
    `refusing to copy shared history across filesystems: ${source} -> ${destination}; copying is forbidden because a new inode would silently orphan every transcript a running harness already has open`,
  );
}

function exclusiveRefusal(error: unknown, target: string): unknown {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return error;
  return new Error(`shared-history exclusive write refused an existing path: ${target}`);
}

/** Every folder the migration and the lease store make, as private to the account as the pool. */
const FOLDER_MODE = 0o700;

/**
 * The checked folder at `directory`, or `undefined` when it is not there. Only ENOENT means not there: a name the
 * guard could not reach as a folder but that IS there (a link that loops, one made in between) is refused, and a
 * folder that cannot be reached for another reason surfaces that reason.
 */
async function existingFolder(
  folders: DestinationFolders,
  directory: string,
  what: string,
): Promise<GuardedFolder | undefined> {
  const folder = await folders.existing(directory);
  if (folder !== undefined) return folder;
  const there = await lstat(directory).then(
    () => true,
    (error: unknown) => {
      if (!isMissing(error)) throw error;
      return false;
    },
  );
  if (there)
    throw new Error(`refusing to read ${what} at ${directory}: it is there, but not as a folder the guard can reach`);
  return undefined;
}

/**
 * The checked folder at `directory` (as `reach` answers it, `undefined` when not there), made first when it is not
 * there: each missing folder is made THROUGH its checked parent, and the parent synced so the new name is durable.
 * The caller closes it.
 */
async function madeFolder(
  folders: DestinationFolders,
  directory: string,
  reach: (directory: string) => Promise<GuardedFolder | undefined>,
): Promise<GuardedFolder> {
  const missing: string[] = [];
  let at = path.resolve(directory);
  let folder = await reach(at);
  while (folder === undefined) {
    missing.unshift(path.basename(at));
    at = path.dirname(at);
    folder = await reach(at);
  }
  for (const segment of missing) {
    const parent: GuardedFolder = folder;
    try {
      folder = await folders.child(parent, segment, path.join(parent.path, segment), FOLDER_MODE);
      await syncFolder(parent);
    } finally {
      await parent.close();
    }
  }
  return folder;
}

/** Make a folder's new, renamed or removed names durable: `fsync` through its held descriptor, never by path. */
async function syncFolder(folder: GuardedFolder): Promise<void> {
  await folder.sync();
}

/** Write every byte to a raw descriptor (at its offset, or at its end when opened to append). */
function writeAll(descriptor: number, bytes: Uint8Array): void {
  for (let written = 0; written < bytes.byteLength; )
    written += writeSync(descriptor, bytes, written, bytes.byteLength - written);
}

/**
 * Real filesystem primitives for the shared-history planner.
 *
 * Every path is confined to a root supplied by the composition root, and confinement is decided on
 * the canonical path — the nearest existing ancestor resolved through its symbolic links — so no
 * link above the final component can move an operation outside the allowed roots. `snapshot` uses
 * lstat and never follows a symbolic link: a foreign link is evidence to preserve, not an empty
 * directory to replace. Only ENOENT means absent; permission, truncation and type failures refuse
 * the migration.
 *
 * **Nothing below a folder is reached by path.** The trees this moves — an account's history folders and the pool its
 * links lead into — are written by the harnesses, so by the agents they run: any folder in them can be swapped for a
 * link into the state home the moment after it was looked at. So every read, write, rename, unlink, rmdir and link is
 * made through a folder opened and checked by the state-home guard (`./destination-folders.ts`): inside a home each
 * folder is walked from the home down without following a link, anywhere else the real path is walked from `/` the
 * same way, a folder that is a home or one of its key files by identity is refused, and the step reaches its entry
 * THROUGH the held descriptor (Linux `/proc`, macOS descriptor calls). A swapped folder is refused, never followed, so
 * nothing in the home is moved, read into the pool, or removed, and every folder is synced through its descriptor too.
 * Where descriptor reach cannot be loaded at all, the migration is not made rather than made by path
 * (`SharedHistoryUnavailableError`): a provisioner apply goes on without it and reports it as skipped. `deviceIdOf` and `canonicalDirectoryOf` stay path reads: they only
 * inform the plan, and every step it then takes is made as above.
 *
 * Every mutation is durable before it returns — the bytes, and the directory entry that names them,
 * including both parents of a rename. That is what lets the caller's progress cursor mean something
 * after a crash: an action the cursor counts really did survive.
 */
export class FileSharedHistoryFileSystem implements SharedHistoryFileSystem {
  private readonly allowedRoots: readonly string[];

  /**
   * `fence`: the daemon's state homes (and their key files), which no step may reach into — absent, no home is judged
   * and every step still goes through a checked folder. `disk`: how folders are reached; a test names one.
   */
  constructor(
    allowedRoots: readonly string[],
    private readonly fence?: SourceFence,
    private readonly disk: GuardDisk & FolderDisk = new NodeGuardDisk(),
  ) {
    if (allowedRoots.length === 0) throw new Error('at least one allowed shared-history root is required');
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  async snapshot(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    return await this.within(folders, path.dirname(target), async folder =>
      folder === undefined ? undefined : await this.observe(folders, folder, path.basename(target), options),
    );
  }

  /**
   * The device a rename involving this path would have to work on.
   *
   * A path that exists answers for itself, and it answers with its own inode: a symbolic link is
   * renamed as the link, never as whatever it points at. A path that does not exist yet — the pool,
   * on the first apply — is answered by the nearest ancestor that does, resolved THROUGH its
   * symbolic links, because that resolved directory is where the kernel will create the new name.
   * Reading a link ancestor's own inode instead would name the wrong filesystem and let a
   * cross-device rename slip past the preflight.
   */
  async deviceIdOf(target: string): Promise<number> {
    await this.assertAllowedPath(target);
    const resolved = path.resolve(target);
    // Through the same disk every step uses: the entry itself, else its nearest existing ancestor as resolved.
    const own = await this.disk.identity(resolved);
    if (own !== undefined) return Number(own.device);
    let current = path.dirname(resolved);
    for (;;) {
      const parent = path.dirname(current);
      try {
        const real = await this.disk.realpath(current);
        const found = await this.disk.identity(real);
        if (found !== undefined) return Number(found.device);
      } catch (error) {
        if (!endsResolution(error) || parent === current) throw error;
      }
      current = parent;
    }
  }

  /**
   * The real directory a path names, its own final component resolved along with every ancestor.
   *
   * This is the one place that deliberately follows the final link, and it exists so the planner can
   * decide identity rather than spelling: `real/a` and `alias/a` are one home, and only a resolved
   * path says so. It reads and never writes, and the resolved directory is confined exactly like the
   * path that was asked for — a home linked out of the writable roots becomes a refusal here rather
   * than a directory the migration would go on to move things out of.
   */
  async canonicalDirectoryOf(target: string): Promise<string> {
    await this.assertAllowedPath(target);
    const canonical = await canonicalDirectory(path.resolve(target));
    await this.assertAllowedPath(canonical);
    return canonical;
  }

  async ensureDirectory(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    const existing = await this.within(folders, path.dirname(target), async folder =>
      folder === undefined ? undefined : await folder.describe(path.basename(target)),
    );
    if (existing !== undefined && existing.kind !== 'directory') {
      throw new Error(`shared-history directory path is ${kindOf(existing)}: ${target}`);
    }
    await (await this.durable(folders, target)).close();
  }

  async ensureFile(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    const folder = await this.durable(folders, path.dirname(target));
    const leaf = path.basename(target);
    try {
      let descriptor: number;
      try {
        descriptor = await folder.openFile(leaf, 'new', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await folder.describe(leaf);
        if (existing?.kind !== 'file') {
          throw new Error(`shared-history file path is ${kindOf(existing)}: ${target}`);
        }
        return;
      }
      // The empty file is itself the durable fact an ensure-entry action claims, so it is synced like
      // any other write before the caller's cursor is allowed to count it.
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      await syncFolder(folder);
    } finally {
      await folder.close();
    }
  }

  /**
   * Move one name to another without ever replacing what is already there.
   *
   * `rename(2)` is the obvious call and it silently replaces an existing regular file, so an
   * observation that the destination is free is a guard against the predictable collisions — a pool
   * entry left by an earlier run, a re-apply, two homes contributing the same name — and not against
   * a writer that creates that name in the window. `renameat2(RENAME_NOREPLACE)` would close it and
   * no Node or Bun API exposes it, so a regular file goes by `link(2)` then unlink instead: the link
   * fails EEXIST atomically rather than clobbering, and a hard link is by definition the same inode,
   * which is the whole point of not copying.
   *
   * Directories and symbolic links keep the rename, for reasons rather than convenience. `link` on a
   * directory is EPERM everywhere. `link` on a symbolic link source follows it on some platforms and
   * not others, so quarantining a foreign link — the case where following it is exactly the damage to
   * avoid — would be platform-dependent evidence destruction. Renaming onto an occupied directory
   * already fails, and onto an empty one removes nothing that holds bytes.
   *
   * The one thing the link path gives up is single-call atomicity: a crash between the link and the
   * unlink leaves the inode under both names. Nothing is lost or overwritten by that, the cursor has
   * not advanced past the action, and recovery reports it as possibly half applied — which is what it
   * is. That is a better failure than a file quietly replaced.
   *
   * Both names are reached through their checked folders, so the move happens between the two folders that were
   * checked, whatever their paths name by then.
   */
  async move(source: string, destination: string): Promise<void> {
    await this.assertAllowedPath(source);
    await this.assertAllowedPath(destination);
    const folders = await this.folders();
    const from = await this.reach(folders, path.dirname(source));
    if (from === undefined) throw new Error(`shared-history move source is absent: ${source}`);
    try {
      const leaf = path.basename(source);
      const existing = await from.describe(leaf);
      if (existing === undefined) throw new Error(`shared-history move source is absent: ${source}`);
      const into = await this.durable(folders, path.dirname(destination));
      try {
        const name = path.basename(destination);
        if ((await into.describe(name)) !== undefined) {
          throw new Error(`shared-history move destination already exists: ${destination}`);
        }
        if (existing.kind === 'file') {
          // Give a regular file its new name atomically, then take the old one away, syncing both parents.
          await into.link(from, leaf, name).catch((error: unknown) => {
            throw sharedHistoryMoveRefusal(error, source, destination);
          });
          await syncFolder(into);
          await from.unlink(leaf);
          await syncFolder(from);
          return;
        }
        await from.renameInto(leaf, into, name).catch((error: unknown) => {
          throw sharedHistoryMoveRefusal(error, source, destination);
        });
        // A rename changes two directories, and the old name is as important as the new one: syncing
        // only the destination can leave a crash with the same inode reachable from both places.
        await syncFolder(into);
        if (from.path !== into.path) await syncFolder(from);
      } finally {
        await into.close();
      }
    } finally {
      await from.close();
    }
  }

  async writeTextAtomic(target: string, text: string): Promise<void> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    const folder = await this.durable(folders, path.dirname(target));
    const leaf = path.basename(target);
    const temporary = `.${leaf}.${randomUUID()}.tmp`;
    try {
      const existing = await folder.describe(leaf);
      if (existing !== undefined && existing.kind !== 'file') {
        throw new Error(`shared-history text path is ${kindOf(existing)}: ${target}`);
      }
      const descriptor = await folder.openFile(temporary, 'new', 0o600);
      try {
        writeAll(descriptor, new TextEncoder().encode(text));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      await folder.rename(temporary, leaf);
      await syncFolder(folder);
    } finally {
      await folder.unlink(temporary).catch(() => undefined);
      await folder.close();
    }
  }

  /**
   * Create a file that must not already exist, and make its existence durable.
   *
   * The migration journal is only useful if an entry that was reported as written is still there
   * after a crash, so the bytes are synced and so is the directory entry that names them. An
   * existing path is refused rather than replaced: a journal that overwrites its own record of what
   * it was about to do cannot be replayed.
   */
  async writeTextExclusive(target: string, text: string): Promise<void> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    const folder = await this.durable(folders, path.dirname(target));
    try {
      const descriptor = await folder.openFile(path.basename(target), 'new', 0o600).catch((error: unknown) => {
        throw exclusiveRefusal(error, target);
      });
      try {
        writeAll(descriptor, new TextEncoder().encode(text));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      await syncFolder(folder);
    } finally {
      await folder.close();
    }
  }

  /**
   * Add to a regular file's text without replacing the file and without removing a byte of it.
   *
   * A pooled history file is open in live harness readers, so its inode has to survive the write —
   * and a live harness may also be appending to it. This therefore only ever appends: the file is
   * opened O_APPEND so every write lands at the end no matter who else grew it, and there is no
   * truncate anywhere, so a concurrent writer's lines cannot be erased by ours. The check is that
   * the file still BEGINS with the text the plan was computed from; growth past that prefix is
   * tolerated, a rewrite of it returns `false` so the domain can re-plan. Anything that is not a
   * regular file — a symbolic link most of all — is refused rather than followed.
   */
  async appendTextIfPrefix(target: string, expected: string, addition: string): Promise<boolean> {
    await this.assertAllowedPath(target);
    const folders = await this.folders();
    return await this.within(folders, path.dirname(target), async folder => {
      const leaf = path.basename(target);
      const existing = folder === undefined ? undefined : await folder.describe(leaf);
      if (folder === undefined || existing?.kind !== 'file') {
        throw new Error(`shared-history append expected a file, found ${kindOf(existing)}: ${target}`);
      }
      // Opened through the folder without following a link: a link swapped in after the look above fails the open
      // instead of being written through.
      const descriptor = await folder.openFile(leaf, 'append');
      try {
        // A FIFO opens without blocking; anything that is not a regular file is refused here, before a byte moves.
        if (!fstatSync(descriptor).isFile()) {
          throw new Error(`shared-history append expected a file, found something else: ${target}`);
        }
        const prefix = new TextEncoder().encode(expected);
        const seen = new Uint8Array(prefix.byteLength);
        const read = readSync(descriptor, seen, 0, seen.byteLength, 0);
        if (read !== prefix.byteLength || !prefix.every((byte, index) => byte === seen[index])) return false;
        writeAll(descriptor, new TextEncoder().encode(addition));
        fsyncSync(descriptor);
        return true;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  async createSymbolicLink(target: string, destination: string): Promise<void> {
    await this.assertAllowedPath(target);
    await this.assertAllowedPath(destination);
    if ((await this.snapshot(target, { recursive: false })) === undefined) {
      throw new Error(`refusing to create a dangling shared-history link: ${destination} -> ${target}`);
    }
    const folders = await this.folders();
    const folder = await this.durable(folders, path.dirname(destination));
    try {
      const leaf = path.basename(destination);
      if ((await folder.describe(leaf)) !== undefined) {
        throw new Error(`shared-history link destination already exists: ${destination}`);
      }
      await folder.symlink(target, leaf);
      await syncFolder(folder);
    } finally {
      await folder.close();
    }
  }

  async removeSymbolicLink(target: string, expectedTarget: string): Promise<void> {
    await this.assertAllowedPath(target);
    await this.removeFrom(target, 'symbolic-link', 'rollback expected a symbolic link', async (folder, leaf) => {
      if (path.resolve(path.dirname(target), await folder.readlink(leaf)) !== path.resolve(expectedTarget)) {
        throw new Error(`shared-history rollback refused a replaced symbolic link: ${target}`);
      }
      await folder.unlink(leaf);
    });
  }

  async removeEmptyDirectory(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    await this.removeFrom(target, 'directory', 'cleanup expected a directory', async (folder, leaf) => {
      await folder.rmdir(leaf);
    });
  }

  async removeFile(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    await this.removeFrom(target, 'file', 'cleanup expected a file', async (folder, leaf) => {
      await folder.unlink(leaf);
    });
  }

  /** Removes `target` through its checked folder, once it is the kind expected, and makes the removal durable. */
  private async removeFrom(
    target: string,
    kind: SharedHistoryNode['kind'],
    expectation: string,
    remove: (folder: GuardedFolder, leaf: string) => Promise<void>,
  ): Promise<void> {
    const folders = await this.folders();
    await this.within(folders, path.dirname(target), async folder => {
      const leaf = path.basename(target);
      const existing = folder === undefined ? undefined : await folder.describe(leaf);
      if (folder === undefined || existing === undefined || kindOf(existing) !== kind) {
        throw new Error(`shared-history ${expectation}: ${target}`);
      }
      await remove(folder, leaf);
      await syncFolder(folder);
    });
  }

  /**
   * Read one entry of a checked folder, and its children when it is a directory, without following any symbolic link.
   *
   * A child folder is opened THROUGH its parent without following a link, so a folder swapped for a link into the
   * home while the tree is read is refused rather than listed, and a file's text is read through its folder, never
   * through a link put in its place — so nothing of the home's is read into a plan. Children are reached through
   * names a directory listing produced, inside a folder already confined, so they are inside the allowed roots by
   * construction: re-deciding containment for every entry of a large transcript tree would buy nothing.
   */
  private async observe(
    folders: DestinationFolders,
    folder: GuardedFolder,
    leaf: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    const information = await folder.describe(leaf);
    if (information === undefined) return undefined;
    const deviceId = Number(information.device);
    const modifiedAtMs = Number(information.modified ?? 0n) / 1e6;
    if (information.kind === 'link') {
      return {
        kind: 'symbolic-link',
        modifiedAtMs,
        deviceId,
        target: await folder.readlink(leaf),
      } satisfies SharedHistorySymbolicLinkNode;
    }
    if (information.kind === 'file') {
      return {
        kind: 'file',
        modifiedAtMs,
        deviceId,
        size: information.size,
        ...(options.readText ? { text: (await readFolderFile(folder, leaf)).toString('utf8') } : {}),
      };
    }
    if (information.kind !== 'directory') return { kind: 'other', modifiedAtMs, deviceId };

    const children: Record<string, SharedHistoryNode> = {};
    if (options.recursive === false) return { kind: 'directory', modifiedAtMs, deviceId, children };
    const child = await folders.child(folder, leaf, path.join(folder.path, leaf));
    try {
      for (const name of (await child.list()).toSorted()) {
        const node = await this.observe(folders, child, name);
        if (node === undefined) {
          throw new Error(`shared-history entry disappeared while it was being read: ${path.join(child.path, name)}`);
        }
        children[name] = node;
      }
    } finally {
      await child.close();
    }
    return { kind: 'directory', modifiedAtMs, deviceId, children };
  }

  /** This call's way to the folders, judged against the fence as the disk has it now. */
  private async folders(): Promise<DestinationFolders> {
    const homes = this.fence === undefined ? undefined : (await resolveSourceFence(this.fence, this.disk)).homes;
    return new DestinationFolders(homes, this.disk);
  }

  /**
   * The checked folder at `directory`, or `undefined` when it is not there; refused where it is not anchored. Only
   * ENOENT means not there: a folder that cannot be reached for another reason — an ancestor that is a file, one this
   * process may not search — surfaces that reason, as every read of this migration does.
   */
  private async reach(folders: DestinationFolders, directory: string): Promise<GuardedFolder | undefined> {
    const folder = await existingFolder(folders, directory, 'shared history');
    if (folder === undefined || folder.anchored) return folder;
    await folder.close();
    throw new SharedHistoryUnavailableError(
      `refusing to migrate shared history in ${directory}: its folders cannot be reached through their descriptors here, so a step could be redirected into the state home${folders.unavailable === undefined ? '' : ` (${folders.unavailable})`}`,
    );
  }

  private async within<T>(
    folders: DestinationFolders,
    directory: string,
    use: (folder: GuardedFolder | undefined) => Promise<T>,
  ): Promise<T> {
    const folder = await this.reach(folders, directory);
    try {
      return await use(folder);
    } finally {
      await folder?.close();
    }
  }

  /**
   * The checked folder at `directory`, made first when it is not there: each missing folder is made THROUGH its
   * checked parent, and the parent synced so the new name is durable. The caller closes it.
   */
  private async durable(folders: DestinationFolders, directory: string): Promise<GuardedFolder> {
    return await madeFolder(folders, directory, async at => await this.reach(folders, at));
  }

  private async assertAllowedPath(target: string): Promise<void> {
    if (!path.isAbsolute(target)) throw new Error(`shared-history path must be absolute: ${target}`);
    const canonical = await canonicalPath(target);
    // A root is resolved completely, its own final component included: a root the operator gave as a
    // symbolic link names the directory it points at, and everything canonically inside that
    // directory — the pool a home's history link resolves into — is inside the root.
    const roots = await Promise.all(this.allowedRoots.map(async root => await canonicalDirectory(root)));
    if (!roots.some(root => isInside(root, canonical))) {
      throw new SharedHistoryAccessRefusedError(target, roots);
    }
  }
}

/** A guard identity's kind as the planner names it, or `absent`. */
function kindOf(information: FileIdentity | undefined): SharedHistoryNode['kind'] | 'absent' {
  if (information === undefined) return 'absent';
  return information.kind === 'link' ? 'symbolic-link' : information.kind;
}

/** Tells one run of a pid apart from a later process that reuses the number. */
export interface ProcessStartSource {
  /** `undefined` when the pid is gone or its start cannot be read. */
  startOf(pid: number): Promise<number | undefined>;
}

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name, which may hold spaces. */
function procStatStart(text: string): number | undefined {
  const fields = text
    .slice(text.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const start = Number(fields[19]);
  return Number.isSafeInteger(start) && start > 0 ? start : undefined;
}

/** `ps -o lstart=` under `LC_ALL=C TZ=UTC0` (`Sat Sep  6 18:48:09 2026`), as epoch seconds. */
function psStart(text: string): number | undefined {
  const millis = Date.parse(`${text.trim().replace(/^[A-Z][a-z]{2} /u, '')} UTC`);
  return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1000) : undefined;
}

/**
 * The host's own record of when a process started: `/proc` on Linux, `ps` elsewhere.
 *
 * The value is only ever compared with another read on the same host, so each platform's own unit is
 * fine. `ps` is named by absolute path so a minimal `PATH` can neither miss it nor be handed another.
 */
export class HostProcessStarts implements ProcessStartSource {
  constructor(
    private readonly platform: string,
    private readonly procRoot = '/proc',
    private readonly psExecutable = '/bin/ps',
  ) {}

  async startOf(pid: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (this.platform === 'linux') {
      const text = await readFile(path.join(this.procRoot, String(pid), 'stat'), 'utf8').catch(() => undefined);
      return text === undefined ? undefined : procStatStart(text);
    }
    const child = Bun.spawn([this.psExecutable, '-o', 'lstart=', '-p', String(pid)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { LC_ALL: 'C', TZ: 'UTC0' },
    });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? psStart(text) : undefined;
  }
}

/** The file in each pool's `.leases` folder that its claimants are decided under, one at a time. */
const LEASE_LOCK = '.lock';

/** How often a claimant tries for the lock file when another claimant's open makes it in between. */
const LOCK_OPEN_ATTEMPTS = 3;

/**
 * A lease as stored, or `undefined` when there is none or it is not a lease (which proves no holder). Read THROUGH the
 * held folder, a regular file only and never through a link or a pipe; only ENOENT means none, so a name that is
 * something else refuses the claim rather than being written over.
 */
async function readLease(
  folder: GuardedFolder,
  conversation: ConversationId,
): Promise<ConversationLeaseRecord | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFolderFile(folder, conversation);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const parsed = ConversationLeaseRecordSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the lease with `text` in one rename inside the held folder, so a reader sees the old lease or the new one,
 * never part — the temporary made exclusively there, synced, renamed over the lease, and the folder synced.
 */
async function writeLease(folder: GuardedFolder, conversation: ConversationId, text: string): Promise<void> {
  const temporary = `.${conversation}.${randomUUID()}.tmp`;
  try {
    const descriptor = await folder.openFile(temporary, 'new', 0o600);
    try {
      writeAll(descriptor, new TextEncoder().encode(text));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    await folder.rename(temporary, conversation);
    await folder.sync();
  } finally {
    await folder.unlink(temporary).catch(() => undefined);
  }
}

/**
 * The lock file of the held `.leases` folder, opened THROUGH it: the one there (never through a link, never blocking
 * on a pipe), or made there exclusively when there is none. Refused when it is not a regular file.
 */
async function openLeaseLock(folder: GuardedFolder): Promise<number> {
  const lock = path.join(folder.path, LEASE_LOCK);
  for (let attempt = 0; attempt < LOCK_OPEN_ATTEMPTS; attempt += 1) {
    const descriptor = await folder.openFile(LEASE_LOCK, 'read').catch(async (error: unknown) => {
      if (!isMissing(error)) throw error;
      // Another claimant can make it between the two opens: open the one it made.
      return await folder.openFile(LEASE_LOCK, 'new', 0o600).catch((made: unknown) => {
        if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw made;
        return undefined;
      });
    });
    if (descriptor === undefined) continue;
    if (fstatSync(descriptor).isFile()) return descriptor;
    closeSync(descriptor);
    throw new Error(`refusing the conversation lease lock ${lock}: it is not a regular file`);
  }
  throw new Error(
    `refusing the conversation lease lock ${lock}: it kept appearing and disappearing while it was opened`,
  );
}

export interface FileConversationLeaseStoreOptions {
  /** How long a claim waits for another claimant's read-decide-write to finish. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
  /**
   * The state homes no lease may be read or written in, with their key files (docs/secrets.md#what-the-state-home-fence-refuses).
   * Without it no home is judged, and every lease is still reached through a checked folder.
   */
  readonly fence?: SourceFence;
  /** The guard's disk; the platform's own by default. */
  readonly disk?: GuardDisk & FolderDisk;
  /** How the lock's C call is loaded — a test names one that fails. */
  readonly loadLock?: () => FileLock;
}

/**
 * Conversation leases as files under `<fleet>/shared/<harness>/.leases/` (docs/design/account-model.md §9.3).
 *
 * Every read-decide-write runs under one mutex per pool: an exclusive `flock(2)` on `.leases/.lock`, which the kernel
 * drops when its holder closes it or dies, so a crashed claimant can never wedge the next one, and two claimants can
 * never both read a stale lease and both believe they took it over. The lease itself is plain JSON written by rename,
 * so the harness pid it names — not an open file — is what holds it, and a holder that has exited is stale without
 * anybody removing anything.
 *
 * The pool is written by every runtime's harness, and so by the agent in it: the `.leases` folder (or a folder above
 * it) can be swapped for a link the moment after it was looked at. So nothing in it is reached by path. The folder is
 * opened and checked through the state-home guard (`DestinationFolders`) — inside a home, walked from the home without
 * following a link; anywhere, refused where it is a home or one of its key files by identity — and the lock, every
 * lease read, write, rename and unlink reach their entry THROUGH that handle (Linux `/proc/self/fd/N/<leaf>`, macOS
 * descriptor calls). Where neither reach is available the lease is refused ({@link ConversationLeaseUnavailableError}),
 * never made by path.
 */
export class FileConversationLeaseStore implements ConversationLeaseStore {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly fence: SourceFence | undefined;
  private readonly disk: GuardDisk & FolderDisk;
  private readonly loadLock: () => FileLock;

  constructor(
    private readonly fleetDirectory: string,
    private readonly processes: ProcessStartSource,
    options: FileConversationLeaseStoreOptions = {},
  ) {
    this.waitMs = options.waitMs ?? 5_000;
    this.pollMs = options.pollMs ?? 10;
    this.now = options.now ?? (() => new Date());
    this.fence = options.fence;
    this.disk = options.disk ?? new NodeGuardDisk();
    this.loadLock = options.loadLock ?? loadFileLock;
  }

  async claim(
    claim: ConversationLeaseClaim,
    standing: (session: string) => Promise<ConversationHolderStanding>,
  ): ReturnType<ConversationLeaseStore['claim']> {
    const conversation = ConversationIdSchema.parse(claim.conversation);
    const folders = await this.folders();
    const folder = await madeFolder(
      folders,
      conversationLeaseDirectory(this.fleetDirectory, claim.harness),
      async directory => await this.reach(folders, directory),
    );
    try {
      return await this.exclusive(folder, async () => {
        const existing = await readLease(folder, conversation);
        const decision = decideConversationLease(existing, claim, {
          holderStart: existing === undefined ? undefined : await this.processes.startOf(existing.holder.pid),
          holderSession: existing?.holder.session === undefined ? 'unknown' : await standing(existing.holder.session),
        });
        // Only an existing lease can be held, so `existing` is defined here.
        if (decision === 'held') return { kind: 'held', lease: existing as ConversationLeaseRecord };
        const start = await this.processes.startOf(claim.holder.pid);
        const lease: ConversationLeaseRecord = {
          v: 1,
          harness: claim.harness,
          conversation,
          holder: { ...claim.holder, ...(start === undefined ? {} : { start }) },
          // A renewal is the same writer, so the conversation has been written by it since it first took it.
          since: decision === 'renew' && existing !== undefined ? existing.since : this.now().toISOString(),
        };
        await writeLease(folder, conversation, `${JSON.stringify(lease)}\n`);
        return { kind: 'claimed', decision, lease };
      });
    } finally {
      await folder.close();
    }
  }

  async releaseSession(session: string): Promise<readonly string[]> {
    const released: string[] = [];
    const folders = await this.folders();
    for (const kind of ['claude', 'codex'] as const satisfies readonly HarnessKind[]) {
      const folder = await this.reach(folders, conversationLeaseDirectory(this.fleetDirectory, kind));
      if (folder === undefined) continue;
      try {
        await this.exclusive(folder, async () => {
          let removed = false;
          for (const name of await folder.list()) {
            // The lock, a temporary, and any name this store never writes.
            const conversation = ConversationIdSchema.safeParse(name).data;
            if (conversation === undefined) continue;
            // An entry that cannot be read as a lease holds nothing this session can release.
            const lease = await readLease(folder, conversation).catch(() => undefined);
            if (lease?.holder.session !== session) continue;
            await folder.unlink(conversation);
            released.push(lease.conversation);
            removed = true;
          }
          if (removed) await folder.sync();
        });
      } finally {
        await folder.close();
      }
    }
    return released;
  }

  /** This call's way to the folders, judged against the fence as the disk has it now. */
  private async folders(): Promise<DestinationFolders> {
    const homes = this.fence === undefined ? undefined : (await resolveSourceFence(this.fence, this.disk)).homes;
    return new DestinationFolders(homes, this.disk);
  }

  /**
   * The checked folder at `directory`, or `undefined` when it is not there; refused where it is not anchored (its
   * entries would be reached by path). Only ENOENT means not there.
   */
  private async reach(folders: DestinationFolders, directory: string): Promise<GuardedFolder | undefined> {
    if (this.disk.missingDescriptorPaths === true) throw this.unavailable(directory, 'this host has no /proc/self/fd');
    const folder = await existingFolder(folders, directory, 'the conversation leases');
    if (folder === undefined || folder.anchored) return folder;
    await folder.close();
    throw this.unavailable(directory, folders.unavailable);
  }

  private unavailable(directory: string, why: string | undefined): ConversationLeaseUnavailableError {
    return new ConversationLeaseUnavailableError(
      `refusing the conversation lease in ${directory}: its folder cannot be reached through its descriptor here, so a lease written there could be redirected into the state home${why === undefined ? '' : ` (${why})`}`,
    );
  }

  /** Runs `work` while holding this pool's lock, waiting up to the budget for another claimant. */
  private async exclusive<T>(folder: GuardedFolder, work: () => Promise<T>): Promise<T> {
    let lock: FileLock;
    try {
      lock = this.loadLock();
    } catch (error) {
      throw new ConversationLeaseUnavailableError(
        `refusing the conversation lease in ${folder.path}: the lock it is decided under could not be loaded here (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const descriptor = await openLeaseLock(folder);
    try {
      const deadline = Date.now() + this.waitMs;
      while (!lock.tryLock(descriptor)) {
        if (Date.now() >= deadline)
          throw new Error(
            `the conversation lease store at ${folder.path} stayed busy: another claimant held its lock for ${String(this.waitMs)} ms`,
          );
        await Bun.sleep(this.pollMs);
      }
      return await work();
    } finally {
      // The only open of the lock is this one, so closing it lets the next claimant in.
      closeSync(descriptor);
    }
  }
}
