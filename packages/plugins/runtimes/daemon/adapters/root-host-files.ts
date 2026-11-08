/**
 * {@link HostFiles} over the kernel's roots: the host's files, read only, by absolute path, every read through a
 * root handle that resolves links before it checks, refuses everything inside the daemon's own home, and never follows
 * a link out (`harness-home`, `fleet`) — or through the ONE file the kernel lets Runtimes open beside a harness home
 * (`~/.claude.json`, `RootsPort.harnessFile`: no folder listing, no write).
 *
 * A path is served only when a mount names it. Anything else is refused in a sentence, never read: this is the seam
 * that replaced the raw-path reads, so it must not be a way back to them.
 */
import { isAbsolute, relative, sep } from 'node:path';
import type { RootFileHandle, RootHandle, RootLstat, RootStat, RootsPort } from '@ferretry/kernel/contract';
import type { HostEntry, HostFiles } from './ports.ts';

/** What serves one absolute path: a root and the path inside it, or the one file a `harnessFile` handle names. */
type Mounted =
  | { readonly kind: 'root'; readonly root: RootHandle; readonly inside: string }
  | { readonly kind: 'file'; readonly file: RootFileHandle };

/** Finds what serves `absolutePath`, or `undefined` when nothing the plugin holds reaches it. */
export type HostMounts = (absolutePath: string) => Mounted | undefined;

const refused = (path: string): Error =>
  new Error(`${path} is outside the folders Runtimes may read on this machine, so it was not opened`);

/** `inside` as a relative path below `base`, or `undefined` when it is not at or under it. */
function below(base: string, path: string): string | undefined {
  if (!isAbsolute(path) || !isAbsolute(base)) return undefined;
  const inside = relative(base, path);
  if (inside === '') return '';
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : inside;
}

const kindOf = (stat: RootStat | RootLstat): HostEntry['kind'] => {
  switch (stat.kind) {
    case 'symlink':
      return 'link';
    case 'file':
    case 'directory':
      return stat.kind;
    default:
      return 'other';
  }
};
const entryOf = (stat: RootStat | RootLstat): HostEntry => ({ kind: kindOf(stat), size: stat.size });

export function rootHostFiles(mounts: HostMounts): HostFiles {
  const resolveIn = (root: RootHandle, inside: string, shown: string) => {
    const spelled = inside === '' ? '.' : inside;
    const resolved = root.resolve(spelled);
    if (!resolved.ok) throw new Error(`${shown} could not be opened (${resolved.error})`);
    return resolved.value;
  };
  const mount = (path: string): Mounted => {
    const found = mounts(path);
    if (found === undefined) throw refused(path);
    return found;
  };
  return {
    readText: async path => {
      const target = mount(path);
      if (target.kind === 'file')
        return await target.file.stat().then(s => (s === undefined ? undefined : target.file.readText()));
      const at = resolveIn(target.root, target.inside, path);
      return (await target.root.lstat(at)) === undefined ? undefined : await target.root.readText(at);
    },
    readBytes: async path => {
      const target = mount(path);
      if (target.kind === 'file')
        return await target.file.stat().then(s => (s === undefined ? undefined : target.file.readBytes()));
      const at = resolveIn(target.root, target.inside, path);
      return (await target.root.lstat(at)) === undefined ? undefined : await target.root.readBytes(at);
    },
    stat: async path => {
      const target = mount(path);
      const found =
        target.kind === 'file'
          ? await target.file.stat()
          : await target.root.stat(resolveIn(target.root, target.inside, path));
      return found === undefined ? undefined : entryOf(found);
    },
    lstat: async path => {
      const target = mount(path);
      const found =
        target.kind === 'file'
          ? await target.file.lstat()
          : // The root's own base has no leaf of its own to look at: the kernel checked every hop to it (a link anywhere on
            // the way is refused), so what is there is what `stat` says.
            target.inside === ''
            ? await target.root.stat(resolveIn(target.root, target.inside, path))
            : await target.root.lstat(resolveIn(target.root, target.inside, path));
      return found === undefined ? undefined : entryOf(found);
    },
    list: async path => {
      const target = mount(path);
      if (target.kind === 'file') throw new Error(`${path} is one file; its folder is not listable`);
      const at = resolveIn(target.root, target.inside, path);
      return (await target.root.lstat(at)) === undefined ? undefined : await target.root.list(at);
    },
  };
}

/**
 * The mounts for the first-run scan: each harness home as a `harness-home` root scoped to that ABSOLUTE folder, and
 * `besideFile` (`~/.claude.json`) as the one declared file beside a home. Nothing else is served.
 *
 * @pending runtimes: the first-run scan of the host's harness homes is not composed into the setup service
 */
export function harnessMounts(
  roots: Pick<RootsPort, 'root' | 'harnessFile'>,
  homes: readonly string[],
  besideFile?: string,
): HostMounts {
  const held = new Map<string, RootHandle>();
  return absolutePath => {
    if (besideFile !== undefined && absolutePath === besideFile)
      return { kind: 'file', file: roots.harnessFile(besideFile) };
    for (const home of homes) {
      const inside = below(home, absolutePath);
      if (inside === undefined) continue;
      let root = held.get(home);
      if (root === undefined) {
        root = roots.root('harness-home', { subfolder: home });
        held.set(home, root);
      }
      return { kind: 'root', root, inside };
    }
    return undefined;
  };
}

/** The mounts for the fleet folder: its absolute path (`fleetDirectory`) and the `fleet` root that holds it. */
export function fleetMounts(root: RootHandle, fleetDirectory: string): HostMounts {
  return absolutePath => {
    const inside = below(fleetDirectory, absolutePath);
    return inside === undefined ? undefined : { kind: 'root', root, inside };
  };
}
