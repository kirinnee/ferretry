import type { AgendaId } from '@ferretry/core-asks/contract';
import type { AgendaInbox } from '../hooks/use-agenda-inbox.ts';
import { type InboxCard, inboxCardKey } from './agenda-inbox.ts';
import type { DaemonId } from './machine.ts';

/** A requested item's identity outlives its place in the deck, including its undo hold. */
export const inboxOpenCard = (
  inbox: AgendaInbox,
  target: { readonly daemonId: DaemonId; readonly sessionId: string; readonly id: AgendaId } | null,
): InboxCard | undefined => {
  if (target === null) return undefined;
  const key = inboxCardKey(target.daemonId, target.sessionId, target.id);
  const { pending, sending, failed } = inbox.deferredState;
  const card = [
    ...inbox.cards,
    ...inbox.withFerret,
    ...inbox.parked,
    ...pending.map(entry => entry.card),
    ...sending.map(entry => entry.card),
    ...failed.map(entry => entry.card),
  ].find(card => card.key === key);
  if (card === undefined) return undefined;
  // Prefer the current board (the daemon's echo), rather than the receipt's earlier snapshot.
  const item = inbox.boardOf?.(target.daemonId, target.sessionId).find(item => item.id === target.id);
  return item === undefined ? card : { ...card, item };
};
