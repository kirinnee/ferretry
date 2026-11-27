import { basename, dirname } from 'node:path';
import type { FerretStartedPayload } from '@ferretry/core-ferrets/contract';
import { isAtOrUnder, isPrivateBelowHome } from '../features/folders/fence.ts';
import type { ProjectFolders } from './ports.ts';
import type { ProjectRegistry } from './registry.ts';

/**
 * Where the OS keeps scratch space: a repository there is a test's or a tool's, not the owner's. Judged on the real path,
 * and never for a place inside the owner's own home (a home that itself sits in a temp folder is still the owner's).
 */
const TEMP_TREES: readonly string[] = ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

/** A folder name the harness keeps its linked worktrees under: those resolve to their main checkout, never to themselves. */
const WORKTREE_FOLDER = '.worktrees';

/**
 * Whether a repository root is somewhere a project is never guessed at: the owner's home itself or any folder above it
 * (a tracked home is dotfiles, not a project; a tracked `/` is a machine), the OS temp folders, a worktrees folder, and
 * a private place inside the home (`~/.claude`, `~/.ssh`, …). Ferretry's own home is the `imports` fence's (`mayName`).
 */
export function isAmbientRoot(root: string, home: string): boolean {
  if (isAtOrUnder(home, root)) return true;
  const inHome = isAtOrUnder(root, home);
  if (!inHome && TEMP_TREES.some(tree => isAtOrUnder(root, tree))) return true;
  if (root.split('/').includes(WORKTREE_FOLDER)) return true;
  return inHome && isPrivateBelowHome(root.slice(home.length).split('/').filter(Boolean));
}

/**
 * A ferret started somewhere: when that is inside a git repository nobody registered, the repository becomes a project
 * (`existing-folder`, the owner's own words for a folder already on disk). The repository is the main checkout, named by
 * git's common directory, so a ferret in a subfolder or a linked worktree registers the repository, not the place it stands.
 *
 * Nothing already registered is touched: a repository that is known (by its folder or by its git directory) is left exactly
 * as it is, so a renamed project or one with accounts is never rewritten by a start. A repository whose common directory is
 * not the `.git` of a main checkout (bare, a submodule's) is not guessed at, and neither is one whose named root git does
 * not itself call a checkout of that repository (a bare repository that happens to be named `.git`). Ambient places
 * ({@link isAmbientRoot}) and Ferretry's own home are never registered.
 */
export async function discoverProject(
  started: Pick<FerretStartedPayload, 'folder'>,
  folders: ProjectFolders,
  registry: ProjectRegistry,
): Promise<void> {
  const common = await folders.gitCommonDirectory(started.folder);
  if (common === undefined || basename(common) !== '.git') return;
  const root = dirname(common);
  if (isAmbientRoot(root, await folders.home())) return;
  if (!(await folders.mayName(root))) return;
  if (!(await folders.isCheckout(root, common))) return;
  const known = await registry.list();
  if (known.some(project => project.path === root || project.git?.commonDirectory === common)) return;
  await registry.register({ kind: 'existing-folder', path: root });
}
