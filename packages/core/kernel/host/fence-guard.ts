import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { BEFORE_SUFFIX, insideFence, internalRootFolder } from '../contract/home.ts';
import { ApiError } from '../contract/http.ts';
import type { FileIdentity, HostFs } from './adapters/node-fs.ts';
import {
  identityKey,
  type IndexInput,
  type PrivateIndex,
  type PrivateSnapshot,
  privateIndexOf,
  recheckIntervalOf,
  type TruncationWatcher,
} from './fence-index.ts';
import { IDENTITY_FILE } from './identity.ts';
import { INTERNAL_ROOT_FOLDERS } from './internal-roots.ts';

/**
 * The fence's own guard (§7.7, §9.3, S40–S49), copied from today's state-home guard
 * (`packages/fleet/src/lib/state-home-guard.ts`) and narrowed to what the kernel's roots ask: a path is judged
 * NORMALIZED, as named, once resolved, and by IDENTITY — every folder above its real path is compared by device and
 * inode with the home and every `-before-` folder, which catches a bind mount or alias a path string would miss.
 * What is opened is then proven to be what was checked (same real path, same device and inode), so a link or a file
 * swapped in between reaches nothing. Every doubt fails closed.
 */

/** Today's `absolute`: an absolute path, normalized — `.` and `..` segments and doubled slashes are gone. */
export function absolute(path: string, what: string): string {
  if (!isAbsolute(path)) throw new TypeError(`${what} must be an absolute path: ${path}`);
  return normalize(path).replace(/(.)\/+$/, '$1');
}

/** Today's `within`: `path` is `directory` or below it ('..' only as a whole first segment). */
export const within = (directory: string, path: string): boolean => {
  const from = relative(directory, path);
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};

export const same = (a: { readonly device: bigint; readonly inode: bigint }, b: FileIdentity | undefined): boolean =>
  b !== undefined && a.device === b.device && a.inode === b.inode;

/** A set of identity keys that is only ever asked "is this one in it?": what the guards need, however it is held. */
interface KeyLookup {
  readonly has: (key: string) => boolean;
  readonly size: number;
}

/** The fence by name (as configured and as resolved) and by identity. */
export interface Fence {
  readonly named: string;
  readonly real: string;
  /**
   * The real paths of the home's `state` and `config` folders that are there: today's homes are
   * `[home, state, config]`, each by its real path, so a folder linked out of the home is fenced by name wherever it
   * lives.
   */
  readonly places: readonly string[];
  /** Every identity the fence holds. Read on demand: building it costs as many entries as there are places. */
  readonly identities: readonly { readonly device: bigint; readonly inode: bigint }[];
  /** {@link identities} as comparable keys, for a lookup that does not grow with how many places are held. */
  readonly keys: KeyLookup;
  /**
   * The devices of the private trees whose members were not all indexed: an entry on one of them cannot be proven
   * not to be an alias of an unindexed member, so it is refused ({@link fencedReal}).
   */
  readonly closed: ReadonlySet<bigint>;
}

/**
 * The home's key files and folders, relative to the home: today's `stateHomeFence(home).pinned`
 * (`packages/fleet/src/lib/state-home-fence.ts`) with the daemon's identity key at the place the kernel keeps it
 * ({@link IDENTITY_FILE}, the one owner of that path: nothing here spells it). Each is recognised by IDENTITY wherever a walk meets it, so
 * one bind-mounted or hard-linked alone into a work folder is refused under any name. The list is kept whole: its
 * v4 places (`fleet`, `fleet/homes`, `state/sessions`) still pin a home that holds them and cost nothing where absent;
 * where 5.0 keeps those folders is {@link internalRootPins}.
 */
export const PINNED_KEY_PATHS: readonly string[] = [
  'api-token',
  'api-warden-token',
  'tmux.sock',
  ...['secrets.key', 'secrets.json', 'mcp-oauth-secrets.json', 'login-secrets.json', 'passkeys.json'].map(
    name => `state/${name}`,
  ),
  IDENTITY_FILE,
  'fleet',
  'fleet/homes',
  'state/sessions',
];

