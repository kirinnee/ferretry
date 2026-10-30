/**
 * THE AGENDA'S LINK TO CARDS (`board-design.md` §2.6): which open agenda items name each card, and which of
 * those block the work now. The agenda store owns the fact; a card only DERIVES "Waiting on you" from it,
 * so the task store holds no copy and resolving the item clears it with no write to the card.
 *
 * An item lives in the agenda of the session that raised it. The sessions read are the ferrets on the
 * board — every card's owner and assignee — because they are the ones that raise an item for a card: by
 * `fy agenda add --task`, or by the daemon taking the raising session's focus card, which only a ferret
 * that may work the card can hold. A notice is context, never an ask, so it is not counted.
 */
import type { AgendaRef, AttentionItem, BoardTask, BoardTaskId, TaskRef } from '@ferretry/protocol';
import { effectiveAssignee } from './authority.ts';
import type { AgendaLinkSource, CardAsks } from './ports.ts';

/** One session's open agenda items, read through the agenda's own reader. Empty for a session with none. */
export interface AgendaItemsReader {
  open(sessionId: string): Promise<readonly AttentionItem[]>;
}

/** How many agendas are read at once. */
export const AGENDA_READ_CONCURRENCY = 16;

/** Whether an item's card reference names a card of this machine. */
const isLocal = (ref: TaskRef, machineId: string | undefined): boolean =>
  ref.machineId === undefined || ref.machineId === machineId;

export class AgendaCardLinks implements AgendaLinkSource {
  constructor(
    private readonly agendas: AgendaItemsReader,
    private readonly machineId: () => string | undefined,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async asksFor(cards: readonly BoardTask[]): Promise<ReadonlyMap<BoardTaskId, CardAsks>> {
    const wanted = new Set(cards.map(card => card.id));
    const sessions = [...new Set(cards.flatMap(card => [card.owner, effectiveAssignee(card)]))];
    const machine = this.machineId();
    const asks = new Map<BoardTaskId, { open: AgendaRef[]; blocking: AgendaRef[] }>();
    for (let start = 0; start < sessions.length; start += AGENDA_READ_CONCURRENCY) {
      const batch = sessions.slice(start, start + AGENDA_READ_CONCURRENCY);
      const read = await Promise.all(batch.map(async sessionId => [sessionId, await this.read(sessionId)] as const));
      for (const [sessionId, items] of read) {
        for (const item of items) {
          const task = item.task;
          if (task === undefined || task === null || item.notice === true) continue;
          if (!isLocal(task, machine) || !wanted.has(task.id)) continue;
          const entry = asks.get(task.id) ?? { open: [], blocking: [] };
          const ref = { sessionId, id: item.id };
          entry.open.push(ref);
          if (item.blockingNow === true) entry.blocking.push(ref);
          asks.set(task.id, entry);
        }
      }
    }
    return asks;
  }

  /** An agenda that cannot be read costs its asks, never the board read. */
  private async read(sessionId: string): Promise<readonly AttentionItem[]> {
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
