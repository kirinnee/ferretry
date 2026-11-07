import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import { basename, dirname, join, relative } from 'node:path';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
import type { HeldRoot, PinnedFileKind, PinnedFileProbe, PinnedOpenOptions, PinnedTarget } from '../contract/pinned.ts';
import { insideFence } from '../contract/home.ts';
import { MAX_ROOT_WINDOW_BYTES } from '../contract/ports.ts';
import type {
  RootEntry,
  RootHandle,
  RootLstat,
  RootName,
  RootsPort,
  RootStat,
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
import type { PinRegistry } from './pins.ts';

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
async function openCheckedFolder(scope: Scope, real: string): Promise<OpenedDirectory> {
  if (!within(scope.base.real, real)) refuse('link_escape');
  const folder = await scope.fs.openDirectory(real).catch(() => refuse('changed'));
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
): Promise<{ readonly folder: OpenedDirectory; readonly real: string }> {
  let existing = full;
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
      await scope.fs.mkdir(at, mode).catch(() => refuse('changed'));
      const made = await scope.fs.openDirectory(at).catch(() => refuse('changed'));
      await folder.close();
      folder = made;
      parent = join(parent, segment);
      const problem = await folderProblem(scope, parent, made.identity);
      if (problem !== undefined) refuse(problem);
    }
  } catch (error) {
    await folder.close();
    throw error;
  }
  return { folder, real: parent };
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

/**
 * A held owner's root whose every walk is judged against the fence AGAIN (S40, S47). The root itself was checked at
 * the pin, but a root can be an ancestor of the home (a ferret working in `~`), and the descriptor walk beneath it
 * knows nothing of the home. So each `open` and each `probe` asks, like every other op of an owner's root: the fence
 * is recomputed (a home that cannot be identified refuses), the path is refused by name before the walk starts, and
 * every component the walk opened is refused by device and inode (a bind mount or alias a name would miss) — the walk
 * never serves a byte from, or lists, the home. A file with several names is refused unless it is proven immutable
 * (S49), as `withCheckedFile` does. Same `policyCwd`, the object the registry minted.
 */
function fencedPin(pinned: HeldRoot, setup: PinFenceSetup): HeldRoot {
  const { fs, home, immutable } = setup;
  const fenceNow = async (): Promise<Fence> => {
    const fence = await fenceOf(fs, home).catch(() => undefined);
    return fence ?? refuse('fenced');
  };
  const named = (rel: string): string => join(pinned.rootReal, rel);
  return Object.freeze({
    rootReal: pinned.rootReal,
    policyCwd: pinned.policyCwd,
    open: async (rel: string, options?: PinnedOpenOptions): Promise<PinnedTarget> => {
      const fence = await fenceNow();
      if (fencedByName(fence, named(rel))) return refuse('fenced');
      const target = await pinned.open(rel, options);
      try {
        const real = join(pinned.rootReal, target.canonical);
        if (
          fencedByName(fence, real) ||
          target.identities.some(entry =>
            fence.identities.some(held => held.device === entry.dev && held.inode === entry.ino),
          )
        )
          return refuse('fenced');
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
      return {
        // A verdict on names: one inside the home is `unsupported` (nothing a read would serve) without being walked.
        classify: async (rels, budget) => {
          const fence = await fenceNow();
          const asked = rels.map(rel => fencedByName(fence, named(rel)));
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

function rootHandle(setup: HandleSetup): RootHandle {
  const { fs, home, name, plugin, base, anchor, scopedParent, check, immutable, random, pins } = setup;
  const ownerRoot = OWNER_ROOTS.has(name);
  const readOnly = READ_ONLY_ROOTS.has(name);
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
      return scope.base.fence === undefined ? pinned : fencedPin(pinned, { fs, home, immutable });
    },
  };
  HANDLES.set(handle, { plugin, real: path => real(path), realParent: path => realParent(path) });
  return handle;
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
      const anchor = ((): string | undefined => {
        switch (name) {
          case 'agent-homes':
          case 'downloads':
          case 'credentials':
            return home;
          case 'worktrees':
            return dirname(absolute(layout.worktrees, 'the worktrees folder'));
          default:
            return undefined;
        }
      })();
      const base = (): string | undefined => {
        switch (name) {
          case 'agent-homes': {
            const below = internalSubfolder();
            return below === undefined
              ? undefined
              : absolute(join(`${home}/state/${layout.plugin}/agent-homes`, below), 'a root');
          }
          case 'downloads':
            return `${home}/state/${layout.plugin}/downloads`;
          case 'credentials':
            return `${home}/state/${layout.plugin}/credentials`;
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
      const scopedParent =
        name === 'agent-homes' && subfolder !== undefined && subfolder !== ''
          ? `${home}/state/${layout.plugin}/agent-homes`
          : undefined;
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
