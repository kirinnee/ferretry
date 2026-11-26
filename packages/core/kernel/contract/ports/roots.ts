import type { Instant, Result } from '@ferretry/std';
import type { ChildEnvironment, FencedPath, FolderRefusal } from '../bound.ts';
import type { StateFileDef } from '../define.ts';
import type { FerretId } from '../ids.ts';
import type { HeldRoot, PinOptions } from '../pinned.ts';

/** The declared roots (§7.7). */
export type RootName =
  | 'agent-homes'
  | 'harness-history'
  | 'worktrees'
  | 'work'
  | 'imports'
  | 'downloads'
  /** Logins' own sign-in material (`state/logins/credentials`): Logins alone, even if another plugin declares it. */
  | 'credentials'
  /**
   * Ferrets' per-ferret session folders (`state/ferrets/sessions/<ferret>`, the plaintext session credential file
   * among them): Ferrets alone, even if another plugin declares it.
   */
  | 'sessions'
  /**
   * The fleet folder (`<home>/fleet`: the wrappers in `bin/`, one harness home per runtime in `homes/<id>/`, `assets/`,
   * `shared/`, `setup/`, `ids.json`, `manifest.json`): Runtimes alone, even if another plugin declares it. Internal and
   * writable, made `0700` by the kernel, and reached exactly as `agent-homes` is — every call through checked,
   * no-follow descriptors, no link anywhere from the home down to it. A handle may be scoped to ONE relative folder in
   * it (`{ subfolder: 'homes/<id>' }`: one runtime's harness home and nothing beside it).
   */
  | 'fleet'
  /**
   * One harness's OWN home on this machine, as the harness itself resolves it (`CLAUDE_CONFIG_DIR` or `~/.claude`,
   * `CODEX_HOME` or `~/.codex`), for the first-run import's scan: an owner's root, READ-ONLY, Runtimes alone. The
   * handle is scoped to the ABSOLUTE folder the caller names (`{ subfolder: '/home/me/.claude' }`, exactly as
   * `harness-history` is), refuses everything inside the fence, and never follows a link out of that folder. Runtimes also
   * scopes it to a launch folder and each of its ancestors to read the Claude settings files and the repository layout
   * a start would run under (a read, never a write: nothing in the folder is changed).
   */
  | 'harness-home'
  /**
   * A project folder's own files the plugin writes on the owner's behalf (MCP's `<root>/.mcp.json`, Skills'
   * `<root>/.claude/skills/<name>/**`): an owner's root, WRITABLE, and narrowed twice. The handle is scoped PER CALL to ONE
   * absolute folder (`{ subfolder: '/home/me/project' }`, exactly as `harness-home` is) and to the relative paths the
   * manifest declared in `permissions.projectFiles`; a name outside that set is refused `not_declared` whatever the
   * folder holds. A write is as `work`'s is, with this root's one extra rule that a link at ANY level (inside the folder)
   * and a file with a second hard link are refused, never followed. It refuses everything inside the fence.
   *
   * GAP, stated exactly (redesign §7.7): the write is a checked, no-follow DESCRIPTOR write where a path reaches the
   * held folder (`/proc/self/fd`) and where it does not (macOS: the held folder's own `openat`, `renameat`, `unlinkat`,
   * each folder proven by device and inode first), so a folder swapped for a link between the check and the syscall
   * overwrites nothing outside it. A host whose descriptor calls cannot be loaded writes by path after one re-proof, as
   * before. Even with reach the parent is proved, not held (an ABA swap is not seen). No link is made into or out of
   * this root, `copyTree` included.
   *
   * Whether the folder is one Projects or Ferrets names is the PLUGIN ADAPTER's rule, never the kernel's (declared limit,
   * redesign §7.7, which lists what an adapter must check).
   */
  | 'project-files';

/**
 * {@link RootHandle.linkTo}'s target: a name in one of THIS plugin's own root handles (maybe the same one). The link
 * written points at its REAL path, resolved and fenced by that handle, never at text the caller chose.
 */
export interface RootLinkTarget {
  readonly root: RootHandle;
  readonly path: FencedPath;
  /**
   * The target may not exist yet (today's credential link: an empty sign-in slot's file is written by the harness
   * THROUGH the link). Its folder must exist and is resolved and fenced; the missing leaf is judged by name. Without
   * it a missing target is refused, so a link never dangles by accident.
   */
  readonly dangling?: true;
}

/**
 * {@link RootsPort.harnessFile}: ONE file of the host's harness setup, read-only, and nothing beside it — no path
 * argument, no listing, no write. Every read goes through one held descriptor of a regular file with exactly one name
 * (`links === 1`) that is not a link; anything else is refused.
 */
