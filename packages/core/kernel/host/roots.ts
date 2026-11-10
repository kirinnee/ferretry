import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import { basename, dirname, join, posix, relative } from 'node:path';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
import type { StateFileDef } from '../contract/define.ts';
import {
  type ComponentIdentity,
  FsError,
  type FsErrorCode,
  type HeldRoot,
  type PinnedFileKind,
  type PinnedFileProbe,
  type PinnedOpenOptions,
  type PinnedTarget,
} from '../contract/pinned.ts';
import { insideFence, internalRootFolder } from '../contract/home.ts';
import { MAX_ROOT_WINDOW_BYTES } from '../contract/ports.ts';
import type {
  RootEntry,
  RootHandle,
  RootLstat,
  RootName,
  RootsPort,
  RootStat,
  RootDurableHeld,
  RootDurableRead,
  RootFileHandle,
  RootIdentity,
  RootLinkTarget,
  RootPublished,
  RootPublishOptions,
  RootWriteOptions,
  SharedTreeSource,
} from '../contract/ports.ts';
import type { FileIdentity, HostFs, OpenedDirectory, OpenedFile } from './adapters/node-fs.ts';
import type { FolderRemoval, FolderSteps } from './adapters/pinned/descriptor-folder.ts';
import {
  absolute,
  type Fence,
  fenceOf,
  fencedByName,
  fencedReal,
  HARD_LINK_ROOTS,
  hardLinkAllowed,
  hopsThroughFence,
  pinCreatedAt,
  type PinReport,
  type PrivateGuard,
  privateGuardOf,
  privatelyHeld,
  resolveImmutableRoots,
  same,
  within,
} from './fence-guard.ts';
import { identityKey, type TruncationWatcher } from './fence-index.ts';
import { HOME_ROOT_FOLDERS, isInternalRoot, isKernelMadeRoot } from './internal-roots.ts';
import type { PinRegistry, UnjudgedRoot } from './pins.ts';
import { holdsPrivate, ownStateTree, receivingRoot, refuseShared, SharedTrees } from './shared-trees.ts';
import { type OwnFolderSpellings, PROCESS_FOLDER_ROOTS, processFolderAllowed } from './processes.ts';
import { type ProjectUse, projectFilesScope, projectPathRefusal } from '../manifest/project-files.ts';
import {
  anchorWalk,
  harnessFileRefusal,
  permittedMode,
  renameNamesRefusal,
  spellingHolds,
  takesAnchor,
  takesLinks,
  takesRenames,
  takesUnlinks,
  unlinkNameRefusal,
} from './root-rules.ts';

/** Owner's roots refuse everything inside the fence; internal roots reach only their own subtree (§7.7). */
const OWNER_ROOTS: ReadonlySet<RootName> = new Set([
  'harness-history',
  'work',
  'imports',
  'harness-home',
  'project-files',
]);
const READ_ONLY_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'imports', 'harness-home']);
/**
 * Roots only one plugin may have, whatever another manifest declares: the sign-in material (Logins), the session
 * folders (Ferrets), and the fleet folder and the host harness homes the fleet is set up from (Runtimes).
 */
const ROOT_OWNERS: Partial<Record<RootName, string>> = {
  credentials: 'logins',
  sessions: 'ferrets',
  fleet: 'runtimes',
  'harness-home': 'runtimes',
};

/**
 * Whether a plugin may hold a root: an owned root (`credentials`, `sessions`) is its owner's alone. One fact, read by
 * the real roots port and by the testing host, so a plugin's unit test cannot hold what production refuses.
 */
export function mayHoldRoot(plugin: string, name: RootName): boolean {
  const owner = ROOT_OWNERS[name];
  return owner === undefined || owner === plugin;
}

/** Whether a root is an owner's own (`work`, `imports`, `harness-*`, `project-files`). One fact for both hosts. */
export function isOwnerRoot(name: RootName): boolean {
  return OWNER_ROOTS.has(name);
}

/** Whether a root is read-only through every handle (an owner's harness or import folder). One fact for both hosts. */
export function isReadOnlyRoot(name: RootName): boolean {
  return READ_ONLY_ROOTS.has(name);
}

/** The roots whose files and folders never get a group or other bit, whatever a caller asks for. */
function isPrivateRoot(name: RootName): boolean {
  return name === 'sessions';
}

/**
 * A ferret's own folder name under `sessions`: the MINTED ferret-id shape, lower case only (one plain segment, no `.`,
 * `..`, `/`, `\`, NUL). Lower case only because a case-insensitive disk (macOS APFS) would make `ABC-1` and `abc-1`
 * one folder; ids are minted lower case (base-36 time + lower-case hex), so nothing real is refused.
 */
const SESSION_FOLDER = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

/** The one segment a `sessions` handle may be scoped to, or nothing when the given subfolder is not exactly that. */
function sessionFolder(subfolder: string | undefined): string | undefined {
  return subfolder !== undefined && SESSION_FOLDER.test(subfolder) ? subfolder : undefined;
}

/**
 * The folder below an internal root's anchor that a handle scoped to `subfolder` names, or `undefined` when the
 * scope is refused. One fact for production and for the testing host, so a plugin test sees the isolation production
 * enforces. `sessions`: exactly one minted-id segment. `agent-homes` and `fleet`: one relative path (never absolute, never
 * `..`, no NUL), or none for the whole base. Any other root takes no such scope: it answers `''`.
 */
export function scopedSubfolder(name: RootName, subfolder: string | undefined): string | undefined {
  if (name === 'sessions') return sessionFolder(subfolder);
  if (name !== 'agent-homes' && name !== 'fleet') return '';
  if (subfolder === undefined || subfolder === '') return '';
  if (subfolder.startsWith('/') || subfolder.includes('\0') || subfolder.split('/').includes('..')) return undefined;
  return subfolder;
}
export const DEFAULT_COPY_ENTRIES = 10_000;
const windowOk = (offset: number, length: number): boolean =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  Number.isSafeInteger(length) &&
  length >= 0 &&
  length <= MAX_ROOT_WINDOW_BYTES;

export interface RootLayout {
  readonly home: string;
  readonly plugin: string;
  /** `<home>-worktrees`. */
  readonly worktrees: string;
}

/**
 * Why a root refused, host-side: the contract's {@link FolderRefusal}, plus today's guard rules a handle's caller
 * meets only as this error — `hard_link` (a file with another name that could be anywhere), `changed` (what was
 * opened is not what was checked), `not_a_file`, `no_descriptor_reach` (a folder remove, any remove of an owner
 * root, or any `rename`, on a host that cannot reach an entry through its checked folder, S44), and `not_empty` (a
 * `remove` with `onlyIfEmpty` of a folder that holds an entry).
 */
export type RootRefusal =
  | FolderRefusal
  | 'read_only'
  | 'not_declared'
  | 'hard_link'
  | 'changed'
  | 'not_a_file'
  | 'no_descriptor_reach'
  | 'not_empty';

export class RootError extends Error {
  constructor(readonly refusal: RootRefusal) {
    super(`root refused: ${refusal}`);
    this.name = 'RootError';
  }
}

const refuse = (refusal: RootRefusal): never => {
  throw new RootError(refusal);
};

/**
 * The lexical half (synchronous, `RootHandle.resolve`): no `..`, no NUL, NORMALIZED (so `.` segments and doubled
 * slashes never reach a comparison, S41), inside the root, outside the fence.
 */
export function lexicalInRoot(
  home: string,
  base: string,
  ownerRoot: boolean,
  relativePath: string,
): Result<FencedPath, FolderRefusal> {
  if (relativePath.includes('\0') || relativePath.split('/').some(part => part === '..')) return err('outside');
  const root = absolute(base, 'a root');
  const candidate = absolute(relativePath.startsWith('/') ? relativePath : join(root, relativePath), 'the path');
  if (!within(root, candidate)) return err('outside');
  if (ownerRoot && insideFence(absolute(home, 'the home'), candidate)) return err('fenced');
  return ok(candidate as FencedPath);
}

/** The home's private places as every root is told them: the composed list, and how often the kept index is looked at. */
interface PrivatePlaces {
  readonly files: readonly string[];
  readonly recheckMs: number;
  /** Told when a private place reaches its budget, or fits again: the one watcher the host gives every root. */
  readonly watch?: TruncationWatcher;
  /** Told how each look a create makes went, so the host says a failure once and again after a good look. */
  readonly report?: PinReport;
}

const NO_PRIVATE: PrivatePlaces = { files: [], recheckMs: 0 };

/** A root's base once checked: its real path and, for an owner's root, the fence it is judged against. */
interface CheckedBase {
  readonly real: string;
  readonly fence: Fence | undefined;
  /**
   * An internal root's private-places check (an owner's root has the whole {@link Fence}): whether a real path inside
   * the root is one of the home's private places, by identity. Answers true for a place that cannot be looked at.
   */
  readonly guard: PrivateCheck | undefined;
}

interface PrivateCheck {
  readonly held: (real: string) => Promise<boolean>;
  /** Whether an entry already looked at (its identity in hand) is one of them: no path is walked. */
  readonly heldIdentity: (identity: { readonly device: bigint; readonly inode: bigint }) => Promise<boolean>;
}

/** The guard of an internal root at `real`: the places are looked at once per base check, and a doubt refuses. */
function privateCheckOf(fs: HostFs, home: string, real: string, privateFiles: PrivatePlaces): PrivateCheck {
  let guard: Promise<PrivateGuard> | undefined;
  // One place for the doubt: a guard that cannot be built, or a place that cannot be looked at, answers "held".
  const answer = async (ask: (kept: PrivateGuard) => Promise<boolean> | boolean): Promise<boolean> => {
    try {
      guard ??= privateGuardOf(fs, home, real, privateFiles.files, privateFiles.recheckMs, privateFiles.watch);
      return await ask(await guard);
    } catch {
      return true;
    }
  };
  return {
    held: async path => await answer(kept => privatelyHeld(fs, kept, path, real)),
    heldIdentity: async identity =>
      await answer(kept => kept.keys.has(identityKey(identity)) || kept.closed.has(identity.device)),
  };
}

/**
 * The base check (§7.7): an owner's root's real base is outside the fence by name and identity; an internal root's
 * base must be EXACTLY where its anchor says (no link anywhere from the anchor down to it), so a substituted base
 * cannot hand it another subsystem's folder.
 */
async function checkBase(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  anchor: string | undefined,
  privateFiles: PrivatePlaces = NO_PRIVATE,
): Promise<Result<CheckedBase, FolderRefusal>> {
  let real: string;
  try {
    real = await fs.realpath(absolute(base, 'a root'));
  } catch {
    return err('outside');
  }
  if (ownerRoot) {
    // A home that cannot be identified fails closed: nothing in an owner's root is reached until it can.
    const fence = await fenceOf(fs, home, privateFiles.files, privateFiles.recheckMs, privateFiles.watch).catch(
      () => undefined,
    );
    if (fence === undefined || (await fencedReal(fs, fence, real))) return err('fenced');
    return ok({ real, fence, guard: undefined });
  }
  if (anchor !== undefined) {
    const named = absolute(base, 'a root');
    const from = relative(anchor, named);
    if (!within(anchor, named)) return err('link_escape');
    const realAnchor = await fs.realpath(anchor).catch(() => undefined);
    if (realAnchor === undefined || real !== join(realAnchor, from)) return err('link_escape');
  }
  return ok({ real, fence: undefined, guard: privateCheckOf(fs, home, real, privateFiles) });
}

/**
 * The full check (§7.7, §9.3), asked again before EVERY read or write so a link swapped in after `resolve` cannot
 * escape (S41): resolves symlinks along the longest existing prefix, refuses a path that resolves outside the root
 * (`link_escape`), a device or other special file, and, for an owner's root, anything inside the fence (S40) — by
 * name, by identity and on every link hop (S43).
 */
export async function resolveInRoot(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  relativePath: string,
  anchor?: string,
  privateFiles: PrivatePlaces = NO_PRIVATE,
): Promise<Result<FencedPath, FolderRefusal>> {
  const resolved = await resolveChecked(fs, home, base, ownerRoot, relativePath, anchor, privateFiles);
  return resolved.ok ? ok(resolved.value.full) : resolved;
}

async function resolveChecked(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  relativePath: string,
  anchor: string | undefined,
  privateFiles: PrivatePlaces = NO_PRIVATE,
): Promise<Result<{ readonly full: FencedPath; readonly base: CheckedBase }, FolderRefusal>> {
  const lexical = lexicalInRoot(home, base, ownerRoot, relativePath);
  if (!lexical.ok) return lexical;
  const checked = await checkBase(fs, home, base, ownerRoot, anchor, privateFiles);
  if (!checked.ok) return checked;
  const realBase = checked.value.real;
  const fence = checked.value.fence;
  if (fence !== undefined && (await hopsThroughFence(fs, fence, lexical.value))) return err('fenced');
  const parts = relative(absolute(base, 'a root'), lexical.value)
    .split('/')
    .filter(part => part !== '');
  let resolved = realBase;
  let index = 0;
  for (; index < parts.length; index += 1) {
    const next = join(resolved, parts[index] as string);
    const info = await fs.lstat(next);
    if (info === undefined) break;
    if (info.kind === 'other') return err('device_file');
    resolved = info.kind === 'link' ? await fs.realpath(next).catch(() => next) : next;
    if (!within(realBase, resolved)) return err('link_escape');
  }
  const full = absolute(join(resolved, ...parts.slice(index)), 'the path');
  if (!within(realBase, full)) return err('link_escape');
  if (fence !== undefined) {
    // A path not made yet is judged by name and by its nearest existing folder (by identity).
    const existing = await nearestExisting(fs, full);
    if (existing === undefined || fencedByName(fence, full) || (await fencedReal(fs, fence, existing)))
      return err('fenced');
  }
  if (checked.value.guard !== undefined) {
    const existing = await nearestExisting(fs, full);
    if (existing === undefined || (await checked.value.guard.held(existing))) return err('fenced');
  }
  return ok({ full: full as FencedPath, base: checked.value });
}

async function nearestExisting(fs: HostFs, path: string): Promise<string | undefined> {
  for (let current = path; ; current = dirname(current)) {
    if ((await fs.identity(current).catch(() => undefined)) !== undefined) return current;
    if (dirname(current) === current) return undefined;
  }
}

