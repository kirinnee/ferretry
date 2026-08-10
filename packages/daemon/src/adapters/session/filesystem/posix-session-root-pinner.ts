import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  read,
  realpathSync,
  statSync,
} from 'node:fs';
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
  unsupportedPlatform,
  type WorkBudget,
} from '../../../lib/session/filesystem/index.ts';
import type { PinnedWorkingDirectory } from '../../../lib/worktrees/ports.ts';
import { type DirectorySyscalls, loadDirectorySyscalls } from './directory-syscalls.ts';
import {
  canonicalRel,
  componentIdentity,
  contains,
  direntType,
  errorCode,
  isMissing,
  pinnedMetadata,
} from './pin-support.ts';

/**
 * Containment by DESCRIPTOR on a system with no path alias for one — macOS, and any other POSIX
 * platform that is not Linux.
 *
 * THE PROBLEM. Confinement requires opening each component FROM its already-open parent, so that the
 * walk which proves containment is the walk that serves the bytes. Linux can hand an open directory to
 * a path-only API as `/proc/<pid>/fd/<n>`; macOS has no equivalent — `/dev/fd/<n>` names a descriptor
 * but cannot be walked THROUGH — so the sibling implementation refuses outright there.
 *
 * THE MECHANISM. There is a second way to make a descriptor addressable, older than procfs: install it
 * as the kernel's working directory with `fchdir`, after which a one-segment relative name is resolved
 * by the kernel from that directory and from nowhere else. That is `openat` in every respect that
 * matters here. It is also how the pin reaches the two capabilities that speak nothing but paths —
 * enumeration, which opens `.`, and Git, whose child inherits the installed directory.
 *
 * WHY THIS IS SAFE DESPITE BEING GLOBAL. The installed directory is shared by everything in the
 * runtime, so every bracket is opened and released within ONE synchronous run and never spans an
 * `await`. Nothing else in a single-threaded runtime can observe the window. Reads, `fstat`s and closes
 * take descriptors and need no bracket at all; only opening a component, enumerating a directory and
 * starting Git do.
 *
 * WHY EVERY BRACKET RE-PROVES ITSELF. That a relative name reaches the kernel rather than being
 * resolved against a cached string is a property of the runtime, not a documented guarantee — and this
 * runtime is inconsistent about it (its `realpath` does NOT honour the installed directory, which is
 * why the single `realpath` here is handed an absolute path). A wrong answer would raise no error; it
 * would quietly describe another tree. So each bracket opens `.` and compares its identity against the
 * descriptor just installed, and the whole surface refuses on a mismatch. One `open` and one `fstat`
 * turn an assumption about a runtime into a fact about this call.
 *
 * ACCEPTED RESIDUAL RISK, beyond those the sibling implementation lists. A listed SYMLINK's badge —
 * does it escape, what does it point at, how big is it — needs one `realpath`, and it is given an
 * absolute path built from the pinned directory's own kernel-reported location, because this runtime's
 * `realpath` cannot be aimed at a descriptor. An ancestor renamed in that instant yields a wrong BADGE.
 * It cannot yield wrong bytes: name and type come from the pinned enumeration, and no symlink is ever
 * served.
 */

/**
 * The runtime's own working directory, borrowed and handed back.
 *
 * Held as a DESCRIPTOR rather than as a name: restoring by pathname would fail once that directory were
 * renamed or removed, and would leave the runtime standing in a session's tree — the worst place to
 * leave it.
 */
class InstalledDirectory {
  private home: number | undefined;

  constructor(private readonly syscalls: DirectorySyscalls) {}