export interface RootFileHandle {
  readonly name: 'harness-home';
  /** The file's absolute path, as the caller named it (never followed). */
  readonly path: string;
  stat(): Promise<RootStat | undefined>;
  lstat(): Promise<RootLstat | undefined>;
  readText(limitBytes?: number): Promise<string>;
  readBytes(limitOrWindow?: number | RootReadWindow): Promise<Uint8Array>;
  fileIdentity(): Promise<RootIdentity | undefined>;
  readDurable<T = RootDurableRead>(
    limitBytes?: number,
    hold?: (read: RootDurableHeld) => Promise<T>,
  ): Promise<T | undefined>;
}

/** `RootHandle.copyTree`: what to bring, and how. */
export interface TreeCopyOptions {
  /** Link the destination name to the source folder (today's skill link into a runtime home) instead of copying. */
  readonly link?: boolean;
  /** The most entries a copy walks (folders count); past it the copy stops and throws. Default 10 000. */
  readonly maxEntries?: number;
}

export interface RootStat {
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly modified: Instant;
  /** POSIX permission bits (`& 0o7777`), so a copy or a replace can keep them. */
  readonly mode: number;
  /** Hard links to the object: a file with more than one may be a file from anywhere and is never read or copied. */
  readonly links: number;
}

/** What is AT a name, the leaf not followed: a link is reported as a `symlink`, never as what it points at. */
export interface RootLstat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly modified: Instant;
  /** POSIX permission bits (`& 0o7777`) of the leaf itself. */
  readonly mode: number;
  /** Hard links to the leaf itself. */
  readonly links: number;
}

/** One name in a folder, as `RootHandle.entries` lists it: the leaf as it is, never followed. */
export interface RootEntry extends RootLstat {
  readonly name: string;
}

/** `RootHandle.readBytes` with a window: `length` bytes from `offset`; fewer at the end of the file. */
export interface RootReadWindow {
  readonly offset: number;
  readonly length: number;
}

/** `RootHandle.readTail`: the bytes, and the file's size when they were read. */
export interface RootTail {
  readonly bytes: Uint8Array;
  readonly size: number;
}

/** The longest window or tail one root read returns (today's rollout tail is 256 KiB). */
export const MAX_ROOT_WINDOW_BYTES = 4 * 1024 * 1024;

export interface RootWriteOptions {
  /** POSIX mode of a file this write creates. Default `0o600`. */
  readonly mode?: number;
  /** Create only: refused when anything (a file, a link) is already at the name; never follows a link. */
  readonly exclusive?: boolean;
  /**
   * Replace an EXISTING regular file only, never through a link (today's MCP project-file replace, O_NOFOLLOW):
   * refused when nothing, a link or anything but a regular file is at the name. The new file lands atomically
   * under the name and keeps the old file's mode unless `mode` is given.
   */
  readonly replaceExisting?: boolean;
}

/** Which object a name reaches: the device and inode, so a caller can prove a path still names what it checked. */
export interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface RootPublishOptions {
  /** POSIX mode of the file this publish creates. Default `0o600`. */
  readonly mode?: number;
  /**
   * Create only: the name is taken by `link(2)` (create-if-absent in the kernel) and an existing name, a link
   * included, is reported as `exists` and left exactly as it was. Without it the new file replaces the name by rename.
   */
  readonly exclusive?: boolean;
}

/** What a {@link RootHandle.publish} came to: the file the name now reaches, or that someone else's was there first. */
export type RootPublished =
  | { readonly outcome: 'published'; readonly identity: RootIdentity }
  | { readonly outcome: 'exists' };

/**
 * One regular file opened ONCE and held (`RootHandle.openBytes`): every read and stat goes through that descriptor
 * (`pread`, `fstat`), never the pathname, so the bytes and the metadata it answers are the held object's and no other's.
 * A held descriptor pins its inode, so the inode number cannot be freed and handed to another file while this is open.
 * The caller closes it.
 */
export interface RootOpenedBytes {
  /** The device and inode of the object held (from the descriptor, never from a name). */
  readonly identity: RootIdentity;
  /**
   * The held object's creation time to the nanosecond, where the host reports one: with the identity it tells two files
   * apart that were given the same inode number in turn. `undefined` where the host knows none.
   */
  readonly birthNs: bigint | undefined;
  /** `length` bytes from `offset` (`length` at most {@link MAX_ROOT_WINDOW_BYTES}), fewer where the file ends: `pread` on the descriptor. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** The held object's size and modification time now (`fstat` on the descriptor). */
  stat(): Promise<{ readonly size: number; readonly mtimeMs: number }>;
  /**
   * Whether the NAME still reaches the held object: the leaf looked at without following a link (`lstat`) through the
   * fenced folder, a regular file with the held device and inode. `false` once it is gone, replaced or a link.
   */
  stillNames(): Promise<boolean>;
  /** Lets the descriptor go. Idempotent; a read after it is refused. */
  close(): Promise<void>;
}

