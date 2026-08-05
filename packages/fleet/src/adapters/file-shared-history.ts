import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  SharedHistoryFileSystem,
  SharedHistoryNode,
  SharedHistorySymbolicLinkNode,
} from '../lib/shared-history.ts';

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
 * Renaming is the only legal move: a copy would hand every open reader a different inode.
 *
 * EXDEV is the one rename failure that tempts a caller into copy-then-delete, so it is translated
 * into an explicit refusal instead of surfacing as a bare errno. Exported because provoking a real
 * cross-device rename needs a second filesystem that no test can assume: the decision is proved
 * here, and `move` is proved to route its rename failures through it by the failures it passes on.
 */
export function sharedHistoryMoveRefusal(error: unknown, source: string, destination: string): unknown {
  if ((error as NodeJS.ErrnoException).code !== 'EXDEV') return error;
  return new Error(
    `refusing to copy shared history across filesystems: ${source} -> ${destination}; copying is forbidden because a new inode would silently orphan every transcript a running harness already has open`,
  );
}

function exclusiveRefusal(error: unknown, target: string): unknown {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return error;
  return new Error(`shared-history exclusive write refused an existing path: ${target}`);
}

/** Write every byte at an explicit offset: a single write can be short and the offset must not drift. */
async function writeAllBytes(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, written);
    written += result.bytesWritten;
  }
}

/** Sync the containing directory so a create or an unlink survives a crash, not only the file bytes. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
 */
