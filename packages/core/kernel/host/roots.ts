import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import { basename, dirname, join, posix, relative } from 'node:path';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
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
import { insideFence } from '../contract/home.ts';
import { MAX_ROOT_WINDOW_BYTES } from '../contract/ports.ts';
import type {
  RootEntry,
  RootHandle,
  RootLstat,
  RootName,
  RootsPort,
  RootStat,
  RootDurableRead,
  RootIdentity,
  RootPublished,
  RootPublishOptions,
  RootWriteOptions,
} from '../contract/ports.ts';
import type { FileIdentity, HostFs, OpenedDirectory, OpenedFile } from './adapters/node-fs.ts';
import {
  absolute,
  type Fence,
  fenceOf,
  fencedByName,
  fencedReal,
  HARD_LINK_ROOTS,
  hardLinkAllowed,
  hopsThroughFence,
  resolveImmutableRoots,
  same,
  within,
} from './fence-guard.ts';
import type { PinRegistry, UnjudgedRoot } from './pins.ts';

/** Owner's roots refuse everything inside the fence; internal roots reach only their own subtree (§7.7). */
const OWNER_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'work', 'imports']);
const READ_ONLY_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'imports']);
/** Internal roots only one plugin may have, whatever another manifest declares. */
const ROOT_OWNERS: Partial<Record<RootName, string>> = { credentials: 'logins' };
const DEFAULT_COPY_ENTRIES = 10_000;
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
 * opened is not what was checked), `not_a_file`, and `no_descriptor_reach` (a remove outside daemon folders on a host
 * that cannot reach an entry through its checked folder, S44).
 */
export type RootRefusal =
  | FolderRefusal
  | 'read_only'
  | 'not_declared'
  | 'hard_link'
  | 'changed'
  | 'not_a_file'
  | 'no_descriptor_reach';

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

/** A root's base once checked: its real path and, for an owner's root, the fence it is judged against. */
interface CheckedBase {
  readonly real: string;
  readonly fence: Fence | undefined;
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
): Promise<Result<CheckedBase, FolderRefusal>> {
  let real: string;
  try {
    real = await fs.realpath(absolute(base, 'a root'));
  } catch {
    return err('outside');
  }
  if (ownerRoot) {
    // A home that cannot be identified fails closed: nothing in an owner's root is reached until it can.
    const fence = await fenceOf(fs, home).catch(() => undefined);
    if (fence === undefined || (await fencedReal(fs, fence, real))) return err('fenced');
    return ok({ real, fence });
  }
  if (anchor !== undefined) {
    const named = absolute(base, 'a root');
    const from = relative(anchor, named);
    if (!within(anchor, named)) return err('link_escape');
    const realAnchor = await fs.realpath(anchor).catch(() => undefined);
    if (realAnchor === undefined || real !== join(realAnchor, from)) return err('link_escape');
  }
  return ok({ real, fence: undefined });
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
): Promise<Result<FencedPath, FolderRefusal>> {
  const resolved = await resolveChecked(fs, home, base, ownerRoot, relativePath, anchor);
  return resolved.ok ? ok(resolved.value.full) : resolved;
}

async function resolveChecked(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  relativePath: string,
  anchor: string | undefined,
): Promise<Result<{ readonly full: FencedPath; readonly base: CheckedBase }, FolderRefusal>> {
  const lexical = lexicalInRoot(home, base, ownerRoot, relativePath);
  if (!lexical.ok) return lexical;
  const checked = await checkBase(fs, home, base, ownerRoot, anchor);
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

async function folderProblem(scope: Scope, real: string, opened: FileIdentity): Promise<RootRefusal | undefined> {
  if (opened.kind !== 'directory') return 'not_a_file';
  const again = await scope.fs.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await scope.fs.identity(real))) return 'changed';
  if (scope.base.fence !== undefined && (await fencedReal(scope.fs, scope.base.fence, real))) return 'fenced';
  return undefined;
}

/** Today's `openedProblem` for a file, plus its hard-link rule (S49). */
async function fileProblem(scope: Scope, real: string, opened: FileIdentity): Promise<RootRefusal | undefined> {
  if (opened.kind !== 'file') return opened.kind === 'other' ? 'device_file' : 'not_a_file';
  const again = await scope.fs.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await scope.fs.identity(real))) return 'changed';
  if (!within(scope.base.real, real)) return 'link_escape';
  if (scope.base.fence !== undefined && (await fencedReal(scope.fs, scope.base.fence, real))) return 'fenced';
  if (opened.links > 1 && !(await hardLinkAllowed(scope.fs, await scope.immutable(), real))) return 'hard_link';
  return undefined;
}