/** {@link RootHandle.readDurable}: the bytes, and the identity of the file they were read from. */
export interface RootDurableRead {
  readonly bytes: Uint8Array;
  readonly identity: RootIdentity;
}

/** The `hold` argument of {@link RootHandle.readDurable}: what was read, and a question the caller asks while the file is still held. */
export interface RootDurableHeld extends RootDurableRead {
  /** Whether the NAME still reaches the very inode that was read (the descriptor pins it, so it cannot be reused). */
  stillNames(): Promise<boolean>;
}

/** Why {@link RootHandle.checkPrivateChain} refused one folder on the way. */
export type DirectoryChainFault =
  /** Nothing is there (a check makes nothing). */
  | 'missing'
  /** A file, a socket or another thing that is not a folder. */
  | 'not_directory'
  /** A symbolic link: whatever it points at, the folder could be swapped by renaming the link. */
  | 'link'
  /** Owned by somebody other than the daemon's user. */
  | 'foreign_owner'
  /** Writable by its group or by everyone: another user could add, rename or swap a name in it. */
  | 'writable_by_others'
  /** The daemon's own user is not known on this host, so ownership cannot be judged: nothing is proved. */
  | 'unknown_owner'
  /** The folder could not be looked at (no permission, a disk error): nothing is proved. */
  | 'unreadable'
  /** The folder is not below the home: this check is for the kernel-made roots, and judges nothing else. */
  | 'outside_home';

/**
 * The first folder of a chain that is not private, and why. `component` is its path RELATIVE to the home (`.` is the
 * home itself, `state/claude-code`), never absolute; `reason` is a plain sentence naming that component and carries no
 * file content and no secret value.
 */
export interface DirectoryChainProblem {
  readonly fault: DirectoryChainFault;
  readonly component: string;
  readonly reason: string;
}

/**
 * A scoped handle on one root: resolves symlinks before checking, refuses `..`, keeps today's link and device-file
 * checks, and refuses everything inside the fence for an owner's root.
 */
