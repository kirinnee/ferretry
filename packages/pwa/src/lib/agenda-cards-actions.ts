/**
 * WHAT A NOTICE'S CARDS FORM DOES (`AgendaItem.cards`, one Send for every card's pick), as the board's own writes: Open goes to the
 * card's page, Start a ferret is `POST /v1/board/tasks/:id/start` (a NEW ferret on the card, or the one that already holds it), Close is the board's drop with the
 * reason the owner confirmed. Nothing here is a second path to the daemon: each is the verb the board page uses,
 * so the daemon's authorization applies to it exactly as it does there, and a refusal comes back in its words.
 */

import type { BoardTaskId } from '@ferretry/protocol';
import type { AgendaCardOutcome, AgendaCardsActions } from '../features/agenda/agenda-cards-list.tsx';
import type { BoardActions } from './board-actions.ts';
import type { DaemonId } from './daemon-connection.ts';
import { daemonBoardCardPath, daemonSessionPath } from './pages/routes.ts';

export const agendaCardsActions = (
  board: Pick<BoardActions, 'start' | 'drop'>,
  daemonId: DaemonId,
  onNavigate: (to: string) => void,
): AgendaCardsActions => {
  const target = (id: BoardTaskId) => ({ daemonId, id });
  const refused = (message: string): AgendaCardOutcome => ({ ok: false, message });
  // One key per Start click: kept while the request got no answer (the next click is a retry of it, and the daemon
  // answers a repeat with the first result), dropped once the daemon has answered, so a later click is new work.
  const pending = new Map<BoardTaskId, string>();
  return {
    cardPath: id => daemonBoardCardPath(daemonId, id),
    chatPath: sessionId => daemonSessionPath(daemonId, sessionId),
    open: id => onNavigate(daemonBoardCardPath(daemonId, id)),
    start: async id => {
      const key = pending.get(id) ?? crypto.randomUUID();
      pending.set(id, key);
      const started = await board.start(target(id), key);
      if (started.ok || started.error.status !== 0) pending.delete(id);
      return started.ok
        ? started.value.started
          ? { ok: true, note: 'Started: a new ferret is working on this card.' }
          : { ok: true, ferret: started.value.sessionId, note: 'A ferret is already working on this card.' }
        : refused(started.error.message);
    },
    openChat: sessionId => onNavigate(daemonSessionPath(daemonId, sessionId)),
    close: async (id, reason) => {
      const dropped = await board.drop(target(id), reason);
      return dropped.ok ? { ok: true, note: 'Closed. The card is off the board.' } : refused(dropped.error.message);
    },
  };
};
