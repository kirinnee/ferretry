/**
 * The browser entry for "the board by project": the REAL `BoardPage` over a scripted daemon port that holds THREE
 * projects (one of them Unfiled) and keeps its tasks in memory, so the page is driven through real transitions.
 *
 *   ?style=<style>&palette=<palette>&mode=light|dark
 *   ?project=<id>      start narrowed to one project
 *
 * The page keeps its filters in the URL (`onSearch` writes it with `history.replaceState`, and the scene reads it back),
 * and a live daemon is played by `window.__board`: `move(id, lane)` and `remove(id)` change a task, `tick()` is the
 * store's next beat, which reads the board again.
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DaemonBoardStore } from '../../../../app/lib/board-store.ts';
import { BoardPage } from '../../../../app/views/board-page.tsx';
import { THIS_MACHINE } from '../../../../app/lib/machine.ts';
import {
  boardAnswer,
  boardTask,
  fakeEnvironment,
  fakePort,
  laneSetFor,
  OTHER_PROJECT,
  PROJECT,
} from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
html.dataset.style = params.get('style') ?? 'studio';
html.dataset.palette = params.get('palette') ?? 'studio';
html.dataset.mode = params.get('mode') ?? 'light';
html.dataset.theme = `${html.dataset.palette}-${html.dataset.mode}`;

const LEAD = 'mvuc7tsf-0c3d50df';
const UNFILED = '00000000-0000-4000-8000-0000000000ff';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

let tasks = [
  boardTask('F3', { title: 'Rich CI cache summary', laneId: 'plan', owner: LEAD }),
  boardTask('F4', { title: 'Release notes for 4.111', laneId: 'implement', owner: LEAD }),
  boardTask('F5', { title: 'Retire the old inbox route', laneId: 'review', owner: LEAD }),
  boardTask('F6', { title: 'Lane editor copy', laneId: 'todo', owner: LEAD }),
  boardTask('F7', { title: 'Fix the search page title', laneId: 'implement', owner: LEAD, projectId: OTHER_PROJECT }),
  boardTask('F8', { title: 'Add a sitemap', laneId: 'todo', owner: LEAD, projectId: OTHER_PROJECT }),
  boardTask('F10', { title: 'Tidy the scratch folder', laneId: 'todo', owner: LEAD, projectId: UNFILED }),
];

const projects = [
  { id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() },
  { id: OTHER_PROJECT, name: 'docs-site', path: '/work/docs-site', laneSet: laneSetFor(OTHER_PROJECT) },
  { id: UNFILED, name: 'Unfiled', path: null, laneSet: laneSetFor(UNFILED) },
] as never;

const env = fakeEnvironment();
const store = new DaemonBoardStore(
  fakePort({
    board: async (_daemon, query) =>
      boardAnswer(
        tasks.filter(task => query.project === null || query.project === undefined || task.projectId === query.project),
        { laneSet: null, projectId: null },
      ),
    projects: async () => projects,
  }),
  env,
);

Object.assign(window, {
  __board: {
    move: (id: string, laneId: string): void => {
      tasks = tasks.map(task => (task.id === id ? { ...task, laneId } : task));
    },
    remove: (id: string): void => {
      tasks = tasks.filter(task => task.id !== id);
    },
    tick: (): void => {
      env.advance(10 * 60_000);
      env.fire();
    },
  },
});

const phone = window.innerWidth < 700;

function Scene() {
  const [search, setSearch] = useState(params.get('project') === null ? '' : `project=${params.get('project')}`);
  return (
    <BoardPage
      callsigns={new Map([[LEAD, 'Denisha']])}
      machines={[{ connection: THIS_MACHINE, name: 'This machine' }]}
      now={NOW}
      onNavigate={() => undefined}
      onSearch={next => {
        window.history.replaceState(null, '', `${window.location.pathname}${next === '' ? '' : `?${next}`}`);
        setSearch(next);
      }}
      phone={phone}
      search={search}
      store={store}
    />
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