export interface RootHandle {
  readonly name: RootName;
  /**
   * `true` for a root the kernel makes under the home (`agent-homes`, `downloads`, `credentials`, `sessions`, `fleet`),
   * `false` for an owner's root (`work`, `imports`, `harness-history`, `harness-home`) or one outside the home
   * (`worktrees`). A consumer that must never sit on an owner's folder asserts it.
   */
  readonly internal: boolean;
  resolve(relative: string): Result<FencedPath, FolderRefusal>;
  readText(path: FencedPath, limitBytes?: number): Promise<string>;
  /**
   * The whole file (up to `limitBytes`), or, with a {@link RootReadWindow}, `length` bytes from `offset` (today's
   * Codex rollout index head window). A window longer than {@link MAX_ROOT_WINDOW_BYTES} is refused.
   */
  readBytes(path: FencedPath, limitOrWindow?: number | RootReadWindow): Promise<Uint8Array>;
  /**
   * The last `maxBytes` of a file (at most {@link MAX_ROOT_WINDOW_BYTES}) and its size, from one open (today's
   * rollout tail window): fenced exactly as `readBytes`.
   */
  readTail(path: FencedPath, maxBytes: number): Promise<RootTail>;
  /**
   * Opens the file at the name ONCE and keeps the descriptor ({@link RootOpenedBytes}): fenced exactly as `readBytes`,
   * and the leaf is looked at without following a link, so a link at the name (inside the root too) is refused
   * `not_a_file`, and the descriptor must be the very object the name reaches (else `changed`). `undefined` when nothing
   * is at the name. The caller closes the result. Optional only so a test double of a root need not implement it: every
   * root the kernel makes does.
   */
  openBytes?(path: FencedPath): Promise<RootOpenedBytes | undefined>;
  /** Atomic replace by default; `exclusive` creates only (today's worktree registry write, `wx`). */
  writeText(path: FencedPath, text: string, options?: RootWriteOptions): Promise<void>;
  /** The same, for bytes. */
  writeBytes(path: FencedPath, bytes: Uint8Array, options?: RootWriteOptions): Promise<void>;
  /**
   * A DURABLE publish (the state filesystem's contract): missing folders are made (`0700`) and, parent first, every
   * ancestor this call created plus the folder's own parent are synced BEFORE anything is written; the bytes go into a
   * new temp file in the same folder (`O_EXCL | O_NOFOLLOW`, exactly `mode`, fsync'd); that is moved onto the name
   * (`exclusive`: by `link(2)`, losing reports `exists`; otherwise by rename); and the folder is synced last. The temp
   * name is never left behind, and a name this call did not create is never removed. Every step goes through the
   * fenced, descriptor-reached folder: no link is followed.
   */
  publish(path: FencedPath, bytes: Uint8Array, options?: RootPublishOptions): Promise<RootPublished>;
  /**
   * Reads a file through one held descriptor and fsyncs THAT descriptor before answering, so the bytes returned are
   * the bytes made durable; `undefined` only when nothing is at the name. Fenced exactly as `readBytes`; a name that
   * is mid-publish by `link` (two names for a moment) is waited out briefly rather than refused (and
   * a leftover second name of this root's own interrupted publish is removed, but ONLY on an internal, writable root: on a read-only or owner root it stays refused as `hard_link`). With `hold`, the descriptor stays OPEN
   * until `hold` settles and its answer is returned (`hold` is not called when nothing is at the name), so a caller
   * that syncs the folder and then asks `stillNames` compares against an inode that cannot have been freed and
   * reused meanwhile.
   */
  readDurable<T = RootDurableRead>(
    path: FencedPath,
    limitBytes?: number,
    hold?: (read: RootDurableHeld) => Promise<T>,
  ): Promise<T | undefined>;
  /**
   * Syncs one folder's entries, with `parent` the folder's own parent first (when that parent is still inside the root).
   * A platform that cannot sync a directory (`EINVAL`, `ENOTSUP`, `EPERM`) is tolerated; anything else throws.
   */
  syncDirectory(path: FencedPath, options?: { readonly parent?: boolean }): Promise<void>;
  /** The device and inode the NAME reaches now (the leaf never followed), or `undefined` when nothing is there. */
  fileIdentity(path: FencedPath): Promise<RootIdentity | undefined>;
  /**
   * Brings a folder from one of THIS plugin's root handles (`source`, maybe this one) to `to` in this root: a copy
   * (each file read off the disk, never through a link: a link inside is skipped, a file with a second hard link is
   * skipped, modes kept) or, with `link`, one link at `to` to the source folder's real path. Both ends are fenced. A link is
   * refused `link_escape`, nothing written, when `to` or the source is inside a credential home (the `agent-homes` and
   * `credentials` roots: a folder alias would carry a placed sign-in into another ferret's home).
   */
  copyTree(source: RootHandle, from: FencedPath, to: FencedPath, options?: TreeCopyOptions): Promise<void>;
  /**
   * Materializes a {@link SharedTree} another plugin minted (`RootsPort.share`: Skills' skill folder) at `to` in THIS
   * root, which must be an internal, writable root (`agent-homes`): any other is refused. A copy keeps `copyTree`'s
   * rules exactly (each file read off the disk through a checked descriptor, a link inside skipped, a file with a
   * second hard link skipped, modes kept, `maxEntries`, both ends fenced, a NEW folder at `to`). `link` asks for one
   * link at `to` to the tree's real path instead, and one link is made whenever it is asked for (a tree is always the
   * minter's own opaque state tree, so there is nothing else to weigh). The answer says which was made. A link made
   * stays until the harness removes it: revoking the tree stops new materializations only (a declared GAP).
   * A tree that is forged, rebuilt from its JSON, or whose minter stopped is refused.
   */
  copyShared(tree: SharedTree, to: FencedPath, options?: TreeCopyOptions): Promise<SharedTreeCopied>;
  /**
   * Makes ONE symlink at `to` to a {@link SharedCredential}'s file. Only on `agent-homes`, only by the plugin the credential
   * was minted for, only on a handle scoped to one subfolder (a ferret's home; the kernel does not know which ferret, so
   * the credential is bound to the receiver, not to a ferret), only at `<that folder>/<file>` (the
   * credential's own name, one level) and only when nothing is at `to`. The file must still be the very one minted (same
   * device and inode, one name): otherwise `changed`. Never a copy. This is the ONE call that does not ask the private-place
   * fence about the TARGET (the sign-in file is pinned by inode); the link's PLACE is fenced as usual. The credential is
   * SINGLE-USE: the first link that stays spends it, and any later link with it (after an unlink, or into another
   * ferret's home) is refused `not_shared`; an attempt that made no link does not spend it. The kernel records the link
   * it placed (by the link itself, not its name): `rename` on `agent-homes` refuses (`link_escape`, nothing written) to
   * move it, or a folder holding it, out of the home it was linked into; removing it (`unlink`, `remove`) stays allowed.
   * A link made stays until its holder removes it: revoking the credential stops new links only (a declared GAP).
   */
  linkCredential(credential: SharedCredential, to: FencedPath): Promise<void>;
  /**
   * THE HISTORY-POOL DOOR. Makes `<home>/<entry>` a symlink to the REAL path of `<pool>/<entry>`, where `<pool>` is the
   * caller's OWN declared history pool (`permissions.historyPool`: an opaque `state/<plugin>/history-pool/*` tree, outside
   * the ferret-home tree) and the kernel, not the caller, names the target. Only on `agent-homes`
   * (any other root: `not_internal`).
   * It exists so every ferret on a harness reads and continues any other ferret's conversations (v4's behaviour): the one
   * thing it adds is exactly that, and nothing else in a home is shared by it.
   *
   * Refused, with a closed reason (`HistoryPoolError.refusal`) and nothing written in the home (the pool folder and entry may
   * have been made, owner-only, when a race is lost after every check: see the GAP in `docs/secrets.md`): the manifest lacks
   * `permissions.historyPool` (`not_permitted`); `entry` is on the kernel's fixed deny list or is not one plain, non-hidden
   * name (`denied`: `.credentials.json`, `.claude.json`, `settings*.json`, `auth.json`, `config.toml`, `CLAUDE.md`,
   * `AGENTS.md`, `skills`, `plugins`, anything starting with `.`, a `/`, a NUL, `..`) whatever the manifest declares; `entry`
   * is legal but not in the manifest's closed list (`not_listed`); `home` is not exactly one ferret home folder at the top
   * of `agent-homes` (`not_home`); the pool is not the caller's own opaque, non-private state tree (`not_own`); anything
   * is already at `<home>/<entry>` (`exists`: never an overwrite — the caller moves a real folder aside first with
   * `moveToHistoryPool`). The home must already exist and be reached with no link on the way (`link_escape`); this call
   * never makes one. A host that reaches an open folder by no descriptor path (macOS today) refuses
   * `no_descriptor_reach`: the link is made only through the held, checked folder, never by a path a swapped parent could redirect.
   *
   * The pool base is made at boot; the entry in it is made on first use, by the kernel, through checked no-follow descriptors: a
   * `0700` folder (`kind: 'folder'`) or an empty `0600` file (`kind: 'file'`), and an entry already in the pool must be that
   * kind: a link at the pool folder or at the entry is `link_escape` (nothing is followed), the wrong kind `changed`, a file
   * with a second name `hard_link`. The pool is reached by a no-follow descent from the checked plugin state folder, each
   * folder opened from its parent's descriptor and proved to be the folder judged by name, so nothing is made behind a
   * substituted folder. A link made is proved before it stays: it lands on the pool entry's real path AND the entry is
   * judged again (no link on the way, its kind, its hard-link count, the private-place fence) and is the very file or
   * folder held when it was made; otherwise only the link THIS call made is taken back and refused. A link made stays until its holder removes it (`unlink`):

   * revoking `permissions.historyPool` stops new links only (a declared GAP, `docs/secrets.md`).
   */
  linkHistory(home: FencedPath, entry: string): Promise<void>;
  /**
   * Moves ONE regular file of a listed history entry (the file entry itself, or a file below a folder entry) out of ONE
   * ferret home into this plugin's minted pool view. A folder, a link or any other kind is `not_file` before anything is
   * made: the caller walks a folder and moves its files, so every file is judged on its own. `to` is
   * `<same entry>/...` or `.conflicts/<same ferret>/<same entry>/...`; a path component below the entry may be any
   * name but an empty or hidden one, or one with `/`, `\` or NUL (`denied`). Parents are made `0700` only in the pool.
   * The move is `renameat2(RENAME_NOREPLACE)` between the two held parent folders: a taken target is `exists` (a
   * `HistoryPoolError`) with the source left where it was, decided by the kernel in the move itself. After the move the
   * file is judged again at its new name; a different file or a second name moves it back and refuses `changed` /
   * `hard_link`. No copy fallback (`changed` across devices), no hard-linked file (`hard_link`), no placed credential
   * link (`link_escape`), no followed link. Only an `agent-homes` home handle has this door (`not_internal`); another
   * plugin's or a forged pool view is `not_own`. A host without a no-replace move (macOS; a Linux whose `renameat2` did
   * not load, failed its self-test, or a filesystem without the flag) refuses `no_descriptor_reach`: never a plain rename.
   */
  moveToHistoryPool(from: FencedPath, pool: RootHandle, to: FencedPath): Promise<void>;
  /** A folder made (or narrowed) to `0700`, refused when a link or a file is at the name. */
  ensurePrivateDirectory(path: FencedPath): Promise<void>;
  /**
   * The directory-chain policy for a credential-bearing file (v4's launch overlay, as a kernel fact): looks at EVERY
   * folder from the home down to the folder `path` names, each by its own `lstat` (no link followed), and answers the
   * FIRST that is missing, is not a plain directory, is a link, is owned by someone other than the daemon's user, or is
   * writable by its group or by everyone. A pass means every one of them is a real directory the daemon alone can change.
   * The home's own spelling may be a link (the fence and every internal root already anchor on its real path); what it
   * reaches is judged like the rest. Read-only: it makes nothing and NEVER changes a mode (silently narrowing an
   * ancestor would hide that it was open), so the caller refuses the write with `reason` and the owner fixes the folder.
   * Ask it before the file is written AND again immediately before it is used (a mode or an owner can change between);
   * the write itself is still made through the no-follow descriptors of `publish`, so a link swapped in after the check
   * reaches nothing. For a root below the home only (`agent-homes`, `fleet`, `sessions`, `downloads`, `credentials`);
   * any other root answers `outside_home`. A path the root refuses throws, as every call does.
   */
  checkPrivateChain(path: FencedPath): Promise<Result<void, DirectoryChainProblem>>;
  list(path: FencedPath): Promise<readonly string[]>;
  /** The folder's names with each leaf's own kind, size, mode and hard-link count (a link is listed, never entered). */
  entries(path: FencedPath): Promise<readonly RootEntry[]>;
  stat(path: FencedPath): Promise<RootStat | undefined>;
  /** The leaf's own kind (a link is `symlink`); its parents are resolved and fenced as for every call. */
  lstat(path: FencedPath): Promise<RootLstat | undefined>;
  /** `mkdir -p` inside the root; a new folder gets `mode` (default `0o700`). */
  makeDirectory(path: FencedPath, options?: { readonly mode?: number }): Promise<void>;
  /** The real path of an EXISTING name, links resolved, checked again to be inside the root. */
  realPath(path: FencedPath): Promise<FencedPath>;
  /**
   * Holds a folder in this root OPEN and walks beneath it by descriptor (today's session-viewer pinner): the
   * folder is fenced like every call, and the object actually held is checked again to be inside the root. Its
   * `policyCwd` is the only cwd `kernel.spawn` accepts as a pin, and only from the plugin whose root minted it.
   */
  pin(path: FencedPath, options?: PinOptions): Promise<HeldRoot>;
  /**
   * Removes the name, a folder one entry at a time through descriptors. The LEAF IS NEVER FOLLOWED: the folder it sits in is
   * resolved and judged inside the root, then the entry is removed by its own name, so a link at the name goes as a link
   * and what it points at (inside the root or outside it) is untouched. Remove of a folder needs descriptor reach; refused `no_descriptor_reach` without it (macOS until the descriptor bracket lands), and an owner root refuses every remove then. On a host without descriptor reach a file or link of an internal root is unlinked by path after one re-proof of its folder: a parent swapped in between can delete ONE same-named file outside the root, never a tree (declared GAP). [own] BEFORE-GREEN(runtimes) closed by the bracket unit.
   *
   * With `onlyIfEmpty` a folder is removed with `rmdir` semantics: ONE kernel call, empty-check and removal in the same
   * syscall, so a folder that holds any entry (a link included) is refused `not_empty` and nothing is removed, never
   * recursing. A file or link at the name behaves as without the option. A folder without descriptor reach is refused
   * `no_descriptor_reach` exactly as above (the option never widens what a host without reach may remove).
   * Identity-bound removal reports `deleted` only after actual deletion and verified absence; an absent entry reports
   * `already_missing`. Neither absence alone nor a successful no-op proves this caller deleted a checkout.
   */
  remove(
    path: FencedPath,
    options?: {
      readonly onlyIfEmpty?: boolean;
      readonly expectedIdentity?: RootIdentity;
      /** Veto before each unlink/rmdir, after any directory preflight. Throwing preserves remaining entries. */
      readonly beforeDelete?: () => Promise<void>;
    },
  ): Promise<void | 'deleted' | 'already_missing'>;
  /**
   * Work/worktrees only: moves a directory to a `.fy-remove-*` sibling through its held parent, without following
   * links. Checks the expected device/inode before AND after the move. A source swapped inside rename is restored
   * with an exclusive move when possible, otherwise preserved at `to`, and refused `changed`; it is never deleted.
   * The caller durably records the identity and destination before calling, then removes with `expectedIdentity`.
   * `beforeRename` vetoes after asynchronous preflight, immediately before either rename syscall.
   * Optional for test doubles; every production handle supplies it (other roots refuse `read_only`).
   */
  quarantineRename?(
    from: FencedPath,
    to: FencedPath,
    expectedIdentity: RootIdentity,
    beforeRename?: () => Promise<void>,
  ): Promise<void>;
  /**
   * A symlink at `at` (today's "stored once, never copied" link from a runtime home to the host's credential or
   * history) whose text is the REAL path of `target` in one of THIS plugin's own root handles — the rule `copyTree`'s
   * `link` keeps for a folder, for a file too. Only into an internal, writable root that takes links (`fleet`,
   * `agent-homes`); any other root refuses `read_only`, and another plugin's handle (or a look-alike) `not_declared`.
   * Refused `link_escape` too, nothing written, when `at` or `target` is inside a credential home (the `agent-homes` and
   * `credentials` roots): the dedicated `linkCredential` is the one way a sign-in is linked.
   * `at`'s folder must exist and be reached with no link on the way inside the root (`link_escape`); the link is made
   * through that folder's checked, no-follow descriptor, and refused when anything (a link included) is at the name.
   * A child that follows the link is the harness; the kernel's own reads still never follow it out of the root.
   */
  linkTo(at: FencedPath, target: RootLinkTarget): Promise<void>;
  /**
   * `fchmod` of an EXISTING file or folder at `path`, through a descriptor opened without following a link (a link at
   * the name is refused, never followed): today's provisioner keeping or narrowing a mode. Only permission bits: an
   * internal root keeps `mode & 0o700` (no group or other bit, ever), any other writable root `mode & 0o777` (never
   * setuid, setgid or sticky). Refused on a read-only root (`read_only`), for a file with a second hard link
   * (`hard_link`: its mode is also another name's) and for a mode that is not an integer in `0..0o7777`.
   */
  setMode(path: FencedPath, mode: number): Promise<void>;
  /**
   * Moves the entry at `from` to `to`, both in THIS handle's root (the provisioner moving a file aside as evidence
   * and moving it back to undo: a copy cannot, `copyTree` skips a link inside a home). Only into an internal, writable
   * root that takes links (`fleet`, `agent-homes`); any other root refuses `read_only`. Both ends are fenced and
   * every parent is opened without following a link (`link_escape`); the entry moves AS IS (a link stays a link and is
   * never followed, a directory moves whole; a link keeps the text it holds, so a RELATIVE link moved to a parent at
   * another depth points elsewhere afterwards, while kernel-made links are absolute). The move runs between the two
   * parents' descriptors (on macOS, where no path reaches a held folder, `renameat` between the two proven
   * descriptors), so a host with neither refuses `no_descriptor_reach` and moves nothing. `from` must exist and nothing may be at `to`
   * (`outside`, never overwritten; a look then the move, a declared GAP). Each end's parent folder must already exist
   * (`rename` makes none, as `writeText` does): a missing parent, or one that is a file, is `changed`, and a link on
   * the way to either end is `link_escape` (both ends' links are judged before either parent is opened), except a link
   * that reaches nothing, which is `changed` (its parent cannot be opened), on the testing host as on the real one.
   * There is no copy fallback: a
   * refused move (another device, a folder into itself) is `changed`, with no path or content in it.
   */
  rename(from: FencedPath, to: FencedPath): Promise<void>;
  /**
   * Removes the SYMLINK at `name` and nothing else: the link is never followed and what it points at (inside this root
   * or outside it) is never touched, so a link whose target lies outside the root is still removable (`remove` follows
   * the leaf and refuses that). Only inside an internal, writable root that takes links (`fleet`, `agent-homes`); any
   * other root refuses `read_only`. The name is fenced and every parent is opened without following a link
   * (`link_escape`). A name that is a file or folder, or is absent, is refused `outside` and left as it was. A refused
   * removal is `changed`; no refusal carries a path or content.
   */
  unlink(name: FencedPath): Promise<void>;
}

