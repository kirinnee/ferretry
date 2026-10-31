/**
 * The cards waiting for the owner's try, from the shared board store's unfiltered read (the key the phone's Board badge
 * also holds). It asks for no beat of its own: the board is read once when the app opens and then stays live by the
 * fleet feed's `board.changed` events (`noteEvent`), so an idle page sends no extra request for it.
 */

import { useMemo } from 'react';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import { type ToTestCard, toTestCards } from '../lib/to-test-inbox.ts';
import { type BoardMachine, useBoard } from './use-board.ts';

export const useToTestCards = (store: DaemonBoardStore, machines: readonly BoardMachine[]): readonly ToTestCard[] => {
  const { model } = useBoard(store, machines, NO_BOARD_FILTERS, { beat: false });
  return useMemo(() => toTestCards(model), [model]);
};
