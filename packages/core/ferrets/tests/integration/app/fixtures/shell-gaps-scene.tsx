/**
 * The browser entry for the two ferrets surfaces this unit adds: the REAL ferret list with outdated ferrets (and its ⋯ menu,
 * "Restart outdated (N)"), and the REAL Instructions panel, over a fake daemon that answers from memory. No network. Every
 * name below is made up.
 *
 *   ?view=list                  the ferret list: two outdated ferrets, one up to date, one stopped
 *   ?view=list-menu             the same with the ⋯ menu open (the test opens it)
 *   ?view=list-answered         after "Restart outdated": the answer line, the restarted ferret bare, the busy one Queued
 *   ?view=instructions          the Instructions panel over a folder holding four instruction files
 *   ?theme=<family>-<mode>
 */
import { deviceControls, type ScreenRef } from '@ferretry/app';
import { RouterProvider } from '@ferretry/app/testing/router';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { FunctionComponent } from 'react';
import { createRoot } from 'react-dom/client';
import { FerretList } from '../../../../app/features/list/ferret-list.tsx';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { createInstructionsPanel } from '../../../../app/views/instructions.tsx';
import '../../../../app/features/list/ferret-list.css';
import '../../../../app/features/restart-outdated/restart-outdated.css';
import { listDaemon, summary } from '../../../unit/app/list/support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'list';

const SCREENS: readonly ScreenRef[] = [
  { plugin: 'ferrets', id: 'ferrets', path: 'ferrets', label: 'Ferrets' },
  { plugin: 'conversation', id: 'chat', path: 'ferrets/:ferret/chat', label: 'Chat' },
];

const recent = new Date(Date.now() - 60_000).toISOString();
const FERRETS = [
  summary('zoe-1', {
    name: 'zoe',
    title: 'Fixture running',
    folder: '/work/ferretry',
    mode: 'interactive',
    state: 'working',
    stateAt: recent,
    outdated: { sections: ['pack', 'agenda'] },
  }),
  summary('kai-1', {
    name: 'kai',
    title: 'Release train',
    folder: '/work/ferretry',
    mode: 'interactive',
    state: 'idle',
    stateAt: recent,
    outdated: { sections: ['tools'] },
  }),
  summary('hadi-1', {
    name: 'hadi',
    title: 'Docs sweep',
    folder: '/work/notes',
    mode: 'interactive',
    state: 'idle',
    stateAt: recent,
  }),
  summary('piper-1', {
    name: 'piper',
    title: 'Ledger rewrite',
    folder: '/work/notes',
    mode: 'interactive',
    state: 'stopped',
    stateAt: recent,
    outdated: { sections: ['tools'] },
  }),
];

const file = (name: string, size: number) => ({ name, type: 'file', size });
const LISTING = {
  root: '/work/ferretry',
  path: '',
  entries: [
    file('README.md', 3_200),
    file('CLAUDE.md', 12_800),
    file('CLAUDE.local.md', 640),
    file('AGENTS.md', 5_100),
    file('GEMINI.md', 900),
    { name: 'src', type: 'dir' },
  ],
};

const list = listDaemon(FERRETS);
if (view === 'list-answered') {
  const base = list.client.call;
  (list.client as { call: unknown }).call = async (route: string, init?: unknown) =>
    route === 'POST /v1/restarts'
      ? {
          restarted: [{ id: 'kai-1', name: 'kai' }],
          queued: [{ id: 'zoe-1', name: 'zoe', reason: 'mid-turn' }],
          skipped: [],
          failed: [],
        }
      : (base as (route: string, init?: unknown) => Promise<unknown>)(route, init);
}
const instructionsClient = {
  call: async (route: string) => {
    if (route === 'GET /v1/ferrets/:ferretId/fs') return LISTING;
    throw new Error(`no route ${route}`);
  },
} as unknown as LiveFerretsClient;

deviceControls().setDeviceControls({ sessionsMode: 'all' });
window.history.replaceState(null, '', '/d/alpha/ferrets/hadi-1/chat');

const root = document.getElementById('root') as HTMLElement;
const reactRoot = createRoot(root);
if (view === 'instructions') {
  const Panel = createInstructionsPanel(instructionsClient) as FunctionComponent<PanelProps>;
  Object.assign(root.style, { maxWidth: '360px', margin: '0 auto', padding: '16px' });
  reactRoot.render(<Panel {...({ subject: 'zoe-1' } as PanelProps)} />);
} else {
  Object.assign(root.style, { maxWidth: '360px', margin: '0 auto' });
  reactRoot.render(
    <RouterProvider screens={SCREENS}>
      <FerretList client={list.client} />
    </RouterProvider>,
  );
}
