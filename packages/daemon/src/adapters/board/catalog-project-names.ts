import { type BoardProjectId, type ProjectList, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import type { BoardProjectNames } from '../../lib/board/index.ts';

/** What the Unfiled board is called where the owner reads it. */
export const UNFILED_BOARD_NAME = 'Unfiled';

/**
 * A board's name from the project registry (`projects.json`). A project the registry no longer lists, or a
 * registry that cannot be read, is named by its id rather than refusing the start that asked.
 */
export class CatalogProjectNames implements BoardProjectNames {
  constructor(private readonly catalog: { projects(): Promise<ProjectList> }) {}

  async nameOf(projectId: BoardProjectId): Promise<string> {
    if (projectId === UNFILED_PROJECT_ID) return UNFILED_BOARD_NAME;
    const projects = await this.catalog.projects().catch(() => []);
    return projects.find(project => project.id === projectId)?.name ?? projectId;
  }
}
