import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type ComponentIdentity,
  type FsEntryType,
  FsError,
  type PinnedDirectoryEntry,
  type PinnedListing,
  type PinnedMetadata,
  type PinnedOpenOptions,
  type PinnedRoot,
  type PinnedTarget,
  rootIsDenied,
  type SessionRootPinner,
} from '../../../lib/session/filesystem/index.ts';

/**
 * Containment by DESCRIPTOR, which is the only containment this subsystem has.
 *
 * WHY NOT A PATHNAME. A validated path string is a claim about the past. `realpath` followed by
 * `open(pathname)` validates one walk and performs a second, and only the second decides which bytes are
 * served: swap an intermediate directory — or the configured cwd itself — for a symlink in between, and
 * the read lands outside the tree having passed containment, the denylist and the gitignore gate on a
 * path that no longer describes the bytes. Here the walk that validates IS the walk that serves. Each
 * component is opened `O_DIRECTORY|O_NOFOLLOW` from its already-open parent, so a component swapped
 * mid-walk fails (ELOOP or ENOTDIR) rather than redirecting us, and one swapped after we opened it
 * cannot affect the descriptor we already hold.
 *
 * WHY INTERIOR SYMLINKS ARE REFUSED OUTRIGHT rather than resolved-and-contained: it costs the ability to
 * browse through an in-tree symlinked directory, and buys a containment proof that does not depend on
 * winning a race.
 *
 * WHY NON-LINUX FAILS CLOSED. The pin has to be handed to capabilities that only speak paths — `opendir`
 * and Git's working directory — and `/proc/<pid>/fd/<n>` is how a descriptor becomes such a path. Falling
 * back to the configured pathname would re-open the root-swap hole, so the whole surface refuses until
 * another platform has an equivalent descriptor-backed implementation.
 *
 * ACCEPTED RESIDUAL RISKS.
 *
 *  - Hardlinks. A hardlink to a file outside the tree is indistinguishable from a normal file: it has no
 *    link to follow and no separate identity. The daemon and the agent run as the same user, so the
 *    agent can already read anything the daemon can.
 *  - A cwd swapped BEFORE a request begins is not an escape. The configured cwd then honestly names the
 *    other tree, and a viewer shows the tree its cwd names; every gate runs against that same tree. What
 *    the pin guarantees is COHERENCE — gates and bytes always come from one tree, never mixed.
 */

/** True on Linux, where `/proc/<pid>/fd/<n>` is a path alias for an open descriptor. */
const HAS_PROCFS_PIN = process.platform === 'linux';