/**
 * The 5.0 home's private folders, pinned like the key paths: every internal root the kernel makes for a plugin
 * (`state/<plugin>/<root>`, {@link internalRootFolder}: Ferrets' `state/ferrets/sessions` holds each ferret's
 * `environment.json` and turns, a harness's `agent-homes` its sign-in), for every plugin folder `state` holds. It is
 * today's `state/sessions` and `fleet/homes` pin at the place 5.0 keeps them, derived from the kernel's own layout so
 * the pin and the base the kernel serves can never name two places. A `-before-` folder is fenced whole already.
 */
export function internalRootPins(stateEntries: readonly string[]): readonly string[] {
  return stateEntries
    .filter(plugin => !BEFORE_SUFFIX.test(plugin))
    .flatMap(plugin => INTERNAL_ROOT_FOLDERS.map(root => internalRootFolder(plugin, root)));
}

/**
 * The kept index of the places the plugins declared private ({@link privateIndexOf}): the identity of each declared
 * place and, for a folder, of what it holds to a bounded depth (`credentials/<id>/auth.json`, a browser profile's
 * cookies, a ferret's `environment.json`), so a member bind mounted or linked out under another name is held as well.
 * One index per disk, home, declared list and look interval, shared by every root of every plugin.
 */
const INDEXES = new WeakMap<HostFs, Map<string, PrivateIndex>>();

function indexOf(
  fs: HostFs,
  real: string,
  privateFiles: readonly string[],
  recheckMs: number,
  watcher?: TruncationWatcher,
): PrivateIndex {
  const kept = INDEXES.get(fs) ?? new Map<string, PrivateIndex>();
  INDEXES.set(fs, kept);
  const key = JSON.stringify([real, privateFiles, recheckIntervalOf(recheckMs)]);
  const found = kept.get(key);
  const index =
    found ??
    privateIndexOf(
      fs,
      real,
      {
        pins: stateEntries => [...PINNED_KEY_PATHS, ...internalRootPins(stateEntries)],
        private: privateFiles,
      } satisfies IndexInput,
      { recheckMs },
    );
  if (found === undefined) kept.set(key, index);
  // Whoever asks may watch: the host hands every root the one watcher, so a truncation is told once, to it.
  if (watcher !== undefined) index.watch(watcher);
  return index;
}

/**
 * Whether `path` (segments below `state/`) is, holds, or is held by one of the composed private places: the same `*`
 * grammar the index reads (one whole segment). The segments are compared as far as both go, so the place itself, a
 * file inside a private folder, the folder a `*` member lives in and the plugin's own folder above a place all match.
 */
export function touchesPrivate(privateFiles: readonly string[], relativeToState: string): boolean {
  const path = ['state', ...relativeToState.split('/').filter(segment => segment !== '')];
  return privateFiles.some(place => {
    const segments = place.split('/');
    for (let at = 0; at < Math.min(segments.length, path.length); at += 1) {
      const wanted = segments[at];
      if (wanted !== '*' && wanted !== path[at]) return false;
    }
    return true;
  });
}

/**
 * A private place was just CREATED (or replaced) at `relativeToState` (`<plugin>/<path>` below the home's `state`): looks
 * at the index again before the create is reported done, so a first write has no window in which the new file is not
 * yet pinned by identity and a root would let an alias of it through. A path no place touches costs nothing. The index
 * is the very one every root of the host reads (same disk, home, list and look interval), so the next root call
 * holds the file. A look that fails rejects `ApiError(503, …, 'private_unpinned')`: the file is on disk, but no root
 * opens anything until a look succeeds, because every later answer looks again and throws too.
 */
export async function pinCreated(
  fs: HostFs,
  home: string,
  privateFiles: readonly string[],
  relativeToState: string,
  recheckMs = 0,
  watcher?: TruncationWatcher,
): Promise<void> {
  if (!touchesPrivate(privateFiles, relativeToState)) return;
  const plugin = relativeToState.split('/')[0] ?? '';
  try {
    const real = await fs.realpath(absolute(home, 'the home'));
    await indexOf(fs, real, privateFiles, recheckMs, watcher).renew();
  } catch (error) {
    throw new ApiError(503, unpinnedSentence(plugin, error), 'private_unpinned');
  }
}

/** The sentence for a look that could not be made: the errno code at most, never the message (it carries a path). */
export function unpinnedSentence(plugin: string, error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  const reason = typeof code === 'string' && /^E[A-Z0-9]{1,15}$/u.test(code) ? code : 'the disk could not be read';
  return `A private file of ${plugin} could not be pinned, so no folder is opened until it can be: ${reason}.`;
}

