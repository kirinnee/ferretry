/**
 * The cards waiting for the owner's try, from the same unfiltered board read the phone's Board badge already holds
 * (one store key), so listing them in the Inbox costs no request of its own.
 */

import { useMemo } from 'react';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import { type ToTestCard, toTestCards } from '../lib/to-test-inbox.ts';
import { type BoardMachine, useBoard } from './use-board.ts';

export const useToTestCards = (store: DaemonBoardStore, machines: readonly BoardMachine[]): readonly ToTestCard[] => {
  const { model } = useBoard(store, machines, NO_BOARD_FILTERS);
  return useMemo(() => toTestCards(model), [model]);
};
