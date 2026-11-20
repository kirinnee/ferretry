/**
 * The cards a machine notice is about (`AgendaItem.cards`), as one form wired to the board. The rows are the
 * daemon's; each pick the one Send does is the board's own write (`agendaCardsActions`), so a card is opened, started or
 * closed here with the same authority, and the same refusals, as on the board page.
 * Outside the app store (a harness) the board is idle: Open still goes to the card, Start and Close are refused.
 */

import type { AgendaCardRow } from '@ferretry/protocol';
import { useMemo } from 'react';
import { agendaCardsActions } from '../../lib/agenda-cards-actions.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useBoardActions } from '../../hooks/use-board.ts';
import { IDLE_STORE } from '../../hooks/use-chat-card.ts';
import { useOptionalAppStore } from '../../lib/store.tsx';
import { AgendaCardsList } from './agenda-cards-list.tsx';

export interface AgendaCardsHostProps {
  readonly connection: DaemonConnection;
  readonly cards: readonly AgendaCardRow[];
  readonly onNavigate: (to: string) => void;
  /** Every card's pick took: the notice is answered. */
  readonly onSent?: (() => void) | undefined;
}

const NO_AGENDA = { respond: () => Promise.reject(new Error('this host has no agenda')) };

export function AgendaCardsHost({ connection, cards, onNavigate, onSent }: AgendaCardsHostProps) {
  const store = useOptionalAppStore();
  const machines = useMemo(() => [connection], [connection]);
  const board = useBoardActions(store?.board ?? IDLE_STORE, store?.attention ?? NO_AGENDA, machines);
  const actions = useMemo(
    () => agendaCardsActions(board, connection.daemonId, onNavigate),
    [board, connection.daemonId, onNavigate],
  );
  return <AgendaCardsList actions={actions} cards={cards} onSent={onSent} />;
}
