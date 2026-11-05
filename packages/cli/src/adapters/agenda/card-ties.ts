import type { TaskRef } from '@ferretry/protocol';
import type { IAgendaCardTies } from '../../lib/agenda/ports';
import type { IBoardGateway } from '../../lib/board/ports';

/**
 * What a card depends on and what depends on it, read from the board's card route: `fy agenda add --task` lists an
 * open agenda carrying one of them first (dependent things share one agenda). A card the board cannot read (a typo,
 * an older daemon, a board that is off) has no ties, so the add goes on without them.
 */
export class BoardCardTies implements IAgendaCardTies {
  constructor(private readonly board: Pick<IBoardGateway, 'task'>) {}

  async ties(card: TaskRef) {
    try {
      const { task } = await this.board.task(card.id);
      return { dependsOn: task.dependsOn.map(dependency => dependency.task), blocks: task.blocks };
    } catch {
      return undefined;
    }
  }
}
