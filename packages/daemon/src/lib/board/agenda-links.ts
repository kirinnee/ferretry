/**
 * THE AGENDA'S LINK TO CARDS (`board-design.md` §2.6; docs/agenda.md § Card asks): which open agendas carry each card,
 * and which of those carry its ask the owner has yet to answer. The agenda store owns the fact; a card only DERIVES
 * from it (its `openAsks`, and that it is never stale while its ask is open), so the task store holds no copy and
 * closing the agenda clears it with no write to the card.
 *
 * An agenda carries a card when it is about the card (`task`, or a card a merge brought in) or carries one of the
 * card's asks. An item lives in the agenda of the session that raised it, or of the ferret the daemon raised it for;
 * the sessions read are the ferrets on the board — every card's owner and assignee — and their agenda homes, because
 * a card's ask goes on its ferret's home. A notice is context, never an ask, so it is not counted.
 */
import {
  type AgendaItem,
  type AgendaRef,
  type BoardTask,
  type BoardTaskId,
  carriesCard,
  openCardAsks,
} from '@ferretry/protocol';
import { effectiveAssignee } from './authority.ts';
import type { AgendaLinkSource, CardAsks } from './ports.ts';

/** One session's open agenda items, read through the agenda's own reader. Empty for a session with none. */
export interface AgendaItemsReader {
  open(sessionId: string): Promise<readonly AgendaItem[]>;
}

/** Where a session's agenda lives: its agenda home, the owner's own ferret at the root of its lineage. */
export interface AgendaHomeLookup {
  of(sessionId: string): Promise<string>;
}

/** How many agendas are read at once. */
export const AGENDA_READ_CONCURRENCY = 16;

/** Every session is its own home: for a board without sub-ferrets, and the tests. */
const SELF_HOMES: AgendaHomeLookup = { of: async sessionId => sessionId };

export class AgendaCardLinks implements AgendaLinkSource {
  constructor(
    private readonly agendas: AgendaItemsReader,
    private readonly machineId: () => string | undefined,
    private readonly diagnostics: { warn(message: string): void },
    private readonly homes: AgendaHomeLookup = SELF_HOMES,
  ) {}

  async asksFor(
    cards: readonly BoardTask[],
    board: readonly BoardTask[] = cards,
  ): Promise<ReadonlyMap<BoardTaskId, CardAsks>> {
    const ferrets = [...new Set(board.flatMap(card => [card.owner, effectiveAssignee(card)]))];
    // In batches like the agenda reads below: a board of thousands of ferrets must not land its home walks in one burst.
    const homes: string[] = [];
    for (let start = 0; start < ferrets.length; start += AGENDA_READ_CONCURRENCY) {
      const batch = ferrets.slice(start, start + AGENDA_READ_CONCURRENCY);
      homes.push(...(await Promise.all(batch.map(async each => await this.homes.of(each).catch(() => each)))));
    }
    const sessions = [...new Set([...ferrets, ...homes])];
    const machine = this.machineId();
    const asks = new Map<BoardTaskId, { open: AgendaRef[]; asking: AgendaRef[] }>();
    for (let start = 0; start < sessions.length; start += AGENDA_READ_CONCURRENCY) {
      const batch = sessions.slice(start, start + AGENDA_READ_CONCURRENCY);
      const read = await Promise.all(batch.map(async sessionId => [sessionId, await this.read(sessionId)] as const));
      for (const [sessionId, items] of read) {
        for (const item of items) {
          if (item.notice === true) continue;
          const ref = { sessionId, id: item.id };
          for (const card of cards) {
            if (!carriesCard(item, card.id, machine)) continue;
            const entry = asks.get(card.id) ?? { open: [], asking: [] };
            entry.open.push(ref);
            if (openCardAsks(item).some(ask => ask.gate.cardId === card.id)) entry.asking.push(ref);
            asks.set(card.id, entry);
          }
        }
      }
    }
    return asks;
  }

  /** An agenda that cannot be read costs its asks, never the board read. */
  private async read(sessionId: string): Promise<readonly AgendaItem[]> {
    try {
      return await this.agendas.open(sessionId);
    } catch (error) {
      this.diagnostics.warn(
        `could not read the agenda of ${sessionId} for its cards: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