/** What one operation on one root knows: the disk, the root's checked base, and its rules. */
interface Scope {
  readonly fs: HostFs;
  readonly base: CheckedBase;
  readonly ownerRoot: boolean;
  readonly immutable: () => Promise<readonly string[]>;
  /**
   * `project-files` only (K3): every name the walk reaches is spelled exactly as the disk resolves it. The judge already
   * proved that; this makes each later `realpath` of the walk prove it AGAIN, so a link swapped into the folder after the
   * judge (to another place inside it, which the declared set never reached) is refused instead of followed.
   */
  readonly literal?: true;
  /**
   * `project-files` only (S179): the REAL path of the scope's anchor (`within`, else the scoped folder). Every folder a
   * write reaches below it is opened from its parent's descriptor without following a link (`openFolderBelow`), so a
   * folder swapped for a link after the checks reaches nothing. The anchor is the one folder reached by path.
   */
  readonly descent?: string;
  /**
   * `imports` with a `within` anchor only: the REAL path of the anchor. Every folder a READ reaches (the scoped folder
   * and any folder inside it) is opened from the anchor's descriptor down, each from its parent's, with
   * `O_DIRECTORY | O_NOFOLLOW`, and the file is opened from its folder's descriptor (`openFile`), so a folder swapped
   * for a link at any step of one call reads, stats and lists nothing outside it, WHETHER OR NOT the lstat walk found
   * every folder (the base must be exactly its spelling below the anchor). A host that reaches an open folder by neither
   * a descriptor path nor the C library's calls keeps the by-path read: there a swap inside ONE call can let a listing,
   * a stat or an identity answer the outside folder's names and metadata, while a file's bytes stay refused by the
   * spelling and identity proofs; it never refuses a read that works today. Unlike `descent`, nothing is made or
   * written through it.
   */
  readonly heldFrom?: string;
}

/** `real` is what the disk resolved `path` to: a literal scope refuses a name that resolved elsewhere (a link swapped in). */
function literalReal(scope: Scope, path: string, real: string): string {
  if (scope.literal === true && real !== path) refuse('link_escape');
  return real;
}

/**
 * Today's `openedFolderProblem`: the folder opened at `real` is a folder, is the one at `real` now (same real path,
 * same device and inode), is inside the root, and (an owner's root) is outside the fence by identity.
 */
async function openCheckedFolder(scope: Scope, real: string): Promise<OpenedDirectory>;
async function openCheckedFolder(
  scope: Scope,
  real: string,
  tolerateUnsupported: true,
): Promise<OpenedDirectory | undefined>;
async function openCheckedFolder(
  scope: Scope,
  real: string,
  tolerateUnsupported = false,
): Promise<OpenedDirectory | undefined> {
  if (!within(scope.base.real, real)) refuse('link_escape');
  if (scope.heldFrom !== undefined && !tolerateUnsupported) {
    const held = await openHeldFolder(scope, scope.heldFrom, real);
    if (held !== undefined) return held;
  }
  const folder = await scope.fs.openDirectory(real).catch((error: unknown) => {
    // Today's `fsync*Directory` tolerated EINVAL/ENOTSUP/EPERM at the OPEN too: only the sync asks for this.
    if (tolerateUnsupported && ['EINVAL', 'ENOTSUP', 'EPERM'].includes(errnoOf(error) ?? '')) return undefined;
    return refuse('changed');
  });
  if (folder === undefined) return undefined;
  const problem = await folderProblem(scope, real, folder.identity);
  if (problem !== undefined) {
    await folder.close();
    refuse(problem);
  }
  return folder;
}

/**
 * A READ of an `imports` scope with an anchor (`Scope.heldFrom`): the folder at `real` opened from the anchor's
 * descriptor down, through `openFolderBelow` (the walk `project-files` writes through), so a link swapped in at any
 * level is `link_escape`. `undefined` only on a host that reaches an open folder by neither a descriptor path nor the C
 * library's calls: the caller then opens it by path, as that host always did.
 */
async function openHeldFolder(scope: Scope, anchor: string, real: string): Promise<OpenedDirectory | undefined> {
  try {
    return (await openFolderBelow(scope, anchor, real, 0o700, false)).folder;
  } catch (error) {
    if (error instanceof RootError && error.refusal === 'no_descriptor_reach') return undefined;
    throw error;
  }
}

async function folderProblem(scope: Scope, real: string, opened: FileIdentity): Promise<RootRefusal | undefined> {
  if (opened.kind !== 'directory') return 'not_a_file';
  const again = await scope.fs.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await scope.fs.identity(real))) return 'changed';
  if (await heldPlace(scope, real)) return 'fenced';
  return undefined;
}

/**
 * Whether `path` (a real path in the root, an entry itself never followed) is the fence's or a private place's, by name
 * and by identity: an owner's root asks its whole fence, any other root asks the home's private places. A doubt is yes.
 */
async function heldPlace(scope: Scope, path: string): Promise<boolean> {
  if (scope.base.fence !== undefined) return await fencedReal(scope.fs, scope.base.fence, path);
  return scope.base.guard !== undefined && (await scope.base.guard.held(path));
}

/**
 * Whether an entry whose identity is in hand is a private place or the fence's. Used for the members of a folder the walk
 * has already opened and judged (a recursive remove): their folders were checked, so only the entry itself is asked.
 */
async function heldMember(scope: Scope, identity: FileIdentity): Promise<boolean> {
  // A tree that was not indexed whole holds its whole device unproven: an owner's root refuses a member there too.
  if (scope.base.fence !== undefined) return heldByIdentity(scope.base.fence, identity);
  return scope.base.guard !== undefined && (await scope.base.guard.heldIdentity(identity));
}

/**
 * Refuses a name that IS a private place or the fence's (an entry itself, never followed, by identity) before an
 * operation replaces, removes, links over or changes it: a bind mount or alias of a private file kept under an innocent
 * name is not a name any write, rename-over, link, delete or mode change may touch. A name nothing is at is nobody's.
 */
async function refuseHeldName(scope: Scope, path: string): Promise<void> {
  if ((await scope.fs.identity(path).catch(() => ({}))) === undefined) return;
  if (await heldPlace(scope, path)) refuse('fenced');
}

/** Today's `openedProblem` for a file, plus its hard-link rule (S49). */
async function fileProblem(scope: Scope, real: string, opened: FileIdentity): Promise<RootRefusal | undefined> {
  if (opened.kind !== 'file') return opened.kind === 'other' ? 'device_file' : 'not_a_file';
  const again = await scope.fs.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await scope.fs.identity(real))) return 'changed';
  if (!within(scope.base.real, real)) return 'link_escape';
  if (await heldPlace(scope, real)) return 'fenced';
  if (opened.links > 1 && !(await hardLinkAllowed(scope.fs, await scope.immutable(), real))) return 'hard_link';
  return undefined;
}

/**
 * The file at `real` opened once to read. A scope that reads by descriptor (`Scope.heldFrom`) opens the file from its
 * folder's descriptor, the folder itself reached from the anchor (`openHeldFolder`); the folder is let go as soon as the
 * file is open. What an open that failed means is the errno alone (a path is never in the answer): a link or a file where
 * a folder should be is `link_escape`, anything else `changed`. A folder that reaches nothing by descriptor (`ENOSYS`)
 * opens the file by path.
 */
async function openLeaf(scope: Scope, real: string): Promise<OpenedFile> {
  if (scope.heldFrom === undefined) return await scope.fs.openRead(real).catch(() => refuse('changed'));
  const folder = await openCheckedFolder(scope, dirname(real));
  try {
    return await folder.openFile(basename(real));
  } catch (error) {
    switch (errnoOf(error)) {
      case 'ENOSYS':
        return await scope.fs.openRead(real).catch(() => refuse('changed'));
      case 'ELOOP':
      case 'ENOTDIR':
        return refuse('link_escape');
      default:
        return refuse('changed');
    }
  } finally {
    await folder.close();
  }
}

/**
 * Today's `openOutsideStateHomes`: judged by real path and identity BEFORE the open (so a device is never opened),
 * opened once without following a link, proven to be the file that was checked, then read through THAT descriptor —
 * whole, up to a limit, a window or a tail: every read of a root goes through here.
 */
async function withCheckedFile<T>(scope: Scope, full: string, use: (file: OpenedFile) => Promise<T>): Promise<T> {
  const real = literalReal(scope, full, await scope.fs.realpath(full));
  const before = await scope.fs.identity(real);
  if (before === undefined) return refuse('changed');
  const judged = await fileProblem(scope, real, before);
  if (judged !== undefined) refuse(judged);
  const handle = await openLeaf(scope, real);
  try {
    const problem = await fileProblem(scope, real, handle.identity);
    if (problem !== undefined) refuse(problem);
    return await use(handle);
  } finally {
    await handle.close();
  }
}

/** Reaches `leaf` in a checked folder: through its descriptor, or by real path once the folder is proven still there. */
async function entry(scope: Scope, folder: OpenedDirectory, real: string, leaf: string): Promise<string> {
  const through = folder.entryPath(leaf);
  if (through !== undefined) return through;
  const problem = await folderProblem(scope, real, folder.identity);
  if (problem !== undefined) refuse(problem);
  return leaf === '' ? real : join(real, leaf);
}

/**
 * The steps of a write or a publish in a checked folder, one spelling for both hosts: through the folder's descriptor
 * where a path reaches it (`entry`), and through its held descriptor's own calls where none does (macOS, `folder.at`),
 * so a parent swapped for a link after the check cannot carry the temp, the look or the rename out of the folder.
 */
interface FolderWork {
  look(leaf: string): Promise<FileIdentity | undefined>;
  create(leaf: string, data: string | Uint8Array, mode: number): Promise<FileIdentity>;
  /** Moves `leaf` onto `toLeaf` in the same folder, replacing what is there. */
  replace(leaf: string, toLeaf: string): Promise<void>;
  /** A second name `toLeaf` for `leaf`; `EEXIST` when taken. */
  link(leaf: string, toLeaf: string): Promise<void>;
  drop(leaf: string): Promise<void>;
}

function folderWork(scope: Scope, folder: OpenedDirectory, real: string): FolderWork {
  const held = folder.at;
  if (held !== undefined && folder.entryPath('') === undefined) {
    return {
      look: async leaf => await held.identity(leaf),
      create: async (leaf, data, mode) => await held.writeNew(leaf, data, mode),
      replace: async (leaf, toLeaf) => await held.renameInto(leaf, folder, toLeaf),
      link: async (leaf, toLeaf) => await held.link(leaf, folder, toLeaf),
      drop: async leaf => await held.unlink(leaf),
    };
  }
  return {
    look: async leaf => await scope.fs.identity(await entry(scope, folder, real, leaf)),
    create: async (leaf, data, mode) => await scope.fs.writeNew(await entry(scope, folder, real, leaf), data, mode),
    replace: async (leaf, toLeaf) =>
      await scope.fs.rename(await entry(scope, folder, real, leaf), await entry(scope, folder, real, toLeaf)),
    link: async (leaf, toLeaf) =>
      await scope.fs.link(await entry(scope, folder, real, leaf), await entry(scope, folder, real, toLeaf)),
    drop: async leaf => await scope.fs.unlink(await entry(scope, folder, real, leaf)),
  };
}

/**
 * A fresh scoped agent home is made below its declared, already-existing parent. Use the same checked-folder,
 * descriptor-reached mkdir and no-follow open as writeChecked: a sibling link is never a creation shortcut.
 */
async function ensureScopedBase(
  fs: HostFs,
  home: string,
  base: string,
  parentRoot: string,
  anchor: string | undefined,
): Promise<void> {
  if (!within(parentRoot, base)) refuse('outside');
  let existing = base;
  const missing: string[] = [];
  while ((await fs.lstat(existing)) === undefined) {
    if (existing === parentRoot) refuse('outside');
    missing.unshift(basename(existing));
    existing = dirname(existing);
    if (!within(parentRoot, existing)) refuse('outside');
  }
  if (missing.length === 0) return;
  const checked = await checkBase(fs, home, existing, false, anchor);
  if (!checked.ok) return refuse(checked.error);
  // The kernel making a root's own base touches no private place: a doubt about another plugin's folder stops nothing here.
  const scope: Scope = {
    fs,
    base: { ...checked.value, guard: undefined },
    ownerRoot: false,
    immutable: async () => [],
  };
  let parent = checked.value.real;
  let folder = await openCheckedFolder(scope, parent);
  try {
    for (const segment of missing) {
      const at = await entry(scope, folder, parent, segment);
      await fs.mkdir(at, 0o700).catch(() => refuse('changed'));
      // Creating a folder is not atomic with persisting its name: the folder it was made in is synced through the
      // descriptor already proven, parent first, so the new entry is durable before anything is made or written below
      // it (a ferret's `sessions/<ferret>` holds its effect ledger and credential). A filesystem that cannot sync a
      // directory (`EINVAL`, `ENOTSUP`, `EPERM`) is tolerated by the adapter, as the state filesystem tolerates it.
      await folder.sync();
      const made = await fs.openDirectory(at).catch(() => refuse('changed'));
      const previous = folder;
      folder = made;
      await previous.close();
      parent = join(parent, segment);
      const problem = await folderProblem(scope, parent, made.identity);
      if (problem !== undefined) refuse(problem);
      // `0700` exactly, through the descriptor just proven (the umask filtered the mkdir mode): today's provisioner.
      await made.chmod(0o700).catch(() => refuse('changed'));
    }
  } finally {
    await folder.close();
  }
}

/**
 * Today's `createOutsideStateHomes` for a folder: the nearest existing folder at or above `full` is opened and
 * checked, and (with `make`) every missing folder below it is made THROUGH it one at a time, with `mode`, and checked
 * in turn. Answers the checked folder at `full`, still open; the caller closes it. Without `make`, a missing folder is
 * refused.
 */
async function openFolderMaking(
  scope: Scope,
  full: string,
  mode: number,
  make: boolean,
): Promise<{ readonly folder: OpenedDirectory; readonly real: string; readonly created: readonly string[] }> {
  if (scope.descent !== undefined) return await openFolderBelow(scope, scope.descent, full, mode, make);
  let existing = full;
  const created: string[] = [];
  const missing: string[] = [];
  let parent = await scope.fs.realpath(existing).catch(() => undefined);
  while (parent === undefined && within(scope.base.real, dirname(existing)) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
    parent = await scope.fs.realpath(existing).catch(() => undefined);
  }
  if (parent === undefined || (!make && missing.length > 0)) return refuse('outside');
  literalReal(scope, existing, parent);
  if (!within(scope.base.real, join(parent, ...missing))) refuse('link_escape');
  let folder = await openCheckedFolder(scope, parent);
  try {
    for (const segment of missing) {
      const at = await entry(scope, folder, parent, segment);
      // Another publisher may make the same folder at the same moment: that is not a change under us. The open
      // below (`O_DIRECTORY | O_NOFOLLOW`) and the check after it still prove whatever is there is a folder, and a
      // folder this call did not make is not one it reports as created.
      let madeHere = true;
      await scope.fs.mkdir(at, mode).catch((error: unknown) => {
        if (errnoOf(error) !== 'EEXIST') return refuse('changed');
        madeHere = false;
      });
      const made = await scope.fs.openDirectory(at).catch(() => refuse('changed'));
      await folder.close();
      folder = made;
      parent = join(parent, segment);
      if (madeHere) created.push(parent);
      const problem = await folderProblem(scope, parent, made.identity);
      if (problem !== undefined) refuse(problem);
    }
  } catch (error) {
    await folder.close();
    throw error;
  }
  return { folder, real: parent, created };
}

/**
 * `openFolderMaking` for a `project-files` scope (S179): the anchor is opened once by its real path and proven (same
 * device and inode as a fresh look), then EVERY folder below it, down to `full`, is opened from its parent's open
 * descriptor with `O_DIRECTORY | O_NOFOLLOW` (a missing one made through the same descriptor with `make`), and the
 * caller's leaf is then acted on through the last folder held. A folder swapped for a link at any level after the
 * checks therefore answers `ELOOP` (`link_escape`) instead of carrying the write out of the project. A host that
 * reaches an open folder by neither a descriptor path nor the C library's calls refuses `no_descriptor_reach`: this
 * root fails closed there, it never falls back to the by-path walk.
 */
