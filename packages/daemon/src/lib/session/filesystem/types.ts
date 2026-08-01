/**
 * The frozen vocabulary of the session working-tree viewer.
 *
 * This surface is an arbitrary-file-read primitive wearing a viewer costume, so containment is the
 * feature rather than a precaution. Threat model: the daemon's bearer token is assumed to be in a
 * visitor's hands, because the PWA reaches the daemon through a tunnel whose local proxy makes every
 * request arrive from loopback. Nothing in this subsystem may rely on "only the owner has the token".
 *
 * The layers a request meets, in order:
 *
 *  1. Syntactic gate, before any filesystem call — no absolute paths, no `..`, no backslashes, no
 *     NUL, no control characters, no empty segments ({@link normalizeRelativePath}).
 *  2. Containment by DESCRIPTOR, not by string. The root is opened once and held, and each component
 *     is then opened `O_DIRECTORY|O_NOFOLLOW` from its already-open parent. The walk that validates
 *     IS the walk that serves, which is what closes the component-level TOCTOU.
 *  3. Regular files only, read by HANDLE. Symlinks are never served — not at the leaf and not at any
 *     interior component.
 *  4. Unconditional denylist by basename/glob, plus all of `.git/` and `node_modules/`, refused in
 *     content and in diff, and applied to the LEXICAL path as well as the canonical one.
 *  5. Gitignore gate — content of a gitignored path is refused, and a gitignored DIRECTORY cannot be
 *     enumerated either, because the filenames inside one are themselves the leak.
 *  6. Caps — one mebibyte per file, two thousand entries per listing, a NUL inside the sniff window
 *     means binary and no content.
 */

/** Largest file whose bytes are served. Bigger files report their real size and no content. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Largest number of entries one listing reports. One dirent past this sets `truncated`. */
export const MAX_LISTING_ENTRIES = 2_000;

/** How far into a file a NUL byte still means "do not try to render this as text". */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Per-side cap for a diff. Both sides are held in memory and staged into a scratch directory before
 * Git sees them, so this bounds that cost; the rendered diff is separately capped by the runner's
 * stdout limit.
 *
 * Spelled out rather than aliased to {@link MAX_FILE_BYTES}: the two are equal today by coincidence of
 * judgement, not by a rule, and an alias would make one of them silently follow the other the next time
 * somebody tunes a viewer limit.
 */
export const MAX_DIFF_SIDE_BYTES = 1024 * 1024;

export type FsErrorCode =
  | 'invalid_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'escapes_root'
  | 'denied'
  /** The gitignore gate, kept distinct from `denied` the same way the view flags are. */
  | 'ignored';

/** Every refusal this subsystem raises. The code is the contract; the message is for a human. */
export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FsError';
  }
}

/**
 * The frozen listing contract. Anything else on disk (fifo, socket, device) is omitted from a
 * listing rather than given a fourth type no viewer can render.
 */
export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsEntry {
  readonly name: string;
  readonly type: FsEntryType;
  readonly size?: number;
  readonly mtime?: string;
  /** Gitignored: listed, never served. */
  readonly ignored?: boolean;
  /** On the unconditional denylist: listed, never served. */
  readonly denied?: boolean;
  /** A symlink resolving outside the session root, or broken: listed, never served. */
  readonly escapes?: boolean;
}

export interface FsListing {
  /** The session root as PINNED, not as configured. */
  readonly root: string;
  /** The listed directory relative to the root; `''` is the root itself. */
  readonly path: string;
  readonly entries: readonly FsEntry[];
  /** The directory held more than {@link MAX_LISTING_ENTRIES} entries. */
  readonly truncated?: boolean;
}

/** Why a view carries no bytes. Distinct from the flags so a client can branch without prose. */
export type FsRefusalReason = 'denylist' | 'ignored' | 'escapes';

export interface FsFileView {
  readonly path: string;
  readonly size: number;
  readonly mtime?: string;
  /** Present only when content is actually served. */
  readonly content?: string;
  /** A NUL byte inside the first {@link BINARY_SNIFF_BYTES}. */
  readonly binary?: boolean;
  /** Larger than the cap; `size` still reports the real size. */
  readonly tooLarge?: boolean;
  /** Refused by the HARD denylist only, so a client can say "never served". */
  readonly denied?: boolean;
  /** Refused by the gitignore gate, or because we could not prove otherwise. */
  readonly ignored?: boolean;
  readonly reason?: FsRefusalReason;
  /** Served from `HEAD` rather than from the working tree. */
  readonly rev?: 'head';
}

export interface FsDiffView {
  readonly path: string;
  readonly diff: string;
  readonly kind: 'tracked' | 'untracked' | 'none';
  readonly truncated?: boolean;
  /** Hard denylist. */
  readonly denied?: boolean;
  /** Gitignore gate. The same split as {@link FsFileView}. */
  readonly ignored?: boolean;
  readonly reason?: 'denylist' | 'ignored';
}

/** Where a validated relative path landed, for callers that only want the location. */
export interface ResolvedTarget {
  /** Realpath of the root AS PINNED. */
  readonly rootReal: string;
  /** The normalised path relative to the root. */
  readonly rel: string;
  /**
   * The absolute path after the pinned walk, guaranteed inside the root.
   *
   * This is a NAME derived from the walk that proved containment. Anything that goes on to read
   * bytes must use the walk's own handle instead, because a name can be redirected the moment it is
   * returned.
   */
  readonly absolute: string;
}
