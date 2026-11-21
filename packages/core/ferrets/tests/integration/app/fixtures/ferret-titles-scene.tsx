/**
 * The browser entry for "one task-like title per ferret, no callsign line": the REAL `FerretListBody` and the REAL
 * header `FerretName` over fixed fake data — a ferret titled by its owner, one titled from its conversation (auto) and
 * one with no title yet. No daemon, no network. Everything on screen is fake data.
 *
 *   ?view=list (default)   the list, the way the side column draws it
 *   ?view=header&ferret=f-ora   the chat header's name for one ferret
 *   ?theme=<family>-<mode>
 */

import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { deviceControls } from '@ferretry/app';
import { FerretName } from '../../../../app/features/header/name-panel.tsx';
import { FerretListBody } from '../../../../app/features/list/ferret-list.tsx';
import '../../../../app/features/header/ferret-actions.css';
import '../../../../app/features/list/ferret-list.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
deviceControls().setDeviceControls({ sessionsMode: 'all' });

const ferret = (id: string, name: string, folder: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  runtime: 'claude-main',
  folder,
  mode: 'interactive',
  state: 'working',
  createdAt: '2026-11-01T08:00:00.000Z',
  stateAt: '2026-11-14T09:30:00.000Z',
  ...over,
});
const FERRETS = [
  ferret('f-zoe', 'zoe', '/work/ferretry', { title: 'Fix stuck sign-in', titleSource: 'owner' }),
  ferret('f-kai', 'kai', '/work/ferretry', { title: 'Fix Flaky Login Test', titleSource: 'auto' }),
  ferret('f-ora', 'ora', '/work/handbook', { state: 'idle' }),
];
const client = { call: (async () => FERRETS) as never };

const screens = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
window.history.pushState(null, '', '/d/alpha/ferrets');

const named = FERRETS.find(candidate => candidate.id === params.get('ferret')) ?? FERRETS[0];

createRoot(document.getElementById('root') as HTMLElement).render(
  params.get('view') === 'header' ? (
    <div style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 720, padding: 16 }}>
      <FerretName compact={false} ferret={named as never} />
    </div>
  ) : (
    <RouterProvider screens={screens}>
      <div style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 420, padding: 8 }}>
        <FerretListBody client={client} needing={new Map()} />
      </div>
    </RouterProvider>
  ),
);
