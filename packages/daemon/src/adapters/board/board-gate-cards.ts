/**
 * The board as the gate items read and write it (`GateBoard`): a card's view with its lanes, its board's name and
 * who asked for it, and the owner's act on it through the one `BoardService`, so authority, history and the
 * reopen and done ladders are the board's own.
 */
import type { BoardProjectId, BoardTaskActionRequest, BoardTaskId, BoardTaskView, LaneSet } from '@ferretry/protocol';
import {
  type BoardCaller,
  BoardError,
  type BoardService,
  cardAudience,
  type GateBoard,
  type GateCard,
} from '../../lib/board/index.ts';

/** A board's name, when it has one: the gate item says where the card waits. */
export interface GateProjectNames {
  project(projectId: BoardProjectId): Promise<{ readonly name: string } | undefined>;
}

export class BoardGateCards implements GateBoard {
  constructor(
    private readonly board: Pick<BoardService, 'task' | 'sweepBoard' | 'act'>,
    private readonly projects: GateProjectNames,
  ) {}

  async card(id: BoardTaskId): Promise<GateCard | undefined> {
    try {
      const found = await this.board.task(id);
      return await this.gateCard(found.task, found.laneSet);
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not-found') return undefined;
      throw error;
    }
  }

  async cards(): Promise<readonly GateCard[]> {
    const { views, laneSets } = await this.board.sweepBoard();
    const names = new Map<BoardProjectId, string | undefined>();
    for (const projectId of new Set(views.map(view => view.projectId))) {
      names.set(projectId, (await this.projects.project(projectId).catch(() => undefined))?.name);
    }
    return views.map(view => cardOf(view, laneSets.get(view.projectId) ?? null, names.get(view.projectId)));
  }

  async act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller): Promise<void> {
    await this.board.act(id, request, caller);
  }

  private async gateCard(view: BoardTaskView, laneSet: LaneSet | null): Promise<GateCard> {
    const name = (await this.projects.project(view.projectId).catch(() => undefined))?.name;
    return cardOf(view, laneSet, name);
  }
}

const cardOf = (view: BoardTaskView, laneSet: LaneSet | null, projectName: string | undefined): GateCard => ({
  task: view,
  laneSet,
  audience: cardAudience(view),
  ...(projectName === undefined ? {} : { projectName }),
});
