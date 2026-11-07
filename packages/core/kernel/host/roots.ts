import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
import { insideFence } from '../contract/home.ts';
import type { FerretId } from '../contract/ids.ts';
import type { RootHandle, RootName, RootsPort, RootStat } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';

/** Owner's roots refuse everything inside the fence; internal roots reach only their own subtree (§7.7). */
const OWNER_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'work', 'imports']);
const READ_ONLY_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'imports']);

export interface RootLayout {
  readonly home: string;
  readonly plugin: string;
  /** `<home>-worktrees`. */
  readonly worktrees: string;
}

const join = (base: string, relative: string): string =>
  relative === '' ? base : `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;

const inside = (base: string, path: string): boolean => path === base || path.startsWith(`${base.replace(/\/+$/, '')}/`);

export class RootError extends Error {
  constructor(readonly refusal: FolderRefusal | 'read_only' | 'not_declared') {
    super(`root refused: ${refusal}`);
    this.name = 'RootError';
  }
}

/**
 * Resolves a path inside one root (§7.7, §9.3): refuses `..` and NUL, resolves symlinks of the longest existing
 * prefix before checking, refuses a path that resolves outside the root (`link_escape`), a device or other special
 * file, and — for an owner's root — anything inside the fence (the live home and every `-before-` folder).
 */
export async function resolveInRoot(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  relative: string,
): Promise<Result<FencedPath, FolderRefusal>> {
  if (relative.includes('\0') || relative.split('/').some(part => part === '..')) return err('outside');
  const candidate = join(base, relative);
  if (!inside(base, candidate)) return err('outside');
  let realBase: string;
  try {
    realBase = await fs.realpath(base);
  } catch {
    return err('outside');
  }
  if (ownerRoot && insideFence(home, realBase)) return err('fenced');
  // Resolve the longest existing prefix; the rest is created under it.
  const parts = candidate.slice(base.replace(/\/+$/, '').length).split('/').filter(part => part !== '');
  let resolved = realBase;
  let index = 0;
  for (; index < parts.length; index += 1) {
    const next = `${resolved}/${parts[index]}`;
    const info = await fs.lstat(next);
    if (info === undefined) break;
    if (info.kind === 'other') return err('device_file');
    resolved = info.kind === 'link' ? await fs.realpath(next) : next;
    if (!inside(realBase, resolved)) return err('link_escape');
  }
  const full = [resolved, ...parts.slice(index)].join('/');
  if (!inside(realBase, full)) return err('link_escape');
  if (ownerRoot && insideFence(home, full)) return err('fenced');
  return ok(full as FencedPath);
}

function handle(
  fs: HostFs,
  home: string,
  name: RootName,
  base: () => string | undefined,
  limits: { readonly ownerRoot: boolean; readonly readOnly: boolean },
): RootHandle {
  const own = async (path: FencedPath): Promise<FencedPath> => {
    const root = base();
    if (root === undefined || !inside(root, path) || (limits.ownerRoot && insideFence(home, path)))
      throw new RootError('outside');
    return path;
  };
  const writable = (): void => {
    if (limits.readOnly) throw new RootError('read_only');
  };
  return {
    name,
    resolve: () => {
      throw new TypeError('use resolveAsync: resolution reads the filesystem');
    },
    readText: async (path, limit) => {
      const text = await fs.readText(await own(path));
      return limit === undefined ? text : text.slice(0, limit);
    },
    readBytes: async (path, limit) => {
      const bytes = await fs.readBytes(await own(path));
      return limit === undefined ? bytes : bytes.slice(0, limit);
    },
    writeText: async (path, text) => {
      writable();
      await fs.writeAtomic(await own(path), text, 0o600);
    },
    list: async path => await fs.list(await own(path)),
    stat: async (path): Promise<RootStat | undefined> => {
      const info = await fs.lstat(await own(path));
      if (info === undefined || (info.kind !== 'file' && info.kind !== 'directory')) return undefined;
      return { kind: info.kind, size: info.size, modified: instantFromEpochMs(info.mtimeMs) };
    },
    remove: async path => {
      writable();
      await fs.remove(await own(path));
    },
  };
}

/**
 * A root handle whose `resolve` is asynchronous in fact. The leaf's `RootHandle.resolve` is synchronous; resolution
 * has to read the filesystem to follow symlinks, so the host pre-resolves through `resolveAsync` and `resolve`
 * throws. Reported to the lead as a leaf change (make `resolve` return a Promise).
 */
export interface HostRootHandle extends RootHandle {
  resolveAsync(relative: string): Promise<Result<FencedPath, FolderRefusal>>;
}

/** The roots port for one plugin: only roots its manifest declared (§3.7); anything else throws at build. */
export function rootsPortFor(
  fs: HostFs,
  layout: RootLayout,
  declared: readonly RootName[],
  workFolders: () => WorkFolders | undefined,
): RootsPort {
  const allowed = new Set(declared);
  return {
    root: (name, scope): HostRootHandle => {
      if (!allowed.has(name)) throw new RootError('not_declared');
      const base = (): string | undefined => {
        switch (name) {
          case 'agent-homes':
            return join(`${layout.home}/state/${layout.plugin}/agent-homes`, scope?.subfolder ?? '');
          case 'downloads':
            return `${layout.home}/state/${layout.plugin}/downloads`;
          case 'worktrees':
            return layout.worktrees;
          case 'work':
            return scope?.ferret === undefined ? undefined : workFolders()?.folderOf(scope.ferret as FerretId);
          case 'harness-history':
          case 'imports':
            // The owner-named folder (or the harness's documented history folder), absolute.
            return scope?.subfolder?.startsWith('/') === true ? scope.subfolder : undefined;
        }
      };
      const ownerRoot = OWNER_ROOTS.has(name);
      const root = handle(fs, layout.home, name, base, { ownerRoot, readOnly: READ_ONLY_ROOTS.has(name) });
      return {
        ...root,
        resolveAsync: async relative => {
          const at = base();
          if (at === undefined) return err(name === 'work' ? 'unknown_ferret' : 'outside');
          if (name === 'work' && scope?.ferret !== undefined) {
            const checked = workFolders()?.check(scope.ferret, join(at, relative));
            if (checked === undefined) return err('unknown_ferret');
            if (!checked.ok) return checked;
          }
          return await resolveInRoot(fs, layout.home, at, ownerRoot, relative);
        },
      };
    },
  };
}