function procPath(fd: number): string {
  return `/proc/${process.pid}/fd/${fd}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Every way the kernel says "there is nothing usable at that name". */
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENAMETOOLONG';
}

function componentIdentity(metadata: Stats): ComponentIdentity {
  return { dev: metadata.dev, ino: metadata.ino, ctimeMs: metadata.ctimeMs, mode: metadata.mode };
}

function pinnedMetadata(metadata: Stats): PinnedMetadata {
  const type = metadata.isDirectory() ? 'dir' : metadata.isFile() ? 'file' : 'other';
  return { type, size: metadata.size, mtime: metadata.mtime.toISOString(), mode: metadata.mode };
}

function contains(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(`${rootReal}${path.sep}`);
}

/**
 * Root-relative CANONICAL path of a contained target, in the slash-joined shape the gates expect.
 *
 * This is what stops an in-root symlinked directory from laundering a denied or ignored target: `alias ->
 * .git` passes containment (its target IS inside the root) while the lexical path `alias/config` matches
 * no denylist entry and no ignore rule.
 */
function canonicalRel(rootReal: string, targetReal: string): string | undefined {
  if (targetReal === rootReal) return undefined;
  return targetReal
    .slice(rootReal.length + 1)
    .split(path.sep)
    .join('/');
}

function direntType(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryType | undefined {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return undefined; // fifo, socket, device — nothing a viewer can show
}

/** Was this component a symlink? Message fidelity only; the link is already refused. */
async function isSymlinkAt(parentProcPath: string, segment: string): Promise<boolean> {
  try {
    return (await lstat(`${parentProcPath}/${segment}`)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Which refusal does this symlink deserve — `escapes_root` or `not_a_file`?
 *
 * Purely cosmetic in security terms: the link is refused before this runs. Resolving here is therefore
 * safe, because it decides a MESSAGE and never whether bytes are served — it exists so an out-of-tree
 * link reports "points outside the session" rather than a flat "not a file".
 */
async function symlinkRefusal(
  rootReal: string,
  parentProcPath: string,
  segment: string,
  reportedPath: string,
): Promise<FsError> {
  try {
    const target = await realpath(`${parentProcPath}/${segment}`);
    if (!contains(rootReal, target))
      return new FsError('escapes_root', `path escapes the session root: ${reportedPath}`);
  } catch {
    // A broken link, or resolution raced: refused either way.
  }
  return new FsError('not_a_file', `symlinks are not served: ${reportedPath}`);
}

/** An object opened by the pinned walk, serving only from its own descriptor. */
class ProcfsPinnedTarget implements PinnedTarget {
  constructor(
    private readonly handle: FileHandle,
    readonly metadata: PinnedMetadata,
    readonly canonical: string,
    readonly identities: readonly ComponentIdentity[],
    private readonly rootReal: string,
  ) {}

  /**
   * Bytes of an ALREADY-OPEN regular file.
   *
   * Taking the handle rather than a path is the whole point: `stat` then `readFile` checks one path and
   * reads another, and everything in between can be replaced with a symlink pointing anywhere.
   */
  async read(maxBytes: number): Promise<Uint8Array | undefined> {
    const size = this.metadata.size;
    if (size > maxBytes) return undefined;
    const bytes = new Uint8Array(size);
    let read = 0;
    while (read < bytes.byteLength) {
      const { bytesRead } = await this.handle.read(bytes, read, bytes.byteLength - read, read);
      if (bytesRead === 0) break; // truncated under us; serve what exists
      read += bytesRead;
    }
    return read === bytes.byteLength ? bytes : bytes.subarray(0, read);
  }

  /**
   * One level of an already-open directory.
   *
   * Streamed and stopped one dirent past the cap, so the advertised limit bounds real memory and latency.
   * A `readdir` would materialise all million entries of a `node_modules`-scale directory before the
   * slice, which makes the cap decorative and hands a token holder a cheap allocation amplifier.
   */
  async list(maxEntries: number): Promise<PinnedListing> {
    const own = procPath(this.handle.fd);
    const kept: PinnedDirectoryEntry[] = [];
    let truncated = false;
    const dir = await opendir(own);
    try {
      for await (const dirent of dir) {
        if (kept.length >= maxEntries) {
          truncated = true; // one dirent past the cap is all we need to know
          break;
        }
        const type = direntType(dirent);
        if (type === undefined) continue;
        kept.push(await this.classify(own, dirent.name, type));
      }
    } finally {
      // Breaking out of `for await` already closes the handle, and a second close then throws — or, in
      // Bun, returns undefined rather than a promise, so this cannot be a `.catch()`.
      try {
        await dir.close();
      } catch {
        // already closed by the iterator
      }
    }
    return { entries: kept, truncated };
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }

  /**
   * Describe one child, resolved THROUGH this open directory rather than through a pathname.
   *
   * A symlink's own metadata is useless to a viewer; what matters is whether its target stays inside the
   * tree and what that target IS, since `alias -> .git` must be badged denied even though the name
   * `alias` is innocent.
   */
  private async classify(own: string, name: string, type: FsEntryType): Promise<PinnedDirectoryEntry> {
    const child = path.join(own, name);
    if (type !== 'symlink') {
      try {
        const metadata = await lstat(child);
        return { name, type, size: metadata.size, mtime: metadata.mtime.toISOString() };
      } catch (error) {
        if (!isMissing(error)) throw error;
        return { name, type };
      }
    }
    try {
      const linkReal = await realpath(child);
      if (!contains(this.rootReal, linkReal)) return { name, type, escapes: true };
      const metadata = await stat(linkReal);
      const target = canonicalRel(this.rootReal, linkReal);
      return { name, type, size: metadata.size, mtime: metadata.mtime.toISOString(), ...(target ? { target } : {}) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { name, type, escapes: true }; // a broken link: nothing to serve either way
    }
  }
}

/** A session root held open, plus the component walk that is the only way to reach anything beneath it. */
class ProcfsPinnedRoot implements PinnedRoot {
  constructor(
    private readonly handle: FileHandle,
    readonly rootReal: string,
  ) {}

  get policyCwd(): string {
    return procPath(this.handle.fd);
  }

  async open(rel: string, options: PinnedOpenOptions = {}): Promise<PinnedTarget> {
    const segments = rel === '' ? [] : rel.split('/');
    let current = await open(this.policyCwd, constants.O_RDONLY | constants.O_DIRECTORY);
    let metadata = await current.stat();
    const identities: ComponentIdentity[] = [componentIdentity(metadata)];
    const walked: string[] = [];

    try {
      for (const [index, segment] of segments.entries()) {
        const isLeaf = index === segments.length - 1;
        const wantDirectory = !isLeaf || options.wantDirectory === true;
        const next = await this.step(procPath(current.fd), segment, [...walked, segment].join('/'), rel, wantDirectory);
        // Adopt the new handle BEFORE describing it. The outer catch closes whatever `current` holds, so a
        // failing `fstat` needs no error path of its own and cannot leak a descriptor.
        await current.close().catch(() => undefined);
        current = next;
        metadata = await current.stat();
        walked.push(segment);
        identities.push(componentIdentity(metadata));
      }
      return new ProcfsPinnedTarget(current, pinnedMetadata(metadata), walked.join('/'), identities, this.rootReal);
    } catch (error) {
      await current.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }

  /**
   * Open ONE component from its already-open parent, never following a link.
   *
   * `ELOOP` means the component IS a symlink and we refused to follow it. `ENOTDIR` where a directory was
   * required is either a plain file mid-path or — with `O_DIRECTORY|O_NOFOLLOW` — a symlink TO a
   * directory, which the kernel reports as `ENOTDIR` rather than `ELOOP`. Both are the swap losing, which
   * is the point; the `lstat` only decides which refusal to name.
   */
  private async step(
    from: string,
    segment: string,
    reported: string,
    rel: string,
    wantDirectory: boolean,
  ): Promise<FileHandle> {
    try {
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (wantDirectory ? constants.O_DIRECTORY : 0);
      return await open(`${from}/${segment}`, flags);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ELOOP') throw await symlinkRefusal(this.rootReal, from, segment, reported);
      if (code === 'ENOTDIR' && wantDirectory) throw await this.notADirectory(from, segment, reported);
      if (isMissing(error)) throw new FsError('not_found', `no such path: ${rel}`);
      throw error;
    }
  }

  private async notADirectory(from: string, segment: string, reported: string): Promise<FsError> {
    if (await isSymlinkAt(from, segment)) return await symlinkRefusal(this.rootReal, from, segment, reported);
    return new FsError('not_a_directory', `not a directory: ${reported}`);
  }
}

/**
 * Pins a session cwd by opening it once and holding the descriptor.
 *
 * `O_NOFOLLOW` is deliberately NOT used on the root itself: a session cwd may legitimately be reached
 * through a symlink (`~/Workspace` pointing elsewhere is ordinary), and the root is configured by the
 * daemon rather than supplied by a request. What matters is that whatever it resolves to is pinned ONCE
 * and never re-walked.
 */
export class ProcfsSessionRootPinner implements SessionRootPinner {
  async pin(cwd: string): Promise<PinnedRoot> {
    // A security precondition, not an optimisation: listings, Git and the component walk all need a path
    // alias for an already-open descriptor, and using `cwd` as a fallback would validate one tree and
    // serve another after a rename or symlink swap.
    if (!HAS_PROCFS_PIN) throw new FsError('denied', 'filesystem viewing requires descriptor-backed procfs support');

    const handle = await this.openRoot(cwd);
    try {
      // Read the identity of the object we actually HOLD, not of the name we were given.
      const rootReal = await readlink(procPath(handle.fd));
      const metadata = await handle.stat();
      if (!metadata.isDirectory()) throw new FsError('not_a_directory', 'session cwd is not a directory');
      // The chokepoint every entry point shares, so a denied root is refused for listings, content, diffs
      // and changes alike.
      if (rootIsDenied(rootReal)) throw new FsError('denied', 'session cwd is not served');
      return new ProcfsPinnedRoot(handle, rootReal);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async openRoot(cwd: string): Promise<FileHandle> {
    try {
      return await open(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      // `ENOTDIR` from `O_DIRECTORY` means it exists but is not a directory.
      if (errorCode(error) === 'ENOTDIR') throw new FsError('not_a_directory', 'session cwd is not a directory');
      if (isMissing(error)) throw new FsError('not_found', `session cwd is not available: ${cwd}`);
      throw error;
    }
  }
}