async function openFolderBelow(
  scope: Scope,
  anchor: string,
  full: string,
  mode: number,
  make: boolean,
): Promise<{ readonly folder: OpenedDirectory; readonly real: string; readonly created: readonly string[] }> {
  if (!within(anchor, full) || !within(scope.base.real, full)) return refuse('link_escape');
  const segments = relative(anchor, full)
    .split('/')
    .filter(part => part !== '');
  const named = await scope.fs.identity(anchor).catch(() => undefined);
  let folder = await scope.fs.openDirectory(anchor).catch(() => refuse('changed'));
  const created: string[] = [];
  let parent = anchor;
  try {
    if (named === undefined || !same(folder.identity, named)) refuse('changed');
    // No path and no C calls reach this open folder: the leaf would be acted on by a path a link could redirect.
    if (folder.entryPath('') === undefined && folder.at === undefined) refuse('no_descriptor_reach');
    for (const segment of segments) {
      const child = await folder
        .openChild(segment, make ? { mode } : undefined)
        .catch((error: unknown) => refuseChild(error));
      await folder.close();
      folder = child.folder;
      parent = join(parent, segment);
      if (child.created) created.push(parent);
    }
    const problem = await folderProblem(scope, parent, folder.identity);
    if (problem !== undefined) refuse(problem);
  } catch (error) {
    await folder.close();
    throw error;
  }
  return { folder, real: parent, created };
}

/**
 * The LEAF folder of a `project-files` call (S179), made (when missing) and opened THROUGH the folder `openFolderBelow`
 * holds, never by a path a link could redirect, then proven to still be at its place. Answers the open folder (the
 * caller closes it) and whether this call made it. A name that is a file is `outside` (it is no folder of ours); a link
 * is `link_escape`.
 */
async function openLeafBelow(
  scope: Scope,
  held: { readonly folder: OpenedDirectory; readonly real: string },
  leaf: string,
): Promise<{ readonly folder: OpenedDirectory; readonly created: boolean }> {
  const child = await held.folder
    .openChild(leaf, { mode: 0o700 })
    .catch((error: unknown) => (errnoOf(error) === 'ENOTDIR' ? refuse('outside') : refuseChild(error)));
  const problem = await folderProblem(scope, join(held.real, leaf), child.folder.identity).catch(
    async (error: unknown) => {
      await child.folder.close();
      throw error;
    },
  );
  if (problem !== undefined) {
    await child.folder.close();
    return refuse(problem);
  }
  return child;
}

/** What a folder that could not be opened below another means, by the errno alone (a path is never in the answer). */
function refuseChild(error: unknown): never {
  switch (errnoOf(error)) {
    case 'ELOOP':
    case 'ENOTDIR':
      return refuse('link_escape');
    case 'ENOENT':
      return refuse('outside');
    case 'ENOSYS':
      return refuse('no_descriptor_reach');
    default:
      return refuse('changed');
  }
}

/**
 * Today's `createOutsideStateHomes`, atomically: the leaf's folder is opened and checked (missing folders made through
 * it), the content goes into a NEW temp file made through the checked folder (`O_EXCL | O_NOFOLLOW`), and that is
 * renamed over the leaf in the same folder. `exclusive` creates the leaf itself the same way and never replaces;
 * `replaceExisting` replaces only a regular file already at the name (never through a link), keeping its mode.
 */
async function writeChecked(
  scope: Scope,
  full: string,
  data: string | Uint8Array,
  random: () => string,
  options: RootWriteOptions = {},
): Promise<void> {
  const leaf = basename(full);
  if (leaf === '' || full === scope.base.real) refuse('not_a_file');
  const { folder, real: parent } = await openFolderMaking(
    scope,
    dirname(full),
    0o700,
    options.replaceExisting !== true,
  );
  try {
    await refuseHeldName(scope, join(parent, leaf));
    const work = folderWork(scope, folder, parent);
    if (options.exclusive === true) {
      // An existing name (a link included) fails the create itself: its own error says so.
      const created = await work.create(leaf, data, options.mode ?? 0o600);
      if (created.kind !== 'file' || created.links !== 1) refuse('changed');
      return;
    }
    let mode = options.mode ?? 0o600;
    if (options.replaceExisting === true) {
      const current = await work.look(leaf);
      if (current?.kind !== 'file') return refuse(current?.kind === 'link' ? 'link_escape' : 'outside');
      mode = options.mode ?? current.mode;
    }
    const temp = `.${leaf}.${random()}.tmp`;
    const created = await work.create(temp, data, mode).catch(() => refuse('changed'));
    if (created.kind !== 'file' || created.links !== 1) refuse('changed');
    try {
      await work.replace(temp, leaf);
    } catch (error) {
      await work.drop(temp).catch(() => undefined);
      throw error;
    }
  } finally {
    await folder.close();
  }
}

const errnoOf = (error: unknown): string | undefined => (error as { code?: string }).code;

const identityOfEntry = (found: FileIdentity): RootIdentity => ({ device: found.device, inode: found.inode });

