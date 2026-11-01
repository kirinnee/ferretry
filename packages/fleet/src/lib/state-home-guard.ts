import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * THE STATE-HOME GUARD: no file a daemon reads FOR an agent and hands on, and no file it writes for one, is
 * inside the daemon's own state home (`FY_HOME`: the API tokens, the tmux socket, the vault and its key,
 * `state/`, `config/`, every agent's credential home).
 *
 * ONE way in for every caller, so the safe order is never rebuilt by hand:
 *
 *   {@link resolveStateHomes} once — each home by name, by real path AND by device+inode;
 *   {@link openOutsideStateHomes} to read, {@link createOutsideStateHomes} to write,
 *   {@link copyTreeOutsideStateHomes} for a whole folder.
 *
 * Each answers a {@link Guarded} result — `ok: false` names the rule — and only an `ok` result carries a
 * handle that can read or write, so a caller cannot read a file it did not check. A path is judged as named,
 * once resolved, and by IDENTITY: every folder above the real path is compared by device and inode with every
 * home, which catches a bind mount, case folding and Unicode normalisation that a path string would miss.
 * What is opened is then proven to be what was checked (same real path, same device and inode), so a link or a
 * file swapped in between reaches nothing. Every doubt fails closed. The disk is a port ({@link GuardDisk});
 * `NodeGuardDisk` in `@ferretry/fleet/adapters` is the real one.
 *
 * In fleet so the daemon and the fleet share ONE guard (docs/agent-tools.md#files).
 */

/** Which file an entry is: what kind, and the device and inode that name it whatever path reached it. */
export interface FileIdentity {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
  /** How many names (hard links) the file has. */
  readonly links: number;
  readonly size: number;
  /** The permission bits. */
  readonly mode: number;
}

/** A file opened to read. */
export interface GuardReadHandle {
  readonly identity: FileIdentity;
  /** Copies what this descriptor reads into a NEW file (never through a link); throws past `maxBytes`. */
  copyTo(to: string, maxBytes: number, mode: number): Promise<number>;
  /** What this descriptor reads, as UTF-8; throws past `maxBytes`. */
  readText(maxBytes: number): Promise<string>;
  close(): Promise<void>;
}

/** A file opened to write. Nothing is written until the caller writes. */
export interface GuardWriteHandle {
  readonly identity: FileIdentity;
  /** Empties the file, through this descriptor. */
  truncate(): Promise<void>;
  /** Copies `source` (a file the caller trusts) into this descriptor; throws past `maxBytes`. */
  copyFrom(source: string, maxBytes: number): Promise<number>;
  close(): Promise<void>;
}

/** A folder opened so an entry can be reached through IT, not through whatever its path names a moment later. */
export interface GuardDirectoryHandle {
  readonly identity: FileIdentity;
  /** A path that reaches `leaf` in this open folder (Linux `/proc/self/fd/N/leaf`), or `undefined` where there is none. */
  entryPath(leaf: string): string | undefined;
  close(): Promise<void>;
}

/** What the guard asks of the disk. Every open refuses a link at its last step. */
export interface GuardDisk {
  realpath(path: string): Promise<string>;
  /** The entry itself (`lstat`), never followed; `undefined` when nothing is there. */
  identity(path: string): Promise<FileIdentity | undefined>;
  /** Opens to read, without blocking on a pipe. */
  openRead(path: string): Promise<GuardReadHandle>;
  openDirectory(path: string): Promise<GuardDirectoryHandle>;
  /** `new`: creates, failing with `taken` when something is there. `existing`: opens without emptying, `absent` when nothing is. */
  openWrite(path: string, how: 'new' | 'existing', mode: number): Promise<GuardWriteHandle | 'taken' | 'absent'>;
  /** Where the symlink at `path` points, as written. */
  readlink(path: string): Promise<string>;
  list(path: string): Promise<readonly string[]>;
  mkdir(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Why the guard refused. `state-home`: inside a home. `outside`: outside the folder the caller confined it to. */
export type GuardRule =
  | 'state-home'
  | 'outside'
  | 'not-found'
  | 'not-a-file'
  | 'changed'
  | 'hard-link'
  | 'taken'
  | 'loop'
  | 'too-many';

/** A guard's answer: a value only when every check passed. */
export type Guarded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rule: GuardRule; readonly home?: string };

/** A state home that could not be resolved: nothing may be reached until it can. */
export class StateHomeUnresolvedError extends Error {
  constructor() {
    super('the daemon’s state home cannot be resolved');
    this.name = 'StateHomeUnresolvedError';
  }
}

interface KnownDirectory {
  readonly named: string;
  readonly real: string;
  readonly device: bigint;
  readonly inode: bigint;
}

declare const stateHomesBrand: unique symbol;

/** The resolved homes and the openings inside them; made only by {@link resolveStateHomes}. */
export interface StateHomes {
  readonly homes: readonly KnownDirectory[];
  /** Folders inside a home that ARE reachable (e.g. the fleet's assets), by name and identity. */
  readonly openings: readonly KnownDirectory[];
  readonly [stateHomesBrand]: true;
}

/** Whether a path is inside a home — `home` names it when so. */
export type HomeVerdict = { readonly inside: false } | { readonly inside: true; readonly home: string };

const OUTSIDE: HomeVerdict = { inside: false };

function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new TypeError(`${what} must be an absolute path: ${path}`);
  return normalize(path);
}

const within = (directory: string, path: string): boolean => {
  const from = relative(directory, path);
  // '..' as a whole first segment only: a child named '..cache' is inside, and must not read as outside.
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};

const refused = (
  rule: GuardRule,
  home?: string,
): { readonly ok: false; readonly rule: GuardRule; readonly home?: string } =>
  home === undefined ? { ok: false, rule } : { ok: false, rule, home };

const same = (a: { readonly device: bigint; readonly inode: bigint }, b: FileIdentity | undefined): boolean =>
  b !== undefined && a.device === b.device && a.inode === b.inode;

/**
 * Each home (and each opening) by name, by real path and by device+inode. Throws {@link StateHomeUnresolvedError}
 * when one cannot be resolved or is not a folder, and a `TypeError` for a relative path.
 */
export async function resolveStateHomes(
  input: { readonly homes: readonly string[]; readonly openings?: readonly string[] },
  disk: Pick<GuardDisk, 'realpath' | 'identity'>,
): Promise<StateHomes> {
  const known = async (paths: readonly string[]): Promise<readonly KnownDirectory[]> =>
    await Promise.all(
      paths.map(async path => {
        const named = absolute(path, 'a state home');
        const real = await disk.realpath(named).catch(() => {
          throw new StateHomeUnresolvedError();
        });
        const entry = await disk.identity(real);
        if (entry?.kind !== 'directory') throw new StateHomeUnresolvedError();
        return { named, real, device: entry.device, inode: entry.inode };
      }),
    );
  return { homes: await known(input.homes), openings: await known(input.openings ?? []) } as StateHomes;
}

/**
 * The home holding `path`, judged by its NAME alone: as configured and as resolved, less any opening. Pure — for
 * a caller that reaches its bytes some other safe way (a descriptor walk) and needs only the rule.
 */
export function stateHomeByName(homes: StateHomes, path: string): HomeVerdict {
  const target = absolute(path, 'the path');
  const names = (directory: KnownDirectory): readonly string[] => [directory.named, directory.real];
  if (homes.openings.some(opening => names(opening).some(name => within(name, target)))) return OUTSIDE;
  const home = homes.homes.find(directory => names(directory).some(name => within(name, target)));
  return home === undefined ? OUTSIDE : { inside: true, home: home.named };
}

/**
 * The home holding the REAL path `real`, by name and then by identity: every folder from `real` up to the root is
 * compared by device and inode with each home and opening, nearest first. A folder that cannot be read fails closed.
 */
export async function stateHomeOf(
  homes: StateHomes,
  real: string,
  disk: Pick<GuardDisk, 'identity'>,
): Promise<HomeVerdict> {
  const named = stateHomeByName(homes, real);
  if (named.inside) return named;
  for (let current = absolute(real, 'the path'); ; current = dirname(current)) {
    const entry = await disk.identity(current);
    if (entry === undefined) return { inside: true, home: homes.homes[0]?.named ?? current };
    if (homes.openings.some(opening => same(opening, entry))) return OUTSIDE;
    const home = homes.homes.find(directory => same(directory, entry));
    if (home !== undefined) return { inside: true, home: home.named };
    if (dirname(current) === current) return OUTSIDE;
  }
}

/** A file the guard checked and opened: its real path and identity, and the reads that use THIS descriptor. */
export interface GuardedFile {
  readonly path: string;
  readonly identity: FileIdentity;
  copyTo(to: string, maxBytes: number, mode?: number): Promise<number>;
  readText(maxBytes: number): Promise<string>;
  close(): Promise<void>;
}

/** How hard links and link hops are judged. */
export interface GuardLinkOptions {
  /**
   * A file with more than one name is refused (its other name could be anywhere, a home included) unless its
   * real path is under one of `allowUnder` — e.g. `/nix/store`, root-owned and immutable.
   */
  readonly hardLinks?: 'refuse' | { readonly allowUnder: readonly string[] };
  /**
   * `landing` (the default) judges where a path finally lands. `every` also refuses a path whose resolution
   * passes through a symlink that LIVES inside a home — a link in a home that leads out to a credential —
   * except a link that is a home's own configured name (a symlinked home).
   */
  readonly hops?: 'landing' | 'every';
}

export interface GuardReadOptions extends GuardLinkOptions {
  /** A REAL folder the file must stay under. */
  readonly inside?: string;
}

/** The most link hops one path may take, as the kernel allows. */
const MAX_HOPS = 40;

/**
 * Where the first symlink that LIVES inside a home sits, on the way `path` resolves — followed hop by hop with
 * `readlink`, each link judged where it is (by name and by identity) before it is followed.
 */
async function hopInsideHome(homes: StateHomes, path: string, disk: GuardDisk): Promise<HomeVerdict> {
  const segments = (text: string): string[] => text.split(sep).filter(part => part !== '' && part !== '.');
  const pending = segments(absolute(path, 'the path'));
  const configured = new Set(homes.homes.map(home => home.named));
  let current: string = sep;
  for (let hops = 0; pending.length > 0; ) {
    const segment = pending.shift() as string;
    const next = segment === '..' ? dirname(current) : join(current, segment);
    const entry = await disk.identity(next);
    if (entry?.kind !== 'link') {
      // Nothing there: resolution fails anyway, and the caller refuses it as not found.
      if (entry === undefined) return OUTSIDE;
      current = next;
      continue;
    }
    if (!configured.has(next)) {
      const verdict = await stateHomeOf(homes, next, disk);
      if (verdict.inside) return verdict;
    }
    hops += 1;
    if (hops > MAX_HOPS) return OUTSIDE;
    const target = await disk.readlink(next);
    pending.unshift(...segments(target));
    if (isAbsolute(target)) current = sep;
  }
  return OUTSIDE;
}

const hardLinkAllowed = (options: GuardLinkOptions, real: string): boolean =>
  typeof options.hardLinks === 'object' &&
  options.hardLinks.allowUnder.some(root => within(absolute(root, 'allowUnder'), real));

/**
 * Opens the file at the absolute `path` to read, if — and only if — it is a regular file outside every home
 * (and under `inside`), by name, by real path and by identity, and still the file that was checked once open.
 */
export async function openOutsideStateHomes(
  path: string,
  homes: StateHomes,
  disk: GuardDisk,
  options: GuardReadOptions = {},
): Promise<Guarded<GuardedFile>> {
  const named = stateHomeByName(homes, path);
  if (named.inside) return refused('state-home', named.home);
  if (options.hops === 'every') {
    const hop = await hopInsideHome(homes, path, disk);
    if (hop.inside) return refused('state-home', hop.home);
  }
  const real = await disk.realpath(path).catch(() => undefined);
  if (real === undefined) return refused('not-found');
  if (options.inside !== undefined && !within(absolute(options.inside, 'inside'), real)) return refused('outside');
  const resolved = stateHomeByName(homes, real);
  if (resolved.inside) return refused('state-home', resolved.home);
  // Known to be a regular file BEFORE the open, so a device is never opened at all.
  const before = await disk.identity(real);
  if (before === undefined) return refused('not-found');
  if (before.kind !== 'file') return refused('not-a-file');
  const handle = await disk.openRead(real).catch(() => undefined);
  if (handle === undefined) return refused('changed');
  const problem =
    (await openedProblem(homes, real, handle.identity, disk)) ??
    (handle.identity.links > 1 && !hardLinkAllowed(options, real) ? refused('hard-link') : undefined);
  if (problem !== undefined) {
    await handle.close();
    return problem;
  }
  return {
    ok: true,
    value: {
      path: real,
      identity: handle.identity,
      copyTo: async (to, maxBytes, mode = 0o600) => await handle.copyTo(to, maxBytes, mode),
      readText: async maxBytes => await handle.readText(maxBytes),
      close: async () => await handle.close(),
    },
  };
}

/** Why an opened entry at `real` may not be used: not a file, not the one checked, or inside a home. */
async function openedProblem(
  homes: StateHomes,
  real: string,
  opened: FileIdentity,
  disk: GuardDisk,
): Promise<{ readonly ok: false; readonly rule: GuardRule; readonly home?: string } | undefined> {
  if (opened.kind !== 'file') return refused('not-a-file');
  const again = await disk.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await disk.identity(real))) return refused('changed');
  const verdict = await stateHomeOf(homes, real, disk);
  return verdict.inside ? refused('state-home', verdict.home) : undefined;
}