  /**
   * Installs `fd`, proves the kernel agrees, and returns the undo.
   *
   * The undo never throws: it is called from a `finally`, where a throw would replace the caller's own
   * error with this one and leave the runtime standing in a session's directory.
   */
  install(fd: number): () => void {
    this.home ??= openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    const home = this.home;
    if (this.syscalls.fchdir(fd) !== 0) throw new FsError('denied', 'the session folder could not be held open');
    const release = (): void => {
      this.syscalls.fchdir(home);
    };
    try {
      this.prove(fd);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  /** Runs `act` with `fd` installed. `act` MUST NOT await — see this file's header. */
  enter<Result>(fd: number, act: () => Result): Result {
    const release = this.install(fd);
    try {
      return act();
    } finally {
      release();
    }
  }

  /** The kernel's own path for `fd`, which is how a pinned directory learns where it really is. */
  realPathOf(fd: number): string {
    return this.enter(fd, () => this.here());
  }

  /**
   * Where the kernel says the installed directory is. Only meaningful INSIDE a bracket, and the reason
   * it is separate from {@link realPathOf} is that its callers are already inside one.
   */
  here(): string {
    return this.syscalls.currentDirectory();
  }

  /**
   * Does a relative name reach the directory just installed?
   *
   * A mismatch means this runtime resolved `.` against something other than the kernel's working
   * directory, so every relative open in the bracket would land somewhere unintended. There is no
   * degraded mode to fall back to, and a pathname fallback is the hole this class exists to close.
   */
  private prove(fd: number): void {
    const here = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const reached = fstatSync(here);
      const installed = fstatSync(fd);
      if (reached.dev !== installed.dev || reached.ino !== installed.ino) throw unsupportedPlatform(process.platform);
    } finally {
      closeSync(here);
    }
  }
}

/** Bytes of an already-open file, with no path anywhere in the call. */
async function readAt(fd: number, buffer: Uint8Array, offset: number, length: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    read(fd, buffer, offset, length, offset, (error, bytesRead) => (error ? reject(error) : resolve(bytesRead)));
  });
}

/** One child of a listing, as the pinned enumeration reported it. */
interface FoundEntry {
  readonly name: string;
  readonly type: FsEntryType;
}

/** An object opened by the pinned walk, serving only from its own descriptor. */
class PosixPinnedTarget implements PinnedTarget {
  constructor(
    private readonly fd: number,
    private readonly directory: InstalledDirectory,
    readonly metadata: PinnedMetadata,
    readonly canonical: string,
    readonly identities: readonly ComponentIdentity[],
    private readonly rootReal: string,
  ) {}

  /**
   * Bytes of an ALREADY-OPEN regular file.
   *
   * Taking the descriptor rather than a path is the whole point: `stat` then `readFile` checks one path
   * and reads another, and everything in between can be replaced with a symlink pointing anywhere.
   */
  async read(maxBytes: number): Promise<Uint8Array | undefined> {
    const size = this.metadata.size;
    if (size > maxBytes) return undefined;
    const bytes = new Uint8Array(size);
    let done = 0;
    while (done < bytes.byteLength) {
      const bytesRead = await readAt(this.fd, bytes, done, bytes.byteLength - done);
      if (bytesRead === 0) break; // truncated under us; serve what exists
      done += bytesRead;
    }
    return done === bytes.byteLength ? bytes : bytes.subarray(0, done);
  }

  /**
   * One level of an already-open directory.
   *
   * The WHOLE enumeration happens inside one bracket and synchronously, which is not a style choice:
   * this runtime's async directory iterator resolves its path LAZILY, so a handle opened through the
   * pin and iterated after the bracket closed enumerated the runtime's own directory instead — the
   * exact silent-wrong-tree failure this file's header describes, observed rather than imagined.
   * Reading it out under the pin also costs one borrow for the listing rather than one per entry.
   *
   * Stopped one dirent past the cap, so the advertised limit bounds real memory and latency instead of
   * slicing a list already materialised in full — which also bounds how long this holds the directory.
   */
  async list(maxEntries: number, budget?: WorkBudget): Promise<PinnedListing> {
    return this.directory.enter(this.fd, () => {
      const here = this.directory.here();
      const dir = opendirSync('.');
      const entries: PinnedDirectoryEntry[] = [];
      let truncated = false;
      try {
        while (true) {
          const dirent = dir.readSync();
          if (dirent === null) break;
          if (entries.length >= maxEntries) {
            truncated = true; // one dirent past the cap is all we need to know
            break;
          }
          // Asked before classifying rather than after, because classifying is what costs: a spent
          // budget must not buy one more `lstat` per remaining child of a directory holding thousands.
          if (budget?.expired() === true) {
            truncated = true;
            break;
          }
          const type = direntType(dirent);
          if (type === undefined) continue;
          entries.push(this.classify(here, { name: dirent.name, type }));
        }
      } finally {
        dir.closeSync();
      }
      return { entries, truncated };
    });
  }

