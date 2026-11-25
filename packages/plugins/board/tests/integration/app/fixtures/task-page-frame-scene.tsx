/**
 * The browser entry for "a task opened by its link sits inside the shell": the REAL task screens (`/task/:id` and the
 * former `/card/:id`, built by `createSurfaces`) inside the shell's own `.fy-frame` / `.fy-main` boxes, beside a
 * navigation and a machine picker. Everything on screen is fake data.
 *
 *   ?theme=<family>-<mode>
 *   ?route=task|card    the screen the address names (default task)
 */

import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createSurfaces } from '../../../../app/views/surfaces.tsx';
import { boardTask, laneSetFor } from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const LEAD = 'mvuc7tsf-0c3d50df';
const task = boardTask('F3', {
  title: 'Rich CI cache summary',
  laneId: 'plan',
  owner: LEAD,
  premise: 'The CI summary lists every cache miss.',
  context: '- The cache key hashes the lockfile.',
  ask: { text: 'Show cache hits and misses in the CI summary', source: `session:${LEAD}` },
});

const answers: Readonly<Record<string, unknown>> = {
  'GET /v1/board/tasks/:taskId': { card: task, laneSet: laneSetFor() },
  'GET /v1/board/projects': { projects: [] },
  'GET /v1/board/ids': { ids: ['F3'] },
  'GET /v1/ferrets': [],
  'GET /v1/ferrets/:ferretId/agenda': { items: [], resolved: [] },
  'GET /v1/health': { version: '5.0.0' },
};
const client = {
  call: async (route: string) => {
    if (route in answers) return answers[route];
    throw new Error(`no fake answer for ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const surfaces = createSurfaces(client);
const Screen = (
  params.get('route') === 'card' ? surfaces.screens.card : surfaces.screens.task
) as ComponentType<ScreenProps>;
const phone = window.innerWidth < 700;

// THE SHELL'S OWN BOXES: the frame is the viewport; the navigation and the machine picker are its own columns (a bar at
// the foot on a phone), and a page draws inside `.fy-main`.
const nav = (
  <nav
    data-shell-nav=""
    style={{
      flex: 'none',
      display: 'flex',
      flexDirection: phone ? 'row' : 'column',
      gap: 12,
      padding: 12,
      ...(phone
        ? { borderTop: '1px solid var(--border)', order: 2 }
        : { width: 168, borderRight: '1px solid var(--border)' }),
    }}
  >
    <button data-shell-machine="" type="button">
      Workshop
    </button>
    <a href="#agenda">Agenda</a>
    <a href="#board">Board</a>
  </nav>
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div
    className={`fy-frame ${phone ? 'fy-frame--nav-bottom' : 'fy-frame--nav-left'}`}
    style={phone ? { flexDirection: 'column' } : undefined}
  >
    {nav}
    <div className="fy-columns" style={{ flexDirection: 'row' }}>
      <main className="fy-main" data-shell-main="">
        <Screen params={{ id: 'F3' }} />
      </main>
    </div>
  </div>,
);