/** A file the guard checked and opened to write. */
export interface GuardedWrite {
  /** Its real path. */
  readonly path: string;
  /** Whether this call made it (it was not there before). */
  readonly created: boolean;
  /** Empties it, then copies `source` in; throws past `maxBytes`. */
  copyFrom(source: string, maxBytes: number): Promise<number>;
  /**
   * After a failed write: removes the file this call made, through the folder it checked when the platform
   * gives such a path (and only while it is still that file), else empties it. Never removes by a path that
   * could have been swapped.
   */
  discard(): Promise<void>;
  close(): Promise<void>;
}

export interface GuardWriteOptions {
  /** A REAL folder the file must stay under. */
  readonly inside?: string;
  /** Write into a file already there. Without it, a file already there is `taken`. */
  readonly overwrite: boolean;
  /** The new file's permission bits. */
  readonly mode: number;
}

/**
 * Opens the absolute `path` to write, if — and only if — its folder and the file are outside every home (and
 * under `inside`), by name, by real path and by identity. The folder is opened and checked first, and the file
 * is reached THROUGH it where the platform allows, then proven to be a single-named regular file in that folder
 * before a byte is written. Nothing is ever removed by path: a mismatch is refused, not cleaned up.
 */
export async function createOutsideStateHomes(
  path: string,
  homes: StateHomes,
  disk: GuardDisk,
  options: GuardWriteOptions,
): Promise<Guarded<GuardedWrite>> {
  const target = absolute(path, 'the path');
  const leaf = basename(target);
  if (leaf === '' || leaf === '.' || leaf === '..' || target === dirname(target))
    throw new TypeError(`name a file, not a folder: ${path}`);
  const named = stateHomeByName(homes, target);
  if (named.inside) return refused('state-home', named.home);
  const parent = await disk.realpath(dirname(target)).catch(() => undefined);
  if (parent === undefined) return refused('not-found');
  const real = join(parent, leaf);
  if (options.inside !== undefined && !within(absolute(options.inside, 'inside'), real)) return refused('outside');
  const folder = await disk.openDirectory(parent).catch(() => undefined);
  if (folder === undefined) return refused('changed');
  const close = async (): Promise<void> => await folder.close();
  const folderProblem = await openedFolderProblem(homes, parent, folder.identity, disk);
  if (folderProblem !== undefined) {
    await close();
    return folderProblem;
  }
  const through = folder.entryPath(leaf) ?? real;
  // An open that fails outright (a folder, a link put there since) is refused, never retried by path.
  const openAs = async (how: 'new' | 'existing') =>
    await disk.openWrite(through, how, options.mode).catch(() => 'failed' as const);
  let handle = options.overwrite ? await openAs('existing') : 'absent';
  const created = handle === 'absent';
  if (handle === 'absent') handle = await openAs('new');
  if (typeof handle === 'string') {
    await close();
    return refused(handle === 'failed' ? 'changed' : 'taken');
  }
  const opened = handle;
  const discard = async (): Promise<void> => {
    const entry = folder.entryPath(leaf);
    if (created && entry !== undefined && same(opened.identity, await disk.identity(entry))) await disk.unlink(entry);
    else await opened.truncate();
  };
  const problem =
    opened.identity.kind !== 'file'
      ? refused('not-a-file')
      : opened.identity.links > 1
        ? refused('hard-link')
        : await openedProblem(homes, real, opened.identity, disk);
  if (problem !== undefined) {
    if (created) await discard().catch(() => undefined);
    await opened.close();
    await close();
    return problem;
  }
  return {
    ok: true,
    value: {
      path: real,
      created,
      copyFrom: async (source, maxBytes) => {
        await opened.truncate();
        return await opened.copyFrom(source, maxBytes);
      },
      discard,
      close: async () => {
        await opened.close();
        await close();
      },
    },
  };
}

