/**
 * A directory held OPEN, in the shape a capability that only speaks paths can use (today's
 * `lib/worktrees/ports.ts` `PinnedWorkingDirectory`, copied). Install it, start the child, and release WITHOUT
 * awaiting in between: a bracket that spans an await is visible to every other request in flight and is a bug in
 * the caller, not a tunable.
 */
export interface PinnedWorkingDirectory {
  /** Where the pin resolves to right now. Diagnostics and messages only — never reopened. */
  readonly describe: string;
  /** Installs the held directory and returns its undo, both synchronous. */
  install(): () => void;
}

/**
 * A held directory and the descriptor walk beneath it (today's `lib/session/filesystem/ports.ts`, copied with its
 * invariants): the walk that proves containment is the walk that serves the bytes. Reached through
 * `RootHandle.pin`, fenced to the plugin's declared roots.
 */

/**
 * The frozen listing contract. Anything else on disk (fifo, socket, device) is omitted from a
 * listing rather than given a fourth type no viewer can render.
 */
export type FsEntryType = 'file' | 'dir' | 'symlink';

export type FsErrorCode =
  | 'invalid_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'escapes_root'
  | 'denied'
  /** The gitignore gate, kept distinct from `denied` the same way the view flags are. */
  | 'ignored'
  /**
   * This daemon cannot confine reads here AT ALL, so the whole surface is closed rather than a
   * particular path refused.
   *
   * Kept distinct from `denied` because the two ask a client for opposite behaviour: a `denied` path is
   * one refusal among many on a working surface, and retrying a different path is sensible. This is a
   * property of the machine the daemon runs on, unchanged by any retry — a client that offers one is
   * offering a control that cannot succeed.
   */
  | 'unsupported';

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

/** What a human calls the system they are running, so a refusal reads as a fact about their computer. */
const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', win32: 'Windows' };

/**
 * The one refusal a viewer shows verbatim, so it is written for BOTH of its readers.
 *
 * The first clause is what a person needs: the feature is missing on their machine, and it is neither
 * their fault nor something they can configure away. The clause after the dash is what a developer
 * needs, because a surface that only says "unavailable" sends them into the source to find out WHICH
 * mechanism is absent. A client shows the first and folds the second away.
 *
 * The platform is an argument rather than something this layer reads, and an unknown one is named as
 * the runtime spells it — a wrong-but-honest "sunos" beats inventing a friendly name for a system
 * nobody here has tested.
 */
export function unsupportedPlatform(platform: string): FsError {
  return new FsError(
    'unsupported',
    `file browsing is not available on ${PLATFORM_NAMES[platform] ?? platform} yet — this daemon ` +
      'confines every read to the session folder by holding that folder open, and it has no way to ' +
      'do that here',
  );
}

/**
 * Identity of one component in the descriptor-backed walk.
 *
 * `dev` + `ino` detect replacement with another object. `mode` catches a type change that preserved the
 * inode. Both are exact, and nothing about them depends on a clock.
 *
 * `ctimeNs` detects an ABA rename — the old directory moved away, the replacement used for the Git policy
 * check, then the old directory moved back — because a rename stamps the moved inode's ctime even when the
 * final name once again resolves to the original inode. That detection is BEST-EFFORT: a timestamp only
 * moves when the clock it is read from has ticked, and Linux stamps from the coarse clock (one tick is
 * 1–10 ms) unless the filesystem has fine-grained timestamps, so a round trip inside one tick leaves ctime
 * where it was and is invisible. It is kept at full nanosecond precision so that nothing the kernel DID
 * record is thrown away here.
 *
 * Best-effort is safe because of what an ABA can and cannot change. The object at the name afterwards is
 * the SAME directory the descriptor holds, and every byte is served through that descriptor, so containment,
 * the state-home fence (by device and inode), the hard-link refusal and the denylist are decided on the
 * object served and never consult ctime. What a round trip can launder is only the Git verdict, which is a
 * verdict on a NAME — and whoever can rename inside the worktree can already move an ignored file to a name
 * Git does not ignore, with no race at all. The ignore gate keeps a tree's own secrets out of the viewer; it
 * was never a boundary against the tree's writer.
 */
export interface ComponentIdentity {
  /** Exact, as a `bigint` stat gives it: an inode past 2^53 rounded to a number could match another, or miss. */
  readonly dev: bigint;
  readonly ino: bigint;
  /** Nanoseconds, from the same `bigint` stat: the millisecond figure would hide a change the kernel recorded. */
  readonly ctimeNs: bigint;
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
  /**
   * How many names (hard links) the object has, from the same `fstat`. Absent where the platform did not
   * say. A read for an agent refuses a file with more than one: another name could be inside the state home.
   */
  readonly links?: number;
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
  /** The directory held at least one entry past the cap, or the budget ran out part-way through it. */
  readonly truncated: boolean;
}

