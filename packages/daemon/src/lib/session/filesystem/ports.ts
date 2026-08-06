import type { GitWorkingDirectory } from '../../worktrees/ports.ts';
import type { FsEntryType } from './types.ts';

/**
 * The two capabilities the session working-tree viewer needs from the outside world.
 *
 * WHY CONTAINMENT IS A PORT AND NOT A HELPER. The gates in this directory judge PATHS, and a check
 * performed on a name is not a check performed on the file that is eventually opened. What makes the
 * viewer safe is that the walk which proves containment is the same walk that produces the descriptor
 * the bytes come from — so that walk cannot be a string function in the domain. It is declared here as
 * {@link SessionRootPinner} and implemented once, against a kernel that can express "open this
 * component from that already-open parent, and refuse to follow a link".
 *
 * WHY GIT IS A PORT. Two of the six gates are Git policy — is this path ignored, is it tracked — and
 * both of them are answered by a process that only speaks pathnames. That is a real weakness, and the
 * domain compensates for it by re-walking the name afterwards and proving every component is still the
 * object whose descriptor served the request ({@link PinnedTarget.identities}). Declaring Git as a port
 * keeps that compensation in the domain where it is unit-testable, rather than inside an adapter where
 * a fake could not exercise it.
 */

/**
 * Identity of one component in the descriptor-backed walk.
 *
 * `dev` + `ino` detect replacement with another object. `ctimeMs` also detects an ABA rename — the old
 * directory moved away, the replacement used for the Git policy check, then the old directory moved
 * back — because a rename changes ctime even when the final name once again resolves to the original
 * inode. `mode` catches a type change that preserved the inode.
 */
export interface ComponentIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly mode: number;
}

/** What the walk learned about the object it opened, from an `fstat` of the handle itself. */
export interface PinnedMetadata {
  /** `other` covers a fifo, socket or device: a thing no viewer can render. */
  readonly type: 'file' | 'dir' | 'other';
  readonly size: number;
  readonly mtime: string;
  /** POSIX mode bits. Only the executable bit is used, to keep a diff's file mode honest. */
  readonly mode: number;
}

/**
 * One child of a pinned directory, already classified through the pinned descriptor.
 *
 * `escapes` and `target` are resolved by the adapter because they need a `realpath` and a containment
 * comparison against the pinned root — both IO. Everything the DOMAIN then decides about this entry
 * (denylist, gitignore, ordering) is decided from these fields alone.
 */
export interface PinnedDirectoryEntry {
  readonly name: string;
  readonly type: FsEntryType;
  readonly size?: number;
  readonly mtime?: string;
  /** A symlink whose target resolves outside the pinned root, or a broken one. Never served. */
  readonly escapes?: boolean;
  /** Root-relative canonical path of a CONTAINED symlink's target, so the gates can judge it. */
  readonly target?: string;
}

export interface PinnedListing {
  readonly entries: readonly PinnedDirectoryEntry[];
  /** The directory held at least one entry past the cap. */
  readonly truncated: boolean;
}

/**
 * An object opened through the pinned walk, held OPEN.
 *
 * Every read goes through this handle rather than through a pathname, which is the whole point: `stat`
 * then `readFile` checks one path and reads another, and everything in between — the leaf, a parent, the
 * root itself — can be replaced with a symlink pointing anywhere.
 */
export interface PinnedTarget {
  readonly metadata: PinnedMetadata;
  /**
   * Root-relative canonical path of what was actually opened, `''` for the root.
   *
   * The walk refuses interior symlinks, so this equals the requested path today. The gates check it
   * anyway, because they must not depend on that invariant holding through a future refactor.
   */
  readonly canonical: string;
  /** The identity of every component of the walk, root first and leaf last. */
  readonly identities: readonly ComponentIdentity[];
  /** Bytes of an already-open regular file, or `undefined` when it exceeds `maxBytes`. */
  read(maxBytes: number): Promise<Uint8Array | undefined>;
  /** One level of an already-open directory, streamed and stopped one entry past `maxEntries`. */
  list(maxEntries: number): Promise<PinnedListing>;
  close(): Promise<void>;
}

/** How a walk should treat the LEAF. Interior components are always required to be directories. */
export interface PinnedOpenOptions {
  readonly wantDirectory?: boolean;
}

/**
 * A session root held OPEN, so nothing can be substituted underneath it.
 *
 * A resolved root STRING is only a claim about the past. Between validating a cwd and using it, the
 * directory it names can be renamed away and replaced with a symlink to anywhere — after which every
 * subsequent open, enumeration and Git spawn that re-walks the string lands outside the tree, having
 * passed containment, the denylist and the gitignore gate on a path that no longer describes the bytes
 * being served. Holding the descriptor makes the root an OBJECT rather than a name.
 */
export interface PinnedRoot {
  /** Realpath of the root AS PINNED — for reporting and for the root gate, never for re-opening. */
  readonly rootReal: string;
  /**
   * The pinned DESCRIPTOR, in whatever shape this platform can hand to a capability that only speaks
   * paths — Git's working directory. A caller reached from HTTP must pass this and never the configured
   * cwd.
   *
   * A string here is a path that resolves to the descriptor itself rather than to a name that can be
   * re-pointed (Linux spells that `/proc/<pid>/fd/<n>`); a {@link PinnedWorkingDirectory} is the same
   * guarantee on a platform with no such alias, installed for the instant of the spawn. What both
   * spellings promise is identical, and neither is the configured pathname.
   */
  readonly policyCwd: GitWorkingDirectory;
  /** Walk `rel` component by component from the pin, refusing a symlink at ANY component. */
  open(rel: string, options?: PinnedOpenOptions): Promise<PinnedTarget>;
  close(): Promise<void>;
}

