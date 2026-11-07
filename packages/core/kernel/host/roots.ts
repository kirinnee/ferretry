import type { Result } from '@ferretry/std';
import { err, instantFromEpochMs, ok } from '@ferretry/std';
import type { FencedPath, FolderRefusal, WorkFolders } from '../contract/bound.ts';
import { insideFence } from '../contract/home.ts';
import type { RootHandle, RootLstat, RootName, RootsPort, RootStat, RootWriteOptions } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';
import type { PinRegistry } from './pins.ts';

/** Where a root's pins come from: the kernel's registry, and the plugin they are minted for. */
export interface RootPinning {
  readonly registry: PinRegistry;
  readonly plugin: string;
}

/** Owner's roots refuse everything inside the fence; internal roots reach only their own subtree (§7.7). */
const OWNER_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'work', 'imports']);
const READ_ONLY_ROOTS: ReadonlySet<RootName> = new Set(['harness-history', 'imports']);
/** Internal roots only one plugin may have, whatever another manifest declares. */
const ROOT_OWNERS: Partial<Record<RootName, string>> = { credentials: 'logins' };
const DEFAULT_COPY_ENTRIES = 10_000;

/** Every handle the kernel made, with the plugin it was made for and its fenced resolver (for `copyTree`). */
const HANDLES = new WeakMap<
  object,
  { readonly plugin: string; readonly real: (path: FencedPath) => Promise<FencedPath> }
>();

export interface RootLayout {
  readonly home: string;
  readonly plugin: string;
  /** `<home>-worktrees`. */
  readonly worktrees: string;
}

const trim = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
const join = (base: string, relative: string): string =>
  relative === '' ? trim(base) : `${trim(base)}/${relative.replace(/^\/+/, '')}`;
const inside = (base: string, path: string): boolean => path === trim(base) || path.startsWith(`${trim(base)}/`);

export class RootError extends Error {
  constructor(readonly refusal: FolderRefusal | 'read_only' | 'not_declared') {
    super(`root refused: ${refusal}`);
    this.name = 'RootError';
  }
}

/** The lexical half (synchronous, `RootHandle.resolve`): no `..`, no NUL, inside the root, outside the fence. */
export function lexicalInRoot(
  home: string,
  base: string,
  ownerRoot: boolean,
  relative: string,
): Result<FencedPath, FolderRefusal> {
  if (relative.includes('\0') || relative.split('/').some(part => part === '..')) return err('outside');
  const candidate = relative.startsWith('/') ? trim(relative) : join(base, relative);
  if (!inside(base, candidate)) return err('outside');
  if (ownerRoot && insideFence(home, candidate)) return err('fenced');
  return ok(candidate as FencedPath);
}

/**
 * The full check (§7.7, §9.3), asked again before EVERY read or write so a link swapped in after `resolve` cannot
 * escape (S41): resolves symlinks along the longest existing prefix, refuses a path that resolves outside the root
 * (`link_escape`), a device or other special file, and, for an owner's root, anything inside the fence (S40).
 */
export async function resolveInRoot(
  fs: HostFs,
  home: string,
  base: string,
  ownerRoot: boolean,
  relative: string,
): Promise<Result<FencedPath, FolderRefusal>> {
  const lexical = lexicalInRoot(home, base, ownerRoot, relative);
  if (!lexical.ok) return lexical;
  let realBase: string;
  try {
    realBase = await fs.realpath(base);
  } catch {
    return err('outside');
  }
  if (ownerRoot && insideFence(home, realBase)) return err('fenced');
  const parts = lexical.value
    .slice(trim(base).length)
    .split('/')
    .filter(part => part !== '');
  let resolved = realBase;
  let index = 0;
  for (; index < parts.length; index += 1) {
    const next = `${resolved}/${parts[index]}`;
    const info = await fs.lstat(next);
    if (info === undefined) break;
    if (info.kind === 'other') return err('device_file');
    resolved = info.kind === 'link' ? await fs.realpath(next).catch(() => next) : next;
    if (!inside(realBase, resolved)) return err('link_escape');
  }
  const full = [resolved, ...parts.slice(index)].join('/');
  if (!inside(realBase, full)) return err('link_escape');
  if (ownerRoot && insideFence(home, full)) return err('fenced');
  return ok(full as FencedPath);
}

