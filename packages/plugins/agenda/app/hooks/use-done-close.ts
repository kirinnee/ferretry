/**
 * THE CARDS AN AGENDA ITEM'S "DONE · CLOSES" WOULD CLOSE, and the way to close them through the board's own Done.
 *
 * Today this read the board the app store kept. Cards are Board's: this half has no need on Board's routes, so it
 * reads and moves a card only through a {@link DoneCloseBoard} a host hands it ({@link DoneCloseBoardProvider}).
 * Nothing is offered without one, for an item that did not ask, or for a card that is already closed or gone.
 * GAP(done-close-board): no host provides a board yet, so the ask surfaces offer no Done · closes until Board
 * contributes one (or the lead gives Agenda a need on Board's card routes).
 */

import type { AgendaItem, TaskRef } from '../wire/index.ts';
import { createContext, createElement, type ReactNode, useContext, useMemo, useSyncExternalStore } from 'react';
import {
  type CardForClose,
  closeCards,
  closePlan,
  type DoneCloseCard,
  type DoneCloseResult,
  type DoneCloseSource,
  offeredCards,
} from '../lib/agenda-done-close.ts';
import type { DaemonId } from '../lib/machine.ts';

/** One card as the board last read it. */
export interface DoneCloseCardState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  /** The board said there is no such card. */
  readonly missing: boolean;
  readonly title?: string | undefined;
  /** Present once the card was read. */
  readonly card?: CardForClose | undefined;
}

/** What a host that holds the board hands this half: a live read of a card and Board's own move. */
export interface DoneCloseBoard {
  readonly subscribe: (listener: () => void) => () => void;
  /** The card as last read (the same object until it changes); asking starts a read when none was made. */
  readonly cardState: (daemonId: DaemonId, id: string) => DoneCloseCardState;
  /** Moves the card into `laneId` with Board's move, recorded in its history and told to its ferret. */
  readonly move: (daemonId: DaemonId, id: string, card: CardForClose, laneId: string) => Promise<DoneCloseResult>;
}

const DoneCloseBoardContext = createContext<DoneCloseBoard | undefined>(undefined);

/** Hands the ask surfaces below it the board a Done · closes reads and moves cards through. */
export const DoneCloseBoardProvider = (props: {
  readonly board: DoneCloseBoard;
  readonly children?: ReactNode;
}): ReactNode => createElement(DoneCloseBoardContext.Provider, { value: props.board }, props.children);

const IDLE: DoneCloseCardState = Object.freeze({ status: 'idle', missing: false });
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

const readCard = (state: DoneCloseCardState): CardForClose | undefined =>
  state.status === 'ready' ? state.card : undefined;

/** A card that is gone or already closed has nothing left to close, so it offers nothing. */
const closable = (state: DoneCloseCardState): boolean => {
  if (state.missing) return false;
  const card = readCard(state);
  return card === undefined || closePlan(card).kind !== 'closed';
};

export const useDoneClose = (
  daemonId: DaemonId | undefined,
  item: AgendaItem | undefined,
): DoneCloseSource | undefined => {
  const board = useContext(DoneCloseBoardContext);
  const refs = useMemo(
    () => (daemonId === undefined || item === undefined ? [] : offeredCards(item, daemonId)),
    [daemonId, item],
  );
  const first = refs[0];
  const state = useSyncExternalStore(board?.subscribe ?? NO_SUBSCRIPTION, () =>
    board === undefined || daemonId === undefined || first === undefined ? IDLE : board.cardState(daemonId, first.id),
  );

  return useMemo((): DoneCloseSource | undefined => {
    if (board === undefined || first === undefined || daemonId === undefined || !closable(state)) return undefined;
    const cards: DoneCloseCard[] = [{ ref: first, title: state.title }];
    const closeOne = async (ref: TaskRef): Promise<DoneCloseResult> => {
      const card = readCard(board.cardState(daemonId, ref.id));
      const plan = closePlan(card);
      if (plan.kind === 'closed') return { ok: true };
      if (plan.kind === 'refused' || card === undefined)
        return { ok: false, message: plan.kind === 'refused' ? plan.message : 'the card could not be read' };
      return await board.move(daemonId, ref.id, card, plan.laneId);
    };
    return { cards, close: targets => closeCards(targets, closeOne) };
  }, [board, first, daemonId, state]);
};