/**
 * Pins one session's working directory.
 *
 * An implementation that cannot hand an already-open descriptor to a path-only API must FAIL, not fall
 * back to the configured pathname: the fallback re-opens the root-swap hole this port exists to close.
 * The whole surface failing closed on such a platform is the correct outcome.
 */
export interface SessionRootPinner {
  /** `cwd` is the CONFIGURED pathname from the session document — the last name this subsystem trusts. */
  pin(cwd: string): Promise<PinnedRoot>;
}

export interface SessionRepoInfo {
  readonly repo: boolean;
  /** Absolute worktree top level. */
  readonly root?: string;
  /** The session cwd relative to the repo root: `''` at the root, otherwise slash-terminated. */
  readonly prefix: string;
  /** The current branch, or `undefined` when detached. */
  readonly branch?: string;
  /** False in a freshly initialised repo with no commits. */
  readonly hasHead: boolean;
}

export interface SessionGitChange {
  /** Relative to the SESSION cwd, never to the repo root. */
  readonly path: string;
  /** The two-character porcelain XY code, for example `" M"`, `"A "`, `"??"`. */
  readonly status: string;
  /** Rename or copy source, relative to the session cwd. Omitted when the source sits outside it —
   *  reporting it would leak a sibling path. */
  readonly from?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface SessionChangesView {
  readonly repo: boolean;
  readonly branch?: string;
  readonly changes: readonly SessionGitChange[];
  /** Git's own output hit the byte cap, so the list may be incomplete. */
  readonly truncated?: boolean;
}

/** One side of a diff, as bytes the caller already holds. */
export interface DiffSide {
  readonly bytes: Uint8Array;
  /** A Git file mode: `0o100644`, `0o100755`, or `0o120000` for a symlink whose bytes are link TEXT. */
  readonly mode: number;
}

/** The HEAD entry for one path: its recorded mode plus its bytes, which the diff formatter needs so a
 *  mode change or a symlink-to-file type change still renders. */
export interface HeadEntry {
  readonly mode: number;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

export interface HeadBlob {
  readonly size: number;
  /** Absent when the blob is larger than the caller's cap. */
  readonly bytes?: Uint8Array;
}

export interface RenderedDiff {
  readonly diff: string;
  readonly truncated: boolean;
}

/**
 * Every path under the session cwd that Git does not exclude, in ONE answer.
 *
 * The gitignore rule is applied by the tool that owns it — `--exclude-standard` — rather than being
 * re-derived a directory at a time, which is both the correct owner and the difference between one
 * question and one per directory. `truncated` means Git's own output hit the caller's byte cap, so the
 * list is short by an amount nobody can know without asking again for more.
 */
export interface SessionFileList {
  /** Relative to the session cwd, in Git's own order, each name at most once. */
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/**
 * The Git reads this viewer needs, every one of them taking a PINNED working directory.
 *
 * `ignoredPaths` must THROW when it cannot tell, rather than answering "not ignored": a viewer that
 * cannot prove a file is unignored must not claim it is safe to serve, and the domain turns that throw
 * into a refusal.
 */
export interface SessionGit {
  repoInfo(cwd: GitWorkingDirectory): Promise<SessionRepoInfo>;
  /**
   * Every unexcluded path beneath this working directory, bounded by `maxBytes` of Git output.
   *
   * Throws when Git could not answer, and the DOMAIN turns that into an index that reports itself
   * incomplete rather than into a refusal of the whole read: a search surface that answers "no files"
   * and a search surface that answers "I could not look" must not be the same response, because only one
   * of them tells a reader to stop trusting the result. What this returns is a candidate list and never
   * a permission — every gate still runs on the read that follows.
   */
  listFiles(cwd: GitWorkingDirectory, maxBytes: number): Promise<SessionFileList>;
  ignoredPaths(cwd: GitWorkingDirectory, rels: readonly string[]): Promise<ReadonlySet<string>>;
  isTracked(cwd: GitWorkingDirectory, rel: string): Promise<boolean>;
  changes(cwd: GitWorkingDirectory): Promise<SessionChangesView>;
  headEntry(cwd: GitWorkingDirectory, rel: string, maxBytes: number): Promise<HeadEntry | undefined>;
  readHeadBlob(cwd: GitWorkingDirectory, rel: string, maxBytes: number): Promise<HeadBlob | undefined>;
  /** Render a unified diff between two byte snapshots the CALLER obtained, using Git as a formatter. */
  diffSnapshots(rel: string, oldSide: DiffSide | undefined, newSide: DiffSide | undefined): Promise<RenderedDiff>;
}

/**
 * Barrier awaited at the exact moment the TOCTOU window would open: after this request's path has been
 * validated and its descriptor obtained, but before any byte is read or handed to Git.
 *
 * Tests pass this; routes never do. It exists because the race it guards is real but rare — measured at
 * well under one percent of calls against a name-reopening implementation — so a stress test finds it
 * only by lottery and a green run proves nothing. With this hook a regression swaps the parent, the leaf
 * or the root precisely inside the window and asserts deterministically that only pinned bytes come
 * back. Any future refactor that reopens a path by name after validation fails those tests every run.
 *
 * Deliberately a per-call argument rather than service state: requests run concurrently, and a shared
 * mutable hook would fire for whichever request happened to be in flight.
 *
 * @internal
 */
export type AfterValidationHook = () => Promise<void>;