export class FileSharedHistoryFileSystem implements SharedHistoryFileSystem {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) throw new Error('at least one allowed shared-history root is required');
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  async snapshot(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    await this.assertAllowedPath(target);
    return await this.observe(target, options);
  }

  async ensureDirectory(target: string): Promise<boolean> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing !== undefined) {
      if (existing.kind !== 'directory') {
        throw new Error(`shared-history directory path is ${existing.kind}: ${target}`);
      }
      return false;
    }
    await mkdir(target, { recursive: true, mode: 0o700 });
    const created = await this.observe(target);
    if (created?.kind !== 'directory') throw new Error(`could not create shared-history directory: ${target}`);
    return true;
  }

  async ensureFile(target: string): Promise<boolean> {
    await this.assertAllowedPath(target);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let handle: FileHandle;
    try {
      handle = await open(target, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.observe(target);
      if (existing?.kind !== 'file') {
        throw new Error(`shared-history file path is ${existing?.kind ?? 'absent'}: ${target}`);
      }
      return false;
    }
    await handle.close();
    return true;
  }

  async move(source: string, destination: string): Promise<void> {
    await this.assertAllowedPath(source);
    await this.assertAllowedPath(destination);
    if ((await this.observe(source)) === undefined) throw new Error(`shared-history move source is absent: ${source}`);
    if ((await this.observe(destination)) !== undefined) {
      throw new Error(`shared-history move destination already exists: ${destination}`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(source, destination);
    } catch (error) {
      throw sharedHistoryMoveRefusal(error, source, destination);
    }
  }

  async writeTextAtomic(target: string, text: string): Promise<void> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing !== undefined && existing.kind !== 'file') {
      throw new Error(`shared-history text path is ${existing.kind}: ${target}`);
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
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
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (error) {
      throw exclusiveRefusal(error, target);
    }
    try {
      await writeAllBytes(handle, new TextEncoder().encode(text));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
  }

  /**
   * Replace a regular file's text without replacing the file.
   *
   * A pooled history file is open in live harness processes, so its inode has to survive the write:
   * the new bytes go into the existing file and the tail is truncated afterwards, and nothing is
   * reported as written before it is synced. The expected contents are compared through the same
   * open handle, which narrows the check-then-write window to that one descriptor; a mismatch
   * returns `false` so the domain can re-plan against what is actually there. Anything that is not a
   * regular file — a symbolic link most of all — is refused rather than followed.
   */
  async rewriteTextInPlace(target: string, expected: string, text: string): Promise<boolean> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing?.kind !== 'file') {
      throw new Error(
        `shared-history in-place rewrite expected a file, found ${existing?.kind ?? 'absent'}: ${target}`,
      );
    }
    // O_NOFOLLOW closes the gap between the check above and this open: a symbolic link swapped in
    // after the lstat fails the open instead of being written through.
    const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if ((await handle.readFile('utf8')) !== expected) return false;
      const bytes = new TextEncoder().encode(text);
      await writeAllBytes(handle, bytes);
      await handle.truncate(bytes.byteLength);
      await handle.sync();
      return true;
    } finally {
      await handle.close();
    }
  }

  async createSymbolicLink(target: string, destination: string): Promise<void> {
    await this.assertAllowedPath(target);
    await this.assertAllowedPath(destination);
    if ((await this.observe(target)) === undefined) {
      throw new Error(`refusing to create a dangling shared-history link: ${destination} -> ${target}`);
    }
    if ((await this.observe(destination)) !== undefined) {
      throw new Error(`shared-history link destination already exists: ${destination}`);
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await symlink(target, destination);
  }

  async removeSymbolicLink(target: string, expectedTarget: string): Promise<void> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing?.kind !== 'symbolic-link') {
      throw new Error(`shared-history rollback expected a symbolic link: ${target}`);
    }
    if (path.resolve(path.dirname(target), existing.target) !== path.resolve(expectedTarget)) {
      throw new Error(`shared-history rollback refused a replaced symbolic link: ${target}`);
    }
    await rm(target);
  }

  async removeEmptyDirectory(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing?.kind !== 'directory') {
      throw new Error(`shared-history cleanup expected a directory: ${target}`);
    }
    await rmdir(target);
  }

  async removeFile(target: string): Promise<void> {
    await this.assertAllowedPath(target);
    const existing = await this.observe(target);
    if (existing?.kind !== 'file') throw new Error(`shared-history cleanup expected a file: ${target}`);
    await rm(target);
    await syncDirectory(path.dirname(target));
  }

  /**
   * Read one entry, and its children when it is a directory, without following any symbolic link.
   *
   * Children are reached through a path whose ancestors are already confined and through names a
   * directory listing produced, so they are inside the allowed roots by construction: re-deciding
   * containment for every entry of a large transcript tree would buy nothing.
   */
  private async observe(
    target: string,
    options: { readonly readText?: boolean; readonly recursive?: boolean } = {},
  ): Promise<SharedHistoryNode | undefined> {
    let information: Stats;
    try {
      information = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (information.isSymbolicLink()) {
      return {
        kind: 'symbolic-link',
        modifiedAtMs: information.mtimeMs,
        target: await readlink(target),
      } satisfies SharedHistorySymbolicLinkNode;
    }
    if (information.isFile()) {
      return {
        kind: 'file',
        modifiedAtMs: information.mtimeMs,
        size: information.size,
        ...(options.readText ? { text: await readFile(target, 'utf8') } : {}),
      };
    }
    if (!information.isDirectory()) return { kind: 'other', modifiedAtMs: information.mtimeMs };

    const children: Record<string, SharedHistoryNode> = {};
    if (options.recursive === false) {
      return { kind: 'directory', modifiedAtMs: information.mtimeMs, children };
    }
    for (const name of (await readdir(target)).toSorted()) {
      const childPath = path.join(target, name);
      const child = await this.observe(childPath);
      if (child === undefined) {
        throw new Error(`shared-history entry disappeared while it was being read: ${childPath}`);
      }
      children[name] = child;
    }
    return { kind: 'directory', modifiedAtMs: information.mtimeMs, children };
  }

  private async assertAllowedPath(target: string): Promise<void> {
    if (!path.isAbsolute(target)) throw new Error(`shared-history path must be absolute: ${target}`);
    const canonical = await canonicalPath(target);
    // A root is resolved completely, its own final component included: a root the operator gave as a
    // symbolic link names the directory it points at, and everything canonically inside that
    // directory — the pool a home's history link resolves into — is inside the root.
    const roots = await Promise.all(this.allowedRoots.map(async root => await canonicalDirectory(root)));
    if (!roots.some(root => isInside(root, canonical))) {
      throw new Error(`refusing shared-history access outside configured roots: ${target}`);
    }
  }
}