/**
 * A cooperative stop, asked BETWEEN steps and never able to interrupt one.
 *
 * The whole-tree index is the one read here that can run long enough for a caller to give up on it or
 * for a deadline to matter, and neither can be honoured by abandoning the work: a `Promise.race` that
 * resolves early leaves enumerations and opens running against a root the domain has already closed,
 * which is a use-after-close in the one subsystem whose entire purpose is holding descriptors correctly.
 * So nothing is ever abandoned. Every loop that could take another step asks first, and a step already
 * begun is always awaited and always closed.
 *
 * The RESIDUAL that buys is exact and worth stating: at most one already-started operation finishes
 * after `expired()` first turns true. For a walk to one path that is a bounded component walk — depth
 * many opens, microseconds. For an enumeration it would be a whole directory, which is why
 * {@link PinnedTarget.list} takes a budget and stops mid-directory rather than at its end. Underneath
 * both sits one filesystem call that no cooperative check can shorten; a hung mount is bounded by the
 * kernel, not by this.
 *
 * A Git child is the one residual this cannot shorten AT ALL. Nothing here can reach into a spawn
 * already running, so an abort arriving mid-command is not felt until that command ends — which is why
 * every Git question in an index read is given the caller's REMAINING budget as its own timeout, and why
 * the budget is asked again before each one. The guarantee is therefore precise: no new child is started
 * after cancellation, and one already started is bounded by the timeout it was given, never by the abort.
 */
export interface WorkBudget {
  /** Has the deadline passed, or has the caller gone away? Asked often; must stay cheap and pure. */
  expired(): boolean;
}

/**
 * The same budget, handed to something that starts a CHILD.
 *
 * A spawn cannot be interrupted from here at all, so it gets the two facts that let it be bounded from
 * the outside instead: whether to start at all, and how long it may take if it does. An implementation
 * that runs more than one command must ask BOTH between them — a timeout alone would let a caller who
 * allowed ten seconds wait twenty, and a cancellation the first command never saw would still start the
 * second.
 */
export interface SpawnBudget extends WorkBudget {
  /** Milliseconds left. Zero exactly when {@link WorkBudget.expired} is true, so it is never a licence. */
  remainingMs(): number;
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
  /**
   * One level of an already-open directory, streamed and stopped one entry past `maxEntries`.
   *
   * A `budget` that expires part-way stops the stream where it stands and reports `truncated`, which is
   * the same thing the entry cap already means: entries exist that this answer does not name. Classifying
   * one child needs its own filesystem calls, so a directory of thousands is the one enumeration long
   * enough to be worth abandoning from the inside rather than after it finishes.
   */
  list(maxEntries: number, budget?: WorkBudget): Promise<PinnedListing>;
  close(): Promise<void>;
}

/** How a walk should treat the LEAF. Interior components are always required to be directories. */
export interface PinnedOpenOptions {
  readonly wantDirectory?: boolean;
}

/**
 * What a {@link PinnedFileProbe} found at one name.
 *
 * - `file`: a regular file, reached by the pinned walk with no symlink at ANY component.
 * - `unsupported`: nothing a read would serve — absent, a directory, a symlink anywhere on the way, or
 *   a path no walk accepts. The same answer an `open` refusal with a domain code gives.
 * - `unreadable`: the kernel refused for a reason that is not about the object's kind (`EACCES` on a
 *   directory, `EIO`), so the name was not proved either way.
 */
export type PinnedFileKind = 'file' | 'unsupported' | 'unreadable';

/**
 * Many "is this a regular file?" questions against ONE pin, sharing every directory walk between them.
 *
 * WHY THIS EXISTS. An index proves tens of thousands of names. Asking each through {@link PinnedRoot.open}
 * re-walked every component from the root, opened a descriptor per component and opened the leaf itself
 * — on a host whose endpoint security intercepts every `open`, that was seconds of synchronous work in
 * one turn of the event loop. A probe keeps the chain of directories it last walked OPEN, so siblings
 * and cousins re-walk nothing, and it answers the leaf from the leaf's own metadata without opening it.
 *
 * WHAT IT STILL PROMISES. No symlink is followed: every directory on the chain was opened by the same
 * refusing step a read uses, and the leaf's verdict is the leaf's OWN type, so a link at the leaf is
 * `unsupported` rather than whatever it points at.
 *
 * WHAT IT IS NOT. A verdict about names, never a licence to serve: no bytes come from here, and every
 * read re-walks through {@link PinnedRoot.open}. A probe is scoped to the one call that opened it and
 * holds descriptors until closed, so a caller MUST close it.
 */
export interface PinnedFileProbe {
  /**
   * The kind of each of `rels`, in order, for a PREFIX of them.
   *
   * `budget` is asked once before each name; the first time it has expired the answer stops there and is
   * shorter than `rels`, which is how a caller tells "not looked at" from any verdict. An implementation
   * that works synchronously hands the event loop back before it starts, so a caller asking in batches
   * never holds the loop for longer than one batch.
   */
  classify(rels: readonly string[], budget?: WorkBudget): Promise<readonly PinnedFileKind[]>;
  close(): Promise<void>;
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
  readonly policyCwd: string | PinnedWorkingDirectory;
  /** Walk `rel` component by component from the pin, refusing a symlink at ANY component. */
  open(rel: string, options?: PinnedOpenOptions): Promise<PinnedTarget>;
  /** A batch of regular-file questions sharing one walk. Closing the root does not close it. */
  probe(): PinnedFileProbe;
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
  pin(cwd: string, options?: PinOptions): Promise<PinnedRoot>;
}

/** What the CALLER's policy adds at the pin's one chokepoint (today: the session viewer's denied roots). */
export interface PinOptions {
  /** Refuse this root (`FsError` `denied`) before anything beneath it is reached: listings, content, Git alike. */
  readonly refuseRoot?: (rootReal: string) => boolean;
}

/**
 * What `RootHandle.pin` answers: a {@link PinnedRoot} whose `policyCwd` is always the held object (a Linux path alias
 * stays inside the kernel), and the only cwd `kernel.spawn` accepts as a pin, from the plugin whose root minted it.
 */
export interface HeldRoot extends PinnedRoot {
  readonly policyCwd: PinnedWorkingDirectory;
}
