/**
 * A thread on a card's gate (docs/board.md § Gates ask the owner): an agent-raised, owner-facing agenda item linked to
 * the card stands in for the gate's own item. Opening, answering or closing such a thread therefore changes whether the
 * card's gate still needs an item of its own, and this tells the gates to look again.
 */
import type { AgendaItem, BoardTaskId } from '@ferretry/protocol';
import type { AgendaBoardChange, AgendaChangeObserver } from '../agenda/index.ts';

/** The card a change to an agenda item could affect the gate of: the agent's own thread on it, never a gate item or notice. */
export const threadCardOf = (item: AgendaItem | undefined): BoardTaskId | undefined => {
  const task = item?.task;
  if (item === undefined || task === undefined || task === null) return undefined;
  return item.raisedBy === 'agent' && item.gate === undefined && item.notice === undefined ? task.id : undefined;
};

export class ThreadGateObserver implements AgendaChangeObserver {
  constructor(private readonly gates: { written(id: BoardTaskId): Promise<void> }) {}

  async changed(_sessionId: string, change: AgendaBoardChange): Promise<void> {
    const cardId = threadCardOf(change.item) ?? threadCardOf(change.addressed);
    if (cardId === undefined) return;
    // DETACHED: the change is committed, and reconciling takes the card's lock and may write this very agenda.
    void this.gates.written(cardId).catch(() => undefined);
  }
}
