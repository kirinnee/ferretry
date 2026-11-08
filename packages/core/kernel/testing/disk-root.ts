import { err, ok } from '@ferretry/std';
import { mkdir, writeFile } from 'node:fs/promises';
import type { FencedPath, WorkFolders } from '../contract/bound.ts';
import type { FerretId } from '../contract/ids.ts';
import type { PathsPort, RootHandle } from '../contract/ports.ts';
import { type HostFs, nodeFs } from '../host/adapters/node-fs.ts';
import { checkDirectory } from '../host/paths.ts';
import { rootsPortFor } from '../host/roots.ts';

/** A real-disk root for a test: the handle, and the folder it is rooted at. */
export interface DiskRoot {
  readonly root: RootHandle;
  /** The (absolute) folder the root reaches; made. Everything the root writes is beneath it. */
  readonly folder: string;
}

/**
 * A REAL root over `<parent>/files` (the kernel's own fenced implementation, `work` root), for the tests of an adapter
 * that stores its files through `RootHandle`. `parent` is the test's own temp folder: the home the fence is judged
 * against and the worktrees folder are made beside the root inside it, so removing `parent` removes everything.
 * `observe` may wrap the disk adapter (never replace it) to see or fail one step.
 */
export async function diskRoot(parent: string, observe: (disk: HostFs) => HostFs = disk => disk): Promise<DiskRoot> {
  const folder = `${parent}/files`;
  await mkdir(folder, { recursive: true });
  await mkdir(`${parent}/home/state/vault`, { recursive: true });
  await writeFile(`${parent}/home/state/vault/vault.key`, 'protected-fixture');
  let counter = 0;
  const folders: WorkFolders = {
    folderOf: () => folder as FencedPath,
    check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
  };
  const root = rootsPortFor(
    observe(nodeFs(() => 'x')),
    { home: `${parent}/home`, plugin: 'ferrets', worktrees: `${parent}/worktrees` },
    ['work'],
    () => folders,
    {
      random: () => {
        counter += 1;
        return `t${String(counter)}`;
      },
    },
  ).root('work', { ferret: 'F1' as FerretId });
  return { root, folder };
}

/** `kernel.paths.checkDirectory` over the real disk, for the tests of an adapter that asks it. */
export function diskPaths(): Pick<PathsPort, 'checkDirectory'> {
  const disk = nodeFs(() => 'x');
  return { checkDirectory: async absolutePath => await checkDirectory(disk, absolutePath) };
}