/**
 * Today's `openOutsideStateHomes`: judged by real path and identity BEFORE the open (so a device is never opened),
 * opened once without following a link, proven to be the file that was checked, then read through THAT descriptor —
 * whole, up to a limit, a window or a tail: every read of a root goes through here.
 */
async function withCheckedFile<T>(scope: Scope, full: string, use: (file: OpenedFile) => Promise<T>): Promise<T> {
  const real = await scope.fs.realpath(full);
  const before = await scope.fs.identity(real);
  if (before === undefined) return refuse('changed');
  const judged = await fileProblem(scope, real, before);
  if (judged !== undefined) refuse(judged);
  const handle = await scope.fs.openRead(real).catch(() => refuse('changed'));
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
  const scope: Scope = { fs, base: checked.value, ownerRoot: false, immutable: async () => [] };
  let parent = checked.value.real;
  let folder = await openCheckedFolder(scope, parent);
  try {
    for (const segment of missing) {
      const at = await entry(scope, folder, parent, segment);
      await fs.mkdir(at, 0o700).catch(() => refuse('changed'));
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
    if (options.exclusive === true) {
      // An existing name (a link included) fails the create itself: its own error says so.
      const created = await scope.fs.writeNew(await entry(scope, folder, parent, leaf), data, options.mode ?? 0o600);
      if (created.kind !== 'file' || created.links !== 1) refuse('changed');
      return;
    }
    let mode = options.mode ?? 0o600;
    if (options.replaceExisting === true) {
      const current = await scope.fs.identity(await entry(scope, folder, parent, leaf));
      if (current?.kind !== 'file') return refuse(current?.kind === 'link' ? 'link_escape' : 'outside');
      mode = options.mode ?? current.mode;
    }
    const temp = `.${leaf}.${random()}.tmp`;
    const created = await scope.fs
      .writeNew(await entry(scope, folder, parent, temp), data, mode)
      .catch(() => refuse('changed'));
    if (created.kind !== 'file' || created.links !== 1) refuse('changed');
    const madeTemp = await entry(scope, folder, parent, temp);
    try {
      await scope.fs.rename(madeTemp, await entry(scope, folder, parent, leaf));
    } catch (error) {
      await scope.fs.unlink(madeTemp).catch(() => undefined);
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
    for (const directory of ancestorsToPersist(scope, created, parent)) await syncChecked(scope, directory);
    const temp = `.${leaf}.${random()}.tmp`;
    const tempPath = await entry(scope, folder, parent, temp);
    // OUTSIDE the cleanup below: a name this call did not create is another publisher's, and losing the exclusive
    // create (which `writeNew` reports by throwing before it owns anything) leaves nothing to remove.
    const made = await scope.fs.writeNew(tempPath, data, options.mode ?? 0o600);
    if (made.kind !== 'file' || made.links !== 1) {
      await scope.fs.unlink(tempPath).catch(() => undefined);
      refuse('changed');
    }
    const leafPath = await entry(scope, folder, parent, leaf);
    if (options.exclusive === true) {
      try {
        await scope.fs.link(tempPath, leafPath);
      } catch (error) {
        await scope.fs.unlink(tempPath).catch(() => undefined);
        if (errnoOf(error) !== 'EEXIST') throw error;
        return { outcome: 'exists' };
      }
      // The second name goes BEFORE the folder sync, so one directory fsync persists the new name and the removed
      // temp together: a crash or a power cut can never leave the leaf with two names, and a loser reading while
      // the winner syncs sees one name. A failed unlink leaves a leftover that `readDurable` knows how to adopt.
      await scope.fs.unlink(tempPath).catch(() => undefined);
      await folder.sync();
      return { outcome: 'published', identity: identityOfEntry(made) };
    }
    try {
      await scope.fs.rename(tempPath, leafPath);
    } catch (error) {
      await scope.fs.unlink(tempPath).catch(() => undefined);
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

async function removeChecked(scope: Scope, full: string): Promise<void> {
  const leaf = basename(full);
  const parent = dirname(full);
  const folder =
    full === scope.base.real
      ? await openCheckedFolder({ ...scope, base: { ...scope.base, real: parent } }, parent)
      : await openCheckedFolder(scope, parent);
  try {
    const through = folder.entryPath(leaf);
    if (through === undefined) {
      // Without descriptor reach nothing outside the daemon's own folders is removed (S44).
      if (scope.ownerRoot) refuse('no_descriptor_reach');
      const problem = await folderProblem(scope, parent, folder.identity);
      if (problem !== undefined) refuse(problem);
      await scope.fs.remove(join(parent, leaf));
      return;
    }
    const identity = await scope.fs.identity(through);
    if (identity === undefined) return;
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
  const real = await scope.fs.realpath(full).catch(() => undefined);
  if (real === undefined) return [];
  const folder = await openCheckedFolder(scope, real);
  try {
    const names = await scope.fs.list(await entry(scope, folder, real, ''));
    const out = [];
    for (const name of names)
      out.push({ name, identity: await scope.fs.identity(await entry(scope, folder, real, name)) });
    return out;
  } finally {
    await folder.close();
  }
}

async function listChecked(scope: Scope, full: string): Promise<readonly string[]> {
  const real = await scope.fs.realpath(full).catch(() => undefined);
  if (real === undefined) return [];
  const folder = await openCheckedFolder(scope, real);
  try {
    return await scope.fs.list(await entry(scope, folder, real, ''));
  } finally {
    await folder.close();
  }
}

/** The leaf at `full` itself (never followed), reached through its checked folder. */
async function leafIdentity(scope: Scope, full: string): Promise<FileIdentity | undefined> {
  if (full === scope.base.real) return await scope.fs.identity(full);
  const parent = await scope.fs.realpath(dirname(full)).catch(() => undefined);
  if (parent === undefined) return undefined;
  const folder = await openCheckedFolder(scope, parent);
  try {
    return await scope.fs.identity(await entry(scope, folder, parent, basename(full)));
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
  readonly real: (path: FencedPath) => Promise<Checked>;
  readonly realParent: (path: FencedPath) => Promise<Checked>;
}

/** Every handle the kernel made, with the plugin it was made for and its checked resolvers (for `copyTree`). */
const HANDLES = new WeakMap<object, SourceAccess>();

interface HandleSetup {
  readonly fs: HostFs;
  readonly home: string;
  readonly name: RootName;
  readonly plugin: string;
  readonly base: () => string | undefined;
  readonly anchor: string | undefined;
  readonly scopedParent: string | undefined;
  readonly check: (path: string) => Result<FencedPath, FolderRefusal> | undefined;
  readonly immutable: () => Promise<readonly string[]>;
  readonly random: () => string;
  readonly pins: PinRegistry | undefined;
}

/** What a held owner's root needs to judge every walk beneath it: the disk, the home it must not reach, the proven stores. */
interface PinFenceSetup {
  readonly fs: HostFs;
  readonly home: string;
  readonly immutable: () => Promise<readonly string[]>;
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
  await fenceOf(setup.fs, setup.home).catch(() => undefined);

const heldByFence = (fence: Fence, identities: readonly ComponentIdentity[]): boolean =>
  identities.some(entry => fence.identities.some(held => held.device === entry.dev && held.inode === entry.ino));

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

/** An internal root's pin: it lives inside the home by design and reaches only its own subtree, so nothing is fenced. */
function internalPin(pinned: UnjudgedRoot): HeldRoot {
  return Object.freeze({ ...pinned, fenced: async (rels: readonly string[]) => rels.map(() => false) });
}

/** An error thrown by the caller's own `hold`: it passes through `readDurable` untouched, never mapped, never retried. */
class HoldFailure {
  constructor(readonly cause: unknown) {}
}

/** How often a read that met a file mid-`link` asks again, and how long it waits between asks. */
const HARD_LINK_RETRIES = 20;
const HARD_LINK_RETRY_MS = 5;

function rootHandle(setup: HandleSetup): RootHandle {
  const { fs, home, name, plugin, base, anchor, scopedParent, check, immutable, random, pins } = setup;
  const ownerRoot = OWNER_ROOTS.has(name);
  const readOnly = READ_ONLY_ROOTS.has(name);
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
          // Only a root this kernel publishes into (internal, writable) can hold its OWN leftover; a read-only or an
          // owner's root never loses a name to a read. At most one adoption per call.
          if (!adoptionTried && !readOnly && !ownerRoot) {
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
  const real = async (path: FencedPath, create = false): Promise<Checked> => {
    const root = base();
    if (root === undefined) refuse(name === 'work' ? 'unknown_ferret' : 'outside');
    if (create && scopedParent !== undefined) {
      // A forged path outside this scope must not create even an empty directory.
      const lexical = lexicalInRoot(home, root as string, ownerRoot, path);
      if (!lexical.ok) return refuse(lexical.error);
      await ensureScopedBase(fs, home, root as string, scopedParent, anchor);
    }
    const resolved = await resolveChecked(fs, home, root as string, ownerRoot, path, anchor);
    if (!resolved.ok) return refuse(resolved.error);
    return { full: resolved.value.full, scope: { fs, base: resolved.value.base, ownerRoot, immutable } };
  };
  /**
   * The leaf NOT followed: its parent resolved and checked, the leaf's own name appended and judged by name. What sits
   * at the name (a link included) is then judged by the call itself, reached through the checked folder.
   */
  const realParent = async (path: FencedPath, create = false): Promise<Checked> => {
    const slash = path.lastIndexOf('/');
    const leaf = path.slice(slash + 1);
    if (slash <= 0 || leaf === '' || leaf === '.' || leaf === '..') return await real(path, create);
    const parent = await real(path.slice(0, slash) as FencedPath, create);
    const full = join(parent.full, leaf);
    if (!within(parent.scope.base.real, full)) refuse('link_escape');
    if (parent.scope.base.fence !== undefined && fencedByName(parent.scope.base.fence, full)) refuse('fenced');
    return { full, scope: parent.scope };
  };
  const writable = (): void => {
    if (readOnly) refuse('read_only');
  };
  const read = async <T>(path: FencedPath, use: (file: OpenedFile) => Promise<T>): Promise<T> => {
    const { full, scope } = await real(path);
    return await withCheckedFile(scope, full, use);
  };
  const write = async (path: FencedPath, data: string | Uint8Array, options?: RootWriteOptions): Promise<void> => {
    writable();
    const leafOnly = options?.exclusive === true || options?.replaceExisting === true;
    const { full, scope } = leafOnly ? await realParent(path, true) : await real(path, true);
    await writeChecked(scope, full, data, random, options);
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
      await fs
        .mkdir(await entry(target.scope, made.folder, made.real, basename(target.full)), 0o700)
        .catch(() => refuse('outside'));
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
        await writeChecked(written.scope, written.full, bytes, random, { exclusive: true, mode: info.mode & 0o777 });
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
      const found = await scope.fs.identity(await entry(scope, folder, dirname(full), basename(full)));
      return found === undefined ? undefined : identityOfEntry(found);
    } finally {
      await folder.close();
    }
  };
  const handle: RootHandle = {
    name,
    resolve: relativePath => {
      const root = base();
      if (root === undefined) return err(name === 'work' ? 'unknown_ferret' : 'outside');
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
      const { full, scope } = await realParent(path, true);
      return await publishChecked(scope, full, bytes, random, options);
    },
    readDurable: async (path, limit, hold) =>
      await readDurable(path, limit, async (read, stillNames) =>
        hold === undefined ? (read as never) : await hold({ ...read, stillNames }),
      ),
    syncDirectory: async (path, options) => {
      const { full, scope } = await real(path);
      if (options?.parent === true && within(scope.base.real, dirname(full)) && dirname(full) !== full)
        await syncChecked(scope, dirname(full));
      await syncChecked(scope, full);
    },
    fileIdentity: async path => await rootHandleIdentity(path),
    copyTree: async (source, from, to, options) => {
      writable();
      const known = HANDLES.get(source);
      if (known === undefined || known.plugin !== plugin) return refuse('not_declared');
      const sourceFolder = await known.real(from);
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
    },
    ensurePrivateDirectory: async path => {
      writable();
      const { full, scope } = await realParent(path, true);
      const made = await openFolderMaking(scope, dirname(full), 0o700, true);
      try {
        const at = await entry(scope, made.folder, made.real, basename(full));
        const info = await scope.fs.identity(at);
        if (info !== undefined && info.kind !== 'directory') refuse('outside');
        if (info === undefined) await scope.fs.mkdir(at, 0o700).catch(() => refuse('changed'));
        const folder = await scope.fs.openDirectory(at).catch(() => refuse('changed'));
        try {
          const problem = await folderProblem(scope, join(made.real, basename(full)), folder.identity);
          if (problem !== undefined) refuse(problem);
          await folder.chmod(0o700);
        } finally {
          await folder.close();
        }
      } finally {
        await made.folder.close();
      }
    },
    lstat: async (path): Promise<RootLstat | undefined> => {
      const { full, scope } = await realParent(path);
      const info = await leafIdentity(scope, full);
      return info === undefined ? undefined : leafOf(info);
    },
    makeDirectory: async (path, options) => {
      writable();
      const { full, scope } = await real(path, true);
      const made = await openFolderMaking(scope, full, options?.mode ?? 0o700, true);
      await made.folder.close();
    },
    realPath: async path => {
      // `real` resolved every existing component inside the root; the whole must exist (a broken link throws), and a
      // name that moved between the two answers is refused rather than re-resolved.
      const { full } = await real(path);
      const again = await fs.realpath(full);
      if (again !== full) refuse('link_escape');
      return full as FencedPath;
    },
    list: async path => {
      const { full, scope } = await real(path);
      return await listChecked(scope, full);
    },
    entries: async path => {
      const { full, scope } = await real(path);
      const out: RootEntry[] = [];
      for (const found of await entriesChecked(scope, full))
        if (found.identity !== undefined) out.push({ name: found.name, ...leafOf(found.identity) });
      return out;
    },
    stat: async path => {
      const { full, scope } = await real(path);
      return await statChecked(scope, full);
    },
    remove: async path => {
      writable();
      const { full, scope } = await real(path);
      await removeChecked(scope, full);
    },
    pin: async (path, options) => {
      if (pins === undefined) return refuse('not_declared');
      const { full, scope } = await real(path);
      const pinned = await pins.pin(plugin, full, options);
      // The name was checked; now the OBJECT held: what the descriptor resolves to must still be in the root.
      try {
        if (!within(scope.base.real, pinned.rootReal)) refuse('link_escape');
        if (scope.base.fence !== undefined && (await fencedReal(fs, scope.base.fence, pinned.rootReal)))
          refuse('fenced');
      } catch (error) {
        await pinned.close();
        throw error;
      }
      if (scope.base.fence === undefined) return internalPin(pinned);
      // Caller-scoped (S47): an agent's read is fenced beneath the root, a person's is not; saying nothing is fenced.
      return options?.fence === 'none'
        ? unfencedPin(pinned, { fs, home, immutable })
        : fencedPin(pinned, { fs, home, immutable });
    },
  };
  HANDLES.set(handle, { plugin, real: path => real(path), realParent: path => realParent(path) });
  return handle;
}

/**
 * The one place the base of an internal root under the home is named: `<home>/state/<plugin>/<name>` for the roots
 * the kernel makes (`agent-homes`, `downloads`, `credentials`), nothing for any other root. Both the folder the kernel
 * makes at boot and the base the roots port serves are this fact.
 */
function internalRootBase(home: string, plugin: string, name: RootName): string | undefined {
  switch (name) {
    case 'agent-homes':
    case 'downloads':
    case 'credentials':
      return `${home}/state/${plugin}/${name}`;
    default:
      return undefined;
  }
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
 * Makes the base of every internal root a plugin DECLARED under the home (`state/<plugin>/agent-homes`, `downloads`,
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
      const owner = ROOT_OWNERS[name];
      if (owner !== undefined && owner !== layout.plugin) continue;
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
  const scope: Scope = { fs, base: checked.value, ownerRoot: false, immutable: async () => [] };
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
  return {
    root: (name, scope) => {
      if (!allowed.has(name)) throw new RootError('not_declared');
      const owner = ROOT_OWNERS[name];
      if (owner !== undefined && owner !== layout.plugin) throw new RootError('not_declared');
      const subfolder = scope?.subfolder;
      const internalSubfolder = (): string | undefined => {
        // An internal root's subfolder is one relative path below its anchor: never absolute, never `..`, no NUL.
        if (subfolder === undefined || subfolder === '') return '';
        if (subfolder.startsWith('/') || subfolder.includes('\0') || subfolder.split('/').includes('..'))
          return undefined;
        return subfolder;
      };
      const internal = internalRootBase(home, layout.plugin, name);
      const anchor = ((): string | undefined => {
        if (internal !== undefined) return home;
        return name === 'worktrees' ? dirname(absolute(layout.worktrees, 'the worktrees folder')) : undefined;
      })();
      const base = (): string | undefined => {
        switch (name) {
          case 'agent-homes': {
            const below = internalSubfolder();
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
          case 'harness-history':
          case 'imports':
            // The owner-named folder, or the harness's documented history folder: absolute, given by the caller.
            return subfolder?.startsWith('/') === true && !subfolder.includes('\0')
              ? absolute(subfolder, 'a root')
              : undefined;
        }
      };
      const check = (path: string): Result<FencedPath, FolderRefusal> | undefined => {
        if (name !== 'work' || scope?.ferret === undefined) return undefined;
        return workFolders()?.check(scope.ferret, path) ?? err('unknown_ferret');
      };
      const scopedParent = name === 'agent-homes' && subfolder !== undefined && subfolder !== '' ? internal : undefined;
      return rootHandle({
        fs,
        home,
        name,
        plugin: layout.plugin,
        base,
        anchor,
        scopedParent,
        check,
        immutable,
        random,
        pins: options.pins,
      });
    },
  };
}
