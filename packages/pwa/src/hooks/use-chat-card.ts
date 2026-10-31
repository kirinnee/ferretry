/**
 * THE CHAT'S CARD: what one session's header chip, Info row and Tasks tab all read.
 *
 * One read of the board (this machine, this session's project) through the U10 store, so the three
 * places draw the same card and a change reaches them together. A host with no board store reads nothing.
 */

import type { SessionView } from '@ferretry/protocol';
import { useMemo } from 'react';
import { type BoardChat, chatCards, chatChip, descendantSessionIds } from '../lib/board-chat.ts';
import type { BoardPort } from '../lib/board-client.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type BoardMachine, useBoard } from './use-board.ts';

/** The store a host without a board is given: with no machine to read it never reaches its port. */
const refuse = (): Promise<never> => Promise.reject(new Error('this host has no board'));
const IDLE_PORT: BoardPort = {
  board: refuse,
  task: refuse,
  projects: refuse,
  lanes: refuse,
  create: refuse,
  version: refuse,
  act: refuse,
};
const IDLE_STORE = new DaemonBoardStore(IDLE_PORT);
const NO_MACHINES: readonly BoardMachine[] = [];

export interface UseChatCardInput {
  /** Absent: the host has no board, and the chat shows no card at all. */
  readonly store: DaemonBoardStore | undefined;
  readonly connection: DaemonConnection;
  readonly machineName: string;
  readonly session: SessionView;
  /** The machine's sessions, for the sub-ferrets' cards. */
  readonly sessions: readonly SessionView[] | undefined;
  /**
   * Whether anything on screen needs the cards read. A session with no focus card and no Tasks tab open
   * costs the daemon nothing: the chip says `No card` from the session's own config.
   */
  readonly reading: boolean;
  /** "Show agent tasks": the Tasks tab draws the cards ferrets made for other ferrets. */
  readonly agents: boolean;
}

export const useChatCard = ({
  store,
  connection,
  machineName,
  session,
  sessions,
  reading,
  agents,
}: UseChatCardInput): BoardChat | null => {
  const machines = useMemo<readonly BoardMachine[]>(
    () => (store === undefined || !reading ? NO_MACHINES : [{ connection, name: machineName }]),
    [store, reading, connection, machineName],
  );
  const projectId = session.config.projectId ?? null;
  // Every card is read, agent cards too: the header chip must find a sub-ferret's own focus card. What the
  // Tasks tab draws is `chatCards`' business.
  const filters = useMemo(() => ({ ...NO_BOARD_FILTERS, project: projectId, agents: true }), [projectId]);
  const board = useBoard(store === undefined || !reading ? IDLE_STORE : store, machines, filters);
  const focus = session.config.focusTask;
  const relatives = useMemo(
    () => descendantSessionIds(sessions ?? [], session.config.id),
    [sessions, session.config.id],
  );
  const { model, status } = board;
  const daemonId = connection.daemonId;
  const sessionId = session.config.id;
  const cards = useMemo(
    () => chatCards(model, { daemonId, sessionId, focus: focus ?? null, relatives, agents }),
    [model, daemonId, sessionId, focus, relatives, agents],
  );
  const chip = useMemo(
    () => chatChip(focus, cards.focus, cards.focus === null ? undefined : cards.places.get(cards.focus.key), status),
    [focus, cards, status],
  );
  return useMemo(
    () =>
      store === undefined
        ? null
        : { chip, cards, status, refresh: board.refresh, agents, splitsAgents: model.splitsAgents },
    [store, chip, cards, status, board.refresh, agents, model.splitsAgents],
  );
};
