/**
 * The cards a machine notice is about (`AgendaItem.cards`), with their buttons. The rows are the daemon's; the three
 * buttons are Board's writes (`agendaCardsActions`): Open goes to the card's page (Board's `card` screen, when Board is
 * installed), Start and Close are made through the {@link AgendaCardsBoard} a host provides
 * ({@link AgendaCardsBoardProvider}). Agenda has no need on Board's routes, so without a host the board is idle: Open
 * still goes to the card, Start and Close are refused with the reason — today's harness behaviour, and now the shell's
 * until Board contributes the board (GAP(cards-board)).
 */

import type { AgendaCardRow } from '@ferretry/core-asks/contract';
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { type AgendaCardsBoard, agendaCardsActions, boardErr } from '../../lib/agenda-cards-actions.ts';
import { useAgendaLinks } from '../../lib/agenda-links.ts';
import type { DaemonConnection } from '../../shell.ts';
import { AgendaCardsList } from './agenda-cards-list.tsx';

export interface AgendaCardsHostProps {
  readonly connection: DaemonConnection;
  readonly cards: readonly AgendaCardRow[];
  readonly onNavigate?: (to: string) => void;
}

const NOT_HERE = 'Cards are Board’s, and Board is not reachable from here: open the card to do this on its page.';

/** The board when no host provides one: every write is refused, saying where it can be made. */
const IDLE_BOARD: AgendaCardsBoard = {
  start: async () => boardErr({ status: 503, message: NOT_HERE }),
  drop: async () => boardErr({ status: 503, message: NOT_HERE }),
};

const AgendaCardsBoardContext = createContext<AgendaCardsBoard>(IDLE_BOARD);

/** Hands the notices below it the board their Start and Close write through. */
export function AgendaCardsBoardProvider({
  board,
  children,
}: {
  readonly board: AgendaCardsBoard;
  readonly children?: ReactNode;
}) {
  return <AgendaCardsBoardContext.Provider value={board}>{children}</AgendaCardsBoardContext.Provider>;
}

const NOWHERE = (): void => undefined;

export function AgendaCardsHost({ connection, cards, onNavigate = NOWHERE }: AgendaCardsHostProps) {
  const board = useContext(AgendaCardsBoardContext);
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
