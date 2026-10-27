/**
 * Which project a folder is in, for MCP — the ONE answer the inventory, the project sign-in list and a
 * launch's delivery all read (docs/mcp-scopes.md › Which project a folder is in).
 *
 * WHY ONE. Each of the three used to work it out for itself. The inventory fell back to a ferret's own
 * folder when it was in no registered project and no managed worktree; the sign-in list and the launch
 * knew only the registered ones. So a ferret working in a repository nobody had registered listed its
 * `.mcp.json` server under a subject (`phoebe..048c658abfb9`, the digest of the ferret's folder) that the
 * sign-in had never heard of — "There is no MCP server named …" — and a sign-in that had landed would
 * never have reached the launch either. Now the folder, and so the project key, is derived here once,
 * and {@link McpProjectFolders.list} holds every folder {@link McpProjectFolders.forCwd} can answer for
 * a ferret on this machine.
 *
 * THE RULE. A folder inside a registered project or a live managed worktree belongs to the longest such
 * root that contains it. Any other folder a ferret works in is its own project. Paths are compared
 * lexically, never resolved: a symlink or a different spelling of a path is a different folder — to
 * every reader alike, which is what keeps a subject the inventory hands out one the sign-in finds.
 */
import { posix } from 'node:path';
import { mcpProjectSubject, sha256Hex } from '@ferretry/protocol';
import { projectRootFor } from '../session-mcp/service.ts';

/**
 * A folder a ferret may work in: a registered project, a live managed worktree, or a folder a ferret
 * works in that is in neither. `project` is the root of the PROJECT it belongs to (itself for a
 * registered project or a lone folder, the source repository for a worktree), so every checkout of one
 * project shares a sign-in.
 */
export interface McpInventoryFolder {
  readonly root: string;
  readonly project: string;
  readonly name?: string;
}

export interface McpProjectFolders {
  /** Every folder project servers are read from: the known ones, then each ferret's folder in none of them. */
  list(): Promise<readonly McpInventoryFolder[]>;
  /** The folder a ferret working in `cwd` is in. Always one: a folder in no known one is its own. */
  forCwd(cwd: string): Promise<McpInventoryFolder>;
}

const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** The project digest in a project server's sign-in subject. */
export const mcpProjectKey = (projectRoot: string): string => sha256Hex(withoutTrailingSlash(projectRoot)).slice(0, 12);

/** The subject a project server's sign-in is filed under — the only place one is made. */
export const mcpFolderSubject = (folder: McpInventoryFolder, name: string): string =>
  mcpProjectSubject(name, mcpProjectKey(folder.project));

/** The known folder that contains `cwd` (the longest), else `cwd` as a project of its own. */
export const mcpFolderFor = (cwd: string, known: readonly McpInventoryFolder[]): McpInventoryFolder => {
  const root = projectRootFor(
    cwd,
    known.map(folder => folder.root),
  );
  const folder =
    root === undefined ? undefined : known.find(candidate => withoutTrailingSlash(candidate.root) === root);
  if (folder !== undefined) return folder;
  const own = withoutTrailingSlash(cwd);
  return { root: own, project: own };
};

/**
 * The known folders, plus the folder of every ferret this daemon holds that is in none of them. A
 * ferret's folder is read through {@link mcpFolderFor} against the KNOWN folders only, exactly as
 * {@link McpProjectFolders.forCwd} reads it — so a launch in a folder no ferret has used yet gets the
 * same project its ferret will be listed under once it exists.
 */
export class KnownAndFerretFolders implements McpProjectFolders {
  constructor(
    private readonly known: () => Promise<readonly McpInventoryFolder[]>,
    private readonly ferrets: () => Promise<readonly string[]>,
  ) {}

  async list(): Promise<readonly McpInventoryFolder[]> {
    const [known, cwds] = await Promise.all([this.known(), this.ferrets()]);
    const folders = [...known];
    const roots = new Set(known.map(folder => withoutTrailingSlash(folder.root)));
    for (const cwd of cwds) {
      const folder = mcpFolderFor(cwd, known);
      const root = withoutTrailingSlash(folder.root);
      if (roots.has(root)) continue;
      roots.add(root);
      folders.push(folder);
    }
    return folders;
  }

  async forCwd(cwd: string): Promise<McpInventoryFolder> {
    return mcpFolderFor(cwd, await this.known());
  }
}

/**
 * The folders a ferret may work in, each joined to its project: registered projects, then live managed
 * worktrees — a worktree belongs to the project registered for its common directory (`projectId`), else
 * to the repository it was forked from. Read fresh per request, like `knownProjectRoots`.
 */
export const mcpInventoryFolders =
  (
    catalogs: { projects(): Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]> },
    worktrees: {
      list(): Promise<{
        readonly worktrees: readonly {
          readonly path: string;
          readonly repositoryRoot: string;
          readonly projectId?: string;
          readonly removedAt?: string;
        }[];
      }>;
    },
  ) =>
  async (): Promise<readonly McpInventoryFolder[]> => {
    const [projects, managed] = await Promise.all([catalogs.projects(), worktrees.list()]);
    return [
      ...projects.map(project => ({ root: project.path, project: project.path, name: project.name })),
      ...managed.worktrees
        .filter(worktree => worktree.removedAt === undefined)
        .map(worktree => {
          const owner = projects.find(project => project.id === worktree.projectId);
          return {
            root: worktree.path,
            project: owner?.path ?? worktree.repositoryRoot,
            ...(owner === undefined ? {} : { name: owner.name }),
          };
        }),
    ];
  };