async function openedFolderProblem(
  homes: StateHomes,
  real: string,
  opened: FileIdentity,
  disk: GuardDisk,
): Promise<{ readonly ok: false; readonly rule: GuardRule; readonly home?: string } | undefined> {
  if (opened.kind !== 'directory') return refused('not-a-file');
  const again = await disk.realpath(real).catch(() => undefined);
  if (again !== real || !same(opened, await disk.identity(real))) return refused('changed');
  const verdict = await stateHomeOf(homes, real, disk);
  return verdict.inside ? refused('state-home', verdict.home) : undefined;
}

export interface GuardTreeOptions extends GuardLinkOptions {
  /** The most bytes one file may hold. */
  readonly maxFileBytes: number;
  /** The most files the copy may make. */
  readonly maxFiles: number;
}

/**
 * Copies the file or folder at `source` to `destination`, following every link (like `cp -RL`) and keeping each
 * file's permission bits. EVERY file and folder is judged where it really lands, and each file is read through
 * {@link openOutsideStateHomes}; the first refusal stops the copy (what was copied stays, for the caller to
 * remove). A folder met twice on one branch is a `loop`, and more than `maxFiles` files is `too-many`. The
 * destination is the caller's to have checked.
 */
export async function copyTreeOutsideStateHomes(
  source: string,
  destination: string,
  homes: StateHomes,
  disk: GuardDisk,
  options: GuardTreeOptions,
): Promise<Guarded<{ readonly files: number; readonly bytes: number }>> {
  const totals = { files: 0, bytes: 0 };
  const links: GuardLinkOptions = {
    ...(options.hardLinks === undefined ? {} : { hardLinks: options.hardLinks }),
    ...(options.hops === undefined ? {} : { hops: options.hops }),
  };
  const copy = async (
    from: string,
    to: string,
    branch: ReadonlySet<string>,
  ): Promise<{ readonly ok: false; readonly rule: GuardRule; readonly home?: string } | undefined> => {
    const real = await disk.realpath(from).catch(() => undefined);
    if (real === undefined) return refused('not-found');
    const entry = await disk.identity(real);
    if (entry?.kind !== 'directory') {
      if (totals.files >= options.maxFiles) return refused('too-many');
      const opened = await openOutsideStateHomes(from, homes, disk, links);
      if (!opened.ok) return opened;
      try {
        totals.bytes += await opened.value.copyTo(to, options.maxFileBytes, opened.value.identity.mode);
        totals.files += 1;
      } finally {
        await opened.value.close();
      }
      return undefined;
    }
    const named = stateHomeByName(homes, from);
    if (named.inside) return refused('state-home', named.home);
    const hop = options.hops === 'every' ? await hopInsideHome(homes, from, disk) : OUTSIDE;
    if (hop.inside) return refused('state-home', hop.home);
    const verdict = await stateHomeOf(homes, real, disk);
    if (verdict.inside) return refused('state-home', verdict.home);
    const key = `${String(entry.device)}:${String(entry.inode)}`;
    if (branch.has(key)) return refused('loop');
    await disk.mkdir(to, entry.mode);
    const below = new Set([...branch, key]);
    for (const name of await disk.list(real)) {
      const problem = await copy(join(real, name), join(to, name), below);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const problem = await copy(absolute(source, 'the source'), absolute(destination, 'the destination'), new Set());
  return problem ?? { ok: true, value: totals };
}