export interface RootsPort {
  /**
   * A synchronous, internal writable view of ONLY this plugin's own opaque, non-private history pool, made `0700` at
   * boot. Requires `permissions.historyPool` (`not_permitted`), own non-private state (`not_own`), and the declared
   * `agent-homes` root (`not_declared`), checked in that order. Uses the regular fenced, no-follow RootHandle reads,
   * windowed reads, opens and writes. It cannot place/source links or itself link/move history into a home.
   */
  historyPool(): RootHandle;
  /** Only roots the manifest declared in `permissions.roots`; anything else throws at build. */
  root(
    name: RootName,
    scope?: {
      readonly ferret?: FerretId;
      readonly subfolder?: string;
      /**
       * Optional ANCHOR, for the roots scoped to an absolute folder the caller names (`imports`, `harness-history`,
       * `harness-home`, `project-files`): the folder itself or one of its ancestors (compared component by component,
       * never by string prefix; plain, absolute, never `/`). The anchor ITSELF may be a link (a project folder reached
       * through a linked workspace still works); every folder BELOW it, down to `subfolder`, must be no link, and a
       * `project-files` scope must also resolve to exactly its spelling below the anchor: `realpath(subfolder)` equal to
       * `realpath(within)` joined with `subfolder`'s path relative to `within` (without `within`, `realpath(subfolder)`
       * equal to `subfolder`), else every call is refused `link_escape`. A `project-files` call then reaches its folder by
       * descriptor: the anchor opened once, each component below it opened from its parent's descriptor without following
       * (`O_DIRECTORY | O_NOFOLLOW`), and the leaf acted on through the last one, so a folder swapped for a link after the
       * check reaches nothing. An `imports` READ (a file, a stat, a listing) reaches its folder the same way, so a folder
       * swapped for a link at any step of ONE call reads nothing outside it; a host with neither a descriptor path
       * nor the C library's calls refuses the read `no_descriptor_reach` (it never reads by path), and a host with the
       * calls but not the working-directory bracket lists by path (a listing there can answer an outside folder's names; file reads are
       * still refused by the spelling and identity proofs). An anchor that is not the folder or its ancestor, or one given to a root that takes no
       * absolute folder, names no folder: every call is refused `outside`. A caller that scopes `project-files` to a
       * project the person named passes THAT folder (or the folder it is reached from, when it is a link such as
       * `~/code -> /mnt/...`) as `within`: without it a project under a link is refused `link_escape`, and `within`
       * equal to `subfolder` checks nothing above the folder itself.
       */
      readonly within?: string;
    },
  ): RootHandle;
  /**
   * A read-only handle on exactly ONE file beside a harness home (`~/.claude.json`, which sits BESIDE `~/.claude`, so
   * no `harness-home` scope reaches it): only for a plugin that may hold `harness-home` (Runtimes) and declared it in
   * `permissions.roots`, and only for a basename listed in `permissions.harnessFiles`. The path must be absolute,
   * normalized and outside the fence. Its folder is never listable: the handle names that one file and nothing else.
   * Throws `not_declared` (or `outside` / `fenced` for the path) at the call.
   */
  harnessFile(absolutePath: string): RootFileHandle;
  /**
   * Mints a {@link SharedTree}: ONE existing folder of this plugin's own, handed read-only to whoever receives it
   * (Skills' skill folder in a launch part, for the harness that materializes it with `RootHandle.copyShared`). Only
   * with `permissions.shareTrees`, and only from what this plugin owns: one name of one of its own declared
   * `opaque` named trees (`installed/*`), never a kernel-made root's folder (`credentials`, `sessions`) and never a folder
   * of an owner's root (a project, an imports folder). Valid until this plugin stops.
   */
  share(source: SharedTreeSource): Promise<SharedTree>;
  /**
   * Mints a {@link SharedCredential}: ONE sign-in file of this plugin's own `credentials` root (`<folder>/<file>`), bound to
   * ONE receiving plugin. Only for the plugin that may hold `credentials` (Logins alone) and has declared it, only for a
   * basename listed in `permissions.shareCredentials`, and only for a regular file with one name and no link on the way.
   * Valid until this plugin stops.
   */
  shareCredential(source: SharedCredentialSource): Promise<SharedCredential>;
}

