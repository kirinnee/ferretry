/**
 * THE CARDS AN AGENDA ITEM'S "DONE · CLOSES" WOULD CLOSE, and the way to close them through the board's own Done.
 *
 * Cards are Board's, and so is the Done: which lane it moves a card into, and the one request that moves it. This half
 * reads and closes a card only through the `agenda.card-answer` hook Board provides for this daemon
 * (`contract/app-hooks.ts`), handed down by {@link DoneCloseBoardProvider}. Nothing is offered without one, for an item
 * that did not ask, for a card of another machine, or for a card that is already closed or gone.
 */

import type { AgendaItem, TaskRef } from '@ferretry/core-asks/contract';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { AgendaCardAnswer, AgendaCardView } from '../../contract/app-hooks.ts';
import {
  closeCards,
  type DoneCloseCard,
  type DoneCloseResult,
  type DoneCloseSource,
  offeredCards,
} from '../lib/agenda-done-close.ts';
import type { DaemonId } from '../lib/machine.ts';

/** The board a Done · closes reads and closes through: the provided hook, and the daemon it was built for. */
export interface DoneCloseBoard extends Pick<AgendaCardAnswer, 'subscribe' | 'watch' | 'card' | 'done'> {
  readonly daemonId: DaemonId;
}

const DoneCloseBoardContext = createContext<DoneCloseBoard | undefined>(undefined);

/** Hands the ask surfaces below it the board a Done · closes reads and moves cards through. */
export const DoneCloseBoardProvider = (props: {
  readonly board: DoneCloseBoard | undefined;
  readonly children?: ReactNode;
}): ReactNode => createElement(DoneCloseBoardContext.Provider, { value: props.board }, props.children);

const IDLE: AgendaCardView = Object.freeze({ status: 'idle', missing: false, closed: false });
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** A card that is gone or already closed has nothing left to close, so it offers nothing. */
const closable = (state: AgendaCardView): boolean => !state.missing && !(state.status === 'ready' && state.closed);

export const useDoneClose = (
  daemonId: DaemonId | undefined,
  item: AgendaItem | undefined,
): DoneCloseSource | undefined => {
  const provided = useContext(DoneCloseBoardContext);
  // A board is built for one daemon: a card on any other is not its to close.
  const board = provided !== undefined && provided.daemonId === daemonId ? provided : undefined;
  const refs = useMemo(
    () => (daemonId === undefined || item === undefined ? [] : offeredCards(item, daemonId)),
    [daemonId, item],
  );
  const first = refs[0];
  const id = first?.id;
  useEffect(() => (board === undefined || id === undefined ? undefined : board.watch(id)), [board, id]);
  const state = useSyncExternalStore(board?.subscribe ?? NO_SUBSCRIPTION, () =>
    board === undefined || id === undefined ? IDLE : board.card(id),
  );

  return useMemo((): DoneCloseSource | undefined => {
    if (board === undefined || first === undefined || !closable(state)) return undefined;
    const cards: DoneCloseCard[] = [{ ref: first, title: state.title }];
    const closeOne = async (ref: TaskRef): Promise<DoneCloseResult> => {
      const closed = await board.done(ref.id);
      return closed.ok ? { ok: true } : { ok: false, message: closed.message };
    };
    return { cards, close: targets => closeCards(targets, closeOne) };
  }, [board, first, state]);
};