/** Syncs one checked folder's entries, opened fresh through the fence and proven before the sync. */
async function syncChecked(scope: Scope, real: string): Promise<void> {
  const folder = await openCheckedFolder(scope, real, true);
  if (folder === undefined) return;
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/**
 * The directories whose entries must be persisted before a file in `leafFolder` is written, parent first: from the
 * folder's own parent down through every folder this call created, and always at least that parent — creating a
 * folder is not atomic with persisting its name, so a call that created nothing must not inherit a promise from
 * whichever call did (today's session-effect ledger walk). Never above the root.
 */
function ancestorsToPersist(scope: Scope, created: readonly string[], leafFolder: string): readonly string[] {
  const top = dirname(created[0] ?? leafFolder);
  const chain: string[] = [];
  for (let directory = dirname(leafFolder); ; directory = dirname(directory)) {
    chain.push(directory);
    if (directory === top || dirname(directory) === directory) break;
  }
  return chain.reverse().filter(directory => within(scope.base.real, directory));
}

/**
 * The durable publish (today's effect ledger, task store and environment store, one place): ancestors synced parent
 * first, the content in a new temp file (`O_EXCL | O_NOFOLLOW`, exactly `mode`, fsync'd by `writeNew`), moved onto
 * the leaf by `link(2)` (`exclusive`) or by rename, then the folder synced. The temp name is released right after a
 * link (before the folder sync) and on a failed link or rename, never after a successful rename (the name is free
 * again and another publisher may own it).
 */
async function publishChecked(
  scope: Scope,
  full: string,
  data: Uint8Array,
  random: () => string,
  options: RootPublishOptions = {},
): Promise<RootPublished> {
  const leaf = basename(full);
  if (leaf === '' || full === scope.base.real) refuse('not_a_file');
  const { folder, real: parent, created } = await openFolderMaking(scope, dirname(full), 0o700, true);
  try {
    await refuseHeldName(scope, join(parent, leaf));
    for (const directory of ancestorsToPersist(scope, created, parent)) await syncChecked(scope, directory);
    const temp = `.${leaf}.${random()}.tmp`;
    const work = folderWork(scope, folder, parent);
    // OUTSIDE the cleanup below: a name this call did not create is another publisher's, and losing the exclusive
    // create (which `writeNew` reports by throwing before it owns anything) leaves nothing to remove.
    const made = await work.create(temp, data, options.mode ?? 0o600);
    if (made.kind !== 'file' || made.links !== 1) {
      await work.drop(temp).catch(() => undefined);
      refuse('changed');
    }
    if (options.exclusive === true) {
      try {
        await work.link(temp, leaf);
      } catch (error) {
        await work.drop(temp).catch(() => undefined);
        if (errnoOf(error) !== 'EEXIST') throw error;
        return { outcome: 'exists' };
      }
      // The second name goes BEFORE the folder sync, so one directory fsync persists the new name and the removed
      // temp together: a crash or a power cut can never leave the leaf with two names, and a loser reading while
      // the winner syncs sees one name. A failed unlink leaves a leftover that `readDurable` knows how to adopt.
      await work.drop(temp).catch(() => undefined);
      await folder.sync();
      return { outcome: 'published', identity: identityOfEntry(made) };
    }
    try {
      await work.replace(temp, leaf);
    } catch (error) {
      await work.drop(temp).catch(() => undefined);
      throw error;
    }
    await folder.sync();
    return { outcome: 'published', identity: identityOfEntry(made) };
  } finally {
    await folder.close();
  }
}

/**
 * A file with exactly one extra name, which is this root's own leftover `.<leaf>.<random>.tmp` from an interrupted
 * exclusive publish, or the private `.<leaf>.<random>.adopt` name an interrupted adoption moved it to (same folder, same device and inode): removes that name through the checked folder's descriptor
 * and says so. If a stranger's file is renamed onto the candidate name in the look-to-move window it is linked back;
 * when even that name was re-taken it stays under the private `.adopt` name (bytes kept, name lost; no kernel writer
 * does this). "Internal" roots include ones other programs also write (agent homes, worktrees, downloads): only a
 * same-inode second name is removed, so the bytes always stay at the leaf. A stranger's hard link (any other name, any other folder) is never touched, so it stays refused.
 */
async function adoptLeftoverName(scope: Scope, full: string, random: () => string): Promise<boolean> {
  const target = await scope.fs.realpath(full);
  const folderPath = dirname(target);
  const leaf = basename(target);
  const folder = await openCheckedFolder(scope, folderPath);
  try {
    const found = await scope.fs.identity(await entry(scope, folder, folderPath, leaf));
    if (found?.kind !== 'file' || found.links !== 2) return false;
    const names = (await scope.fs.list(folderPath)).filter(
      name =>
        name.length > leaf.length + 6 &&
        name.startsWith(`.${leaf}.`) &&
        (name.endsWith('.tmp') || name.endsWith('.adopt')),
    );
    let removed = false;
    for (const name of names) {
      const path = await entry(scope, folder, folderPath, name);
      const sibling = await scope.fs.identity(path);
      if (sibling?.kind !== 'file' || !same(found, sibling)) continue;
      // Moved to a private name nobody else knows BEFORE the last look: a writer that renames another file onto the
      // candidate name between the look and the removal can then never lose its file to this unlink.
      const aside = await entry(scope, folder, folderPath, `.${leaf}.${random()}.adopt`);
      try {
        await scope.fs.rename(path, aside);
      } catch {
        continue;
      }
      const moved = await scope.fs.identity(aside);
      if (moved?.kind === 'file' && same(found, moved)) {
        const unlinked = await scope.fs.unlink(aside).then(
          () => true,
          () => false,
        );
        if (unlinked) removed = true;
        continue;
      }
      // Not ours after all: put it back under its name (an existing name wins; then it stays under the private one).
      const restored = await scope.fs.link(aside, path).then(
        () => true,
        () => false,
      );
      if (restored) await scope.fs.unlink(aside).catch(() => undefined);
    }
    return removed;
  } finally {
    await folder.close();
  }
}

/** Today's `removeEntryWithin`: one name at a time, each folder opened without following a link and proven. */
async function removeWithin(scope: Scope, through: string, expected: FileIdentity): Promise<void> {
  if (await heldMember(scope, expected)) refuse('fenced');
  if (expected.kind !== 'directory') {
    await scope.fs.unlink(through);
    return;
  }
  const folder = await scope.fs.openDirectory(through).catch(() => refuse('changed'));
  try {
    if (!same(expected, folder.identity)) refuse('changed');
    const self = folder.entryPath('');
    if (self === undefined) return refuse('no_descriptor_reach');
    for (const name of await scope.fs.list(self)) {
      const child = folder.entryPath(name) as string;
      const identity = await scope.fs.identity(child);
      if (identity !== undefined) await removeWithin(scope, child, identity);
    }
  } finally {
    await folder.close();
  }
  await scope.fs.rmdir(through);
}

/**
 * `removeWithin` where no path reaches a held folder (macOS): the same walk, one name at a time, but every step goes
 * through the folder's DESCRIPTOR (`FolderSteps`: `unlinkat`, and the working-directory bracket for a listing, an
 * `lstat` and an `rmdir`) and every folder below is opened from its parent's descriptor without following a link, so a
 * folder swapped for a link in the middle of the tree is refused (`changed`), never walked, and nothing outside the
 * proven folder is touched. A name that is not one plain segment is refused `outside`, as the lexical rule would.
 */
async function removeWithinHeld(
  scope: Scope,
  steps: FolderSteps,
  removal: FolderRemoval,
  name: string,
  expected: FileIdentity,
): Promise<void> {
  if (await heldMember(scope, expected)) refuse('fenced');
  if (expected.kind !== 'directory') {
    await steps.unlink(name).catch(error => heldFailure(error));
    return;
  }
  const child = await removal.openFolder(name).catch(() => refuse('changed'));
  try {
    if (!same(expected, child.identity)) refuse('changed');
    const inside = child.steps.removal as FolderRemoval;
    for (const member of await inside.list().catch(error => heldFailure(error))) {
      const identity = await inside.lstat(member).catch(error => heldFailure(error));
      if (identity !== undefined) await removeWithinHeld(scope, child.steps, inside, member, identity);
    }
  } finally {
    await child.close();
  }
  await removal.rmdir(name).catch(error => heldFailure(error));
}

/** What a step through a held folder that failed means to the caller: a folder that is no longer the proven one is `changed`; anything else is the host's own error. */
function heldFailure(error: unknown): never {
  const code = errnoOf(error);
  if (code === 'EBADF' || code === 'EBUSY') return refuse('changed');
  if (code === 'EINVAL') return refuse('outside');
  throw error;
}

/** `remove` of `leaf` in a checked folder through its descriptor and the bracket (the Linux walk, without a path). */
async function removeHeld(
  scope: Scope,
  steps: FolderSteps,
  removal: FolderRemoval,
  leaf: string,
  onlyIfEmpty: boolean,
): Promise<void> {
  const identity = await removal.lstat(leaf).catch(error => heldFailure(error));
  if (identity === undefined) return;
  if (onlyIfEmpty && identity.kind === 'directory') {
    await removeEmptyFolder(() => removal.rmdir(leaf).catch(error => heldFailure(error)));
    return;
  }
  await removeWithinHeld(scope, steps, removal, leaf, identity);
}

/**
 * `rmdir(2)` through the checked folder: ONE syscall both looks for an entry and removes the folder, so no entry can
 * arrive between a look and the removal (a list-then-remove would have that window). Never recurses.
 */
async function removeEmptyFolder(rmdirIt: () => Promise<void>): Promise<void> {
  try {
    await rmdirIt();
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return refuse('not_empty');
    if (code === 'ENOENT') return;
    // the name is no longer a folder (a link or a file took its place after the look)
    if (code === 'ENOTDIR') return refuse('changed');
    throw error;
  }
}

async function removeChecked(scope: Scope, full: string, onlyIfEmpty: boolean): Promise<void> {
  const leaf = basename(full);
  const parent = dirname(full);
  const folder =
    full === scope.base.real
      ? await openCheckedFolder({ ...scope, base: { ...scope.base, real: parent } }, parent)
      : await openCheckedFolder(scope, parent);
  try {
    const through = folder.entryPath(leaf);
    if (through === undefined) {
      // No path reaches the folder (macOS) but the host loaded the C calls AND the working-directory bracket: the
      // whole remove, a tree included, goes through the proven folder's descriptor (`FolderSteps.removal`), as on
      // Linux, for an owner's root as for an internal one.
      const steps = folder.at;
      if (steps?.removal !== undefined) return await removeHeld(scope, steps, steps.removal, leaf, onlyIfEmpty);
      // Without that reach (S44): an owner root removes nothing, and no root removes a FOLDER, because a by-path
      // `rm -r` after one re-proof of the parent deletes an outside tree when the parent is swapped for a link in
      // between. A file or link leaf of an internal root is unlinked by path (sessions markers, tidy): the leaf is
      // looked at without following it, and `unlink` never removes a tree, so the worst a swapped parent costs is ONE
      // same-named file outside the root. Declared GAP: a host whose C library or bracket could not be loaded.
      if (scope.ownerRoot) return refuse('no_descriptor_reach');
      const problem = await folderProblem(scope, parent, folder.identity);
      if (problem !== undefined) return refuse(problem);
      await refuseHeldName(scope, join(parent, leaf));
      const found = await scope.fs.identity(join(parent, leaf));
      if (found === undefined) return;
      if (found.kind === 'directory') return refuse('no_descriptor_reach');
      await scope.fs.unlink(join(parent, leaf));
      return;
    }
    const identity = await scope.fs.identity(through);
    if (identity === undefined) return;
    if (onlyIfEmpty && identity.kind === 'directory') {
      await removeEmptyFolder(() => scope.fs.rmdir(through));
      return;
    }
    await removeWithin(scope, through, identity);
  } finally {
    await folder.close();
  }
}

/** The names in a checked folder, each with its own (never followed) identity reached through that folder. */
async function entriesChecked(
  scope: Scope,
  full: string,
): Promise<readonly { readonly name: string; readonly identity: FileIdentity | undefined }[]> {
  const resolved = await scope.fs.realpath(full).catch(() => undefined);
  if (resolved === undefined) return [];
  const real = literalReal(scope, full, resolved);
  const folder = await openCheckedFolder(scope, real);
  try {
    const names = await namesIn(scope, folder, real);
    const out = [];
    for (const name of names) out.push({ name, identity: await lookIn(scope, folder, real, name) });
    return out;
  } finally {
    await folder.close();
  }
}

async function listChecked(scope: Scope, full: string): Promise<readonly string[]> {
  const resolved = await scope.fs.realpath(full).catch(() => undefined);
  if (resolved === undefined) return [];
  const real = literalReal(scope, full, resolved);
  const folder = await openCheckedFolder(scope, real);
  try {
    return await namesIn(scope, folder, real);
  } finally {
    await folder.close();
  }
}

/**
 * The names in a checked folder, sorted. A scope that reads by descriptor (`Scope.heldFrom`) on a host with no descriptor
 * path lists through the held folder's own steps (the working-directory bracket); everywhere else, through `entry`.
 */
async function namesIn(scope: Scope, folder: OpenedDirectory, real: string): Promise<readonly string[]> {
  const removal = scope.heldFrom !== undefined && folder.entryPath('') === undefined ? folder.at?.removal : undefined;
  if (removal !== undefined) return await removal.list();
  return await scope.fs.list(await entry(scope, folder, real, ''));
}

/** What is at `leaf` in a checked folder, never followed: through its descriptor, or (a held read with no path) its held steps. */
async function lookIn(
  scope: Scope,
  folder: OpenedDirectory,
  real: string,
  leaf: string,
): Promise<FileIdentity | undefined> {
  if (scope.heldFrom !== undefined && folder.at !== undefined && folder.entryPath('') === undefined)
    return await folder.at.identity(leaf);
  return await scope.fs.identity(await entry(scope, folder, real, leaf));
}

/** The leaf at `full` itself (never followed), reached through its checked folder. */
async function leafIdentity(scope: Scope, full: string): Promise<FileIdentity | undefined> {
  if (full === scope.base.real && scope.heldFrom === undefined) return await scope.fs.identity(full);
  const resolved = await scope.fs.realpath(dirname(full)).catch(() => undefined);
  if (full === scope.base.real) {
    // The scoped folder itself: the descriptor it was reached by says what it is, not a second look by path.
    const held = await openCheckedFolder(scope, full);
    try {
      return held.identity;
    } finally {
      await held.close();
    }
  }
  if (resolved === undefined) return undefined;
  const parent = literalReal(scope, dirname(full), resolved);
  const folder = await openCheckedFolder(scope, parent);
  try {
    const found = await lookIn(scope, folder, parent, basename(full));
    // What a name IS is not told about a private place either: a size, a mode or an inode is still a fact about it.
    if (found !== undefined && (await heldPlace(scope, join(parent, basename(full))))) refuse('fenced');
    return found;
  } finally {
    await folder.close();
  }
}

async function statChecked(scope: Scope, full: string): Promise<RootStat | undefined> {
  const info = await leafIdentity(scope, full);
  if (info === undefined || (info.kind !== 'file' && info.kind !== 'directory')) return undefined;
  return {
    kind: info.kind,
    size: info.size,
    modified: instantFromEpochMs(info.mtimeMs),
    mode: info.mode,
    links: info.links,
  };
}

/** A leaf as the disk reported it, in the port's words. */
const leafOf = (info: FileIdentity): RootLstat => ({
  kind: info.kind === 'link' ? 'symlink' : info.kind,
  size: info.size,
  modified: instantFromEpochMs(info.mtimeMs),
  mode: info.mode,
  links: info.links,
});

const decoder = new TextDecoder();

/** One path checked in one root: where it is, and what the operation on it knows. */
interface Checked {
  readonly full: string;
  readonly scope: Scope;
}

/** What `copyTree` may ask of a SOURCE handle: its own checks, never a path of its own choosing. */
interface SourceAccess {
  readonly plugin: string;
  /** The root the handle is on (`kernel.processes` accepts only some). */
  readonly root?: RootName;
  readonly real: (path: FencedPath) => Promise<Checked>;
  readonly realParent: (path: FencedPath) => Promise<Checked>;
  /** An EXISTING folder of this handle, held open and checked (`kernel.processes`): its real path and its lexical one. */
  readonly folder: (path: FencedPath) => Promise<readonly string[]>;
  /** The real path `linkTo` writes as a link's text: a name of this handle, resolved, fenced and proven ({@link linkTargetOf}). */
  readonly linkTarget: (path: FencedPath, dangling: boolean) => Promise<string>;
}

/** Every handle the kernel made, with the plugin it was made for and its checked resolvers (for `copyTree`). */
const HANDLES = new WeakMap<object, SourceAccess>();

/** One minted shared tree: how to reach its folder again (the minter's own checks), and where it came from. */
interface SharedEntry {
  readonly source: SourceAccess;
  readonly from: FencedPath;
}

/** Every shared tree the kernel minted (`RootsPort.share`), known by identity only. */
const SHARED = new SharedTrees<SharedEntry>();

interface HandleSetup {
  readonly fs: HostFs;
  readonly home: string;
  readonly name: RootName;
  readonly plugin: string;
  readonly base: () => string | undefined;
  /**
   * The folders from the caller's `within` anchor down to the scoped folder (`anchorWalk`), each of which must be no
   * link; `undefined` when the scope names no anchor (every call is then judged exactly as before).
   */
  readonly linkFreeFolders: () => readonly string[] | undefined;
  /** The scope's `within` anchor exactly as the caller spelled it (`project-files` reads it for its descent); `undefined` when none. */
  readonly within?: string;
  readonly anchor: string | undefined;
  readonly scopedParent: string | undefined;
  readonly check: (path: string) => Result<FencedPath, FolderRefusal> | undefined;
  readonly immutable: () => Promise<readonly string[]>;
  readonly random: () => string;
  readonly pins: PinRegistry | undefined;
  /** The composed private places of every plugin (`privacy.private`), home-relative. */
  readonly privateFiles: PrivatePlaces;
  /** Whether the plugin declared `permissions.setMode`. */
  readonly setMode?: boolean;
  /** The manifest's `permissions.projectFiles`: the relative set a `project-files` handle may reach. */
  readonly projectFiles?: readonly string[];
}

/** What a held owner's root needs to judge every walk beneath it: the disk, the home it must not reach, the proven stores. */
interface PinFenceSetup {
  readonly fs: HostFs;
  readonly home: string;
  readonly immutable: () => Promise<readonly string[]>;
  readonly privateFiles: PrivatePlaces;
}

/** A walk refusal about the path's KIND or absence: the verdict looks one folder up. Any other refusal is a doubt. */
const NOT_THERE: ReadonlySet<FsErrorCode> = new Set([
  'invalid_path',
  'not_found',
  'not_a_directory',
  'not_a_file',
  'escapes_root',
]);

/** The fence now: recomputed on every ask, so a home that cannot be identified refuses (`undefined` answers fenced). */
const fenceNow = async (setup: PinFenceSetup): Promise<Fence | undefined> =>
  await fenceOf(
    setup.fs,
    setup.home,
    setup.privateFiles.files,
    setup.privateFiles.recheckMs,
    setup.privateFiles.watch,
  ).catch(() => undefined);

/**
 * Whether an entry whose identity is in hand is one of the fence's places, or sits on a device the fence holds unproven
 * (a private tree that was not indexed whole: an entry there cannot be proven not to be an alias of an unindexed
 * member, and an alias keeps its source's device). THE rule, asked by every door of an owner's root — the unpinned
 * root's members and the held (pinned) root's walk alike — so the two can never disagree about a closed device.
 */
const heldByIdentity = (fence: Fence, identity: { readonly device: bigint; readonly inode: bigint }): boolean =>
  fence.keys.has(identityKey(identity)) || fence.closed.has(identity.device);

/**
 * Whether a walk's components reach the fence: every component by device and inode (the home, its `-before-` folders,
 * its key files and folders), and the entry the walk ended on — its LAST component — also by the closed devices, as the
 * unpinned root judges the entry itself. A folder above it is the walk's way there, not an entry: it is judged when a
 * walk ends on it, so a root on a closed device is refused at the pin and an entry beneath one by its own device.
 */
const heldByFence = (fence: Fence, identities: readonly ComponentIdentity[]): boolean => {
  const entry = identities.at(-1);
  return (
    identities.some(component => fence.keys.has(identityKey({ device: component.dev, inode: component.ino }))) ||
    (entry !== undefined && heldByIdentity(fence, { device: entry.dev, inode: entry.ino }))
  );
};

/**
 * Whether each root-relative FOLDER is in the fence by identity, walked through the held descriptor once and
 * remembered (today's `inHome`): every component the walk opened is compared by device and inode with the home, its
 * `-before-` folders and its pinned key paths. A folder that is not there, or not a folder, is judged by the nearest
 * one above it that is; one the walk would not open for any other reason answers fenced.
 */
function folderVerdict(pinned: UnjudgedRoot, fence: Fence): (folder: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  const judge = async (folder: string): Promise<boolean> => {
    let target: PinnedTarget;
    try {
      target = await pinned.open(folder, { wantDirectory: true });
    } catch (error) {
      if (!(error instanceof FsError) || !NOT_THERE.has(error.code) || folder === '') return true;
      return await ask(parentOf(folder));
    }
    try {
      return heldByFence(fence, target.identities);
    } finally {
      await target.close();
    }
  };
  const ask = (folder: string): Promise<boolean> => {
    let verdict = known.get(folder);
    if (verdict === undefined) {
      verdict = judge(folder);
      known.set(folder, verdict);
    }
    return verdict;
  };
  return ask;
}

/** The folder a root-relative name sits in; `''` is the root. */
const parentOf = (rel: string): string => {
  const parent = posix.dirname(rel);
  return parent === '.' || parent === '/' ? '' : parent;
};

/**
 * {@link HeldRoot.fenced} for an owner's root (S47, today's `fenceRefusal` by name and `identityHome` by identity):
 * by name first, then the folder each name sits in by identity through the held walk, then — `leaf` — the entry at
 * the name itself, never followed (`lstat`), so a key file bind-mounted or hard-linked under an innocent name answers
 * fenced. A leaf that cannot be looked at answers fenced.
 */
function fenceVerdict(
  pinned: UnjudgedRoot,
  setup: PinFenceSetup,
  leaf: boolean,
): (rels: readonly string[], folders?: (folder: string) => Promise<boolean>) => Promise<readonly boolean[]> {
  return async (rels, given) => {
    const fence = await fenceNow(setup);
    if (fence === undefined) return rels.map(() => true);
    const folders = given ?? folderVerdict(pinned, fence);
    const answers: boolean[] = [];
    for (const rel of rels) {
      const named = join(pinned.rootReal, rel);
      if (fencedByName(fence, named) || (await folders(parentOf(rel)))) {
        answers.push(true);
        continue;
      }
      if (!leaf) {
        answers.push(false);
        continue;
      }
      const entry = await setup.fs.identity(named).then(
        found => ({ found }),
        () => undefined,
      );
      answers.push(
        entry === undefined || (entry.found !== undefined && heldByFence(fence, [toComponent(entry.found)])),
      );
    }
    return answers;
  };
}

const toComponent = (identity: FileIdentity): ComponentIdentity => ({
  dev: identity.device,
  ino: identity.inode,
  ctimeNs: 0n,
  mode: identity.mode,
});

/**
 * A held owner's root whose every walk is judged against the fence AGAIN (S40, S47) — for an AGENT's read
 * (`PinOptions.fence` `'agent'`, the default). The root itself was checked at the pin, but a root can be an ancestor
 * of the home (a ferret working in `~`), and the descriptor walk beneath it knows nothing of the home. So each `open`
 * and each `probe` asks, like every other op of an owner's root: the fence is recomputed (a home that cannot be
 * identified refuses), the path is refused by name before the walk starts, and every component the walk opened is
 * refused by device and inode — the home, its `-before-` folders and its pinned key files and folders (a bind mount
 * or alias a name would miss) — the walk never serves a byte from, or lists, the home. A file with several names is
 * refused unless it is proven immutable (S49), as `withCheckedFile` does. The probe calls a name in the fence
 * `unsupported` without walking it, by name and by the identity of the folder it sits in (today's `inHome`). Same
 * `policyCwd`, the object the registry minted.
 */
function fencedPin(pinned: UnjudgedRoot, setup: PinFenceSetup): HeldRoot {
  const { fs, immutable } = setup;
  const named = (rel: string): string => join(pinned.rootReal, rel);
  const byFolder = fenceVerdict(pinned, setup, false);
  return Object.freeze({
    rootReal: pinned.rootReal,
    policyCwd: pinned.policyCwd,
    fenced: fenceVerdict(pinned, setup, true),
    open: async (rel: string, options?: PinnedOpenOptions): Promise<PinnedTarget> => {
      const fence = (await fenceNow(setup)) ?? refuse('fenced');
      if (fencedByName(fence, named(rel))) return refuse('fenced');
      const target = await pinned.open(rel, options);
      try {
        const real = join(pinned.rootReal, target.canonical);
        if (fencedByName(fence, real) || heldByFence(fence, target.identities)) return refuse('fenced');
        if (
          target.metadata.type === 'file' &&
          (target.metadata.links ?? 1) > 1 &&
          !(await hardLinkAllowed(fs, await immutable(), real))
        )
          return refuse('hard_link');
      } catch (error) {
        await target.close();
        throw error;
      }
      return target;
    },
    probe: (): PinnedFileProbe => {
      const inner = pinned.probe();
      // Each folder is walked once for the probe's life, as today's `fencedRoot` remembered it.
      let folders: { readonly fence: Fence; readonly ask: (folder: string) => Promise<boolean> } | undefined;
      return {
        // A verdict on names: one in the fence is `unsupported` (nothing a read would serve) without being walked.
        classify: async (rels, budget) => {
          const fence = (await fenceNow(setup)) ?? refuse('fenced');
          if (folders?.fence.real !== fence.real) folders = { fence, ask: folderVerdict(pinned, fence) };
          const asked = await byFolder(rels, folders.ask);
          const kinds = await inner.classify(
            rels.filter((_, index) => !asked[index]),
            budget,
          );
          const out: PinnedFileKind[] = [];
          let next = 0;
          for (let index = 0; index < rels.length && (asked[index] || next < kinds.length); index += 1)
            out.push(asked[index] ? 'unsupported' : (kinds[next++] as PinnedFileKind));
          return out;
        },
        close: () => inner.close(),
      };
    },
    close: () => pinned.close(),
  });
}

/**
 * A PERSON's read of an owner's root (`PinOptions.fence` `'none'`, today's absent fence): nothing beneath the held root
 * is refused for the home or for a hard link, and {@link HeldRoot.fenced} still answers, for a caller that asks.
 */
function unfencedPin(pinned: UnjudgedRoot, setup: PinFenceSetup): HeldRoot {
  return Object.freeze({ ...pinned, fenced: fenceVerdict(pinned, setup, true) });
}

/**
 * An internal root's pin: it lives inside the home by design and reaches only its own subtree, so the home itself is not
 * fenced — but a component the walk opens that is one of the home's private places (a bind mount of the vault key under
 * any name) is refused, by identity, as every other read of the root is. `fenced` answers true for such a name.
 */
function internalPin(pinned: UnjudgedRoot, base: CheckedBase): HeldRoot {
  const guard = base.guard;
  if (guard === undefined)
    return Object.freeze({ ...pinned, fenced: async (rels: readonly string[]) => rels.map(() => false) });
  const held = async (rel: string): Promise<boolean> => await guard.held(join(pinned.rootReal, rel));
  return Object.freeze({
    ...pinned,
    fenced: async (rels: readonly string[]) => await Promise.all(rels.map(held)),
    open: async (rel: string, options?: PinnedOpenOptions): Promise<PinnedTarget> => {
      if (await held(rel)) return refuse('fenced');
      const target = await pinned.open(rel, options);
      try {
        if (await guard.held(join(pinned.rootReal, target.canonical))) return refuse('fenced');
      } catch (error) {
        await target.close();
        throw error;
      }
      return target;
    },
  });
}

/** An error thrown by the caller's own `hold`: it passes through `readDurable` untouched, never mapped, never retried. */
class HoldFailure {
  constructor(readonly cause: unknown) {}
}

/** How often a read that met a file mid-`link` asks again, and how long it waits between asks. */
const HARD_LINK_RETRIES = 20;
const HARD_LINK_RETRY_MS = 5;

/**
 * What a link `linkTo` writes may point at: `checked` (a name its OWN handle resolved and fenced, every link on the way
 * resolved inside that root) when it EXISTS — the real path, a folder proven as `copyTree`'s source is, or a regular
 * file proven as every read is (one name only, outside the fence by identity; `checked` resolved every link that
 * leads somewhere, so a link still at the name leads nowhere and is `not_a_file`). A missing name only with `dangling`:
 * its folder must exist and be exactly the folder the handle reached, and nothing (a dangling link included) may be at
 * the name. A device or other special file is never a target.
 */
async function linkTargetOf(checked: Checked, dangling: boolean): Promise<string> {
  const { full, scope } = checked;
  const found = await scope.fs.identity(full);
  if (found === undefined) {
    if (!dangling) return refuse('outside');
    const folder = await scope.fs.realpath(dirname(full)).catch(() => undefined);
    if (folder !== dirname(full)) refuse('outside');
    const held = await openCheckedFolder(scope, folder as string);
    await held.close();
    return full;
  }
  if (found.kind === 'directory') {
    const held = await openCheckedFolder(scope, full);
    await held.close();
    return full;
  }
  const problem = await fileProblem(scope, full, found);
  if (problem !== undefined) refuse(problem);
  return full;
}

/**
 * `setMode` through the checked folder: the leaf is looked at without following it (a link is refused), opened by the
 * kind it showed (`O_NOFOLLOW` either way), proven to be the very object looked at, and `fchmod`ed through that
 * descriptor. A file with a second name is refused: its mode is that other name's too.
 */
async function setModeChecked(scope: Scope, full: string, bits: number): Promise<void> {
  const parent = dirname(full);
  const folder = await openCheckedFolder(scope, parent);
  try {
    const at = await entry(scope, folder, parent, basename(full));
    const found = await scope.fs.identity(at);
    if (found === undefined) return refuse('outside');
    if (await heldPlace(scope, full)) return refuse('fenced');
    if (found.kind === 'link') return refuse('link_escape');
    if (found.kind === 'other') return refuse('device_file');
    if (found.kind === 'file' && found.links > 1) return refuse('hard_link');
    const opened =
      found.kind === 'directory'
        ? await scope.fs.openDirectory(at).catch(() => refuse('changed'))
        : await scope.fs.openRead(at).catch(() => refuse('changed'));
    try {
      if (opened.identity.kind !== found.kind || !same(found, opened.identity)) refuse('changed');
      if (opened.identity.kind === 'file' && opened.identity.links > 1) refuse('hard_link');
      await opened.chmod(bits);
    } finally {
      await opened.close();
    }
  } finally {
    await folder.close();
  }
}

/**
 * `rename` through the two checked folders: each parent is opened without following a link and proven, the entry at
 * `from` is looked at WITHOUT following it (it must exist: a link stays a link, a directory moves whole), nothing may
 * be at `to` (a link there included), and the move is `rename(2)` between the two folders' descriptors. Where no path
 * reaches an entry through a held folder (macOS) the look and the move are the held folders' own descriptor calls
 * (`OpenedDirectory.at`: `openat` with `O_NOFOLLOW`, `renameat`, each folder proven by device and inode first), so a
 * parent swapped for a link after the proof still moves inside the folder that was checked. A host with neither a
 * path nor those calls is refused `no_descriptor_reach`: the move would resolve both parents by name again and follow
 * a link swapped in after the proof, so it is never made. No copy
 * is ever the fallback: any failure of the move itself (another device, a folder into itself, a full disk) is
 * `changed`, a fact with no path or content in it.
 *
 * GAP (declared, tested): the standard library has no `renameat2(RENAME_NOREPLACE)`, so "nothing at `to`" is a look
 * followed by the move. A writer who creates `to` in that window has a file or an empty folder replaced; a non-empty
 * folder is never replaced (the move fails). The window is the kernel's own two calls, inside folders only the
 * harness and the kernel write.
 */
async function renameChecked(from: Checked, to: Checked): Promise<void> {
  const fromParent = dirname(from.full);
  const toParent = dirname(to.full);
  const source = await openCheckedFolder(from.scope, fromParent);
  try {
    const target = await openCheckedFolder(to.scope, toParent);
    try {
      const sourceName = basename(from.full);
      const targetName = basename(to.full);
      // A folder with no path to its entries (macOS) is reached through its held descriptor's own calls
      // (`renameat` between the two descriptors, each proven by device and inode, the leaf never followed). A folder
      // with neither would run the move on plain paths, which resolve the parents afresh (as `removeWithin` refuses a
      // folder it cannot hold): refuse before anything is looked at or moved.
      const withoutPath = source.entryPath('') === undefined || target.entryPath('') === undefined;
      const sourceSteps = source.at;
      const targetSteps = target.at;
      if (withoutPath && (sourceSteps === undefined || targetSteps === undefined)) return refuse('no_descriptor_reach');
      // A name that IS a private place is neither moved (as the source) nor replaced (as the target), whatever it is called.
      await refuseHeldName(from.scope, from.full);
      await refuseHeldName(to.scope, to.full);
      if (withoutPath && sourceSteps !== undefined && targetSteps !== undefined) {
        if ((await sourceSteps.identity(sourceName)) === undefined) return refuse('outside');
        if ((await targetSteps.identity(targetName)) !== undefined) return refuse('outside');
        await sourceSteps.renameInto(sourceName, target, targetName).catch(() => refuse('changed'));
        return;
      }
      const fromAt = await entry(from.scope, source, fromParent, sourceName);
      const toAt = await entry(to.scope, target, toParent, targetName);
      if ((await from.scope.fs.identity(fromAt)) === undefined) return refuse('outside');
      if ((await to.scope.fs.identity(toAt)) !== undefined) return refuse('outside');
      await from.scope.fs.rename(fromAt, toAt).catch(() => refuse('changed'));
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * `unlink` through the checked folder: the parent is opened without following a link and proven, the leaf is looked at
 * WITHOUT following it, and only a link is removed (`unlink(2)` on the name: what it points at is never opened). A
 * file, a folder or nothing there is `outside`.
 *
 * GAP (declared, tested): the look and the `unlink(2)` are two calls; a writer who swaps a file in for the link in
 * that window has the file removed (a folder is never removed: `unlink` refuses it, `changed`).
 */
async function unlinkChecked(at: Checked): Promise<void> {
  const parent = dirname(at.full);
  const folder = await openCheckedFolder(at.scope, parent);
  try {
    const leaf = await entry(at.scope, folder, parent, basename(at.full));
    // A name that IS a private place (a bind mount or alias kept under an innocent name, or any entry on a device the
    // private places hold unproven) is not one `unlink` may remove, as `remove` and `rename` refuse it.
    await refuseHeldName(at.scope, join(parent, basename(at.full)));
    const found = await at.scope.fs.identity(leaf);
    if (found?.kind !== 'link') return refuse('outside');
    await at.scope.fs.unlink(leaf).catch(() => refuse('changed'));
  } finally {
    await folder.close();
  }
}

/** What a harness file handle needs: the disk, the home it must stay out of, and the one file it names. */
interface HarnessFileSetup {
  readonly fs: HostFs;
  readonly home: string;
  readonly absolutePath: string;
  readonly privateFiles: PrivatePlaces;
}

/**
 * {@link RootsPort.harnessFile}: an owner's read-only root whose base is the file's folder and whose ONLY name is the
 * file. The folder is checked like every owner's root (by name, by identity and on every link hop, outside the fence);
 * the leaf is never followed — a link at the name, a file with a second name (no store is trusted for one here), a
 * device or anything but a regular file is refused, and after the open the NAME must still reach the very file the
 * descriptor holds. Nothing lists the folder, writes, or reaches another name.
 */
function harnessFileHandle(setup: HarnessFileSetup): RootFileHandle {
  const { fs, home, absolutePath, privateFiles } = setup;
  const folder = dirname(absolutePath);
  const leaf = basename(absolutePath);
  const noImmutable = async (): Promise<readonly string[]> => [];
  /** The leaf by name in its checked folder, never followed. */
  const placed = async (): Promise<Checked> => {
    const resolved = await resolveChecked(fs, home, folder, true, folder, undefined, privateFiles);
    if (!resolved.ok) return refuse(resolved.error);
    const base = resolved.value.base;
    const full = join(base.real, leaf);
    if (base.fence !== undefined && fencedByName(base.fence, full)) refuse('fenced');
    return { full, scope: { fs, base, ownerRoot: true, immutable: noImmutable } };
  };
  const read = async <T>(use: (file: OpenedFile) => Promise<T>): Promise<T> => {
    const { full, scope } = await placed();
    const named = await leafIdentity(scope, full);
    if (named === undefined) {
      const error = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      throw error;
    }
    // A link at the name is refused by name; a device, a folder or a second hard link is refused by `withCheckedFile`
    // before anything is opened (no store is trusted for a second name here).
    if (named.kind === 'link') return refuse('link_escape');
    return await withCheckedFile(scope, full, async file => {
      // The open followed nothing, but it opened what the name's REAL path reached: the name itself must still be that
      // very file (a link swapped in, or a swap and back, answers `changed`).
      const now = await leafIdentity(scope, full);
      if (now?.kind !== 'file' || !same(now, file.identity) || file.identity.links !== 1) refuse('changed');
      return await use(file);
    });
  };
  const identityNow = async (): Promise<RootIdentity | undefined> => {
    const { full, scope } = await placed();
    const found = await leafIdentity(scope, full);
    return found === undefined ? undefined : identityOfEntry(found);
  };
  return Object.freeze({
    name: 'harness-home' as const,
    path: absolutePath,
    stat: async (): Promise<RootStat | undefined> => {
      const { full, scope } = await placed();
      return await statChecked(scope, full);
    },
    lstat: async (): Promise<RootLstat | undefined> => {
      const { full, scope } = await placed();
      const info = await leafIdentity(scope, full);
      return info === undefined ? undefined : leafOf(info);
    },
    readText: async (limit?: number) => decoder.decode(await read(async file => await file.read(limit))),
    readBytes: async (limit?: number | { readonly offset: number; readonly length: number }) => {
      if (typeof limit === 'object') {
        if (!windowOk(limit.offset, limit.length)) refuse('outside');
        return (await read(async file => await file.readWindow(limit.offset, limit.length))).bytes;
      }
      return await read(async file => await file.read(limit));
    },
    fileIdentity: identityNow,
    readDurable: async <T>(limit?: number, hold?: (read: RootDurableHeld) => Promise<T>): Promise<T | undefined> => {
      try {
        return await read(async file => {
          const bytes = await file.read(limit);
          await file.sync();
          const done = { bytes, identity: identityOfEntry(file.identity) };
          if (hold === undefined) return done as T;
          try {
            return await hold({
              ...done,
              stillNames: async () => {
                const named = await identityNow();
                return named?.device === done.identity.device && named.inode === done.identity.inode;
              },
            });
          } catch (failure) {
            throw new HoldFailure(failure);
          }
        });
      } catch (error) {
        if (error instanceof HoldFailure) throw error.cause;
        if (errnoOf(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
  });
}

function rootHandle(setup: HandleSetup): RootHandle {
  const { fs, home, name, plugin, base, anchor, scopedParent, check, immutable, random, pins, privateFiles } = setup;
  /**
   * A scope that names an anchor (`within`): every folder from the anchor's first child down to the scoped folder is
   * looked at WITHOUT following it, and a link at any of them is refused `link_escape`. The anchor itself and its
   * ancestors are not looked at (a symlinked project folder works). A folder that is not there yet is no link, and
   * nothing below it exists either. An anchor equal to the scoped folder walks nothing.
   */
  const anchoredFolders = async (): Promise<void> => {
    for (const folder of setup.linkFreeFolders() ?? []) {
      // A folder the walk cannot look at (no permission, a file where a folder should be) is one it cannot prove to be
      // no link: it fails closed as a link does, with the refusal alone — the system's error names an absolute path.
      const found = await fs.lstat(folder).catch(() => refuse('link_escape'));
      if (found === undefined) return;
      if (found.kind === 'link') refuse('link_escape');
    }
  };
  const ownerRoot = OWNER_ROOTS.has(name);
  /**
   * A file or folder this handle just made or replaced under the home's `state` may be a private place (a ferret's
   * `sessions/<id>/environment.json`): the index is looked at again before the write returns, so the very first write
   * has no window in which the new inode is not yet pinned. An owner's root is fenced out of the home and a path outside
   * `state` touches no place; both cost nothing.
   */
  const pinned = async (full: string): Promise<void> => {
    if (ownerRoot || privateFiles.files.length === 0) return;
    await pinCreatedAt(
      fs,
      home,
      privateFiles.files,
      full,
      plugin,
      privateFiles.recheckMs,
      privateFiles.watch,
      privateFiles.report,
    );
  };
  const readOnly = READ_ONLY_ROOTS.has(name);
  const projectRoot = name === 'project-files';
  /**
   * `project-files` only (K3): the name is inside the plugin's declared relative set for this use, judged lexically
   * BEFORE the disk is asked (the same order as the testing host): the folder is one this handle was scoped to, the
   * path is plain and inside it (and outside the fence by name), and the set reaches it. Any other root: no rule here.
   */
  const gate = (path: FencedPath, use: ProjectUse): void => {
    if (!projectRoot) return;
    const root = base();
    if (root === undefined) throw new RootError('outside');
    const lexical = lexicalInRoot(home, root, ownerRoot, path);
    if (!lexical.ok) throw new RootError(lexical.error);
    const refusal = projectPathRefusal(setup.projectFiles, relative(absolute(root, 'a root'), lexical.value), use);
    if (refusal !== undefined) refuse(refusal);
  };
  /**
   * `project-files` only: a link at ANY level of the name, inside the folder, is refused (`link_escape`) even when it
   * points to another place inside it, because the declared set is judged on the NAME and a link would carry a write
   * to a name the set never reached. The resolved path must be exactly the lexical one below the (real) base.
   */
  const linkFree = (
    root: string,
    path: FencedPath,
    resolved: { readonly full: string; readonly base: CheckedBase },
  ): void => {
    if (!projectRoot) return;
    const lexical = lexicalInRoot(home, root, ownerRoot, path);
    if (!lexical.ok) throw new RootError(lexical.error);
    if (relative(resolved.base.real, resolved.full) !== relative(absolute(root, 'a root'), lexical.value))
      refuse('link_escape');
  };
  /**
   * `project-files` only: what is already at the leaf of a write. A link (dangling included) is refused, and so is a
   * file with a second name — it may be a file from anywhere, and a replace must never touch it (S49).
   */
  const leafWritable = async (scope: Scope, full: string): Promise<void> => {
    if (!projectRoot) return;
    const found = await leafIdentity(scope, full);
    if (found === undefined) return;
    if (found.kind === 'link') refuse('link_escape');
    if (found.kind === 'file' && found.links > 1) refuse('hard_link');
  };
  /**
   * Reads through one held descriptor and fsyncs THAT descriptor. `hold` (if any) runs while the descriptor is still
   * open, so the inode it proved cannot be freed and reused before the caller's last compare (today's
   * `assertStillNames`). `link` publishes by giving the file a second name for an instant: a reader that lands
   * there first removes its OWN leftover temp name (an interrupted publish), then asks again after a brief wait. A
   * file that really has several names stays refused after the last try.
   */
  const readDurable = async <T>(
    path: FencedPath,
    limit: number | undefined,
    hold: (read: RootDurableRead, stillNames: () => Promise<boolean>) => Promise<T>,
  ): Promise<T | undefined> => {
    let adoptionTried = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { full, scope } = await real(path);
        return await withCheckedFile(scope, full, async file => {
          const bytes = await file.read(limit);
          await file.sync();
          const read = { bytes, identity: identityOfEntry(file.identity) };
          try {
            return await hold(read, async () => {
              const named = await rootHandleIdentity(path);
              return (
                named !== undefined && named.device === read.identity.device && named.inode === read.identity.inode
              );
            });
          } catch (failure) {
            throw new HoldFailure(failure);
          }
        });
      } catch (error) {
        if (error instanceof HoldFailure) throw error.cause;
        if (errnoOf(error) === 'ENOENT') return undefined;
        if (error instanceof RootError && error.refusal === 'hard_link') {
          // Only a root this kernel publishes into (internal, writable) can hold its OWN leftover; a read-only, an
          // owner's or an outside root (`worktrees`) never loses a name to a read. At most one adoption per call.
          if (!adoptionTried && !readOnly && isKernelMadeRoot(name)) {
            adoptionTried = true;
            const adopted = await real(path)
              .then(async ({ full, scope }) => await adoptLeftoverName(scope, full, random))
              .catch(() => false);
            if (adopted) continue;
          }
          if (attempt < HARD_LINK_RETRIES) {
            await new Promise<void>(resolve => setTimeout(resolve, HARD_LINK_RETRY_MS));
            continue;
          }
        }
        throw error;
      }
    }
  };
  /**
   * `project-files` only (S179): the scoped folder must resolve to exactly its spelling BELOW the anchor, else
   * `link_escape`: `realpath(base)` equal to `realpath(within)` joined with `base`'s path relative to `within` (without
   * `within`, the anchor is the folder itself and `realpath(base)` must equal `base`). The anchor itself and everything
   * above it may be links (a symlinked project folder named as its own anchor works); a link BELOW it is refused, so
   * the adapter's own compare of the folder against its registry holds at the kernel too. Answers the anchor's real
   * path, which the descriptor walk starts from.
   */
  const spelledBelowAnchor = async (folder: string): Promise<string> => {
    const anchorFolder = setup.within ?? folder;
    const realAnchor = await fs.realpath(anchorFolder).catch(() => refuse('outside'));
    const realFolder = await fs.realpath(folder).catch(() => refuse('outside'));
    if (!spellingHolds(folder, setup.within, realFolder, realAnchor)) refuse('link_escape');
    return realAnchor;
  };
  const real = async (path: FencedPath, create = false): Promise<Checked> => {
    const root = base();
    if (root === undefined) refuse(name === 'work' ? 'unknown_ferret' : 'outside');
    const descent = projectRoot ? await spelledBelowAnchor(root as string) : undefined;
    await anchoredFolders();
    // `imports` with an anchor: its reads go by descriptor from the anchor's real path, and the base must be exactly its
    // spelling below the anchor, WHETHER OR NOT the walk found every folder: a folder missing at the walk and planted
    // as a link right after it would otherwise become the base every later check is relative to.
    const anchorReal =
      name === 'imports' && setup.within !== undefined && setup.linkFreeFolders() !== undefined
        ? await fs.realpath(setup.within).catch(() => refuse('outside'))
        : undefined;
    if (create && scopedParent !== undefined) {
      // A forged path outside this scope must not create even an empty directory.
      const lexical = lexicalInRoot(home, root as string, ownerRoot, path);
      if (!lexical.ok) return refuse(lexical.error);
      await ensureScopedBase(fs, home, root as string, scopedParent, anchor);
    }
    const resolved = await resolveChecked(fs, home, root as string, ownerRoot, path, anchor, privateFiles);
    if (!resolved.ok) return refuse(resolved.error);
    linkFree(root as string, path, resolved.value);
    // The folder the base resolved to must be exactly its spelling BELOW the anchor, else a folder swapped for a link
    // between the walk and this look would make the outside folder the base every later check is relative to.
    if (anchorReal !== undefined && !spellingHolds(root as string, setup.within, resolved.value.base.real, anchorReal))
      refuse('link_escape');
    return {
      full: resolved.value.full,
      scope: {
        fs,
        base: resolved.value.base,
        ownerRoot,
        immutable,
        ...(projectRoot ? { literal: true as const } : {}),
        ...(descent === undefined ? {} : { descent }),
        ...(anchorReal === undefined ? {} : { heldFrom: anchorReal }),
      },
    };
  };
  /**
   * The leaf NOT followed: its parent resolved and checked, the leaf's own name appended and judged by name. What sits
   * at the name (a link included) is then judged by the call itself, reached through the checked folder.
   */
  const realParent = async (path: FencedPath, create = false): Promise<Checked> => {
    // The lexical half FIRST (no NUL, no `..`, normalized, inside the root, outside the fence): the parent and the leaf
    // are then taken from the NORMALIZED name, so a forged spelling (`x/`, `x/.`, a single relative name) names the same
    // leaf as its plain form and a NUL anywhere is `outside`, never a raw TypeError from the disk.
    const root = base();
    if (root === undefined) refuse(name === 'work' ? 'unknown_ferret' : 'outside');
    const lexical = lexicalInRoot(home, root as string, ownerRoot, path);
    if (!lexical.ok) return refuse(lexical.error);
    const named: string = lexical.value;
    // The root itself (any spelling of it) has no leaf and no parent inside the root: it is `outside` for every call
    // that names a leaf (`remove` of the root's own folder is judged as itself before it gets here).
    if (named === absolute(root as string, 'a root')) return refuse('outside');
    const leaf = basename(named);
    const parent = await real(dirname(named) as FencedPath, create);
    const full = join(parent.full, leaf);
    if (!within(parent.scope.base.real, full)) refuse('link_escape');
    if (parent.scope.base.fence !== undefined && fencedByName(parent.scope.base.fence, full)) refuse('fenced');
    return { full, scope: parent.scope };
  };
  const writable = (): void => {
    if (readOnly) refuse('read_only');
  };
  /**
   * A private root (`sessions`: it holds a plaintext session credential) never widens past the owner: a file it
   * writes is `0600` whatever mode the caller asks for, and a replaced file loses a wider mode it already had.
   */
  const privateFolder = isPrivateRoot(name);
  const privateWrite = <T extends { readonly mode?: number; readonly replaceExisting?: boolean }>(
    options: T | undefined,
  ): T | undefined => (privateFolder ? ({ ...options, mode: (options?.mode ?? 0o600) & 0o600 } as T) : options);
  const read = async <T>(path: FencedPath, use: (file: OpenedFile) => Promise<T>): Promise<T> => {
    gate(path, 'file');
    const { full, scope } = await real(path);
    return await withCheckedFile(scope, full, use);
  };
  const write = async (path: FencedPath, data: string | Uint8Array, options?: RootWriteOptions): Promise<void> => {
    writable();
    gate(path, 'file');
    // The leaf of a project file is never followed, whatever the options: its own link check comes right after.
    const leafOnly = options?.exclusive === true || options?.replaceExisting === true || projectRoot;
    const { full, scope } = leafOnly ? await realParent(path, true) : await real(path, true);
    await leafWritable(scope, full);
    await writeChecked(scope, full, data, random, privateWrite(options));
    await pinned(full);
  };
  /**
   * Copies `from` (a folder of `source`) into the NEW folder `to`: each name checked against the source's own fence,
   * each file read off the disk through one checked descriptor, never through a link or a hard link, and each written
   * as a new file through this root's checked folder.
   */
  const copyInto = async (
    source: SourceAccess,
    from: FencedPath,
    to: FencedPath,
    budget: { left: number },
  ): Promise<void> => {
    const sourceFolder = await source.real(from);
    const names = await listChecked(sourceFolder.scope, sourceFolder.full);
    const target = await realParent(to, true);
    const made = await openFolderMaking(target.scope, dirname(target.full), 0o700, true);
    try {
      if (target.scope.descent !== undefined) {
        // A project folder: the new folder is made through the held one, so a parent swapped for a link after the
        // check makes nothing outside (macOS has no descriptor path to make it through).
        const child = await openLeafBelow(target.scope, made, basename(target.full));
        await child.folder.close();
        if (!child.created) refuse('outside');
      } else {
        await fs
          .mkdir(await entry(target.scope, made.folder, made.real, basename(target.full)), 0o700)
          .catch(() => refuse('outside'));
      }
    } finally {
      await made.folder.close();
    }
    for (const leafName of names) {
      budget.left -= 1;
      if (budget.left < 0) refuse('outside');
      const sourceName = `${from}/${leafName}` as FencedPath;
      const targetName = `${to}/${leafName}` as FencedPath;
      // Check each name against its source handle's fence, even when it will be skipped as a link.
      const leaf = await source.realParent(sourceName);
      const info = await leafIdentity(leaf.scope, leaf.full);
      if (info === undefined) continue;
      if (info.kind === 'directory') await copyInto(source, sourceName, targetName, budget);
      else if (info.kind === 'file' && info.links <= 1) {
        const file = await source.real(sourceName);
        const bytes = await withCheckedFile(file.scope, file.full, async opened => await opened.read());
        const written = await realParent(targetName, true);
        await writeChecked(
          written.scope,
          written.full,
          bytes,
          random,
          privateWrite({ exclusive: true, mode: info.mode & 0o777 }),
        );
      }
      // a link is left alone (never entered), a device or a hard-linked file is never read
    }
  };
  /**
   * The device and inode the NAME reaches now. The leaf is `lstat`'d, never followed, while `readDurable` follows a
   * leaf link that stays inside the root: a symlinked leaf therefore never matches the file it read, so an exact
   * replay over a link is refused (stricter than today, which compared a followed `stat`).
   */
  const rootHandleIdentity = async (path: FencedPath): Promise<RootIdentity | undefined> => {
    const { full, scope } = await realParent(path).catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT') return { full: undefined, scope: undefined };
      throw error;
    });
    // A folder that is not there holds no name; one that is must still pass the whole fence below.
    if (full === undefined || (await scope.fs.identity(dirname(full))) === undefined) return undefined;
    const folder = await openCheckedFolder(scope, dirname(full));
    try {
      const found = await lookIn(scope, folder, dirname(full), basename(full));
      // An inode is a fact about a private place too: the name that IS one is not told.
      if (found !== undefined && (await heldPlace(scope, full))) refuse('fenced');
      return found === undefined ? undefined : identityOfEntry(found);
    } finally {
      await folder.close();
    }
  };
  const handle: RootHandle = {
    name,
    internal: isKernelMadeRoot(name),
    resolve: relativePath => {
      const root = base();
      if (root === undefined) return err(name === 'work' ? 'unknown_ferret' : 'outside');
      // A project file is named by a RELATIVE path alone: an absolute one is never taken as already inside the folder.
      if (projectRoot && (typeof relativePath !== 'string' || relativePath.startsWith('/'))) return err('outside');
      const lexical = lexicalInRoot(home, root, ownerRoot, relativePath);
      if (!lexical.ok) return lexical;
      return check(lexical.value) ?? lexical;
    },
    readText: async (path, limit) => decoder.decode(await read(path, async file => await file.read(limit))),
    readBytes: async (path, limit) => {
      if (typeof limit === 'object') {
        if (!windowOk(limit.offset, limit.length)) refuse('outside');
        return (await read(path, async file => await file.readWindow(limit.offset, limit.length))).bytes;
      }
      return await read(path, async file => await file.read(limit));
    },
    readTail: async (path, maxBytes) => {
      if (!windowOk(0, maxBytes)) refuse('outside');
      return await read(path, async file => await file.readWindow(-maxBytes, maxBytes));
    },
    writeText: async (path, text, options) => await write(path, text, options),
    writeBytes: async (path, bytes, options) => await write(path, bytes, options),
    publish: async (path, bytes, options) => {
      writable();
      gate(path, 'file');
      const { full, scope } = await realParent(path, true);
      await leafWritable(scope, full);
      const published = await publishChecked(scope, full, bytes, random, privateWrite(options));
      await pinned(full);
      return published;
    },
    readDurable: async (path, limit, hold) => {
      gate(path, 'file');
      return await readDurable(path, limit, async (read, stillNames) =>
        hold === undefined ? (read as never) : await hold({ ...read, stillNames }),
      );
    },
    syncDirectory: async (path, options) => {
      gate(path, 'make');
      const { full, scope } = await real(path);
      if (options?.parent === true && within(scope.base.real, dirname(full)) && dirname(full) !== full)
        await syncChecked(scope, dirname(full));
      await syncChecked(scope, full);
    },
    fileIdentity: async path => {
      gate(path, 'file');
      return await rootHandleIdentity(path);
    },
    copyTree: async (source, from, to, options) => {
      writable();
      gate(to, 'tree');
      const known = HANDLES.get(source);
      if (known === undefined || known.plugin !== plugin) return refuse('not_declared');
      const sourceFolder = await known.real(from);
      // A link is written only INTO a root that takes links (`linkTo`'s rule: `fleet` and `agent-homes`; never a project
      // folder, `work` or any other, where it would carry a write to a name the declared set never reached) and never
      // FROM an owner's root (a project folder, `work`, ...: the link would outlive what the owner declared). A copy is
      // the only door there; these are the refusals the link door gives, so `copyTree` is not a second way round them.
      if (options?.link === true && !takesLinks(name)) return refuse('read_only');
      // (A source whose root is unknown is refused too: the table only holds handles made for a root, so none is.)
      if (options?.link === true && (known.root === undefined || isOwnerRoot(known.root)))
        return refuse('not_declared');
      const checkedSource = await openCheckedFolder(sourceFolder.scope, sourceFolder.full).catch((error: unknown) => {
        if (error instanceof RootError && error.refusal === 'not_a_file') refuse('outside');
        throw error;
      });
      await checkedSource.close();
      const target = await realParent(to, true);
      if (options?.link === true) {
        const made = await openFolderMaking(target.scope, dirname(target.full), 0o700, false);
        try {
          await fs.symlink(sourceFolder.full, await entry(target.scope, made.folder, made.real, basename(target.full)));
        } finally {
          await made.folder.close();
        }
        return;
      }
      // A copy lands in a NEW folder: nothing already there (a planted link) can redirect what it writes.
      if ((await leafIdentity(target.scope, target.full)) !== undefined) refuse('outside');
      await copyInto(known, from, to, { left: options?.maxEntries ?? DEFAULT_COPY_ENTRIES });
      await pinned(target.full);
    },
    copyShared: async (tree, to, options) => {
      // The destination: an internal root the kernel makes, writable. Checked before the tree is even looked at.
      if (!receivingRoot(name)) return refuseShared('not_internal');
      writable();
      const shared = SHARED.open(tree);
      const sourceFolder = await shared.source.real(shared.from);
      const checkedSource = await openCheckedFolder(sourceFolder.scope, sourceFolder.full).catch((error: unknown) => {
        if (error instanceof RootError && error.refusal === 'not_a_file') refuse('outside');
        throw error;
      });
      await checkedSource.close();
      const target = await realParent(to, true);
      // THE link rule: every shared tree is the minter's own internal state and the destination is `agent-homes`.
      if (options?.link === true) {
        // As the copy does, the missing folders on the way are made (0700) through the checked folder above them.
        const made = await openFolderMaking(target.scope, dirname(target.full), 0o700, true);
        try {
          await fs.symlink(sourceFolder.full, await entry(target.scope, made.folder, made.real, basename(target.full)));
        } finally {
          await made.folder.close();
        }
        return 'linked';
      }
      // A copy lands in a NEW folder: nothing already there (a planted link) can redirect what it writes.
      if ((await leafIdentity(target.scope, target.full)) !== undefined) refuse('outside');
      await copyInto(shared.source, shared.from, to, { left: options?.maxEntries ?? DEFAULT_COPY_ENTRIES });
      await pinned(target.full);
      return 'copied';
    },
    ensurePrivateDirectory: async path => {
      writable();
      gate(path, 'make');
      // A handle scoped to one folder of a private root (a ferret's `sessions` folder) can name ITS OWN folder: it is made
      // `0700` when missing and an existing wider one is narrowed through the descriptor just proven to be it. The parent
      // is outside the handle, so this is the only way the folder itself can be held private by its owner.
      if (privateFolder && scopedParent !== undefined && path === base()) {
        const own = await real(path, true);
        const held = await openCheckedFolder(own.scope, own.full);
        try {
          await held.chmod(0o700).catch(() => refuse('changed'));
        } finally {
          await held.close();
        }
        return;
      }
      const { full, scope } = await realParent(path, true);
      const made = await openFolderMaking(scope, dirname(full), 0o700, true);
      try {
        if (scope.descent !== undefined) {
          // A project folder: made and opened through the held folder, never by a path (see `openLeafBelow`). It keeps
          // its mode when it was already there, and one this call makes is `0700`.
          await (await openLeafBelow(scope, made, basename(full))).folder.close();
          return;
        }
        const at = await entry(scope, made.folder, made.real, basename(full));
        const info = await scope.fs.identity(at);
        if (info !== undefined && info.kind !== 'directory') refuse('outside');
        if (info === undefined) await scope.fs.mkdir(at, 0o700).catch(() => refuse('changed'));
        const folder = await scope.fs.openDirectory(at).catch(() => refuse('changed'));
        try {
          const problem = await folderProblem(scope, join(made.real, basename(full)), folder.identity);
          if (problem !== undefined) refuse(problem);
          // A project folder is the owner's: one this call makes is created `0700`, one that is already there (`.claude`
          // above a grant) keeps its mode. Making is the most this root does to a folder above a grant (§7.7).
          if (!projectRoot) await folder.chmod(0o700);
        } finally {
          await folder.close();
        }
      } finally {
        await made.folder.close();
      }
      // A folder made here may be a `*` member of a private place (`sessions/<id>`): pinned before the call returns.
      await pinned(full);
    },
    lstat: async (path): Promise<RootLstat | undefined> => {
      gate(path, 'probe');
      const { full, scope } = await realParent(path);
      const info = await leafIdentity(scope, full);
      return info === undefined ? undefined : leafOf(info);
    },
    makeDirectory: async (path, options) => {
      writable();
      gate(path, 'make');
      const { full, scope } = await real(path, true);
      const made = await openFolderMaking(scope, full, privateFolder ? 0o700 : (options?.mode ?? 0o700), true);
      await made.folder.close();
      await pinned(full);
    },
    realPath: async path => {
      // `real` resolved every existing component inside the root; the whole must exist (a broken link throws), and a
      // name that moved between the two answers is refused rather than re-resolved.
      gate(path, 'probe');
      const { full } = await real(path);
      const again = await fs.realpath(full);
      if (again !== full) refuse('link_escape');
      return full as FencedPath;
    },
    list: async path => {
      gate(path, 'folder');
      const { full, scope } = await real(path);
      return await listChecked(scope, full);
    },
    entries: async path => {
      gate(path, 'folder');
      const { full, scope } = await real(path);
      const out: RootEntry[] = [];
      // A private place's size, mode and times are facts about it too (`stat` refuses them): its entry is left out.
      for (const found of await entriesChecked(scope, full))
        if (found.identity !== undefined && !(await heldMember(scope, found.identity)))
          out.push({ name: found.name, ...leafOf(found.identity) });
      return out;
    },
    stat: async path => {
      gate(path, 'probe');
      const { full, scope } = await real(path);
      return await statChecked(scope, full);
    },
    remove: async (path, removeOptions) => {
      writable();
      gate(path, 'remove');
      // The leaf is NOT followed: the parent is resolved and judged inside the root, then the entry goes by its own
      // name (a link leaf is removed as a link). The root's own folder has no parent inside the root, so it is judged
      // as itself.
      const { full, scope } = path === base() ? await real(path) : await realParent(path);
      // What sits at the name is judged by its own identity, still without following it: a second name of a fenced
      // file (the key, planted as a hard link) is refused, while a link leaf (never the thing it points at) goes.
      const fence = scope.base.fence;
      if (fence !== undefined) {
        const found = await scope.fs.identity(full);
        if (found !== undefined && found.kind !== 'link' && heldByFence(fence, [toComponent(found)])) refuse('fenced');
      }
      await removeChecked(scope, full, removeOptions?.onlyIfEmpty === true);
    },
    linkTo: async (at: FencedPath, target: RootLinkTarget) => {
      writable();
      if (!takesLinks(name)) return refuse('read_only');
      const known = HANDLES.get(target?.root ?? {});
      if (known === undefined || known.plugin !== plugin) return refuse('not_declared');
      const pointsAt = await known.linkTarget(target.path, target.dangling === true);
      const placed = await realParent(at, true);
      // No link on the way: the folder `at` names, as this root names it, is the very folder reached.
      const root = base() as string;
      const lexical = lexicalInRoot(home, root, ownerRoot, at);
      if (!lexical.ok) return refuse(lexical.error);
      if (relative(placed.scope.base.real, placed.full) !== relative(absolute(root, 'a root'), lexical.value))
        refuse('link_escape');
      const made = await openFolderMaking(placed.scope, dirname(placed.full), 0o700, false);
      try {
        const leafAt = await entry(placed.scope, made.folder, made.real, basename(placed.full));
        await refuseHeldName(placed.scope, join(made.real, basename(placed.full)));
        if ((await fs.identity(leafAt)) !== undefined) refuse('outside');
        await fs.symlink(pointsAt, leafAt).catch(() => refuse('changed'));
      } finally {
        await made.folder.close();
      }
    },
    rename: async (from: FencedPath, to: FencedPath) => {
      writable();
      if (!takesRenames(name)) return refuse('read_only');
      const names = renameNamesRefusal(from, to);
      if (names !== undefined) return refuse(names);
      const source = await realParent(from);
      const target = await realParent(to, true);
      // No link on the way at either end: the folder each name gives, as this root names it, is the very folder
      // reached.
      const root = base() as string;
      for (const [given, placed] of [
        [from, source],
        [to, target],
      ] as const) {
        const lexical = lexicalInRoot(home, root, ownerRoot, given);
        if (!lexical.ok) return refuse(lexical.error);
        if (relative(placed.scope.base.real, placed.full) !== relative(absolute(root, 'a root'), lexical.value))
          refuse('link_escape');
      }
      await renameChecked(source, target);
      await pinned(target.full);
    },
    unlink: async (linkName: FencedPath) => {
      writable();
      if (!takesUnlinks(name)) return refuse('read_only');
      const refused = unlinkNameRefusal(linkName);
      if (refused !== undefined) return refuse(refused);
      const placed = await realParent(linkName);
      // No link on the way: the folder the name gives, as this root names it, is the very folder reached.
      const root = base() as string;
      const lexical = lexicalInRoot(home, root, ownerRoot, linkName);
      if (!lexical.ok) return refuse(lexical.error);
      if (relative(placed.scope.base.real, placed.full) !== relative(absolute(root, 'a root'), lexical.value))
        refuse('link_escape');
      await unlinkChecked(placed);
    },
    setMode: async (path: FencedPath, mode: number) => {
      if (setup.setMode !== true) return refuse('not_declared');
      writable();
      const bits = permittedMode(isKernelMadeRoot(name), mode);
      if (bits === undefined) return refuse('outside');
      gate(path, 'file');
      const { full, scope } = await realParent(path);
      await setModeChecked(scope, full, bits);
    },
    pin: async (path, options) => {
      // A held folder is walked by descriptor beneath it with no per-name check, so it could reach past the declared set.
      if (projectRoot) return refuse('not_declared');
      if (pins === undefined) return refuse('not_declared');
      const { full, scope } = await real(path);
      const pinned = await pins.pin(plugin, full, options);
      // The name was checked; now the OBJECT held: what the descriptor resolves to must still be in the root.
      try {
        if (!within(scope.base.real, pinned.rootReal)) refuse('link_escape');
        if (await heldPlace(scope, pinned.rootReal)) refuse('fenced');
      } catch (error) {
        await pinned.close();
        throw error;
      }
      if (scope.base.fence === undefined) return internalPin(pinned, scope.base);
      // Caller-scoped (S47): an agent's read is fenced beneath the root, a person's is not; saying nothing is fenced.
      return options?.fence === 'none'
        ? unfencedPin(pinned, { fs, home, immutable, privateFiles })
        : fencedPin(pinned, { fs, home, immutable, privateFiles });
    },
  };
  HANDLES.set(handle, {
    plugin,
    root: name,
    // As a copy SOURCE a project handle reaches only what its grants cover (a folder at or below one), never above.
    real: async path => {
      gate(path, 'tree');
      return await real(path);
    },
    realParent: async path => {
      gate(path, 'tree');
      return await realParent(path);
    },
    folder: async path => {
      const { full, scope } = await real(path);
      // Judged against the UNSCOPED root (BG-008): a handle scoped to `homes/<id>` (or to anything below) names the very
      // folders an unscoped one does and gets the very same answer, so the folder rule never reads a scope's own base as
      // the root. A root that cannot be placed, or a folder that is not inside it, is refused (fail closed).
      const unscoped =
        scopedParent === undefined ? scope.base.real : await fs.realpath(scopedParent).catch(() => undefined);
      const below = unscoped !== undefined && full.startsWith(`${unscoped}/`) ? full.slice(unscoped.length + 1) : '';
      if (!processFolderAllowed(name, below))
        throw new Error('kernel.processes accepts only a folder at or under fleet/homes/<id>');
      // Held open and checked as `copyTree`'s source is: a folder, the one at that real path, inside the root.
      const held = await openCheckedFolder(scope, full);
      await held.close();
      const root = base();
      const lexical = root === undefined ? undefined : lexicalInRoot(home, root, ownerRoot, path);
      return lexical?.ok === true && lexical.value !== full ? [full, lexical.value] : [full];
    },
    // A project file is never the target of a link another root writes: the link would outlive the declared set.
    linkTarget: async (path, dangling) =>
      projectRoot ? refuse('not_declared') : await linkTargetOf(await real(path), dangling),
  });
  return handle;
}

/**
 * `kernel.processes`' own-root check ({@link OwnFolderSpellings}): the spellings of an existing folder of a handle the
 * kernel made for `plugin` (its real path first, then the path as the root names it), or `undefined` for any other
 * handle — another plugin's, or an object that only looks like one. A path the root refuses throws its refusal.
 */
export const ownFolderSpellings: OwnFolderSpellings = async (plugin, folder) => {
  const known = HANDLES.get(folder.root);
  if (known === undefined || known.plugin !== plugin) return undefined;
  // Only a root the kernel itself bases (`fleet`, `agent-homes`): an owner root (`harness-home`) is any folder the caller names.
  if (known.root === undefined || !PROCESS_FOLDER_ROOTS.has(known.root)) return undefined;
  return await known.folder(folder.path);
};

/**
 * The one place a plugin's own state folder under the home is named: `<home>/state/<plugin>`. Its internal roots sit
 * in it, and `fyd --check` hands a host selftest this same folder as `stateDir`, so the two can never disagree.
 */
export function pluginStateFolder(home: string, plugin: string): string {
  return `${home.replace(/\/+$/u, '')}/state/${plugin}`;
}

/**
 * The one place the base of an internal root under the home is named: `<home>/state/<plugin>/<name>` for the roots
 * the kernel makes per plugin (`agent-homes`, `downloads`, `credentials`, `sessions`), `<home>/<folder>` for one it makes at
 * a fixed place (`fleet`: `<home>/fleet`, {@link HOME_ROOT_FOLDERS}), nothing for any other root. Both the folder the kernel
 * makes at boot and the base the roots port serves are this fact.
 */
function internalRootBase(home: string, plugin: string, name: RootName): string | undefined {
  const fixed = HOME_ROOT_FOLDERS[name];
  if (fixed !== undefined) return `${home.replace(/\/+$/u, '')}/${fixed}`;
  return isInternalRoot(name) ? `${home.replace(/\/+$/u, '')}/${internalRootFolder(plugin, name)}` : undefined;
}

/** One declared internal root whose base the kernel would not make or accept, and why. */
export interface RootBaseRefusal {
  readonly name: RootName;
  readonly refusal: RootRefusal;
  /** The errno code (`EACCES`) when the disk, not a rule, refused. Never the message: it carries the path. */
  readonly code?: string;
}

/** The errno code of a failure, and only that: a message names the path it failed on. */
function errnoCode(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? code : undefined;
}

/**
 * Makes the base of every internal root a plugin DECLARED under the home (`state/<plugin>/agent-homes`, `downloads`, `sessions`,
 * `credentials`), `0700`, before the plugin is built, so a fresh `FY_HOME` serves its first use. A root outside the
 * home (`worktrees`) and an owner's root are never made here. Each missing folder is made through its checked,
 * no-follow-opened parent ({@link ensureScopedBase}); each folder already there — from the home down to the base —
 * must be a real folder, never a link, exactly where the home says. One that is not is refused and left exactly as it
 * is: nothing is followed, replaced or repaired, and every later use of that root is refused by the base check as
 * before. The folders of a base already there are only held to `0700` through their own descriptor (a mode fix). A
 * disk that cannot answer for one base (an unreadable folder) refuses that base the same way and never escapes: the
 * next base, and the plugin's build, go on.
 */
export async function ensureInternalRootBases(
  fs: HostFs,
  layout: Pick<RootLayout, 'home' | 'plugin'>,
  declared: readonly RootName[],
): Promise<readonly RootBaseRefusal[]> {
  const refusals: RootBaseRefusal[] = [];
  for (const name of new Set(declared)) {
    try {
      if (!mayHoldRoot(layout.plugin, name)) continue;
      const home = absolute(layout.home, 'the home');
      const base = internalRootBase(home, layout.plugin, name);
      if (base === undefined) continue;
      await ensureHomeRootBase(fs, home, absolute(base, 'a root'));
    } catch (error) {
      if (error instanceof RootError) refusals.push({ name, refusal: error.refusal });
      else refusals.push({ name, refusal: 'changed', code: errnoCode(error) });
    }
  }
  return refusals;
}

async function ensureHomeRootBase(fs: HostFs, home: string, base: string): Promise<void> {
  if (!within(home, base) || base === home) refuse('outside');
  const homeEntry = await fs.identity(home);
  if (homeEntry?.kind !== 'directory') return refuse('outside');
  // Every folder already there, from the home down: a folder, never a link.
  let at = home;
  for (const segment of relative(home, base).split('/')) {
    at = join(at, segment);
    const found = await fs.identity(at);
    if (found === undefined) break;
    if (found.kind === 'link') refuse('link_escape');
    if (found.kind !== 'directory') refuse('not_a_file');
  }
  await ensureScopedBase(fs, home, base, home, home);
  // What is at the base now must be exactly where the home says, whoever made it.
  const checked = await checkBase(fs, home, base, false, home);
  if (!checked.ok) return refuse(checked.error);
  // Held to 0700 through the descriptor that was just proven to be that folder.
  // The kernel making a root's own base touches no private place: a doubt about another plugin's folder stops nothing here.
  const scope: Scope = {
    fs,
    base: { ...checked.value, guard: undefined },
    ownerRoot: false,
    immutable: async () => [],
  };
  const folder = await openCheckedFolder(scope, checked.value.real);
  try {
    await folder.chmod(0o700).catch(() => refuse('changed'));
  } finally {
    await folder.close();
  }
}

export interface RootsOptions {
  /** A temp file's random suffix. */
  readonly random?: () => string;
  /** Where a file with several names may be read once proven immutable (S49); today's `/nix/store`. */
  readonly hardLinkRoots?: readonly string[];
  /** The kernel's pin registry, for `RootHandle.pin`; absent, every pin is refused. */
  readonly pins?: PinRegistry;
  /** The manifest's `permissions.harnessFiles`, for `RootsPort.harnessFile`; absent, every one is refused. */
  readonly harnessFiles?: readonly string[];
  /** Whether the manifest declared `permissions.setMode`; absent, `RootHandle.setMode` is refused `not_declared`. */
  readonly setMode?: boolean;
  /** Whether the manifest declares `permissions.shareTrees` (`RootsPort.share`); absent, every share is refused. */
  readonly shareTrees?: boolean;
  /** The manifest's `permissions.projectFiles`, for the `project-files` root; absent, every name of it is refused. */
  readonly projectFiles?: readonly string[];
  /** The plugin's declared state files: a shared named tree must be one of its own opaque ones. */
  readonly stateFiles?: readonly StateFileDef[];
  /**
   * The composed private places of every loaded plugin (`composePrivateFiles`: `state/<id>/<path>`), pinned by identity
   * beside the home's key paths for EVERY root. Absent, only the home's own key paths and internal root folders are.
   */
  readonly privateFiles?: readonly string[];
  /**
   * The most milliseconds that pass between two looks at the folders the private places were indexed from (absent: every
   * check looks). A place created or replaced inside that time is indexed at the next look, so it is also the longest one
   * stays unrecognised under a second name.
   */
  readonly privateRecheckMs?: number;
  /**
   * Told when a private place reaches its budget (its device is then refused to every root that does not own it) and
   * when it fits again. The host gives every plugin's roots the same function, so it is told once per change.
   */
  readonly privateWatch?: TruncationWatcher;
  /** Told how each look a create makes went (see {@link PinReport}); the host gives every plugin's roots the same one. */
  readonly privateReport?: PinReport;
  /** Told the plugin's stop: every tree it minted is revoked then. Absent, its trees live as long as the port. */
  readonly onStop?: (fn: () => void) => void;
}

/** The roots port for one plugin: only roots its manifest declared (§3.7); anything else throws. */
export function rootsPortFor(
  fs: HostFs,
  layout: RootLayout,
  declared: readonly RootName[],
  workFolders: () => WorkFolders | undefined,
  options: RootsOptions = {},
): RootsPort {
  const allowed = new Set(declared);
  const random = options.random ?? (() => crypto.randomUUID());
  let proven: Promise<readonly string[]> | undefined;
  const immutable = (): Promise<readonly string[]> =>
    (proven ??= resolveImmutableRoots(fs, options.hardLinkRoots ?? HARD_LINK_ROOTS).catch(() => []));
  const home = absolute(layout.home, 'the home');
  const privateFiles: PrivatePlaces = {
    files: options.privateFiles ?? [],
    recheckMs: options.privateRecheckMs ?? 0,
    ...(options.privateWatch === undefined ? {} : { watch: options.privateWatch }),
    ...(options.privateReport === undefined ? {} : { report: options.privateReport }),
  };
  // Every tree this plugin mints lives until it stops.
  const life = { live: true };
  options.onStop?.(() => {
    life.live = false;
  });
  return {
    harnessFile: absolutePath => {
      const refusal = harnessFileRefusal({
        plugin: layout.plugin,
        mayHold: mayHoldRoot(layout.plugin, 'harness-home'),
        roots: declared,
        names: options.harnessFiles,
        home,
        absolutePath,
      });
      if (refusal !== undefined) throw new RootError(refusal);
      return harnessFileHandle({ fs, home, absolutePath, privateFiles });
    },
    share: async (source: SharedTreeSource) => {
      if (options.shareTrees !== true) return refuseShared('not_permitted');
      const folder = ownStateTree(options.stateFiles ?? [], source.state, source.name);
      if (folder === undefined || holdsPrivate(layout.plugin, folder, privateFiles.files))
        return refuseShared('not_own');
      const base = absolute(join(pluginStateFolder(home, layout.plugin), folder), 'a shared tree');
      const access = stateTreeAccess(fs, home, layout.plugin, base, immutable, privateFiles);
      await existingFolder(access, base as FencedPath);
      return SHARED.mint(basename(base), { source: access, from: base as FencedPath }, life);
    },
    root: (name, scope) => {
      if (!allowed.has(name)) throw new RootError('not_declared');
      if (!mayHoldRoot(layout.plugin, name)) throw new RootError('not_declared');
      const subfolder = scope?.subfolder;
      const internal = internalRootBase(home, layout.plugin, name);
      const anchor = ((): string | undefined => {
        if (internal !== undefined) return home;
        return name === 'worktrees' ? dirname(absolute(layout.worktrees, 'the worktrees folder')) : undefined;
      })();
      const within = scope?.within;
      /**
       * A `within` anchor is judged BEFORE the folder is named: it must be the scoped folder itself or an ancestor of it,
       * component by component, on a root that takes an absolute folder at all. Anything else names no folder, so every
       * call on the handle is refused `outside`, as for any scope the kernel does not accept.
       */
      const anchored = (folder: string | undefined): string | undefined =>
        within === undefined || (folder !== undefined && takesAnchor(name) && anchorWalk(folder, within) !== undefined)
          ? folder
          : undefined;
      const unanchoredBase = (): string | undefined => {
        switch (name) {
          case 'agent-homes':
          case 'fleet': {
            const below = scopedSubfolder(name, subfolder);
            return below === undefined || internal === undefined
              ? undefined
              : absolute(join(internal, below), 'a root');
          }
          case 'sessions': {
            // One ferret's own folder and nothing else: never the whole base, never a nested path.
            const below = scopedSubfolder(name, subfolder);
            return below === undefined || internal === undefined
              ? undefined
              : absolute(join(internal, below), 'a root');
          }
          case 'downloads':
          case 'credentials':
            return internal;
          case 'worktrees':
            return absolute(layout.worktrees, 'the worktrees folder');
          case 'work':
            return scope?.ferret === undefined ? undefined : workFolders()?.folderOf(scope.ferret);
          case 'project-files':
            // ONE absolute project folder per call, plain (no `.`, `..`, empty segment, NUL) and never the filesystem root.
            return projectFilesScope(subfolder);
          case 'harness-history':
          case 'harness-home':
          case 'imports':
            // The owner-named folder, the harness's documented history folder, or the harness's own home (CLAUDE_CONFIG_DIR,
            // CODEX_HOME or the default under the owner's home): absolute, given by the caller.
            return subfolder?.startsWith('/') === true && !subfolder.includes('\0')
              ? absolute(subfolder, 'a root')
              : undefined;
        }
      };
      const base = (): string | undefined => anchored(unanchoredBase());
      /** The folders from the anchor down to the scoped folder, each to be no link; none without an anchor. */
      const linkFreeFolders = (): readonly string[] | undefined => {
        const folder = base();
        return within === undefined || folder === undefined ? undefined : anchorWalk(folder, within);
      };
      const check = (path: string): Result<FencedPath, FolderRefusal> | undefined => {
        if (name !== 'work' || scope?.ferret === undefined) return undefined;
        return workFolders()?.check(scope.ferret, path) ?? err('unknown_ferret');
      };
      const scopedParent =
        (name === 'agent-homes' || name === 'fleet' || name === 'sessions') &&
        subfolder !== undefined &&
        subfolder !== ''
          ? internal
          : undefined;
      return rootHandle({
        fs,
        home,
        name,
        plugin: layout.plugin,
        base,
        linkFreeFolders,
        ...(within === undefined ? {} : { within }),
        anchor,
        scopedParent,
        check,
        immutable,
        random,
        pins: options.pins,
        privateFiles,
        ...(options.setMode === true ? { setMode: true } : {}),
        ...(options.projectFiles === undefined ? {} : { projectFiles: options.projectFiles }),
      });
    },
  };
}

/** A shared tree's folder must exist, be a folder, and pass its source's own checks NOW (at mint, as at every copy). */
async function existingFolder(source: SourceAccess, path: FencedPath): Promise<void> {
  const folder = await source.real(path);
  const opened = await openCheckedFolder(folder.scope, folder.full).catch((error: unknown) => {
    if (error instanceof RootError && error.refusal === 'not_a_file') refuse('outside');
    throw error;
  });
  await opened.close();
}

/**
 * How a shared named tree of the minter's own state (`<home>/state/<plugin>/installed/<name>`) is reached: exactly as an
 * internal root is — anchored at the home, the base EXACTLY where it is named with no link from the home down to it,
 * and every name below resolved and checked again at each call (a link inside is never followed out).
 */
function stateTreeAccess(
  fs: HostFs,
  home: string,
  plugin: string,
  base: string,
  immutable: () => Promise<readonly string[]>,
  privateFiles: PrivatePlaces,
): SourceAccess {
  const real = async (path: FencedPath): Promise<Checked> => {
    const resolved = await resolveChecked(fs, home, base, false, path, home, privateFiles);
    if (!resolved.ok) return refuse(resolved.error);
    return { full: resolved.value.full, scope: { fs, base: resolved.value.base, ownerRoot: false, immutable } };
  };
  const realParent = async (path: FencedPath): Promise<Checked> => {
    const slash = path.lastIndexOf('/');
    const leaf = path.slice(slash + 1);
    if (slash <= 0 || leaf === '' || leaf === '.' || leaf === '..') return await real(path);
    const parent = await real(path.slice(0, slash) as FencedPath);
    const full = join(parent.full, leaf);
    if (!within(parent.scope.base.real, full)) refuse('link_escape');
    return { full, scope: parent.scope };
  };
  // Never in the handle table, so `kernel.processes`' own-root check never reaches a shared tree's folder, and `linkTo`
  // never points a link at one.
  return {
    plugin,
    real,
    realParent,
    folder: async () => refuse('not_declared'),
    linkTarget: async () => refuse('not_declared'),
  };
}
