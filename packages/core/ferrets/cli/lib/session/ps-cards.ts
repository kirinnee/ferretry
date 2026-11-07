import { type BoardProject, type BoardResponse, MAX_BOARD_PAGE } from '@ferretry/protocol';
import type { IBoardGateway } from '../board/ports.ts';

/**
 * The board reads the CARD column of `ps` is named from.
 *
 * One page across every project (`state: 'all'`, so a closed or dropped focus card still names its
 * lane) plus the projects listing that carries each board's lanes — a cross-project read has no
 * lane set of its own to read names from. Two daemon calls however many cards are on screen; a
 * card the page missed (a board longer than the page cap) simply shows its id alone.
 */

/** The reads this needs from the board client, and nothing that writes. */
export type BoardLaneSource = Pick<IBoardGateway, 'board' | 'projects'>;

/** Each card the page covered, keyed by id with its lane name; a card on no listed lane is absent. */
export function laneNamesFrom(page: BoardResponse, projects: readonly BoardProject[]): Map<string, string> {
  const laneSets = new Map(projects.map(project => [project.id, project.laneSet]));
  const names = new Map<string, string>();
  for (const card of page.cards) {
    const lane = laneSets.get(card.projectId)?.lanes.find(lane => lane.id === card.laneId);
    if (lane !== undefined) names.set(card.id, lane.name);
  }
  return names;
}

/** The one read behind `ps`: every board's cards and lane names together. */
export async function boardLaneNames(board: BoardLaneSource): Promise<ReadonlyMap<string, string>> {
  const [page, listing] = await Promise.all([
    board.board({ state: 'all', limit: MAX_BOARD_PAGE }),
    board.projects(undefined),
  ]);
  return laneNamesFrom(page, listing.projects);
}
