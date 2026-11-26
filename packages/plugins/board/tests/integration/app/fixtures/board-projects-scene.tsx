/**
 * The browser entry for "the board by project": the REAL `BoardPage` over fake data for TWO projects.
 *
 *   ?style=<style>&palette=<palette>&mode=light|dark
 *   ?project=<id>      narrow the board to one project (the "Only this project" press)
 */

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
const root = document.documentElement;
root.dataset.style = params.get('style') ?? 'studio';
root.dataset.palette = params.get('palette') ?? 'studio';
root.dataset.mode = params.get('mode') ?? 'light';
root.dataset.theme = `${root.dataset.palette}-${root.dataset.mode}`;

const LEAD = 'mvuc7tsf-0c3d50df';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const tasks = [
  boardTask('F3', { title: 'Rich CI cache summary', laneId: 'plan', owner: LEAD }),
  boardTask('F4', { title: 'Release notes for 4.111', laneId: 'implement', owner: LEAD }),
  boardTask('F5', { title: 'Retire the old inbox route', laneId: 'review', owner: LEAD }),
  boardTask('F6', { title: 'Lane editor copy', laneId: 'todo', owner: LEAD }),
  boardTask('F7', { title: 'Fix the search page title', laneId: 'implement', owner: LEAD, projectId: OTHER_PROJECT }),
  boardTask('F8', { title: 'Add a sitemap', laneId: 'todo', owner: LEAD, projectId: OTHER_PROJECT }),
];

const projects = [
  { id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() },
  { id: OTHER_PROJECT, name: 'docs-site', path: '/work/docs-site', laneSet: laneSetFor(OTHER_PROJECT) },
] as never;

const only = params.get('project');
const store = new DaemonBoardStore(
  fakePort({
    board: async () =>
      boardAnswer(
        tasks.filter(task => only === null || task.projectId === only),
        { laneSet: null, projectId: null },
      ),
    projects: async () => projects,
  }),
  fakeEnvironment(),
);

const phone = window.innerWidth < 700;

createRoot(document.getElementById('root') as HTMLElement).render(
  <BoardPage
    callsigns={new Map([[LEAD, 'Denisha']])}
    machines={[{ connection: THIS_MACHINE, name: 'This machine' }]}
    now={NOW}
    onNavigate={() => undefined}
    onSearch={() => undefined}
    phone={phone}
    search={only === null ? '' : `project=${only}`}
    store={store}
  />,
);