  async close(): Promise<void> {
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  /**
   * Describe one child, resolved through the installed directory rather than through a pathname.
   *
   * A symlink's own metadata is useless to a viewer; what matters is whether its target stays inside the
   * tree and what that target IS, since `alias -> .git` must be badged denied even though the name
   * `alias` is innocent.
   *
   * Every call here but the `realpath` is a bare relative name, so this runs INSIDE a bracket.
   */
  private classify(here: string, entry: FoundEntry): PinnedDirectoryEntry {
    const { name, type } = entry;
    if (type !== 'symlink') {
      try {
        const metadata = lstatSync(name);
        return { name, type, size: metadata.size, mtime: metadata.mtime.toISOString() };
      } catch (error) {
        if (!isMissing(error)) throw error;
        return { name, type };
      }
    }
    try {
      const linkReal = realpathSync(path.join(here, name));
      if (!contains(this.rootReal, linkReal)) return { name, type, escapes: true };
      const metadata = statSync(name);
      const target = canonicalRel(this.rootReal, linkReal);
      return { name, type, size: metadata.size, mtime: metadata.mtime.toISOString(), ...(target ? { target } : {}) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { name, type, escapes: true }; // a broken link: nothing to serve either way
    }
  }
}

/** A session root held open, plus the component walk that is the only way to reach anything beneath it. */
class PosixPinnedRoot implements PinnedRoot {
  constructor(
    private readonly fd: number,
    private readonly directory: InstalledDirectory,
    readonly rootReal: string,
  ) {}

  /**
   * The pin as a working directory for Git.
   *
   * Not a path: there is none to give. The runner installs this for the instant of the spawn, and the
   * child inherits the open directory itself.
   */
  get policyCwd(): PinnedWorkingDirectory {
    return { describe: this.rootReal, install: () => this.directory.install(this.fd) };
  }

  async open(rel: string, options: PinnedOpenOptions = {}): Promise<PinnedTarget> {
    const segments = rel === '' ? [] : rel.split('/');
    // A fresh descriptor for the same directory, so the walk can close what it holds without ever
    // closing the root itself.
    let current = this.directory.enter(this.fd, () => openSync('.', constants.O_RDONLY | constants.O_DIRECTORY));
    let metadata = fstatSync(current);
    const identities: ComponentIdentity[] = [componentIdentity(metadata)];
    const walked: string[] = [];

    try {
      for (const [index, segment] of segments.entries()) {
        const isLeaf = index === segments.length - 1;
        const wantDirectory = !isLeaf || options.wantDirectory === true;
        const next = this.step(current, segment, [...walked, segment].join('/'), rel, wantDirectory);
        // Adopt the new descriptor BEFORE describing it. The outer catch closes whatever `current`
        // holds, so a failing `fstat` needs no error path of its own and cannot leak a descriptor.
        closeSync(current);
        current = next;
        metadata = fstatSync(current);
        walked.push(segment);
        identities.push(componentIdentity(metadata));
      }
      return new PosixPinnedTarget(
        current,
        this.directory,
        pinnedMetadata(metadata),
        walked.join('/'),
        identities,
        this.rootReal,
      );
    } catch (error) {
      closeSync(current);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  /**
   * Open ONE component from its already-open parent, never following a link.
   *
   * `ELOOP` means the component IS a symlink and we refused to follow it. `ENOTDIR` where a directory
   * was required is either a plain file mid-path or — with `O_DIRECTORY|O_NOFOLLOW` — a symlink TO a
   * directory, which some kernels report as `ENOTDIR` rather than `ELOOP`. Both are the swap losing,
   * which is the point; the `lstat` only decides which refusal to name.
   */
  private step(parent: number, segment: string, reported: string, rel: string, wantDirectory: boolean): number {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (wantDirectory ? constants.O_DIRECTORY : 0);
    return this.directory.enter(parent, () => {
      try {
        return openSync(segment, flags);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ELOOP') throw this.symlinkRefusal(segment, reported);
        if (code === 'ENOTDIR' && wantDirectory) throw this.notADirectory(segment, reported);
        if (isMissing(error)) throw new FsError('not_found', `no such path: ${rel}`);
        throw error;
      }
    });
  }

  private notADirectory(segment: string, reported: string): FsError {
    if (this.isSymlinkHere(segment)) return this.symlinkRefusal(segment, reported);
    return new FsError('not_a_directory', `not a directory: ${reported}`);
  }

  /** Was this component a symlink? Message fidelity only; the link is already refused. */
  private isSymlinkHere(segment: string): boolean {
    try {
      return lstatSync(segment).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Which refusal does this symlink deserve — `escapes_root` or `not_a_file`?
   *
   * Purely cosmetic in security terms: the link is refused before this runs. Resolving here is
   * therefore safe, because it decides a MESSAGE and never whether bytes are served — it exists so an
   * out-of-tree link reports "points outside the session" rather than a flat "not a file".
   *
   * Runs inside the parent's bracket, so `currentDirectory` names the parent we actually hold.
   */
  private symlinkRefusal(segment: string, reportedPath: string): FsError {
    try {
      const target = realpathSync(path.join(this.directory.here(), segment));
      if (!contains(this.rootReal, target))
        return new FsError('escapes_root', `path escapes the session root: ${reportedPath}`);
    } catch {
      // A broken link, or resolution raced: refused either way.
    }
    return new FsError('not_a_file', `symlinks are not served: ${reportedPath}`);
  }
}

/**
 * Pins a session cwd by opening it once and holding the descriptor.
 *
 * `O_NOFOLLOW` is deliberately NOT used on the root itself: a session cwd may legitimately be reached
 * through a symlink (`~/Workspace` pointing elsewhere is ordinary), and the root is configured by the
 * daemon rather than supplied by a request. What matters is that whatever it resolves to is pinned ONCE
 * and never re-walked.
 *
 * The C calls are a constructor dependency so a test can withhold them and prove the refusal, and so a
 * runtime that cannot reach them fails at the first pin with a message a reader can act on instead of
 * at import time with a stack trace.
 */
export class PosixSessionRootPinner implements SessionRootPinner {
  private directory: InstalledDirectory | undefined;

  constructor(private readonly load: () => DirectorySyscalls = loadDirectorySyscalls) {}

  async pin(cwd: string): Promise<PinnedRoot> {
    const directory = this.installer();
    const fd = this.openRoot(cwd);
    try {
      // Read the location of the object we actually HOLD, not of the name we were given.
      const rootReal = directory.realPathOf(fd);
      if (!fstatSync(fd).isDirectory()) throw new FsError('not_a_directory', 'session cwd is not a directory');
      // The chokepoint every entry point shares, so a denied root is refused for listings, content,
      // diffs and changes alike.
      if (rootIsDenied(rootReal)) throw new FsError('denied', 'session cwd is not served');
      return new PosixPinnedRoot(fd, directory, rootReal);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** Loaded once. A platform that cannot reach the calls has no working-tree viewer, and says so. */
  private installer(): InstalledDirectory {
    if (this.directory === undefined) {
      try {
        this.directory = new InstalledDirectory(this.load());
      } catch {
        throw unsupportedPlatform(process.platform);
      }
    }
    return this.directory;
  }

  private openRoot(cwd: string): number {
    try {
      return openSync(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      // `ENOTDIR` from `O_DIRECTORY` means it exists but is not a directory.
      if (errorCode(error) === 'ENOTDIR') throw new FsError('not_a_directory', 'session cwd is not a directory');
      if (isMissing(error)) throw new FsError('not_found', `session cwd is not available: ${cwd}`);
      throw error;
    }
  }
}
