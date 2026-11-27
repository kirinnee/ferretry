import { basename, dirname } from 'node:path';
import type { FerretStartedPayload } from '@ferretry/core-ferrets/contract';
import type { ProjectFolders } from './ports.ts';
import type { ProjectRegistry } from './registry.ts';

/**
 * A ferret started somewhere: when that is inside a git repository nobody registered, the repository becomes a project
 * (`existing-folder`, the owner's own words for a folder already on disk). The repository is the main checkout, named by
 * git's common directory, so a ferret in a subfolder or a linked worktree registers the repository, not the place it stands.
 *
 * Nothing already registered is touched: a repository that is known (by its folder or by its git directory) is left exactly
 * as it is, so a renamed project or one with accounts is never rewritten by a start. A repository whose common directory is
 * not the `.git` of a main checkout (bare, a submodule's) is not guessed at.
 */
export async function discoverProject(
  started: Pick<FerretStartedPayload, 'folder'>,
  folders: ProjectFolders,
  registry: ProjectRegistry,
): Promise<void> {
  const common = await folders.gitCommonDirectory(started.folder);
  if (common === undefined || basename(common) !== '.git') return;
  const root = dirname(common);
  const known = await registry.list();
  if (known.some(project => project.path === root || project.git?.commonDirectory === common)) return;
  await registry.register({ kind: 'existing-folder', path: root });
}
