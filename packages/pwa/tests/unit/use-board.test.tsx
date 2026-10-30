import { afterEach, describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { renderToString } from 'react-dom/server';

import {
  type BoardMachine,
  type BoardView,
  useBoard,
  useBoardActions,
  useBoardFilters,
  useBoardProjects,
  useBoardTask,
} from '../../src/hooks/use-board.ts';
import type { BoardActions } from '../../src/lib/board-actions.ts';
import { type BoardFilters, NO_BOARD_FILTERS } from '../../src/lib/board-model.ts';
import { type BoardProjectsState, type BoardTaskState, DaemonBoardStore } from '../../src/lib/board-store.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import {
  boardAnswer,
  card,
  fakeEnvironment,
  fakePort,
  flush,
  laneSetFor,
  laptop,
  PROJECT,
  workstation,
} from './board-support.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const machines: BoardMachine[] = [
  { connection: laptop, name: 'laptop' },
  { connection: workstation, name: 'workstation' },
];

interface Seen {
  board?: BoardView;
  task?: BoardTaskState;
  projects?: ReadonlyMap<unknown, BoardProjectsState>;
  actions?: BoardActions;
  filters?: BoardFilters;
  setFilters?: (next: BoardFilters) => void;
}

function Probe({
  store,
  seen,
  list = machines,
  filters = NO_BOARD_FILTERS,
}: {
  readonly store: DaemonBoardStore;
  readonly seen: Seen;
  readonly list?: readonly BoardMachine[];
  readonly filters?: BoardFilters;
}) {
  seen.board = useBoard(store, list, filters);
  seen.task = useBoardTask(store, list[0]?.connection, 'F1');
  seen.projects = useBoardProjects(
    store,
    list.map(machine => machine.connection),
  );
  seen.actions = useBoardActions(
    store,
    { respond: async () => undefined } as never,
    list.map(machine => machine.connection),
  );
  return null;
}

function Filters({ seen }: { readonly seen: Seen }) {
  const [search, setSearch] = useState('?mine=1');
  const [filters, set] = useBoardFilters(search, next => setSearch(next));
  seen.filters = filters;
  seen.setFilters = set;
  return null;
}

const store = () => {
  const port = fakePort({
    board: async daemon =>
      boardAnswer([card(daemon.daemonId === laptop.daemonId ? 'F1' : 'F2')], {
        projectId: PROJECT,
        laneSet: laneSetFor(),
      }),
    task: async () => ({ task: card('F1'), laneSet: laneSetFor() }),
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
  });
  return new DaemonBoardStore(port, fakeEnvironment());
};

describe('the board hooks', () => {
  test('useBoard reads every machine and groups what comes back', async () => {
    const seen: Seen = {};
    view = await mount(<Probe seen={seen} store={store()} />);
    await interact(() => flush());
    expect(seen.board?.status).toBe('ready');
    expect(seen.board?.model.cards.map(entry => entry.task.id)).toEqual(['F1', 'F2']);
    expect(seen.board?.machines.map(entry => entry.status)).toEqual(['ready', 'ready']);
    await interact(() => seen.board?.refresh());
  });

  test('useBoard says it is loading before any machine answers, and idle with none paired', async () => {
    const seen: Seen = {};
    const held = new DaemonBoardStore(fakePort({ board: () => new Promise(() => undefined) }), fakeEnvironment());
    view = await mount(<Probe seen={seen} store={held} />);
    expect(seen.board?.status).toBe('loading');
    await view.render(<Probe list={[]} seen={seen} store={held} />);
    expect(seen.board?.status).toBe('idle');
  });

  test('useBoard is an error only when every machine failed with nothing to show', async () => {
    const seen: Seen = {};
    const broken = new DaemonBoardStore(
      fakePort({
        board: async () => {
          throw new Error('down');
        },
      }),
      fakeEnvironment(),
    );
    view = await mount(<Probe seen={seen} store={broken} />);
    await interact(() => flush());
    expect(seen.board?.status).toBe('error');
    expect(seen.board?.machines[0]?.error).toBe('down');
  });

  test('useBoardTask, useBoardProjects and useBoardActions read from the store they are given', async () => {
    const seen: Seen = {};
    view = await mount(<Probe seen={seen} store={store()} />);
    await interact(() => flush());
    expect(seen.task?.task?.id).toBe('F1');
    expect(seen.projects?.get(laptop.daemonId)?.projects?.[0]?.name).toBe('ferretry');
    expect(typeof seen.actions?.moveTask).toBe('function');
  });

  test('useBoardTask is idle for a machine that is no longer paired', async () => {
    const seen: Seen = {};
    view = await mount(<Probe list={[]} seen={seen} store={store()} />);
    expect(seen.task?.status).toBe('idle');
  });

  test('useBoardFilters reads the URL and writes the next filters back as a query', async () => {
    const seen: Seen = {};
    view = await mount(<Filters seen={seen} />);
    expect(seen.filters?.mine).toBe(true);
    await interact(() => seen.setFilters?.({ ...NO_BOARD_FILTERS, kind: 'bug' }));
    expect(seen.filters).toEqual({ ...NO_BOARD_FILTERS, kind: 'bug' });
  });

  test('a server render reads the empty snapshots, before any machine has answered', () => {
    const seen: Seen = {};
    renderToString(<Probe seen={seen} store={store()} />);
    expect(seen.board?.status).toBe('loading');
    expect(seen.task?.status).toBe('idle');
  });
});
