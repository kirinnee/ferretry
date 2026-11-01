import {
  type BigIntStats,
  closeSync,
  constants,
  type Dir,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  read,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  type ComponentIdentity,
  type FsEntryType,
  FsError,
  type PinnedDirectoryEntry,
  type PinnedFileKind,
  type PinnedFileProbe,
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
  leafErrorKind,
  leafKind,
  type ProbeSegments,
  pinnedMetadata,
  probeSegments,
  refusedKind,
  sameDirectory,
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
 * would quietly describe another tree. So each bracket asks `.` for its identity and compares it against
 * the descriptor just installed, and the whole surface refuses on a mismatch. The proof is made with the
 * SAME call the bracket then relies on: a bracket that opens proves by opening `.`, and a bracket that
 * only describes names proves by describing `.` — one `lstat` rather than an `open`, which matters on a
 * host whose endpoint security intercepts every `open`.
 *
 * WHY AN INDEX PROBES RATHER THAN OPENS. A file index proves tens of thousands of names, and walking
 * each from the root cost a bracket, an `open`, an `fstat` and a `close` PER COMPONENT PER NAME — about
 * fifty calls for a file four directories deep, every one of them synchronous. {@link PosixFileProbe}
 * holds the chain of directories it last walked, so a sibling re-walks nothing, and describes a run of
 * siblings inside ONE bracket. See that class for what it does and does not promise.
 *
 * ACCEPTED RESIDUAL RISK, beyond those the sibling implementation lists. A listed SYMLINK's badge —
 * does it escape, what does it point at, how big is it — needs one `realpath`, and it is given an
 * absolute path built from the pinned directory's own kernel-reported location, because this runtime's
 * `realpath` cannot be aimed at a descriptor. An ancestor renamed in that instant yields a wrong BADGE.
 * It cannot yield wrong bytes: name and type come from the pinned enumeration, and no symlink is ever
 * served.
 */

/**
 * The synchronous file calls this pinner makes, and nothing else.
 *
 * A constructor dependency for one reason: so a test can COUNT them. On a host where every `open` is
 * intercepted, the number of calls a request makes is its latency, and a budget nobody measures is a
 * budget that regresses silently.
 */
export interface PinFileCalls {
  open(name: string, flags: number): number;
  close(fd: number): void;
  /** `bigint`, so a component's device and inode are exact. */
  fstat(fd: number): BigIntStats;
  /** `bigint` like `fstat`, because the working-directory proof compares the two by device and inode. */
  lstat(name: string): BigIntStats;
  stat(name: string): Stats;
  realpath(name: string): string;
  opendir(name: string): Dir;
}

/** The runtime's own calls, which is what every caller but a counting test passes. */
export const NODE_PIN_FILE_CALLS: PinFileCalls = {
  open: (name, flags) => openSync(name, flags),
  close: fd => closeSync(fd),
  fstat: fd => fstatSync(fd, { bigint: true }),
  lstat: name => lstatSync(name, { bigint: true }),
  stat: name => statSync(name),
  realpath: name => realpathSync(name),
  opendir: name => opendirSync(name),
};

/** Hands the event loop back before a batch of synchronous calls, so batches cannot add up to a stall. */
const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** How a bracket proves the kernel installed what it was asked to: by the same call the bracket uses. */
type Proof = 'open' | 'describe';

/**
 * The runtime's own working directory, borrowed and handed back.
 *
 * Held as a DESCRIPTOR rather than as a name: restoring by pathname would fail once that directory were
 * renamed or removed, and would leave the runtime standing in a session's tree — the worst place to
 * leave it.
 */
class InstalledDirectory {
  private home: number | undefined;

  constructor(
    private readonly syscalls: DirectorySyscalls,
    readonly fs: PinFileCalls,
  ) {}

  /**
   * Installs `fd`, proves the kernel agrees, and returns the undo.
   *
   * The undo never throws: it is called from a `finally`, where a throw would replace the caller's own
   * error with this one and leave the runtime standing in a session's directory.
   *
   * `identity` is the installed descriptor's own `fstat`, when the caller already holds it — an open
   * descriptor's device and inode cannot change, so asking again would be a call that proves nothing.
   */
  install(fd: number, proof: Proof = 'open', identity?: BigIntStats): () => void {
    this.home ??= this.fs.open('.', constants.O_RDONLY | constants.O_DIRECTORY);
    const home = this.home;
    if (this.syscalls.fchdir(fd) !== 0) throw new FsError('denied', 'the session folder could not be held open');
    const release = (): void => {
      this.syscalls.fchdir(home);
    };
    try {
      this.prove(fd, proof, identity);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  /** Runs `act` with `fd` installed. `act` MUST NOT await — see this file's header. */
  enter<Result>(fd: number, act: () => Result, proof: Proof = 'open', identity?: BigIntStats): Result {
    const release = this.install(fd, proof, identity);
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
   * directory, so every relative call in the bracket would land somewhere unintended. There is no
   * degraded mode to fall back to, and a pathname fallback is the hole this class exists to close.
   */
  private prove(fd: number, proof: Proof, identity: BigIntStats | undefined): void {
    const installed = identity ?? this.fs.fstat(fd);
    const reached = proof === 'describe' ? this.fs.lstat('.') : this.reachedByOpen();
    if (reached.dev !== installed.dev || reached.ino !== installed.ino) throw unsupportedPlatform(process.platform);
  }

  private reachedByOpen(): BigIntStats {
    const here = this.fs.open('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      return this.fs.fstat(here);
    } finally {
      this.fs.close(here);
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
      const dir = this.directory.fs.opendir('.');
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
      this.directory.fs.close(this.fd);
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
    const fs = this.directory.fs;
    if (type !== 'symlink') {
      try {
        const metadata = fs.lstat(name);
        return { name, type, size: Number(metadata.size), mtime: metadata.mtime.toISOString() };
      } catch (error) {
        if (!isMissing(error)) throw error;
        return { name, type };
      }
    }
    try {
      const linkReal = fs.realpath(path.join(here, name));
      if (!contains(this.rootReal, linkReal)) return { name, type, escapes: true };
      const metadata = fs.stat(name);
      const target = canonicalRel(this.rootReal, linkReal);
      return { name, type, size: metadata.size, mtime: metadata.mtime.toISOString(), ...(target ? { target } : {}) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { name, type, escapes: true }; // a broken link: nothing to serve either way
    }
  }
}

/** One directory a probe holds open, with the name that reached it from its parent and its identity. */
interface HeldDirectory {
  readonly name: string;
  readonly fd: number;
  readonly identity: BigIntStats;
}

/** Opens ONE directory component from its already-open parent, refusing a link: the walk's own step. */
type DirectoryStep = (parent: number, segment: string, reported: string) => number;

/**
 * Many regular-file questions against one pin, sharing every directory walk between them.
 *
 * THE CHAIN. The probe holds the directories it last walked, root-most first. A name in the same
 * directory reuses the whole chain; a cousin closes back to the shared ancestor and opens only what
 * differs. Candidates arrive sorted, so a tree of N files in D directories costs about D opens rather
 * than one per component per file — and the chain is never deeper than the deepest path, so the
 * descriptors held stay bounded however large the tree.
 *
 * THE LEAF. Answered by `lstat` inside a bracket on its parent, never by opening it: an index needs the
 * leaf's TYPE, and `lstat` reports a link as a link, so there is nothing to follow. Every sibling that
 * follows in the same directory is described inside the SAME bracket.
 *
 * WHAT CHANGED BY NOT OPENING THE LEAF, said plainly. A regular file the daemon may not read (mode
 * `000`) is now listed rather than counted `unreadable`: it IS a name in the tree, and the read that
 * follows still opens it through the walk and reports its own refusal. It also means a FIFO at a
 * tracked path can no longer stall the walk by being opened for reading.
 */
class PosixFileProbe implements PinnedFileProbe {
  private readonly chain: HeldDirectory[] = [];
  /** The last directory that refused, so its remaining children cost no second walk. */
  private refused: { readonly directory: string; readonly kind: PinnedFileKind } | undefined;
  private rootIdentity: BigIntStats | undefined;
  private closed = false;

  constructor(
    private readonly rootFd: number,
    private readonly directory: InstalledDirectory,
    private readonly step: DirectoryStep,
  ) {}

  async classify(rels: readonly string[], budget?: WorkBudget): Promise<readonly PinnedFileKind[]> {
    if (this.closed) throw new Error('the file probe is closed');
    await yieldToLoop();
    const split = rels.map(probeSegments);
    const kinds: PinnedFileKind[] = [];
    let stopped = false;
    while (!stopped && kinds.length < rels.length) {
      if (budget?.expired() === true) break;
      const first = split[kinds.length];
      if (first === undefined) {
        kinds.push('unsupported');
        continue;
      }
      const held = this.reach(first.directories);
      if (typeof held === 'string') {
        kinds.push(held);
        continue;
      }
      // One bracket for this name AND every sibling that follows it; the budget is still asked before each.
      this.directory.enter(
        held.fd,
        () => {
          kinds.push(this.describe(first.leaf));
          while (kinds.length < rels.length) {
            const next: ProbeSegments | undefined = split[kinds.length];
            if (next === undefined || !sameDirectory(next.directories, first.directories)) return;
            if (budget?.expired() === true) {
              stopped = true;
              return;
            }
            kinds.push(this.describe(next.leaf));
          }
        },
        'describe',
        held.identity,
      );
    }
    return kinds;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release(0);
  }

  /** The leaf's own type, from inside its parent's bracket. */
  private describe(leaf: string): PinnedFileKind {
    try {
      return leafKind(this.directory.fs.lstat(leaf));
    } catch (error) {
      return leafErrorKind(error);
    }
  }

  /** Holds the chain open down to `directories`, or names why it could not be reached. */
  private reach(directories: readonly string[]): Pick<HeldDirectory, 'fd' | 'identity'> | PinnedFileKind {
    const key = directories.join('/');
    const refused = this.refused;
    if (refused !== undefined && (key === refused.directory || key.startsWith(`${refused.directory}/`)))
      return refused.kind;
    let kept = 0;
    while (kept < this.chain.length && kept < directories.length && this.chain[kept]?.name === directories[kept])
      kept += 1;
    this.release(kept);
    for (const [depth, segment] of directories.entries()) {
      if (depth < kept) continue;
      const parent = this.chain.at(-1)?.fd ?? this.rootFd;
      let fd: number;
      try {
        fd = this.step(parent, segment, directories.slice(0, depth + 1).join('/'));
      } catch (error) {
        this.refused = { directory: directories.slice(0, depth + 1).join('/'), kind: refusedKind(error) };
        return this.refused.kind;
      }
      try {
        this.chain.push({ name: segment, fd, identity: this.directory.fs.fstat(fd) });
      } catch (error) {
        this.directory.fs.close(fd);
        this.refused = { directory: directories.slice(0, depth + 1).join('/'), kind: refusedKind(error) };
        return this.refused.kind;
      }
    }
    const top = this.chain.at(-1);
    if (top !== undefined) return top;
    this.rootIdentity ??= this.directory.fs.fstat(this.rootFd);
    return { fd: this.rootFd, identity: this.rootIdentity };
  }

  /** Closes every held directory deeper than `depth`. The root itself belongs to the pin and stays. */
  private release(depth: number): void {
    while (this.chain.length > depth) {
      const held = this.chain.pop();
      if (held === undefined) break;
      try {
        this.directory.fs.close(held.fd);
      } catch {
        // already closed
      }
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
    const fs = this.directory.fs;
    const segments = rel === '' ? [] : rel.split('/');
    // A fresh descriptor for the same directory, so the walk can close what it holds without ever
    // closing the root itself.
    let current = this.directory.enter(this.fd, () => fs.open('.', constants.O_RDONLY | constants.O_DIRECTORY));
    let metadata = fs.fstat(current);
    const identities: ComponentIdentity[] = [componentIdentity(metadata)];
    const walked: string[] = [];

    try {
      for (const [index, segment] of segments.entries()) {
        const isLeaf = index === segments.length - 1;
        const wantDirectory = !isLeaf || options.wantDirectory === true;
        const next = this.step(current, segment, [...walked, segment].join('/'), rel, wantDirectory);
        // Adopt the new descriptor BEFORE describing it. The outer catch closes whatever `current`
        // holds, so a failing `fstat` needs no error path of its own and cannot leak a descriptor.
        fs.close(current);
        current = next;
        metadata = fs.fstat(current);
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
      fs.close(current);
      throw error;
    }
  }

  probe(): PinnedFileProbe {
    return new PosixFileProbe(this.fd, this.directory, (parent, segment, reported) =>
      this.step(parent, segment, reported, reported, true),
    );
  }

  async close(): Promise<void> {
    try {
      this.directory.fs.close(this.fd);
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
        return this.directory.fs.open(segment, flags);
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
      return this.directory.fs.lstat(segment).isSymbolicLink();
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
      const target = this.directory.fs.realpath(path.join(this.directory.here(), segment));
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
 * at import time with a stack trace. The file calls are one so a test can count them.
 */
export class PosixSessionRootPinner implements SessionRootPinner {
  private directory: InstalledDirectory | undefined;

  constructor(
    private readonly load: () => DirectorySyscalls = loadDirectorySyscalls,
    private readonly fs: PinFileCalls = NODE_PIN_FILE_CALLS,
  ) {}

  async pin(cwd: string): Promise<PinnedRoot> {
    const directory = this.installer();
    const fd = this.openRoot(cwd);
    try {
      // Read the location of the object we actually HOLD, not of the name we were given.
      const rootReal = directory.realPathOf(fd);
      if (!this.fs.fstat(fd).isDirectory()) throw new FsError('not_a_directory', 'session cwd is not a directory');
      // The chokepoint every entry point shares, so a denied root is refused for listings, content,
      // diffs and changes alike.
      if (rootIsDenied(rootReal)) throw new FsError('denied', 'session cwd is not served');
      return new PosixPinnedRoot(fd, directory, rootReal);
    } catch (error) {
      this.fs.close(fd);
      throw error;
    }
  }

  /** Loaded once. A platform that cannot reach the calls has no working-tree viewer, and says so. */
  private installer(): InstalledDirectory {
    if (this.directory === undefined) {
      try {
        this.directory = new InstalledDirectory(this.load(), this.fs);
      } catch {
        throw unsupportedPlatform(process.platform);
      }
    }
    return this.directory;
  }

  private openRoot(cwd: string): number {
    try {
      return this.fs.open(cwd, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch (error) {
      // `ENOTDIR` from `O_DIRECTORY` means it exists but is not a directory.
      if (errorCode(error) === 'ENOTDIR') throw new FsError('not_a_directory', 'session cwd is not a directory');
      if (isMissing(error)) throw new FsError('not_found', `session cwd is not available: ${cwd}`);
      throw error;
    }
  }
}
