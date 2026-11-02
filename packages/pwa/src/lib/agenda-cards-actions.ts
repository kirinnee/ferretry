/**
 * THE THREE BUTTONS OF A CARD IN A NOTICE (`AgendaItem.cards`), as the board's own writes: Open card goes to the
 * card's page, Start a ferret on it is `POST /v1/board/tasks/:id/start`, Close card is the board's drop with the
 * reason the owner confirmed. Nothing here is a second path to the daemon: each is the verb the board page uses,
 * so the daemon's authorization applies to it exactly as it does there, and a refusal comes back in its words.
 */

import type { BoardTaskId } from '@ferretry/protocol';
import type { AgendaCardOutcome, AgendaCardsActions } from '../features/agenda/agenda-cards-list.tsx';
import type { BoardActions } from './board-actions.ts';
import type { DaemonId } from './daemon-connection.ts';
import { daemonBoardCardPath } from './pages/routes.ts';

export const agendaCardsActions = (
  board: Pick<BoardActions, 'start' | 'drop'>,
  daemonId: DaemonId,
  onNavigate: (to: string) => void,
): AgendaCardsActions => {
  const target = (id: BoardTaskId) => ({ daemonId, id });
  const refused = (message: string): AgendaCardOutcome => ({ ok: false, message });
  return {
    open: id => onNavigate(daemonBoardCardPath(daemonId, id)),
    start: async id => {
      const started = await board.start(target(id));
      return started.ok
        ? { ok: true, note: 'Started: the last ferret on this card is back on it.' }
        : refused(started.error.message);
    },
    close: async (id, reason) => {
      const dropped = await board.drop(target(id), reason);
      return dropped.ok ? { ok: true, note: 'Closed. The card is off the board.' } : refused(dropped.error.message);
    },
  };
};
