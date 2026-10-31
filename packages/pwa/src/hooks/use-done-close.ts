/**
 * THE CARDS AN AGENDA ITEM'S "DONE · CLOSES" WOULD CLOSE, read from the board the app already keeps, and the way
 * to close them through the board's own Done. Nothing is offered outside the app store, before the machine's health
 * has listed the feature, for an item that did not ask, or for a card that is already closed or gone.
 */

import type { AgendaItem, TaskRef } from '@ferretry/protocol';
import { useMemo, useSyncExternalStore } from 'react';
import {
  type CardForClose,
  closeCards,
  closePlan,
  type DoneCloseCard,
  type DoneCloseResult,
  type DoneCloseSource,
  offeredCards,
} from '../lib/agenda-done-close.ts';
import { type BoardTaskState } from '../lib/board-store.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { useOptionalAppStore } from '../lib/store.tsx';
import { IDLE_STORE } from './use-chat-card.ts';
import { useBoardActions, useBoardTask } from './use-board.ts';

const NO_MACHINES: readonly DaemonConnection[] = [];
const NO_AGENDA = { respond: () => Promise.reject(new Error('this host has no agenda')) };
const NO_OFFER = { subscribe: () => () => undefined } as const;

const forClose = (state: BoardTaskState): CardForClose | undefined =>
  state.status !== 'ready' || state.task === null
    ? undefined
    : { laneId: state.task.laneId, dropped: state.task.dropped !== null, laneSet: state.laneSet };

/** A card that is gone or already closed has nothing left to close, so it offers nothing. */
const closable = (state: BoardTaskState): boolean => {
  if (state.missing) return false;
  const card = forClose(state);
  return card === undefined || closePlan(card).kind !== 'closed';
};

export const useDoneClose = (
  daemonId: DaemonId | undefined,
  item: AgendaItem | undefined,
): DoneCloseSource | undefined => {
  const app = useOptionalAppStore();
  const directory = app?.agendaWire;
  const offered = useSyncExternalStore(directory?.subscribe ?? NO_OFFER.subscribe, () =>
    daemonId === undefined ? undefined : directory?.offerCloseOf(daemonId),
  );
  const refs = useMemo(
    () => (daemonId === undefined || item === undefined ? [] : offeredCards(item, offered, daemonId)),
    [daemonId, item, offered],
  );
  const first = refs[0];
  const connection = app?.connections.list().find(record => record.daemonId === daemonId);
  const machines = useMemo(() => (connection === undefined ? NO_MACHINES : [connection]), [connection]);
  const board = app?.board ?? IDLE_STORE;
  const state = useBoardTask(board, first === undefined ? undefined : connection, first?.id ?? '');
  const actions = useBoardActions(board, app?.attention ?? NO_AGENDA, machines);

  return useMemo((): DoneCloseSource | undefined => {
    if (first === undefined || daemonId === undefined || !closable(state)) return undefined;
    const cards: DoneCloseCard[] = [{ ref: first, title: state.task?.title }];
    const closeOne = async (ref: TaskRef): Promise<DoneCloseResult> => {
      const card = forClose(board.taskState(daemonId, ref.id));
      const plan = closePlan(card);
      if (plan.kind === 'closed') return { ok: true };
      if (plan.kind === 'refused' || card === undefined) {
        return { ok: false, message: plan.kind === 'refused' ? plan.message : 'the card could not be read' };
      }
      const moved = await actions.moveTask(
        { daemonId, id: ref.id, laneId: card.laneId, laneSet: card.laneSet },
        plan.laneId,
      );
      return moved.ok ? { ok: true } : { ok: false, message: moved.error.message };
    };
    const close = (targets: readonly TaskRef[]) => closeCards(targets, closeOne);
    return { cards, close };
  }, [first, daemonId, state, board, actions]);
};
