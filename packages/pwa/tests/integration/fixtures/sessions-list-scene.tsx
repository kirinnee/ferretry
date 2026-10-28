/**
 * The browser entry for the sessions-list evidence: the real sessions bar over fixed fake sessions.
 *
 *   ?machines=one|two   the bar lists this machine alone, or Needs you and every machine
 *   ?view=column|drawer the desktop column, or the phone's modal drawer
 *   ?theme=<family>-<mode>
 *
 * Nothing here reaches a daemon: the sessions are literals and navigation is recorded
 * (`window.__sessionsList.navigations`), so the suite proves what the list DRAWS and what a tap opens.
 * Built by `scripts/build-composer-integration-fixture.ts --entry` in a child process. Every name in it
 * is fake.
 */

import type { SessionView } from '@ferretry/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { MachineSource } from '../../../src/lib/all-machines.ts';
import type { DaemonId } from '../../../src/lib/daemon-connection.ts';
import { SessionsBar } from '../../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const STUDIO = 'studio-daemon' as DaemonId;
const LAPTOP = 'laptop-daemon' as DaemonId;

const session = (
  id: string,
  teammate: string,
  label: string,
  cwd: string,
  minutes: number,
  mode: 'auto' | 'interactive',
  state: Partial<SessionView['state']> = {},
): SessionView =>
  sessionView(id, {
    config: { teammate, label, cwd, mode, updatedAt: minutesAgo(minutes) },
    state: { lastActivityAt: minutesAgo(minutes), turnStateAt: minutesAgo(minutes), ...state },
    directory: cwd,
  });

const open = (minutes: number) => ({ open: 1, first: 'A1', ask: 'Ask?', latestAt: minutesAgo(minutes) });

const STUDIO_SESSIONS: readonly SessionView[] = [
  session('s-ivo', 'ivo', 'Relay carrier bench', '/home/k/ferretry', 1, 'auto'),
  session('s-hadi', 'hadi', 'Pick the migration strategy', '/home/k/ferretry', 3, 'interactive', {
    status: 'awaiting_question',
    attention: open(3),
  }),
  session('s-lea', 'lea', 'Split the settings page', '/home/k/ferretry/.worktrees/lea', 8, 'auto', {
    waiting: { since: minutesAgo(8) },
  }),
  session('s-ora', 'ora', 'Draft the weekly notes', '/home/k/notes', 12, 'interactive'),
  session('s-noa', 'noa', 'Tidy the old notes', '/home/k/notes', 90, 'auto', { status: 'completed' }),
  session('s-kai', 'kai', 'Bump the toolchain', '/home/k/ferretry', 140, 'auto', { status: 'failed' }),
  session('s-rue', 'rue', 'Sketch the landing page', '/home/k/notes', 400, 'interactive', { status: 'stopped' }),
];

const LAPTOP_SESSIONS: readonly SessionView[] = [
  session('l-pim', 'pim', 'Review the landing copy', '/Users/k/site', 7, 'interactive', {
    status: 'awaiting_user',
    attention: open(7),
  }),
  session('l-ula', 'ula', 'Resize the hero images', '/Users/k/site', 9, 'auto'),
  session('l-ada', 'ada', 'Old deploy check', '/Users/k/site', 300, 'auto', { status: 'stalled' }),
];

/** A pack: one lead that started four ferrets, one of which started another. `?tree=1` draws this instead. */
const child = (id: string, teammate: string, label: string, parent: string, minutes: number, state = {}) => ({
  ...session(id, teammate, label, '/home/k/ferretry', minutes, 'auto', state),
  config: {
    ...session(id, teammate, label, '/home/k/ferretry', minutes, 'auto', state).config,
    parent,
  },
});
const PACK_SESSIONS: readonly SessionView[] = [
  session('p-lead', 'ivo', 'Harden the relay carrier', '/home/k/ferretry', 1, 'interactive'),
  child('p-pim', 'pim', 'Probe carrier A', 'p-lead', 2),
  child('p-ula', 'ula', 'Probe carrier B', 'p-lead', 3, { status: 'awaiting_user', attention: open(3) }),
  child('p-ada', 'ada', 'Bench the TURN fallback', 'p-lead', 4),
  child('p-kai', 'kai', 'Parse the bench logs', 'p-ada', 5),
  child('p-noa', 'noa', 'Probe carrier C', 'p-lead', 90, { status: 'completed' }),
  session('p-ora', 'ora', 'Draft the weekly notes', '/home/k/ferretry', 12, 'interactive'),
];

const LEARNING = new Set(['s-ivo', 's-ora']);

const source = (
  daemonId: DaemonId,
  name: string,
  sessions: readonly SessionView[],
  projects: MachineSource['projects'],
): MachineSource => ({
  daemonId,
  name,
  reach: 'online',
  projects,
  slice: { sessions, byId: new Map(), status: 'ready', error: null },
});

const STUDIO_PROJECTS = [
  { name: 'ferretry', path: '/home/k/ferretry' },
  { name: 'notes', path: '/home/k/notes' },
];

interface SessionsListEvidence {
  readonly navigations: string[];
}
const evidence: SessionsListEvidence = { navigations: [] };
(globalThis as { __sessionsList?: SessionsListEvidence }).__sessionsList = evidence;

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const two = params.get('machines') === 'two';
const drawer = params.get('view') === 'drawer';
const pack = params.get('tree') === '1';
/** `?mode=default` opens the bar the way a new device does; every other scene starts on All so its counts stay put. */
const initialMode = params.get('mode') === 'default' ? null : 'all';

const MACHINES = [
  { daemonId: STUDIO, name: 'studio' },
  { daemonId: LAPTOP, name: 'laptop' },
];

function Scene() {
  return (
    <div className="kt-shell flex flex-row overflow-hidden" data-scene={drawer ? 'drawer' : 'column'}>
      <SessionsBar
        active={null}
        activeSessionId={pack ? 'p-ora' : 's-ivo'}
        daemonId={STUDIO}
        groupNeedsYou={!pack}
        initialMode={initialMode}
        learningPassive={LEARNING}
        machineName="studio"
        machines={MACHINES}
        now={NOW}
        onAddMachine={() => undefined}
        onClose={() => undefined}
        onNavigate={to => evidence.navigations.push(to)}
        onOpenPalette={() => undefined}
        presentation={drawer ? 'drawer' : 'column'}
        projects={STUDIO_PROJECTS}
        sessions={pack ? PACK_SESSIONS : STUDIO_SESSIONS}
        {...(two
          ? {
              machineSources: [
                source(STUDIO, 'studio', STUDIO_SESSIONS, STUDIO_PROJECTS),
                source(LAPTOP, 'laptop', LAPTOP_SESSIONS, [{ name: 'site', path: '/Users/k/site' }]),
              ],
            }
          : {})}
      />
      <main className="flex min-w-0 flex-1 flex-col gap-2 p-panel text-ui text-fg">
        <p className="m-0 font-semibold">ivo · ferretry</p>
        <p className="m-0 text-muted">The open session&apos;s transcript and composer.</p>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <Scene />
    </StrictMode>,
  );
