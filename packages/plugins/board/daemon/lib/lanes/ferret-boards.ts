/**
 * THE BOARD A FERRET'S FOLDER BELONGS TO, asked again now rather than at its start: for the Unfiled cards of
 * ferrets that started before their repository was a project, or before projects registered themselves. The
 * first rule that answers wins:
 *
 *   1. the board the ferret was stamped with, when that is a project's;
 *   2. the board its folder resolves to now (`resolveFerretProject`: its parent's, its repository's, the
 *      registered folder that contains it);
 *   3. its repository registered as a project, by the rules a ferret's first card follows
 *      (`ProjectAdoption`: never the home folder, a temp or scratch folder, a folder that is not a git
 *      repository, or one outside every project root). That also moves the ferret onto the new board.
 *
 * `null` when none answers, or for a ferret this daemon does not know.
 */
import { type BoardProjectId, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import type { FerretProjectFactSource, FerretProjects } from './ferret-projects.ts';
import type { ProjectAdoption } from './project-adoption.ts';

export class FerretBoardResolver {
  constructor(
    private readonly ferrets: FerretProjectFactSource,
    private readonly projects: Pick<FerretProjects, 'projectForStart'>,
    private readonly adoption: Pick<ProjectAdoption, 'adopt'>,
  ) {}

  async boardOf(ferretId: string): Promise<BoardProjectId | null> {
    const facts = await this.ferrets.read(ferretId);
    if (facts === null) return null;
    if (facts.projectId !== undefined && facts.projectId !== UNFILED_PROJECT_ID) return facts.projectId;
    const resolved = await this.projects.projectForStart({
      folder: facts.folder,
      ...(facts.parent === undefined ? {} : { parent: facts.parent }),
    });
    if (resolved !== UNFILED_PROJECT_ID) return resolved;
    return (await this.adoption.adopt(ferretId))?.projectId ?? null;
  }
}