declare const sharedTreeBrand: unique symbol;

/**
 * One folder of its own state a plugin shares, with the plugin that receives it (§7.7, kernel batch #10). Opaque and
 * unforgeable, like a Vault {@link ChildEnvironment}: no field, kept in a kernel table, so a copy, a spread or a JSON
 * round trip (it serialises as `{ shared: <folder name> }` only, never a path) is nothing the kernel will open.
 */
export interface SharedTree {
  readonly [sharedTreeBrand]: true;
}

/** What {@link RootsPort.share} shares: one name of one of the minter's own opaque named trees. */
export type SharedTreeSource = { readonly state: StateFileDef; readonly name: string };

/**
 * What {@link RootHandle.copyShared} made at the destination: a copy, or (when a link was asked for) one link. A link
 * lets the harness child write into the shared folder, so every ferret sharing it sees the change: "read-only" holds
 * for a copy only, and a link made outlives the tree's revocation (both declared GAPs).
 */
export type SharedTreeCopied = 'copied' | 'linked';

declare const sharedCredentialBrand: unique symbol;

/**
 * One sign-in file of the `credentials` root's owner, handed to ONE named receiver to link into its own agent home. Opaque
 * and unforgeable like a {@link SharedTree}: no field, kept in a kernel table; it serialises as `{ credential: <file name> }`
 * only, never the login's folder or a path.
 */
export interface SharedCredential {
  readonly [sharedCredentialBrand]: true;
}

/** What {@link RootsPort.shareCredential} shares. */
export type SharedCredentialSource = {
  /** One plain segment under the `credentials` root: the login's own folder. */
  readonly folder: string;
  /** A basename listed in the minter's `permissions.shareCredentials`. */
  readonly file: string;
  /** The plugin id that alone may materialize it (`'codex'`). */
  readonly receiver: string;
};
