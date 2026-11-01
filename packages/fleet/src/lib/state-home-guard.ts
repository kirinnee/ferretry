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
 *   {@link copyTreeOutsideStateHomes} for a whole folder;
 *   {@link openFolderOutsideStateHomes} for a folder to write BELOW (the provisioner's destinations), then
 *   {@link openFolderBelow} and {@link removeEntryWithin} through that handle.
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
  /** The owner's user id. */
  readonly owner: number;
  /** The owning group's id. */
  readonly group: number;
  /** When its content last changed, in nanoseconds, where the disk says. */
  readonly modified?: bigint;
  /** When its entry last changed (content, mode, owner or a name), in nanoseconds, where the disk says. */
  readonly changed?: bigint;
}

/** A file opened to read. */
export interface GuardReadHandle {
  readonly identity: FileIdentity;
  /** Copies what this descriptor reads into a NEW file (never through a link); throws past `maxBytes`. */
  copyTo(to: string, maxBytes: number, mode: number): Promise<number>;
  /** Copies what this descriptor reads into `descriptor`, a file the caller just created, and closes it; throws past `maxBytes`. */
  copyToDescriptor?(descriptor: number, maxBytes: number): Promise<number>;
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
  /** Calls made relative to THIS descriptor, where the platform has no descriptor path but these (macOS). */
  readonly at?: DescriptorCalls;
  /** Sets the folder's permission bits through THIS descriptor (`fchmod`), never by a path a link could redirect. */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * One folder step made RELATIVE TO an open folder's descriptor, so a folder swapped after it was opened is never
 * reached: each takes one entry's name (never a path) inside that folder. The disk's own calls, which name paths,
 * cannot promise that where there is no descriptor path.
 */
export interface DescriptorCalls {
  /** The entry itself (`lstat`), never followed; `undefined` when nothing is there. */
  identity(leaf: string): Promise<FileIdentity | undefined>;
  list(): Promise<readonly string[]>;
  mkdir(leaf: string, mode: number): Promise<void>;
  /** Opens the folder `leaf` without following a link. */
  openDirectory(leaf: string): Promise<GuardDirectoryHandle>;
  unlink(leaf: string): Promise<void>;
  rmdir(leaf: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Renames `fromLeaf` here to `toLeaf` in the folder `into` (which must have descriptor calls too). */
  renameInto(fromLeaf: string, into: GuardDirectoryHandle, toLeaf: string): Promise<void>;
  symlink(target: string, leaf: string): Promise<void>;
  /** Where the symbolic link `leaf` points, as written. */
  readlink(leaf: string): Promise<string>;
  /** Hard-links `fromLeaf` here as `toLeaf` in the folder `into` (which must have descriptor calls too). */
  link(fromLeaf: string, into: GuardDirectoryHandle, toLeaf: string): Promise<void>;
  /** A raw descriptor on the file `leaf` ({@link FileOpening}); never through a link. */
  openFile(leaf: string, how: FileOpening, mode: number): Promise<number>;
}

/**
 * How a folder step opens a file, never through a link and never blocking on a pipe: `read`; `new`, created
 * exclusively with its mode; `append`, an existing file opened to read and to add at its end only.
 */
export type FileOpening = 'read' | 'new' | 'append';

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
  /**
   * This process's group ids as they stand NOW — its supplementary groups, its effective group, and every group the
   * group database lists it in (a member may join one with `sg` at any time). Read here, never handed in by a caller.
   */
  groups(): Promise<readonly number[]>;
  /** Whether this process may write in `path` (`access(W_OK)`): mode bits, ACLs and its groups all counted. */
  writable(path: string): Promise<boolean>;
}

/**
 * Why the guard refused. `state-home`: inside a home. `outside`: outside the folder the caller confined it to.
 * `link`: a symbolic link where a folder must be. `not-a-folder`: something else where a folder must be.
 */
export type GuardRule =
  | 'state-home'
  | 'outside'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-folder'
  | 'link'
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
  /**
   * The home's key files and folders by identity, so a bind mount of one of them alone is still seen — and by
   * `place`, the real path of where each one is, which is the one place a folder walk may meet it.
   */
  readonly pinned: readonly { readonly device: bigint; readonly inode: bigint; readonly place: string }[];
  readonly [stateHomesBrand]: true;
}

declare const immutableRootsBrand: unique symbol;

/** Folders proven root-owned and unwritable by anyone else; made only by {@link resolveImmutableRoots}. */
export interface ImmutableRoots {
  readonly roots: readonly string[];
  readonly [immutableRootsBrand]: true;
}

