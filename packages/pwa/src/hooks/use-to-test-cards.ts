/**
 * The cards waiting for the owner's try, from the shared board store's unfiltered read (the key the phone's Board badge
 * also holds). It asks for no beat of its own: the board is read once when the app opens and then stays live by the
 * fleet feed's `board.changed` events (`noteEvent`), so an idle page sends no extra request for it. Only the cards a
 * person asked for are in it, each with the name of its project.
 */

import { useMemo } from 'react';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import { type ToTestCard, toTestCards, withProjectName } from '../lib/to-test-inbox.ts';
import { type BoardMachine, useBoard, useBoardProjects } from './use-board.ts';

export const useToTestCards = (store: DaemonBoardStore, machines: readonly BoardMachine[]): readonly ToTestCard[] => {
  const { model } = useBoard(store, machines, NO_BOARD_FILTERS, { beat: false });
  const connections = useMemo(() => machines.map(machine => machine.connection), [machines]);
  const projects = useBoardProjects(store, connections);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const state of projects.values())
      for (const project of state.projects ?? []) byId.set(project.id, project.name);
    return byId;
  }, [projects]);
  return useMemo(() => toTestCards(model).map(row => withProjectName(row, names)), [model, names]);
};