function rootHandle(
  fs: HostFs,
  home: string,
  name: RootName,
  base: () => string | undefined,
  check: (path: string) => Result<FencedPath, FolderRefusal> | undefined,
  pinning?: RootPinning,
  plugin = pinning?.plugin ?? '',
): RootHandle {
  const ownerRoot = OWNER_ROOTS.has(name);
  const readOnly = READ_ONLY_ROOTS.has(name);
  const real = async (path: FencedPath): Promise<FencedPath> => {
    const root = base();
    if (root === undefined) throw new RootError(name === 'work' ? 'unknown_ferret' : 'outside');
    const resolved = await resolveInRoot(fs, home, root, ownerRoot, path);
    if (!resolved.ok) throw new RootError(resolved.error);
    return resolved.value;
  };
  /**
   * The leaf NOT followed: its parent resolved and fenced, the leaf's own name appended. What sits at the name (a
   * link included) is then judged by the call itself — `lstat` reports it, an exclusive create refuses it.
   */
  const realParent = async (path: FencedPath): Promise<FencedPath> => {
    const slash = path.lastIndexOf('/');
    const leaf = path.slice(slash + 1);
    if (slash <= 0 || leaf === '' || leaf === '.' || leaf === '..') return await real(path);
    const parent = await real(path.slice(0, slash) as FencedPath);
    const full = `${parent}/${leaf}`;
    const root = base();
    if (root === undefined) throw new RootError('outside');
    if (ownerRoot && insideFence(home, full)) throw new RootError('fenced');
    return full as FencedPath;
  };
  const writable = (): void => {
    if (readOnly) throw new RootError('read_only');
  };
  const write = async (path: FencedPath, data: string | Uint8Array, options?: RootWriteOptions): Promise<void> => {
    writable();
    const mode = options?.mode ?? 0o600;
    if (options?.exclusive === true) await fs.writeExclusive(await realParent(path), data, mode);
    else await fs.writeAtomic(await real(path), data, mode);
  };
  /** Copies `from` (a real, fenced source folder) into `to`: off the disk, never through a link or a hard link. */
  const copyInto = async (from: string, to: string, budget: { left: number }): Promise<void> => {
    await fs.mkdirp(to, 0o700);
    for (const name of await fs.list(from)) {
      budget.left -= 1;
      if (budget.left < 0) throw new RootError('outside');
      const info = await fs.lstat(`${from}/${name}`);
      if (info === undefined) continue;
      if (info.kind === 'directory') await copyInto(`${from}/${name}`, `${to}/${name}`, budget);
      else if (info.kind === 'file' && (info.links ?? 1) <= 1)
        await fs.writeAtomic(`${to}/${name}`, await fs.readBytes(`${from}/${name}`), (info.mode ?? 0o600) & 0o777);
      // a link is left alone (never entered), a device or a hard-linked file is never read
    }
  };
  const handle: RootHandle = {
    name,
    resolve: relative => {
      const root = base();
      if (root === undefined) return err(name === 'work' ? 'unknown_ferret' : 'outside');
      const lexical = lexicalInRoot(home, root, ownerRoot, relative);
      if (!lexical.ok) return lexical;
      return check(lexical.value) ?? lexical;
    },
    readText: async (path, limit) => {
      const text = await fs.readText(await real(path));
      return limit === undefined ? text : text.slice(0, limit);
    },
    readBytes: async (path, limit) => {
      const bytes = await fs.readBytes(await real(path));
      return limit === undefined ? bytes : bytes.slice(0, limit);
    },
    writeText: async (path, text, options) => await write(path, text, options),
    writeBytes: async (path, bytes, options) => await write(path, bytes, options),
    copyTree: async (source, from, to, options) => {
      writable();
      const known = HANDLES.get(source);
      if (known === undefined || known.plugin !== plugin) throw new RootError('not_declared');
      const sourceReal = await known.real(from);
      const info = await fs.lstat(sourceReal);
      if (info?.kind !== 'directory') throw new RootError('outside');
      if (options?.link === true) {
        await fs.symlink(sourceReal, await realParent(to));
        return;
      }
      // A copy lands in a NEW folder: nothing already there (a planted link) can redirect what it writes.
      const destination = await realParent(to);
      if ((await fs.lstat(destination)) !== undefined) throw new RootError('outside');
      await copyInto(sourceReal, destination, { left: options?.maxEntries ?? DEFAULT_COPY_ENTRIES });
    },
    ensurePrivateDirectory: async path => {
      writable();
      const at = await realParent(path);
      const info = await fs.lstat(at);
      if (info !== undefined && info.kind !== 'directory') throw new RootError('outside');
      if (info === undefined) await fs.mkdirp(at, 0o700);
      await fs.chmod(at, 0o700);
    },
    lstat: async (path): Promise<RootLstat | undefined> => {
      const info = await fs.lstat(await realParent(path));
      if (info === undefined) return undefined;
      const kind = info.kind === 'link' ? 'symlink' : info.kind;
      return { kind, size: info.size, modified: instantFromEpochMs(info.mtimeMs) };
    },
    makeDirectory: async (path, options) => {
      writable();
      await fs.mkdirp(await real(path), options?.mode ?? 0o700);
    },
    realPath: async path => {
      // `real` resolved every existing component inside the root; the whole must exist (a broken link throws), and a
      // name that moved between the two answers is refused rather than re-resolved.
      const resolved = await real(path);
      const full = await fs.realpath(resolved);
      if (full !== resolved) throw new RootError('link_escape');
      return resolved;
    },
    list: async path => await fs.list(await real(path)),
    stat: async (path): Promise<RootStat | undefined> => {
      const info = await fs.lstat(await real(path));
      if (info === undefined || (info.kind !== 'file' && info.kind !== 'directory')) return undefined;
      return { kind: info.kind, size: info.size, modified: instantFromEpochMs(info.mtimeMs) };
    },
    remove: async path => {
      writable();
      await fs.remove(await real(path));
    },
    pin: async (path, options) => {
      if (pinning === undefined) throw new RootError('not_declared');
      const resolved = await real(path);
      const pinned = await pinning.registry.pin(pinning.plugin, resolved, options);
      // The name was checked; now the OBJECT held: what the descriptor resolves to must still be in the root.
      try {
        const root = base();
        if (root === undefined) throw new RootError('outside');
        const realBase = await fs.realpath(root);
        if (!inside(realBase, pinned.rootReal)) throw new RootError('link_escape');
        if (ownerRoot && insideFence(home, pinned.rootReal)) throw new RootError('fenced');
      } catch (error) {
        await pinned.close();
        throw error;
      }
      return pinned;
    },
  };
  HANDLES.set(handle, { plugin, real });
  return handle;
}