/** A root offered as immutable that is not: not root's, writable by anyone, or by a group this process is in. */
export class MutableRootError extends Error {
  constructor(readonly root: string) {
    super(`${root} is not root-owned and closed to this process's writes, so a hard link under it proves nothing`);
    this.name = 'MutableRootError';
  }
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
 * Each home (and each opening) by name, by real path and by device+inode, and each `pinned` file or folder
 * inside them by device+inode (one not there yet is skipped: nothing can be bound to it). Throws
 * {@link StateHomeUnresolvedError} when a home cannot be resolved or is not a folder, when an OPENING is a home or
 * holds one (an asset tree linked to the home, or to the folder above it, would open the whole fence: openings are
 * asked first), and a `TypeError` for a relative path.
 */
export async function resolveStateHomes(
  input: {
    readonly homes: readonly string[];
    readonly openings?: readonly string[];
    readonly pinned?: readonly string[];
  },
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
  const pinned = await Promise.all(
    (input.pinned ?? []).map(async path => {
      const named = absolute(path, 'a pinned path');
      const entry = await disk.identity(named).catch(() => {
        throw new StateHomeUnresolvedError();
      });
      if (entry === undefined) return [];
      // The entry itself is never followed, so its place is its real folder plus its own name.
      const folder = await disk.realpath(dirname(named)).catch(() => {
        throw new StateHomeUnresolvedError();
      });
      return [{ device: entry.device, inode: entry.inode, place: join(folder, basename(named)) }];
    }),
  );
  const homes = await known(input.homes);
  const openings = await known(input.openings ?? []);
  const keys = pinned.flat();
  for (const opening of openings) {
    const opensAHome = homes.some(
      home => within(opening.real, home.real) || (opening.device === home.device && opening.inode === home.inode),
    );
    if (opensAHome || keys.some(key => key.device === opening.device && key.inode === opening.inode))
      throw new StateHomeUnresolvedError();
  }
  return { homes, openings, pinned: keys } as unknown as StateHomes;
}

type ClosedDisk = Pick<GuardDisk, 'identity' | 'writable'>;

/**
 * Whether the entry at `path` is closed to this process: owned by root (uid 0), never writable by other, writable by
 * its group only when this process is NOT in that group, and refused a write by the kernel itself
 * (`access(W_OK)`, which also counts ACLs the mode bits do not show). A folder must also BE a folder.
 */
async function closedToThisProcess(
  path: string,
  kind: 'file' | 'directory',
  groups: readonly number[],
  disk: ClosedDisk,
): Promise<boolean> {
  const entry = await disk.identity(path);
  if (entry?.kind !== kind || entry.owner !== 0 || (entry.mode & 0o002) !== 0) return false;
  if ((entry.mode & 0o020) !== 0 && groups.includes(entry.group)) return false;
  return kind === 'file' || !(await disk.writable(path).catch(() => true));
}

/**
 * Proves each root closed to this process: its real path and every folder above it are folders closed to it (see
 * {@link closedToThisProcess}) — a multi-user Nix store is `root:nixbld 1775`, written by build users only. So
 * nothing this process (or an agent it runs) does can put a hard link, or a rename, under it. A single-user Nix
 * store, owned by its user, does NOT qualify. The process's groups are read from the disk port, never handed in.
 * Throws {@link MutableRootError} for any root that fails.
 */
export async function resolveImmutableRoots(
  roots: readonly string[],
  disk: Pick<GuardDisk, 'realpath' | 'identity' | 'groups' | 'writable'>,
): Promise<ImmutableRoots> {
  const groups = await disk.groups();
  const real = await Promise.all(
    roots.map(async root => {
      const resolved = await disk.realpath(absolute(root, 'an immutable root')).catch(() => {
        throw new MutableRootError(root);
      });
      for (let current = resolved; ; current = dirname(current)) {
        if (!(await closedToThisProcess(current, 'directory', groups, disk))) throw new MutableRootError(root);
        if (dirname(current) === current) return resolved;
      }
    }),
  );
  return { roots: real } as unknown as ImmutableRoots;
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
 * compared by device and inode with each home, opening and pinned key file, nearest first. A folder that cannot be
 * read fails closed.
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
    if (homes.pinned.some(key => same(key, entry))) return { inside: true, home: homes.homes[0]?.named ?? current };
    if (dirname(current) === current) return OUTSIDE;
  }
}

/** A file the guard checked and opened: its real path and identity, and the reads that use THIS descriptor. */
export interface GuardedFile {
  readonly path: string;
  readonly identity: FileIdentity;
  copyTo(to: string, maxBytes: number, mode?: number): Promise<number>;
  /** Into a file the caller just created, by its descriptor (closed after); throws where the disk cannot. */
  copyToDescriptor(descriptor: number, maxBytes: number): Promise<number>;
  readText(maxBytes: number): Promise<string>;
  close(): Promise<void>;
}

