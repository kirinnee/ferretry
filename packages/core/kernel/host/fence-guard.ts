import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { BEFORE_SUFFIX, insideFence } from '../contract/home.ts';
import type { FileIdentity, HostFs } from './adapters/node-fs.ts';

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

/** The fence by name (as configured and as resolved) and by identity. */
export interface Fence {
  readonly named: string;
  readonly real: string;
  readonly identities: readonly { readonly device: bigint; readonly inode: bigint }[];
}

/**
 * The home's key files and folders, relative to the home: today's `stateHomeFence(home).pinned`
 * (`packages/fleet/src/lib/state-home-fence.ts`), exactly. Each is recognised by IDENTITY wherever a walk meets it, so
 * one bind-mounted or hard-linked alone into a work folder is refused under any name.
 */
export const PINNED_KEY_PATHS: readonly string[] = [
  'api-token',
  'api-warden-token',
  'tmux.sock',
  ...['secrets.key', 'secrets.json', 'mcp-oauth-secrets.json', 'login-secrets.json', 'passkeys.json'].map(
    name => `state/${name}`,
  ),
  'state/daemon-identity.json',
  'fleet',
  'fleet/homes',
  'state/sessions',
];

/**
 * The fence of `home`: its real path, and the identity of the home, of every `<home>-before-*` and
 * `state/<id>-before-*` folder, and of each pinned key file and folder ({@link PINNED_KEY_PATHS}) that is there — the
 * entry itself, never followed, as today's `resolveStateHomes` takes it. A home that cannot be resolved, or a key
 * path that cannot be looked at, fails closed (throws).
 */
export async function fenceOf(fs: HostFs, home: string): Promise<Fence> {
  const named = absolute(home, 'the home');
  const real = await fs.realpath(named);
  const folders = [real];
  const parent = dirname(named);
  const name = basename(named);
  for (const entry of await fs.list(parent))
    if (entry.startsWith(`${name}-before-`) && BEFORE_SUFFIX.test(entry)) folders.push(join(parent, entry));
  for (const entry of await fs.list(join(real, 'state')))
    if (BEFORE_SUFFIX.test(entry)) folders.push(join(real, 'state', entry));
  const identities = [];
  for (const folder of folders) {
    const identity = await fs.identity(folder);
    if (folder === real && identity?.kind !== 'directory') throw new Error('the home cannot be identified');
    if (identity !== undefined) identities.push(identity);
  }
  for (const key of PINNED_KEY_PATHS) {
    const identity = await fs.identity(join(real, key));
    if (identity !== undefined) identities.push(identity);
  }
  return { named, real, identities };
}

/** Inside the fence by NAME: the configured home or its real path (`insideFence` covers every `-before-` folder). */
export function fencedByName(fence: Fence, path: string): boolean {
  const target = absolute(path, 'the path');
  return insideFence(fence.named, target) || insideFence(fence.real, target);
}

/**
 * Today's `stateHomeOf`: by name, then every folder from `real` up to `/` by device and inode. A folder that cannot be
 * read fails closed.
 */
export async function fencedReal(fs: HostFs, fence: Fence, real: string): Promise<boolean> {
  if (fencedByName(fence, real)) return true;
  for (let current = absolute(real, 'the path'); ; current = dirname(current)) {
    const entry = await fs.identity(current).catch(() => undefined);
    if (entry === undefined) return true;
    if (fence.identities.some(identity => same(identity, entry))) return true;
    if (dirname(current) === current) return false;
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
