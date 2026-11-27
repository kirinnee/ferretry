import type { Instant } from '@ferretry/std';
import type { ProjectInfo, ProjectsFile } from '../../../contract/index.ts';
import { ProjectRegistry } from '../../../daemon/lib/registry.ts';
import type { ProjectFolders, RegistryStore } from '../../../daemon/lib/ports.ts';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';

/** A machine of folders in a map: what exists, what git says about it, and every call made. */
export interface FakeMachine extends ProjectFolders {
  readonly directories: Set<string>;
  /** root -> common directory, for the folders that are git work trees. */
  readonly repositories: Map<string, string>;
  readonly calls: string[];
}

export function fakeMachine(
  directories: readonly string[] = [],
  repositories: Record<string, string> = {},
  fenced: readonly string[] = [],
  { home = '/home/owner', notCheckouts = [] as readonly string[] } = {},
): FakeMachine {
  const dirs = new Set(directories);
  const repos = new Map(Object.entries(repositories));
  const calls: string[] = [];
  const machine: FakeMachine = {
    directories: dirs,
    repositories: repos,
    calls,
    isDirectory: async path => {
      calls.push(`isDirectory ${path}`);
      return dirs.has(path);
    },
    mayName: async path => {
      calls.push(`mayName ${path}`);
      return !fenced.some(inside => path === inside || path.startsWith(`${inside}/`));
    },
    canonical: async path => {
      calls.push(`canonical ${path}`);
      return path;
    },
    makeDirectory: async path => {
      calls.push(`mkdir ${path}`);
      if (dirs.has(path)) throw new Error('project folder could not be created');
      dirs.add(path);
    },
    gitInit: async path => {
      calls.push(`git init ${path}`);
      repos.set(path, `${path}/.git`);
    },
    gitClone: async (url, path) => {
      calls.push(`git clone ${url} ${path}`);
      dirs.add(path);
      repos.set(path, `${path}/.git`);
    },
    gitCloneInto: async (url, parent, name, verdict) => {
      const path = `${parent}/${name}`;
      if ((await verdict(parent)) || (await verdict(path))) throw new Error('folder refused');
      if (dirs.has(path)) throw new Error('destination exists');
      await machine.gitClone(url, path);
    },
    gitCommonDirectory: async root => repos.get(root),
    home: async () => home,
    isCheckout: async (root, common) => {
      calls.push(`isCheckout ${root}`);
      return repos.get(root) === common && !notCheckouts.includes(root);
    },
  };
  return machine;
}

/** The registry file in memory, with the same one-at-a-time update the kernel's state port gives. */
function memoryStore(initial: readonly ProjectInfo[] = []): RegistryStore & { file: ProjectsFile } {
  let chain: Promise<unknown> = Promise.resolve();
  const store = {
    file: { format: 1, projects: [...initial] } as ProjectsFile,
    read: async () => store.file.projects,
    update: (change: (current: ProjectsFile) => ProjectsFile) => {
      const run = chain.then(async () => {
        await Promise.resolve();
        store.file = change(store.file);
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

/** A registry over a fake machine and an in-memory file, with every announcement written down. */
export function registryOver(machine: FakeMachine = fakeMachine(), store = memoryStore()) {
  let counter = 0;
  const said: string[] = [];
  const registry = new ProjectRegistry({
    store,
    folders: machine,
    clock: { now: () => '2026-11-07T09:00:00.000Z' as Instant },
    newId: () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`,
    registered: id => said.push(`registered ${id}`),
    removed: id => said.push(`removed ${id}`),
  });
  return { registry, store, said, machine };
}

/** A folder browser over `root` whose repositories are whatever `names()` says now (a clone adds one while a test runs). */
export const listingBrowser = (root: string, names: () => readonly string[]): FolderBrowser => ({
  home: async () => '/home/me',
  holdsSignIn: async () => false,
  leaf: async () => 'present',
  realPaths: async paths => [...paths],
  open: async (path, verdict) => {
    if ((await verdict(path)) !== undefined) return { ok: false, reason: 'refused' };
    return {
      ok: true,
      folder: {
        real: path,
        entries: async () => ({
          entries:
            path === root
              ? names().map(name => ({
                  name,
                  kind: 'directory' as const,
                  modified: '2026-11-19T00:00:00.000Z' as Instant,
                }))
              : [],
          more: false,
        }),
        lookup: async () => 'missing',
        readText: async () => '[remote "origin"]\n\turl = https://github.com/o/cloned.git\n',
        hasGit: async name => names().includes(name),
        device: async () => 'd1',
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      },
    };
  },
});
