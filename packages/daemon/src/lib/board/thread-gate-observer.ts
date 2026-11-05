/**
 * An agenda that carries a card (docs/agenda.md § Card asks): a ferret's own item about the card, or any item carrying
 * one of the card's asks. Opening, answering or closing one changes where the card's ask belongs (a new agenda that
 * carries the card takes the next ask; an ask on an agenda the owner closed is settled), so the asks look again.
 */
import type { AgendaItem, BoardTaskId } from '@ferretry/protocol';
import type { AgendaBoardChange, AgendaChangeObserver } from '../agenda/index.ts';

/** The cards a change to an agenda item could affect the ask of: the card a ferret's item is about, and every card it asks for. */
const threadCardsOf = (item: AgendaItem | undefined): readonly BoardTaskId[] => {
  if (item === undefined || item.notice === true) return [];
  const task = item.task;
  const own =
    item.raisedBy === 'agent' && item.gate === undefined && task !== undefined && task !== null ? [task.id] : [];
  return [...new Set([...own, ...(item.cardAsks ?? []).map(ask => ask.gate.cardId)])];
};

/** The first of {@link threadCardsOf}, for a caller that names one card. */
export const threadCardOf = (item: AgendaItem | undefined): BoardTaskId | undefined => threadCardsOf(item)[0];

export class ThreadGateObserver implements AgendaChangeObserver {
  constructor(private readonly gates: { written(id: BoardTaskId): Promise<void> }) {}

  async changed(_sessionId: string, change: AgendaBoardChange): Promise<void> {
    // The daemon's own card-ask writes come from the asks themselves: looking again would only loop.
    if (change.actor.kind === 'daemon' && change.actor.cause === 'system') return;
    const cards = new Set([...threadCardsOf(change.item), ...threadCardsOf(change.addressed)]);
    // DETACHED: the change is committed, and reconciling takes the card's lock and may write this very agenda.
    for (const cardId of cards) void this.gates.written(cardId).catch(() => undefined);
  }
}
