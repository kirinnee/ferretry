import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import { basename, dirname, join, relative } from 'node:path';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
import { insideFence } from '../contract/home.ts';
import type { RootHandle, RootName, RootsPort, RootStat } from '../contract/ports.ts';
import type { FileIdentity, HostFs, OpenedDirectory } from './adapters/node-fs.ts';
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

/** Owner's roots refuse everything inside the fence; internal roots reach only their own subtree (§7.7). */
const OWNER_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'work', 'imports']);
const READ_ONLY_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'imports']);

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
 * opened once without following a link, proven to be the file that was checked, then read through THAT descriptor.
 */
async function readChecked(scope: Scope, full: string, limit: number | undefined): Promise<Uint8Array> {
  const real = await scope.fs.realpath(full);
  const before = await scope.fs.identity(real);
  if (before === undefined) return refuse('changed');
  const judged = await fileProblem(scope, real, before);
  if (judged !== undefined) refuse(judged);
  const handle = await scope.fs.openRead(real).catch(() => refuse('changed'));
  try {
    const problem = await fileProblem(scope, real, handle.identity);
    if (problem !== undefined) refuse(problem);
    return await handle.read(limit);
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
 * Today's `createOutsideStateHomes`, atomically: the nearest existing folder is opened and checked, every missing
 * folder below it is made THROUGH it one at a time and checked in turn, the content goes into a NEW temp file made
 * through the checked folder (`O_EXCL | O_NOFOLLOW`), and that is renamed over the leaf in the same folder.
 */
async function writeChecked(scope: Scope, full: string, data: string, random: () => string): Promise<void> {
  const leaf = basename(full);
  if (leaf === '' || full === scope.base.real) refuse('not_a_file');
  let existing = dirname(full);
  const missing: string[] = [];
  let parent = await scope.fs.realpath(existing).catch(() => undefined);
  while (parent === undefined && within(scope.base.real, dirname(existing)) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
    parent = await scope.fs.realpath(existing).catch(() => undefined);
  }
  if (parent === undefined) return refuse('outside');
  if (!within(scope.base.real, join(parent, ...missing, leaf))) refuse('link_escape');
  let folder = await openCheckedFolder(scope, parent);
  try {
    for (const segment of missing) {
      const at = await entry(scope, folder, parent, segment);
      await scope.fs.mkdir(at, 0o700).catch(() => refuse('changed'));
      const made = await scope.fs.openDirectory(at).catch(() => refuse('changed'));
      await folder.close();
      folder = made;
      parent = join(parent, segment);
      const problem = await folderProblem(scope, parent, made.identity);
      if (problem !== undefined) refuse(problem);
    }
    const temp = `.${leaf}.${random()}.tmp`;
    const created = await scope.fs
      .writeNew(await entry(scope, folder, parent, temp), data, 0o600)
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

async function statChecked(scope: Scope, full: string): Promise<RootStat | undefined> {
  const parent = await scope.fs.realpath(dirname(full)).catch(() => undefined);
  if (parent === undefined) return undefined;
  if (full === scope.base.real) {
    const info = await scope.fs.identity(full);
    return info?.kind === 'directory'
      ? { kind: 'directory', size: info.size, modified: instantFromEpochMs(info.mtimeMs) }
      : undefined;
  }
  const folder = await openCheckedFolder(scope, parent);
  try {
    const info = await scope.fs.identity(await entry(scope, folder, parent, basename(full)));
    if (info === undefined || (info.kind !== 'file' && info.kind !== 'directory')) return undefined;
    return { kind: info.kind, size: info.size, modified: instantFromEpochMs(info.mtimeMs) };
  } finally {
    await folder.close();
  }
}

const decoder = new TextDecoder();

function rootHandle(
  fs: HostFs,
  home: string,
  name: RootName,
  base: () => string | undefined,
  anchor: string | undefined,
  check: (path: string) => Result<FencedPath, FolderRefusal> | undefined,
  immutable: () => Promise<readonly string[]>,
  random: () => string,
): RootHandle {
  const ownerRoot = OWNER_ROOTS.has(name);
  const readOnly = READ_ONLY_ROOTS.has(name);
  const real = async (path: FencedPath): Promise<{ readonly full: string; readonly scope: Scope }> => {
    const root = base();
    if (root === undefined) refuse(name === 'work' ? 'unknown_ferret' : 'outside');
    const resolved = await resolveChecked(fs, home, root as string, ownerRoot, path, anchor);
    if (!resolved.ok) return refuse(resolved.error);
    return { full: resolved.value.full, scope: { fs, base: resolved.value.base, ownerRoot, immutable } };
  };
  const writable = (): void => {
    if (readOnly) refuse('read_only');
  };
  return {
    name,
    resolve: relativePath => {
      const root = base();
      if (root === undefined) return err(name === 'work' ? 'unknown_ferret' : 'outside');
      const lexical = lexicalInRoot(home, root, ownerRoot, relativePath);
      if (!lexical.ok) return lexical;
      return check(lexical.value) ?? lexical;
    },
    readText: async (path, limit) => {
      const { full, scope } = await real(path);
      return decoder.decode(await readChecked(scope, full, limit));
    },
    readBytes: async (path, limit) => {
      const { full, scope } = await real(path);
      return await readChecked(scope, full, limit);
    },
    writeText: async (path, text) => {
      writable();
      const { full, scope } = await real(path);
      await writeChecked(scope, full, text, random);
    },
    list: async path => {
      const { full, scope } = await real(path);
      return await listChecked(scope, full);
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
  };
}

export interface RootsOptions {
  /** A temp file's random suffix. */
  readonly random?: () => string;
  /** Where a file with several names may be read once proven immutable (S49); today's `/nix/store`. */
  readonly hardLinkRoots?: readonly string[];
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
      return rootHandle(fs, home, name, base, anchor, check, immutable, random);
    },
  };
}
