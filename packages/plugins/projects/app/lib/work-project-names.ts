import { z } from 'zod';
import type { ProjectsClient } from './client.ts';

/**
 * THE NAMES OF A MACHINE'S PROJECTS, for labelling the cards the work search finds. A hit carries only its project's id
 * (a UUID, or `unfiled`), which no reader can use. The names are Board's list of board projects, read by route key
 * (`GET /v1/board/projects`) because that list also holds the Unfiled board; with Board off the read is refused and the
 * map is empty, so a hit shows its id rather than a guess.
 */
export const BOARD_PROJECTS_ROUTE = 'GET /v1/board/projects';

const BoardProjectNamesSchema = z.looseObject({
  projects: z.array(z.looseObject({ id: z.string().min(1), name: z.string().min(1) })),
});

export const workProjectNames = (
  projects: readonly { readonly id: string; readonly name: string }[],
): ReadonlyMap<string, string> => new Map(projects.map(project => [project.id, project.name] as const));

export const readWorkProjectNames = async (client: ProjectsClient): Promise<ReadonlyMap<string, string>> =>
  workProjectNames(BoardProjectNamesSchema.parse(await client.call(BOARD_PROJECTS_ROUTE)).projects);