/** What a snapshot's places are as lookups, made once per snapshot: every owner's fence and every guard reads them. */
interface SnapshotKeys {
  readonly keys: ReadonlySet<string>;
  readonly closed: ReadonlySet<bigint>;
}
const SNAPSHOT_KEYS = new WeakMap<PrivateSnapshot, SnapshotKeys>();

function keysOf(snapshot: PrivateSnapshot): SnapshotKeys {
  const kept = SNAPSHOT_KEYS.get(snapshot);
  if (kept !== undefined) return kept;
  const made = {
    keys: new Set(snapshot.places.map(place => place.key)),
    closed: new Set(snapshot.closed.flatMap(tree => [...tree.devices])),
  };
  SNAPSHOT_KEYS.set(snapshot, made);
  return made;
}

/** The folders of the home that today's fence holds beside the home itself (`NodeStateHomes([home, state, config])`). */
const HOME_FOLDERS: readonly string[] = ['state', 'config'];

/** A fence's absent entry: nothing there, or nothing a folder could be under. Anything else is a doubt. */
const isAbsent = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * The fence of `home`: its real path, the real path and identity of its `state` and `config` folders (today's homes
 * `[home, state, config]`, each resolved to where it really is, so one linked or bind-mounted out of the home is held
 * wherever it lives), and the identity of the home, of every `<home>-before-*` and `state/<id>-before-*` folder, and of
 * each pinned key file and folder ({@link PINNED_KEY_PATHS}) and each private place the plugins declared
 * (`privateFiles`, the composed list of every manifest's `privacy.private`) that is there — the entry itself, never followed, as
 * today's `resolveStateHomes` takes it. A home that cannot be resolved, a `state` or `config` that is there but cannot
 * be resolved or is not a folder, or a key path that cannot be looked at, fails closed (throws); one that is absent is
 * left out.
 */
export async function fenceOf(
  fs: HostFs,
  home: string,
  privateFiles: readonly string[] = [],
  recheckMs = 0,
  watcher?: TruncationWatcher,
): Promise<Fence> {
  const named = absolute(home, 'the home');
  const real = await fs.realpath(named);
  const folders = [real];
  const parent = dirname(named);
  const name = basename(named);
  for (const entry of await fs.list(parent))
    if (entry.startsWith(`${name}-before-`) && BEFORE_SUFFIX.test(entry)) folders.push(join(parent, entry));
  const stateEntries = await fs.list(join(real, 'state'));
  for (const entry of stateEntries) if (BEFORE_SUFFIX.test(entry)) folders.push(join(real, 'state', entry));
  const identities: FileIdentity[] = [];
  for (const folder of folders) {
    const identity = await fs.identity(folder);
    if (folder === real && identity?.kind !== 'directory') throw new Error('the home cannot be identified');
    if (identity !== undefined) identities.push(identity);
  }
  const places: string[] = [];
  for (const folder of HOME_FOLDERS) {
    const place = await fs.realpath(join(real, folder)).catch((error: unknown) => {
      if (isAbsent(error)) return undefined;
      throw error;
    });
    if (place === undefined) continue;
    // The folder itself, followed: a link's target is what holds the files, so its identity is the target's.
    const identity = await fs.identity(place);
    if (identity?.kind !== 'directory') throw new Error(`the home's ${folder} cannot be identified`);
    places.push(place);
    identities.push(identity);
  }
  const snapshot = await indexOf(fs, real, privateFiles, recheckMs, watcher).snapshot();
  const own = new Set(identities.map(identityKey));
  const indexed = keysOf(snapshot);
  return {
    named,
    real,
    places,
    // The private places can be thousands: this list is built only for a caller that asks for it, never per answer.
    get identities() {
      return [...identities, ...snapshot.places.map(place => ({ device: place.device, inode: place.inode }))];
    },
    keys: { has: key => own.has(key) || indexed.keys.has(key), size: own.size + indexed.keys.size },
    closed: indexed.closed,
  };
}

/**
 * Inside the fence by NAME: the configured home or its real path (`insideFence` covers every `-before-` folder), or
 * the real path of its `state` or `config` folder (today's `stateHomeByName`: each home as configured and as resolved).
 */
export function fencedByName(fence: Fence, path: string): boolean {
  const target = absolute(path, 'the path');
  return (
    insideFence(fence.named, target) ||
    insideFence(fence.real, target) ||
    fence.places.some(place => within(place, target))
  );
}

/**
 * Today's `stateHomeOf`: by name, then every folder from `real` up to `/` by device and inode. A folder that cannot be
 * read fails closed.
 */
export async function fencedReal(fs: HostFs, fence: Fence, real: string): Promise<boolean> {
  if (fencedByName(fence, real)) return true;
  for (let current = absolute(real, 'the path'), first = true; ; current = dirname(current), first = false) {
    const entry = await fs.identity(current).catch(() => undefined);
    if (entry === undefined) return true;
    if (fence.keys.has(identityKey(entry))) return true;
    // A private tree that was not indexed whole fails closed: this entry cannot be proven not to be an alias of a member.
    if (first && fence.closed.has(entry.device)) return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * What a root that is NOT an owner's must still refuse (§7.7): the home's private places — the key paths, every plugin's
 * declared private files and every other plugin's internal root folders — by name and by IDENTITY, so a file bind
 * mounted or hard linked into a plugin's own folder under any name is refused (the hard link is already refused by
 * link count; a bind mount keeps one link, so identity is the only thing that sees it). A place the root itself holds
 * (its base, a folder above it, or anything below it) is the root's own and is left out.
 */
export interface PrivateGuard {
  readonly keys: KeyLookup;
  /**
   * The devices of the private trees that were not indexed whole (a budget was reached) and are not the root's own: an
   * entry on one of them cannot be proven not to be an alias of an unindexed member, so it is held. An entry on
   * another device is proven not to be one (an alias keeps its source's device).
   */
  readonly closed: ReadonlySet<bigint>;
}

const GUARDS = new WeakMap<PrivateSnapshot, Map<string, PrivateGuard>>();

/**
 * Two places are nested when either holds the other, by name: the root's own folder and what lives in it. Both are
 * normalized absolute real paths (the index joins them, `absolute` normalizes the base), so a prefix test is exact and
 * does not resolve a path per place: this runs over every place the index holds.
 */
const nested = (a: string, b: string): boolean => {
  const below = (outer: string, inner: string): boolean =>
    inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  return below(a, b) || below(b, a);
};

/**
 * The guard for a root whose real base is `base`: the identity of each private place that is there, except the
 * places that are the root's own. Recomputed on every ask (a file replaced by a rename has a new inode). A place that
 * cannot be looked at fails closed (throws), as the fence does.
 */
export async function privateGuardOf(
  fs: HostFs,
  home: string,
  base: string,
  privateFiles: readonly string[],
  recheckMs = 0,
  watcher?: TruncationWatcher,
): Promise<PrivateGuard> {
  const real = await fs.realpath(absolute(home, 'the home'));
  const snapshot = await indexOf(fs, real, privateFiles, recheckMs, watcher).snapshot();
  // One guard per snapshot and base: the kept snapshot is the same object until the places change.
  const bases = GUARDS.get(snapshot) ?? new Map<string, PrivateGuard>();
  GUARDS.set(snapshot, bases);
  const kept = bases.get(base);
  if (kept !== undefined) return kept;
  const indexed = keysOf(snapshot);
  // Almost every root holds none of the places: then the snapshot's own set is the guard's, not a copy of it.
  const theirs = snapshot.places.some(place => nested(place.path, base));
  const keys = theirs
    ? new Set(snapshot.places.filter(place => !nested(place.path, base)).map(place => place.key))
    : indexed.keys;
  const made = {
    keys,
    closed: new Set(snapshot.closed.filter(tree => !nested(tree.path, base)).flatMap(tree => [...tree.devices])),
  };
  bases.set(base, made);
  return made;
}

/**
 * Whether `real` is a private place or inside one, by identity: the entry itself first, then every folder up to and
 * including the root's `base`, as {@link fencedReal} walks. A path that cannot be looked at is refused.
 */
export async function privatelyHeld(fs: HostFs, guard: PrivateGuard, real: string, base: string): Promise<boolean> {
  if (guard.keys.size === 0 && guard.closed.size === 0) return false;
  for (let current = absolute(real, 'the path'); ; current = dirname(current)) {
    const entry = await fs.identity(current).catch(() => undefined);
    if (entry === undefined) return true;
    if (guard.keys.has(identityKey(entry))) return true;
    // The base is the root's own folder, not an alias; everything below it on a closed tree's device is unproven.
    if (current !== base && guard.closed.has(entry.device)) return true;
    if (current === base || dirname(current) === current || !within(base, dirname(current))) return false;
  }
}

/** The most link hops one path may take, as the kernel allows. */
const MAX_HOPS = 40;

/**
 * Today's `hopInsideHome`: whether `path`'s resolution passes through a symbolic link that LIVES inside the fence —
 * a link in the home that leads back out — each link judged where it is before it is followed. The home's own
 * configured name (a symlinked home) is not such a link.
 */
export async function hopsThroughFence(fs: HostFs, fence: Fence, path: string): Promise<boolean> {
  const segments = (text: string): string[] => text.split(sep).filter(part => part !== '' && part !== '.');
  const pending = segments(absolute(path, 'the path'));
  let current: string = sep;
  for (let hops = 0; pending.length > 0; ) {
    const segment = pending.shift() as string;
    const next = segment === '..' ? dirname(current) : join(current, segment);
    const entry = await fs.identity(next);
    if (entry?.kind !== 'link') {
      if (entry === undefined) return false;
      current = next;
      continue;
    }
    if (next !== fence.named && (await fencedReal(fs, fence, next))) return true;
    hops += 1;
    if (hops > MAX_HOPS) return true;
    const target = await fs.readlink(next);
    pending.unshift(...segments(target));
    if (isAbsolute(target)) current = sep;
  }
  return false;
}

/** Where today's guard allows a file with more than one name, once proven immutable. */
export const HARD_LINK_ROOTS: readonly string[] = ['/nix/store'];

type ClosedFs = Pick<HostFs, 'identity' | 'writable'>;

/**
 * Today's `closedToThisProcess`: owned by root, never writable by other, writable by its group only when this process
 * is NOT in that group, and (a folder) refused a write by the kernel itself.
 */
async function closedToThisProcess(
  path: string,
  kind: 'file' | 'directory',
  groups: readonly number[],
  fs: ClosedFs,
): Promise<boolean> {
  const entry = await fs.identity(path).catch(() => undefined);
  if (entry?.kind !== kind || entry.owner !== 0 || (entry.mode & 0o002) !== 0) return false;
  if ((entry.mode & 0o020) !== 0 && groups.includes(entry.group)) return false;
  return kind === 'file' || !(await fs.writable(path).catch(() => true));
}

/**
 * Today's `resolveImmutableRoots`: each root's real path and every folder above it are folders closed to this process
 * (a multi-user Nix store). A root that fails is left out — naming one grants nothing.
 */
export async function resolveImmutableRoots(fs: HostFs, roots: readonly string[]): Promise<readonly string[]> {
  const groups = await fs.groups();
  const proven: string[] = [];
  for (const root of roots) {
    const resolved = await fs.realpath(absolute(root, 'an immutable root')).catch(() => undefined);
    if (resolved === undefined) continue;
    let closed = true;
    for (let current = resolved; ; current = dirname(current)) {
      if (!(await closedToThisProcess(current, 'directory', groups, fs))) {
        closed = false;
        break;
      }
      if (dirname(current) === current) break;
    }
    if (closed) proven.push(resolved);
  }
  return proven;
}

/**
 * Today's `hardLinkAllowed`: a file with several names at `real` may be used only under a proven immutable root, owned
 * by root itself, with every folder from its own up to that root closed to this process the way the root is.
 */
export async function hardLinkAllowed(fs: HostFs, immutable: readonly string[], real: string): Promise<boolean> {
  const root = immutable.find(candidate => within(candidate, real));
  if (root === undefined) return false;
  const groups = await fs.groups();
  if (!(await closedToThisProcess(real, 'file', groups, fs))) return false;
  for (let current = dirname(real); within(root, current); current = dirname(current)) {
    if (!(await closedToThisProcess(current, 'directory', groups, fs))) return false;
    if (current === root || dirname(current) === current) break;
  }
  return true;
}
