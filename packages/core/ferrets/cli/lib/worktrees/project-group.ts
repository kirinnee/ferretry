import { z } from 'zod';
import { projectGroup } from '../../../contract/worktree-move.ts';
export { projectGroup } from '../../../contract/worktree-move.ts';

/**
 * What `--project` needs of a registered project: its id and its name, nothing more.
 *
 * Ferrets does not know what a project is. It asks the registry the daemon already serves (`GET /v1/projects`), reads
 * these two fields, and hands the daemon one opaque folder name — the daemon never learns the word.
 */
const RegisteredProjectsSchema = z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }));

export const PROJECTS_ROUTE = 'GET /v1/projects';

/** Resolves a typed project (its name, case-insensitively, or its id) to its group, refusing none and several by name. */
export async function resolveProjectGroup(typed: string, readProjects: () => Promise<unknown>): Promise<string> {
  const wanted = typed.trim();
  if (wanted === '') throw new Error('--project needs a project name');
  const projects = RegisteredProjectsSchema.parse(await readProjects());
  const matches = projects.filter(
    project => project.id === wanted || project.name.toLowerCase() === wanted.toLowerCase(),
  );
  const [only, ...others] = matches;
  if (only === undefined) {
    const known = projects.map(project => project.name).join(', ');
    throw new Error(
      `no registered project is named ${JSON.stringify(wanted)}${known === '' ? '' : ` (known: ${known})`}`,
    );
  }
  if (others.length > 0)
    throw new Error(`${matches.length} projects are named ${JSON.stringify(wanted)}; pass the project id`);
  return projectGroup(only);
}