/** The roots port for one plugin: only roots its manifest declared (§3.7); anything else throws. */
export function rootsPortFor(
  fs: HostFs,
  layout: RootLayout,
  declared: readonly RootName[],
  workFolders: () => WorkFolders | undefined,
  pins?: PinRegistry,
): RootsPort {
  const allowed = new Set(declared);
  return {
    root: (name, scope) => {
      if (!allowed.has(name)) throw new RootError('not_declared');
      const owner = ROOT_OWNERS[name];
      if (owner !== undefined && owner !== layout.plugin) throw new RootError('not_declared');
      const base = (): string | undefined => {
        switch (name) {
          case 'agent-homes':
            return join(`${layout.home}/state/${layout.plugin}/agent-homes`, scope?.subfolder ?? '');
          case 'downloads':
            return `${layout.home}/state/${layout.plugin}/downloads`;
          case 'credentials':
            return `${layout.home}/state/${layout.plugin}/credentials`;
          case 'worktrees':
            return layout.worktrees;
          case 'work':
            return scope?.ferret === undefined ? undefined : workFolders()?.folderOf(scope.ferret);
          case 'harness-history':
          case 'imports':
            // The owner-named folder, or the harness's documented history folder: absolute, given by the caller.
            return scope?.subfolder?.startsWith('/') === true ? trim(scope.subfolder) : undefined;
        }
      };
      const check = (path: string): Result<FencedPath, FolderRefusal> | undefined => {
        if (name !== 'work' || scope?.ferret === undefined) return undefined;
        return workFolders()?.check(scope.ferret, path) ?? err('unknown_ferret');
      };
      return rootHandle(
        fs,
        layout.home,
        name,
        base,
        check,
        pins === undefined ? undefined : { registry: pins, plugin: layout.plugin },
        layout.plugin,
      );
    },
  };
}
