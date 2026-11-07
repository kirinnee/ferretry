import type { ProjectFolders } from '../../../daemon/lib/ports.ts';

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
): FakeMachine {
  const dirs = new Set(directories);
  const repos = new Map(Object.entries(repositories));
  const calls: string[] = [];
  return {
    directories: dirs,
    repositories: repos,
    calls,
    isDirectory: async path => {
      calls.push(`isDirectory ${path}`);
      return dirs.has(path);
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
    gitCommonDirectory: async root => repos.get(root),
  };
}
