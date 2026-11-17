/**
 * The tasks a machine notice is about (`AgendaItem.cards`), with their buttons. The rows are the daemon's; the three
 * buttons are Board's writes (`agendaCardsActions`): Open goes to the task's page (Board's `task` screen, when Board is
 * installed), Start and Close are made through the {@link AgendaTasksBoard} the screen binds to Board's
 * `agenda.card-answer` hook ({@link AgendaTasksBoardProvider}, `agenda-board-hooks.tsx`). Without that hook (Board not
 * installed, or not allowed on this machine) the board is idle: Open still goes to the task, and Start and Close are
 * refused with the reason.
 */

import type { AgendaTaskRow } from '@ferretry/core-asks/contract';
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { type AgendaTasksBoard, agendaCardsActions, boardErr } from '../../lib/agenda-cards-actions.ts';
import { useAgendaLinks } from '../../lib/agenda-links.ts';
import type { DaemonConnection } from '../../shell.ts';
import { AgendaCardsList } from './agenda-cards-list.tsx';

export interface AgendaCardsHostProps {
  readonly connection: DaemonConnection;
  readonly cards: readonly AgendaTaskRow[];
  readonly onNavigate?: (to: string) => void;
}

const NOT_HERE = 'Tasks are Board’s, and Board is not reachable from here: open the task to do this on its page.';

/** The board when no host provides one: every write is refused, saying where it can be made. */
const IDLE_BOARD: AgendaTasksBoard = {
  start: async () => boardErr({ status: 503, message: NOT_HERE }),
  drop: async () => boardErr({ status: 503, message: NOT_HERE }),
};

const AgendaTasksBoardContext = createContext<AgendaTasksBoard>(IDLE_BOARD);

/**
 * Hands the notices below it the board their Start and Close write through.
 */
export function AgendaTasksBoardProvider({
  board,
  children,
}: {
  readonly board: AgendaTasksBoard;
  readonly children?: ReactNode;
}) {
  return <AgendaTasksBoardContext.Provider value={board}>{children}</AgendaTasksBoardContext.Provider>;
}

const NOWHERE = (): void => undefined;

export function AgendaCardsHost({ connection, cards, onNavigate = NOWHERE }: AgendaCardsHostProps) {
  const board = useContext(AgendaTasksBoardContext);
  // The route table may be rebuilt on any render; the actions (and the retry key of a Start in flight) must not be.
  const current = useAgendaLinks();
  const links = useRef(current);
  links.current = current;
  const actions = useMemo(
    () =>
      agendaCardsActions(board, connection.daemonId, onNavigate, {
        card: (daemonId, id) => links.current.card(daemonId, id),
        chat: (daemonId, ferret) => links.current.chat(daemonId, ferret),
      }),
    [board, connection.daemonId, onNavigate],
  );
  return <AgendaCardsList actions={actions} cards={cards} />;
}
