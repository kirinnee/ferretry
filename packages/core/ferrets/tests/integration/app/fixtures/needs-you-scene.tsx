/**
 * The browser entry for "the ferret list's Needs you group and its Settings row": the REAL `FerretList` and the REAL
 * "Group Needs you at the top" panel over fixed fake data — the ferrets a daemon would list, and an Agenda that says two
 * of them wait on the owner. No daemon, no network. Everything on screen is fake data.
 *
 *   ?view=list (default)   the list, the way the side column draws it
 *   ?view=row              Settings › This device › the Ferret list group
 *   ?group=0               "Group Needs you at the top" is off for this device
 *   ?theme=<family>-<mode>
 */

import { deviceControls } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { deviceSettingsPanels } from '../../../../app/views/device-settings.tsx';
import { FerretListBody } from '../../../../app/features/list/ferret-list.tsx';
import '../../../../app/features/list/ferret-list.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
deviceControls().setDeviceControls({ groupNeedsYou: params.get('group') !== '0', sessionsMode: 'all' });

const ferret = (id: string, name: string, title: string, folder: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  title,
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
  ferret('f-zoe', 'zoe', 'Fix the stuck sign-in', '/work/ferretry'),
  ferret('f-kai', 'kai', 'Release train', '/work/ferretry', { stateAt: '2026-11-14T09:10:00.000Z' }),
  ferret('f-hadi', 'hadi', 'Docs sweep', '/work/handbook', { state: 'idle' }),
  ferret('f-piper', 'piper', 'Ledger rewrite', '/work/ledger', { state: 'idle', stateAt: '2026-11-14T08:50:00.000Z' }),
  ferret('f-ora', 'ora', 'Old migration', '/work/ledger', { state: 'stopped', stateAt: '2026-11-13T08:00:00.000Z' }),
];

/** What Agenda would say through `ferrets.needs-you`: a stopped ferret with open items is listed though it is over. */
const NEEDING = new Map([
  ['f-hadi', { count: 1, latestAt: '2026-11-14T09:05:00.000Z', ask: 'Which branch should the docs change land on?' }],
  ['f-ora', { count: 2, latestAt: '2026-11-14T08:30:00.000Z', ask: 'May I delete the old migration folder?' }],
]);
const client = {
  call: (async () => FERRETS) as never,
};

const screens = [{ plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' }];
window.history.pushState(null, '', '/d/alpha/ferrets');
const Panel = deviceSettingsPanels['needs-you'];

createRoot(document.getElementById('root') as HTMLElement).render(
  params.get('view') === 'row' ? (
    <main className="fy-page" style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 720, padding: 16 }}>
      <h1>This device</h1>
      <Panel />
    </main>
  ) : (
    <RouterProvider screens={screens}>
      <div style={{ boxSizing: 'border-box', margin: '0 auto', maxWidth: 420, padding: 8 }}>
        <FerretListBody client={client} needing={NEEDING} />
      </div>
    </RouterProvider>
  ),
);