/** How hard links and link hops are judged. */
export interface GuardLinkOptions {
  /**
   * A file with more than one name is refused (its other name could be anywhere, a home included) unless its
   * real path is under one of `allowUnder` — roots PROVEN immutable by {@link resolveImmutableRoots}, such as a
   * multi-user `/nix/store`; a raw path is not accepted.
   */
  readonly hardLinks?: 'refuse' | { readonly allowUnder: ImmutableRoots };
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

/**
 * Whether a file with several names at `real` may be used: it lies under an immutable root, it is itself owned by
 * root, and every folder from its own up to that root is closed to this process the way the root is. A root proven
 * immutable can still hold a folder this user owns (`/usr/local/bin` under a root-owned `/usr/local`), where a
 * hard link to one of its secrets could be put — and that link would be owned by the user, not by root.
 */
async function hardLinkAllowed(
  options: GuardLinkOptions,
  real: string,
  disk: ClosedDisk & Pick<GuardDisk, 'groups'>,
): Promise<boolean> {
  if (typeof options.hardLinks !== 'object') return false;
  const root = options.hardLinks.allowUnder.roots.find(candidate => within(candidate, real));
  if (root === undefined) return false;
  const groups = await disk.groups();
  if (!(await closedToThisProcess(real, 'file', groups, disk))) return false;
  for (let current = dirname(real); within(root, current); current = dirname(current)) {
    if (!(await closedToThisProcess(current, 'directory', groups, disk))) return false;
    if (current === root || dirname(current) === current) break;
  }
  return true;
}

/** Where a path really is and what is there, once judged outside every home. */
export interface JudgedPath {
  readonly real: string;
  readonly identity: FileIdentity;
}

/**
 * Judges the absolute `path` WITHOUT opening it — for a file or a folder, e.g. before linking to it or before a
 * copy's first write: by name, hop by hop when `hops: 'every'`, by real path, and by identity up to `/`. What it
 * answers can change the moment after, so a caller that then READS must still go through
 * {@link openOutsideStateHomes}.
 */
export async function judgeOutsideStateHomes(
  path: string,
  homes: StateHomes,
  disk: GuardDisk,
  options: GuardLinkOptions = {},
): Promise<Guarded<JudgedPath>> {
  const named = stateHomeByName(homes, path);
  if (named.inside) return refused('state-home', named.home);
  if (options.hops === 'every') {
    const hop = await hopInsideHome(homes, path, disk);
    if (hop.inside) return refused('state-home', hop.home);
  }
  const real = await disk.realpath(path).catch(() => undefined);
  if (real === undefined) return refused('not-found');
  const verdict = await stateHomeOf(homes, real, disk);
  if (verdict.inside) return refused('state-home', verdict.home);
  const identity = await disk.identity(real);
  if (identity === undefined) return refused('not-found');
  // A caller that links to the file reaches its inode however it is named: the open's hard-link rule applies here too.
  if (identity.kind === 'file' && identity.links > 1 && !(await hardLinkAllowed(options, real, disk)))
    return refused('hard-link');
  return { ok: true, value: { real, identity } };
}

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
  const judged = await judgeOutsideStateHomes(path, homes, disk, options);
  if (!judged.ok) return judged;
  const { real, identity: before } = judged.value;
  if (options.inside !== undefined && !within(absolute(options.inside, 'inside'), real)) return refused('outside');
  // Known to be a regular file BEFORE the open, so a device is never opened at all.
  if (before.kind !== 'file') return refused('not-a-file');
  const handle = await disk.openRead(real).catch(() => undefined);
  if (handle === undefined) return refused('changed');
  const problem =
    (await openedProblem(homes, real, handle.identity, disk)) ??
    (handle.identity.links > 1 && !(await hardLinkAllowed(options, real, disk)) ? refused('hard-link') : undefined);
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
      copyToDescriptor: async (descriptor, maxBytes) => {
        if (handle.copyToDescriptor === undefined) throw new Error('this disk cannot copy into a descriptor');
        return await handle.copyToDescriptor(descriptor, maxBytes);
      },
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
   * gives such a path (and only while it is still that file), else empties it. A file that was already there
   * is left as it is. Never removes by a path that could have been swapped.
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
  /**
   * The permission bits of each missing folder above the file, which is then made THROUGH the nearest checked
   * folder's descriptor, one folder at a time, each checked in turn. Without it, a missing folder is `not-found`.
   */
  readonly makeFolders?: number;
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
  // The nearest folder that exists; what is missing below it is made through it.
  let existing = dirname(target);
  const missing: string[] = [];
  let parent = await disk.realpath(existing).catch(() => undefined);
  while (parent === undefined && options.makeFolders !== undefined && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
    parent = await disk.realpath(existing).catch(() => undefined);
  }
  if (parent === undefined) return refused('not-found');
  const inside = options.inside === undefined ? undefined : absolute(options.inside, 'inside');
  if (inside !== undefined && !within(inside, join(parent, ...missing, leaf))) return refused('outside');
  const first = await disk.openDirectory(parent).catch(() => undefined);
  if (first === undefined) return refused('changed');
  let folder: GuardDirectoryHandle = first;
  const close = async (): Promise<void> => await folder.close();
  const folderProblem = await openedFolderProblem(homes, parent, folder.identity, disk);
  if (folderProblem !== undefined) {
    await close();
    return folderProblem;
  }
  for (const segment of missing) {
    const at: string = folder.entryPath(segment) ?? join(parent, segment);
    const made: GuardDirectoryHandle | undefined = await disk
      .mkdir(at, options.makeFolders as number)
      .then(async () => await disk.openDirectory(at))
      .catch(() => undefined);
    await close();
    if (made === undefined) return refused('changed');
    folder = made;
    parent = join(parent, segment);
    const problem = await openedFolderProblem(homes, parent, made.identity, disk);
    if (problem !== undefined) {
      await close();
      return problem;
    }
  }
  const real = join(parent, leaf);
  const checked = folder;
  const through = checked.entryPath(leaf) ?? real;
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
    if (!created) return;
    const entry = checked.entryPath(leaf);
    if (entry !== undefined && same(opened.identity, await disk.identity(entry))) await disk.unlink(entry);
    else await opened.truncate();
  };
  const problem =
    opened.identity.kind !== 'file'
      ? refused('not-a-file')
      : opened.identity.links > 1
        ? refused('hard-link')
        : await openedProblem(homes, real, opened.identity, disk);
  if (problem !== undefined) {
    await discard().catch(() => undefined);
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

/** Why an opened folder is not the one at `place` (a real path): not a folder, or not the folder there now. */
async function placedFolderProblem(
  place: string,
  opened: FileIdentity,
  disk: Pick<GuardDisk, 'realpath' | 'identity'>,
): Promise<{ readonly ok: false; readonly rule: GuardRule } | undefined> {
  if (opened.kind !== 'directory') return refused('not-a-file');
  const again = await disk.realpath(place).catch(() => undefined);
  return again !== place || !same(opened, await disk.identity(place)) ? refused('changed') : undefined;
}

/** What the folder primitives ask of the disk: the guard's own calls by path, plus the writes a folder step makes. */
export type FolderDisk = Pick<
  GuardDisk,
  'realpath' | 'identity' | 'openDirectory' | 'mkdir' | 'list' | 'unlink' | 'readlink'
> & {
  /** Removes the EMPTY folder at `path` (`rmdir`), which never follows a link. */
  rmdir(path: string): Promise<void>;
  /** Renames `from` to `to` (neither final step is followed). */
  rename(from: string, to: string): Promise<void>;
  /** Makes a symbolic link at `path` leading to `target`, failing when the name is taken. */
  symlink(target: string, path: string): Promise<void>;
  /** Gives the entry at `from` a second name `to` (a hard link), failing when `to` is taken. */
  linkEntry(from: string, to: string): Promise<void>;
  /** Opens the file at `path` ({@link FileOpening}) and hands back its raw descriptor. */
  openFile(path: string, how: FileOpening, mode: number): Promise<number>;
  /** Descriptor paths were asked for and this host has none (Linux without `/proc`). */
  readonly missingDescriptorPaths?: boolean;
  /** Descriptor calls were asked for and could not be loaded (macOS without its C calls): why. */
  readonly descriptorCallsUnavailable?: string;
};

/** A checked folder whose place no longer leads to it, so nothing more is reached through it by path. */
export class FolderChangedError extends Error {
  constructor(readonly folder: string) {
    super(`refusing to write in ${folder}: it was replaced after it was checked`);
    this.name = 'FolderChangedError';
  }
}

/**
 * A folder the guard opened and checked, so every entry below it is reached THROUGH it rather than through
 * whatever its path names a moment later.
 *
 * - **Linux**: through `/proc/self/fd/N/<leaf>` (the handle's `entryPath`).
 * - **macOS**: through the handle's descriptor-relative calls (`at`): the descriptor is installed as the working
 *   directory for one synchronous call on a relative name, proven there first.
 * - **Neither** (a disk without either): by the real path, once the folder is proven still at it — same real path,
 *   same device and inode — or {@link FolderChangedError}. A swap timed between that proof and the step can still
 *   redirect it, so `anchored` is false and a caller that moves or removes a name refuses to there.
 *
 * {@link GuardedFolder.entry} and {@link GuardedFolder.self} answer a PATH, for reads that only compare or hash
 * (and for showing). Everything that changes the disk, or reads what is then handed on, uses the methods.
 */
export interface GuardedFolder {
  /** Its real path when it was checked. */
  readonly path: string;
  readonly identity: FileIdentity;
  /** Whether its entries are reached THROUGH the descriptor (see above). */
  readonly anchored: boolean;
  /** A path that reaches the ONE entry `leaf` in this folder (a name with no `/`). */
  entry(leaf: string): Promise<string>;
  /** A path that reaches the folder itself. */
  self(): Promise<string>;
  /** The entry `leaf` itself (`lstat`), never followed; `undefined` when nothing is there. */
  describe(leaf: string): Promise<FileIdentity | undefined>;
  /** The names in this folder. */
  list(): Promise<readonly string[]>;
  /** Makes the folder `leaf` (not recursive; a name already taken fails with `EEXIST`). */
  mkdir(leaf: string, mode: number): Promise<void>;
  unlink(leaf: string): Promise<void>;
  rmdir(leaf: string): Promise<void>;
  /** Renames `from` to `to`, both in this folder. */
  rename(from: string, to: string): Promise<void>;
  /** Renames `fromLeaf` here to `toLeaf` in the folder `into` (which may be this one). */
  renameInto(fromLeaf: string, into: GuardedFolder, toLeaf: string): Promise<void>;
  symlink(target: string, leaf: string): Promise<void>;
  /** Where the symbolic link `leaf` points, as written. */
  readlink(leaf: string): Promise<string>;
  /** Hard-links `fromLeaf` in `from` as `leaf` here; a name already taken fails with `EEXIST`. */
  link(from: GuardedFolder, fromLeaf: string, leaf: string): Promise<void>;
  /** A raw descriptor on the file `leaf` (see {@link FolderDisk.openFile}); the caller closes it. */
  openFile(leaf: string, how: FileOpening, mode?: number): Promise<number>;
  /** Sets its permission bits through the descriptor (`fchmod`). */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface GuardFolderOptions {
  /** The permission bits of each missing folder, made THROUGH its checked parent. Without it a missing one is `not-found`. */
  readonly make?: number;
}

const isOneEntry = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes(sep) && !name.includes('\0');

const codeOf = (error: unknown): string | undefined => (error as { readonly code?: string } | undefined)?.code;

/** Each checked folder's own handle, for the one call that needs two of them (`link`). */
const handles = new WeakMap<GuardedFolder, GuardDirectoryHandle>();

function checkedFolder(handle: GuardDirectoryHandle, place: string, disk: FolderDisk): GuardedFolder {
  const proven = async (): Promise<void> => {
    if ((await placedFolderProblem(place, handle.identity, disk)) !== undefined) throw new FolderChangedError(place);
  };
  const entry = async (leaf: string): Promise<string> => {
    if (!isOneEntry(leaf)) throw new TypeError(`name one entry of the folder, not a path: ${leaf}`);
    const through = handle.entryPath(leaf);
    if (through !== undefined) return through;
    await proven();
    return join(place, leaf);
  };
  const leafOf = (leaf: string): string => {
    if (!isOneEntry(leaf)) throw new TypeError(`name one entry of the folder, not a path: ${leaf}`);
    return leaf;
  };
  const at = handle.at;
  const folder: GuardedFolder = {
    path: place,
    identity: handle.identity,
    anchored: at !== undefined || handle.entryPath('.') !== undefined,
    entry,
    self: async () => {
      const through = handle.entryPath('.');
      if (through !== undefined) return through;
      await proven();
      return place;
    },
    describe: async leaf => (at ? await at.identity(leafOf(leaf)) : await disk.identity(await entry(leaf))),
    list: async () => (at ? await at.list() : await disk.list(await folder.self())),
    mkdir: async (leaf, mode) => (at ? await at.mkdir(leafOf(leaf), mode) : await disk.mkdir(await entry(leaf), mode)),
    unlink: async leaf => (at ? await at.unlink(leafOf(leaf)) : await disk.unlink(await entry(leaf))),
    rmdir: async leaf => (at ? await at.rmdir(leafOf(leaf)) : await disk.rmdir(await entry(leaf))),
    rename: async (from, to) =>
      at ? await at.rename(leafOf(from), leafOf(to)) : await disk.rename(await entry(from), await entry(to)),
    renameInto: async (fromLeaf, into, toLeaf) => {
      const target = handles.get(into);
      if (at !== undefined && target?.at !== undefined)
        return await at.renameInto(leafOf(fromLeaf), target, leafOf(toLeaf));
      await disk.rename(await entry(fromLeaf), await into.entry(toLeaf));
    },
    symlink: async (target, leaf) =>
      at ? await at.symlink(target, leafOf(leaf)) : await disk.symlink(target, await entry(leaf)),
    readlink: async leaf => (at ? await at.readlink(leafOf(leaf)) : await disk.readlink(await entry(leaf))),
    link: async (from, fromLeaf, leaf) => {
      const source = handles.get(from);
      if (at !== undefined && source?.at !== undefined)
        return await source.at.link(leafOf(fromLeaf), handle, leafOf(leaf));
      await disk.linkEntry(await from.entry(fromLeaf), await entry(leaf));
    },
    openFile: async (leaf, how, mode = 0o600) =>
      at ? await at.openFile(leafOf(leaf), how, mode) : await disk.openFile(await entry(leaf), how, mode),
    chmod: async mode => await handle.chmod(mode),
    close: async () => await handle.close(),
  };
  handles.set(folder, handle);
  return folder;
}

/** The home a folder at `place` IS by identity while not being at that home's own place (a bind mount), if any. */
function boundHome(homes: StateHomes | undefined, place: string, entry: FileIdentity): string | undefined {
  if (homes === undefined) return undefined;
  const home = homes.homes.find(directory => same(directory, entry));
  if (home !== undefined) return home.real === place ? undefined : home.named;
  const pin = homes.pinned.find(key => same(key, entry));
  return pin === undefined || pin.place === place ? undefined : (homes.homes[0]?.named ?? place);
}

/**
 * Opens the folder `leaf` inside the checked `parent`, THROUGH it, without following a link: a link there is
 * `link`, anything else that is not a folder is `not-a-folder`, and a folder that is a home (or a pinned key) by
 * identity anywhere but at that home's own place — a bind mount — is `state-home`. With `make`, a missing folder is
 * made through the parent first (one somebody else made in the meantime is opened and checked like any other).
 */
export async function openFolderBelow(
  parent: GuardedFolder,
  leaf: string,
  homes: StateHomes | undefined,
  disk: FolderDisk,
  options: GuardFolderOptions = {},
): Promise<Guarded<GuardedFolder>> {
  const place = join(parent.path, leaf);
  const through = handles.get(parent)?.at;
  try {
    let entry = await parent.describe(leaf);
    if (entry === undefined) {
      if (options.make === undefined) return refused('not-found');
      await parent.mkdir(leaf, options.make).catch((error: unknown) => {
        if (codeOf(error) !== 'EEXIST') throw error;
      });
      entry = await parent.describe(leaf);
      if (entry === undefined) return refused('changed');
    }
    if (entry.kind === 'link') return refused('link');
    if (entry.kind !== 'directory') return refused('not-a-folder');
  } catch (error) {
    // The parent, reached by path, is no longer where it was proven.
    if (error instanceof FolderChangedError) return refused('changed');
    throw error;
  }
  // Opened through the parent: by its descriptor-relative call where it has one, else by the path through it.
  const handle = await (
    through === undefined
      ? parent.entry(leaf).then(async at => await disk.openDirectory(at))
      : through.openDirectory(leaf)
  ).catch(() => undefined);
  if (handle === undefined) return refused('changed');
  // Reached by path (no descriptor paths here): proven to be the folder at its real place, like every later use.
  const problem =
    handle.at === undefined && handle.entryPath('.') === undefined
      ? await placedFolderProblem(place, handle.identity, disk)
      : undefined;
  const home = boundHome(homes, place, handle.identity);
  if (problem !== undefined || home !== undefined) {
    await handle.close();
    return problem ?? refused('state-home', home);
  }
  return { ok: true, value: checkedFolder(handle, place, disk) };
}

/** The home whose name (as configured or real) holds `path` most closely, unless an opening holds it. */
function homeHolding(
  homes: StateHomes,
  path: string,
): { readonly home: KnownDirectory; readonly name: string } | undefined {
  const names = (directory: KnownDirectory): readonly string[] => [directory.named, directory.real];
  if (homes.openings.some(opening => names(opening).some(name => within(name, path)))) return undefined;
  let holding: { readonly home: KnownDirectory; readonly name: string } | undefined;
  for (const home of homes.homes)
    for (const name of names(home))
      if (within(name, path) && (holding === undefined || name.length > holding.name.length)) holding = { home, name };
  return holding;
}

/**
 * Opens the absolute folder `path` to WRITE BELOW IT, checked, so every later step goes through the handle.
 *
 * - **Inside a home by name** (a runtime's folder lives in the state home by design): reached from that home's
 *   real path one folder at a time, each opened THROUGH the one above WITHOUT FOLLOWING A LINK. A link anywhere
 *   below the home is `link`, so a folder a harness swapped for a link into the home's secrets is never entered.
 * - **Anywhere else** (a host `~/.claude`, which may well be a link into a dotfiles checkout): links are followed
 *   to find where it lands, which must be outside every home by real path and identity. That real path is then
 *   walked from `/` the same way, through each folder's descriptor without following a link, so the handle is
 *   on the folder the check was about; a link met on the way is `changed`.
 *
 * Either way, a folder that is a home by identity anywhere but at its own place (a bind mount) is `state-home`,
 * and with `make` the missing folders are made through their checked parents. `homes` absent judges no home and
 * still hands back a checked handle.
 */
export async function openFolderOutsideStateHomes(
  path: string,
  homes: StateHomes | undefined,
  disk: FolderDisk,
  options: GuardFolderOptions = {},
): Promise<Guarded<GuardedFolder>> {
  const target = absolute(path, 'the folder');
  const holding = homes === undefined ? undefined : homeHolding(homes, target);
  let start: string;
  let below: readonly string[];
  // Outside the homes, how many of `below` are folders already there (the rest are made).
  let present = 0;
  if (holding !== undefined) {
    start = holding.home.real;
    below = relative(holding.name, target)
      .split(sep)
      .filter(segment => segment !== '');
  } else {
    let existing = target;
    const missing: string[] = [];
    let real = await disk.realpath(existing).catch(() => undefined);
    while (real === undefined && options.make !== undefined && dirname(existing) !== existing) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
      real = await disk.realpath(existing).catch(() => undefined);
    }
    if (real === undefined) return refused('not-found');
    if (homes !== undefined) {
      const verdict = await stateHomeOf(homes, real, disk);
      if (verdict.inside) return refused('state-home', verdict.home);
    }
    if ((await disk.identity(real))?.kind !== 'directory') return refused('not-a-folder');
    // Walked from the root, one folder at a time through the one above and without following a link, exactly
    // like the in-home branch: opening `real` by path would follow every folder above it, and a check made by
    // path afterwards can be satisfied by flipping one of them back and forth in the right order. `real` is
    // canonical, so a link met on the way means it changed.
    const segments = real.split(sep).filter(segment => segment !== '');
    start = sep;
    below = [...segments, ...missing];
    present = segments.length;
  }
  const top = await disk.openDirectory(start).catch(() => undefined);
  if (top === undefined) return refused('changed');
  const topProblem = holding === undefined || same(holding.home, top.identity) ? undefined : refused('changed');
  if (topProblem !== undefined) {
    await top.close();
    return topProblem;
  }
  let folder = checkedFolder(top, start, disk);
  for (const [index, segment] of below.entries()) {
    const existing = index < present;
    let next: Guarded<GuardedFolder>;
    try {
      next = await openFolderBelow(folder, segment, homes, disk, existing ? {} : options);
    } finally {
      await folder.close();
    }
    // A folder of the canonical path that is now a link, or gone, is one that changed since it was resolved.
    if (!next.ok) return existing && (next.rule === 'link' || next.rule === 'not-found') ? refused('changed') : next;
    folder = next.value;
  }
  return { ok: true, value: folder };
}

/**
 * Removes the entry `leaf` of the checked `folder` — a file, a link (never what it points at) or a whole folder —
 * WITHOUT EVER FOLLOWING A LINK: each folder in the tree is opened through the one above it with no-follow
 * (`openFolderBelow`) and emptied through that handle, so a sub-folder swapped for a link into a home while the
 * removal runs is unlinked as the link it now is, and nothing it points at is touched. A folder that is a home by
 * identity (a bind mount) throws. Already gone is done.
 */
export async function removeEntryWithin(
  folder: GuardedFolder,
  leaf: string,
  homes: StateHomes | undefined,
  disk: FolderDisk,
): Promise<void> {
  const unlinked = async (): Promise<void> =>
    await folder.unlink(leaf).catch((error: unknown) => {
      if (codeOf(error) !== 'ENOENT') throw error;
    });
  // `unlink` first: it never follows a link, and it refuses a folder (`EISDIR`; `EPERM` on macOS) — so one call
  // removes every file and link, and only a folder is opened and walked.
  try {
    return await unlinked();
  } catch (error) {
    if (codeOf(error) !== 'EISDIR' && codeOf(error) !== 'EPERM') throw error;
  }
  const opened = await openFolderBelow(folder, leaf, homes, disk);
  if (!opened.ok) {
    if (opened.rule === 'not-found') return;
    // A link (or a file) put where the folder was since it was looked at: only the name is removed.
    if (opened.rule === 'link' || opened.rule === 'not-a-folder') return await unlinked();
    throw new Error(`refusing to remove ${join(folder.path, leaf)}: the state-home guard refused it (${opened.rule})`);
  }
  const child = opened.value;
  try {
    for (const name of await child.list()) await removeEntryWithin(child, name, homes, disk);
  } finally {
    await child.close();
  }
  await folder.rmdir(leaf);
}

export interface GuardTreeOptions extends GuardLinkOptions {
  /** The most bytes one file may hold. */
  readonly maxFileBytes: number;
  /** The most bytes the whole copy may write. */
  readonly maxTotalBytes: number;
  /** The most entries — files AND folders — the copy may make. */
  readonly maxFiles: number;
}

/**
 * Copies the file or folder at `source` to `destination`, following every link (like `cp -RL`) and keeping each
 * file's permission bits. EVERY file and folder is judged where it really lands, and each file is read through
 * {@link openOutsideStateHomes}; the first refusal stops the copy (what was copied stays, for the caller to
 * remove).
 *
 * WRITTEN THROUGH CHECKED FOLDERS. The destination's folder is opened by its real path and checked, then the copy
 * goes on as {@link copyTreeIntoFolder}. Without descriptor paths a folder swapped after that check can still
 * receive a NEW entry (never an overwrite), the declared residue of path writes.
 */
export async function copyTreeOutsideStateHomes(
  source: string,
  destination: string,
  homes: StateHomes,
  disk: GuardDisk & FolderDisk,
  options: GuardTreeOptions,
): Promise<Guarded<{ readonly files: number; readonly bytes: number }>> {
  const target = absolute(destination, 'the destination');
  const parentReal = await disk.realpath(dirname(target)).catch(() => undefined);
  if (parentReal === undefined) return refused('not-found');
  const parent = await disk.openDirectory(parentReal).catch(() => undefined);
  if (parent === undefined) return refused('changed');
  const folder = checkedFolder(parent, parentReal, disk);
  try {
    const parentProblem = await placedFolderProblem(parentReal, parent.identity, disk);
    if (parentProblem !== undefined) return parentProblem;
    return await copyTreeIntoFolder(source, folder, basename(target), homes, disk, options);
  } finally {
    await folder.close();
  }
}

/**
 * Copies `source` as the new entry `leaf` of the checked `folder`, as {@link copyTreeOutsideStateHomes} describes:
 * every entry is made THROUGH an open folder (its descriptor where the platform gives one), each folder the copy
 * makes is opened through its parent without following a link before anything is written into it, and its mode is
 * set through that descriptor.
 *
 * BOUNDED. A folder met twice anywhere in the copy is a `loop` (a link graph can otherwise multiply one folder
 * without end), more than `maxFiles` entries — files and folders — is `too-many`, and more than `maxTotalBytes`
 * written is `too-many` too.
 */
export async function copyTreeIntoFolder(
  source: string,
  folder: GuardedFolder,
  leaf: string,
  homes: StateHomes,
  disk: GuardDisk & FolderDisk,
  options: GuardTreeOptions,
): Promise<Guarded<{ readonly files: number; readonly bytes: number }>> {
  const totals = { files: 0, bytes: 0, entries: 0 };
  const seen = new Set<string>();
  const links: GuardLinkOptions = {
    ...(options.hardLinks === undefined ? {} : { hardLinks: options.hardLinks }),
    ...(options.hops === undefined ? {} : { hops: options.hops }),
  };
  type Refusal = { readonly ok: false; readonly rule: GuardRule; readonly home?: string };
  const copy = async (from: string, parent: GuardedFolder, name: string): Promise<Refusal | undefined> => {
    const real = await disk.realpath(from).catch(() => undefined);
    if (real === undefined) return refused('not-found');
    const entry = await disk.identity(real);
    if (totals.entries >= options.maxFiles) return refused('too-many');
    totals.entries += 1;
    if (entry?.kind !== 'directory') {
      const opened = await openOutsideStateHomes(from, homes, disk, links);
      if (!opened.ok) return opened;
      try {
        const left = options.maxTotalBytes - totals.bytes;
        if (opened.value.identity.size > left) return refused('too-many');
        const max = Math.min(options.maxFileBytes, left);
        const mode = opened.value.identity.mode;
        // Made through the folder, exclusively and never through a link: by its descriptor-relative call where it has
        // one (and filled through the new file's descriptor), else at the path through it.
        const through = handles.get(parent)?.at;
        if (through === undefined) totals.bytes += await opened.value.copyTo(await parent.entry(name), max, mode);
        else totals.bytes += await opened.value.copyToDescriptor(await parent.openFile(name, 'new', mode), max);
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
    if (seen.has(key)) return refused('loop');
    seen.add(key);
    // Writable while it is filled (a Nix store folder is 0555), then given its own mode, as `cp` does. Made here,
    // so a name already taken is somebody else's: `EEXIST` refuses rather than writing into theirs.
    const made = await parent.mkdir(name, entry.mode | 0o700).catch(() => 'changed' as const);
    if (made === 'changed') return refused('changed');
    const opened = await openFolderBelow(parent, name, homes, disk);
    if (!opened.ok) return opened.rule === 'link' || opened.rule === 'not-found' ? refused('changed') : opened;
    const child = opened.value;
    try {
      for (const below of await disk.list(real)) {
        const problem = await copy(join(real, below), child, below);
        if (problem !== undefined) return problem;
      }
      await child.chmod(entry.mode);
    } finally {
      await child.close();
    }
    return undefined;
  };
  const problem = await copy(absolute(source, 'the source'), folder, leaf);
  return problem ?? { ok: true, value: { files: totals.files, bytes: totals.bytes } };
}
