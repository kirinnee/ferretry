/**
 * THE FERRET'S CARDS: what one ferret's side panel reads.
 *
 * One read of the board (this machine, this ferret's project) through the store, so the chip, the panel and the
 * drawer draw the same card and a change reaches them together.
 */

import { useMemo } from 'react';
import { type BoardChat, chatCards, chatChip, descendantSessionIds, type FerretLineage } from '../lib/board-chat.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/machine.ts';
import type { CardRef } from '../../contract/index.ts';
import { type BoardMachine, useBoard } from './use-board.ts';

export interface UseChatCardInput {
  readonly store: DaemonBoardStore;
  readonly connection: DaemonConnection;
  readonly machineName: string;
  readonly ferret: string;
  /** The ferret's focus card, when the host knows it. */
  readonly focus: CardRef | null;
  /** The machine's ferrets, for the helpers' cards. */
  readonly ferrets: readonly FerretLineage[] | undefined;
  /** "Internal": the panel draws the cards ferrets made for other ferrets. */
  readonly agents: boolean;
}

export const useChatCard = ({
  store,
  connection,
  machineName,
  ferret,
  focus,
  ferrets,
  agents,
}: UseChatCardInput): BoardChat => {
  const machines = useMemo<readonly BoardMachine[]>(
    () => [{ connection, name: machineName }],
    [connection, machineName],
  );
  // Every card is read, agent cards too: the header chip must find a helper's own focus card. What the panel
  // draws is `chatCards`' business.
  const filters = useMemo(() => ({ ...NO_BOARD_FILTERS, project: null, agents: true }), []);
  const board = useBoard(store, machines, filters);
  const relatives = useMemo(() => descendantSessionIds(ferrets ?? [], ferret), [ferrets, ferret]);
  const { model, status } = board;
  const daemonId = connection.daemonId;
  const cards = useMemo(
    () => chatCards(model, { daemonId, sessionId: ferret, focus, relatives, agents }),
    [model, daemonId, ferret, focus, relatives, agents],
  );
  const chip = useMemo(
    () => chatChip(focus ?? undefined, cards.focus, cards.focus === null ? undefined : cards.places.get(cards.focus.key), status),
    [focus, cards, status],
  );
  return useMemo(
    () => ({ chip, cards, status, refresh: board.refresh, agents, splitsAgents: model.splitsAgents }),
    [chip, cards, status, board.refresh, agents, model.splitsAgents],
  );
};
