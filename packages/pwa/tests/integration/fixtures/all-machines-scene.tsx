/**
 * The browser entry for the all-machines evidence: TWO FAKE DAEMONS behind the real stores, the real
 * per-machine poll and source hooks, and the real sessions bar and Sessions page.
 *
 *   studio  answers every read.
 *   laptop  answered once, five minutes ago, and has not answered since.
 *
 * The daemons are `DaemonFleetPort` / `DaemonProjectsPort` fakes, so nothing leaves the page — but each
 * one REFUSES a read made with another machine's credential, and records every read it was asked for
 * (`window.__allMachines.reads`), so the suite can prove each list was fetched with its own machine's
 * device and nothing else. Navigation is recorded rather than followed (`…navigations`).
 *
 * Built by `scripts/build-composer-integration-fixture.ts --entry` in a child process, never inside the
 * test runner (see that script). `?scene=bar|page` picks the desktop column or the phone page;
 * `?theme=<family>-<mode>` the theme. Every name and session in it is fake.
 */

import type { SessionView } from '@ferretry/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsPage } from '../../../src/components/sessions-page.tsx';
import { type ListedMachine, useMachineSources } from '../../../src/hooks/use-machine-sources.ts';
import { type FleetPollEnvironment, useMachinesPoll } from '../../../src/hooks/use-machines-poll.ts';
import { DaemonConnectionHealth } from '../../../src/lib/connection-health.ts';
import { DaemonControlsStore } from '../../../src/lib/controls.ts';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { FleetProject } from '../../../src/lib/fleet-grouping.ts';
import { DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { DaemonUsageStore } from '../../../src/lib/usage-store.ts';
import { SessionsBar } from '../../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const STUDIO = daemonConnection({
  daemonId: `fy_daemon_${'Ss'.repeat(21)}A`,
  baseUrl: 'https://studio.example.test',
  deviceId: 'device-on-studio',
});
const LAPTOP = daemonConnection({
  daemonId: `fy_daemon_${'Ll'.repeat(21)}A`,
  baseUrl: 'https://laptop.example.test',
  deviceId: 'device-on-laptop',
});

const session = (
  id: string,
  teammate: string,
  name: string,
  cwd: string,
  minutes: number,
  state: Partial<SessionView['state']> = {},
): SessionView =>
  sessionView(id, {
    config: { teammate, name, cwd, mode: 'interactive', updatedAt: minutesAgo(minutes) },
    state: { lastActivityAt: minutesAgo(minutes), turnStateAt: minutesAgo(minutes), ...state },
    directory: cwd,
  });

const SESSIONS: Readonly<Record<string, readonly SessionView[]>> = {
  [STUDIO.daemonId]: [
    session('s-ivo', 'ivo', 'Relay carrier bench', '/home/k/ferretry', 1),
    session('s-hadi', 'hadi', 'Pick the migration strategy', '/home/k/ferretry', 3, { status: 'awaiting_question' }),
    session('s-lea', 'lea', 'Split the settings page', '/home/k/ferretry/.worktrees/lea', 8, {
      waiting: { since: minutesAgo(8) },
    }),
    session('s-ora', 'ora', 'Fix the release script', '/home/k/notes', 12, { needsHuman: 'the signing key is gone' }),
    session('s-noa', 'noa', 'Tidy the weekly notes', '/home/k/notes', 20),
  ],
  [LAPTOP.daemonId]: [
    session('l-pim', 'pim', 'Review the landing copy', '/Users/k/site', 7, { status: 'awaiting_user' }),
    // The SAME id as a studio session: a different session on a different machine.
    session('s-ivo', 'rue', 'Resize the hero images', '/Users/k/site', 9),
  ],
};

const PROJECTS: Readonly<Record<string, readonly FleetProject[]>> = {
  [STUDIO.daemonId]: [
    { name: 'ferretry', path: '/home/k/ferretry' },
    { name: 'notes', path: '/home/k/notes' },
  ],
  [LAPTOP.daemonId]: [{ name: 'site', path: '/Users/k/site' }],
};

const OWN_DEVICE: Readonly<Record<string, string>> = {
  [STUDIO.daemonId]: STUDIO.deviceId,
  [LAPTOP.daemonId]: LAPTOP.deviceId,
};

interface AllMachinesEvidence {
  readonly studio: string;
  readonly laptop: string;
  readonly reads: { readonly daemonId: string; readonly deviceId: string; readonly what: string }[];
  readonly navigations: string[];
}

const evidence: AllMachinesEvidence = { studio: STUDIO.daemonId, laptop: LAPTOP.daemonId, reads: [], navigations: [] };
(globalThis as { __allMachines?: AllMachinesEvidence }).__allMachines = evidence;

/** A fake daemon: answers only its own device, and only while it is up. */
const answer = <T,>(daemon: DaemonConnection, what: string, value: T): T => {
  evidence.reads.push({ daemonId: daemon.daemonId, deviceId: daemon.deviceId, what });
  if (daemon.deviceId !== OWN_DEVICE[daemon.daemonId]) throw new Error('this device is not paired here');
  if (daemon.daemonId === LAPTOP.daemonId && !laptopUp) throw new Error('laptop is not answering');
  return value;
};

let laptopUp = true;
let clock = NOW - 5 * 60_000;
const fleet = new DaemonFleetStore(
  {
    list: async daemon => answer(daemon, 'sessions', SESSIONS[daemon.daemonId] ?? []),
    get: async () => await Promise.reject(new Error('not in this scene')),
  },
  () => clock,
);
const projects = new DaemonProjectsStore({
  projects: async daemon => answer(daemon, 'projects', PROJECTS[daemon.daemonId] ?? []),
});
const health = new DaemonConnectionHealth(
  { now: () => NOW, schedule: () => () => undefined, random: () => 0.5, isOnline: () => true },
  async () => undefined,
);
const controls = new DaemonControlsStore(undefined);
const usage = new DaemonUsageStore({ usage: async () => await Promise.reject(new Error('no usage here')) });

/** No timers: one read of every machine on mount, which is what a capture needs. */
const STILL: FleetPollEnvironment = {
  visible: () => true,
  setInterval: () => 0,
  clearInterval: () => undefined,
  onVisibility: () => () => undefined,
};

const MACHINES: readonly ListedMachine[] = [
  { connection: STUDIO, name: 'studio' },
  { connection: LAPTOP, name: 'laptop' },
];
const NEW_SESSION_MACHINES = MACHINES.map(machine => ({ daemonId: machine.connection.daemonId, name: machine.name }));
const navigate = (to: string): void => {
  evidence.navigations.push(to);
};

function Scene({ scene }: { readonly scene: 'bar' | 'page' }) {
  useMachinesPoll(
    fleet,
    MACHINES.map(machine => machine.connection),
    STUDIO.daemonId,
    scene === 'page',
    STILL,
  );
  const sources = useMachineSources({ fleet, projects, connectionHealth: health }, MACHINES);
  if (scene === 'page')
    return (
      <div className="kt-shell overflow-y-auto px-1" data-scene="page">
        <SessionsPage
          clock={{ now: () => NOW, intervalMs: 3_600_000 }}
          connection={STUDIO}
          controls={controls}
          fleet={fleet}
          machineSources={sources}
          narrow
          newSessionMachines={NEW_SESSION_MACHINES}
          onNavigate={navigate}
          onOpenWardenReport={() => undefined}
          projects={projects}
          usage={usage}
          wardenStatus={async () => await Promise.reject(new Error('no warden here'))}
        />
      </div>
    );
  return (
    <div className="kt-shell flex flex-row overflow-hidden" data-scene="bar">
      <SessionsBar
        active={null}
        activeSessionId="s-ivo"
        daemonId={STUDIO.daemonId}
        machineName="studio"
        machineSources={sources}
        machines={NEW_SESSION_MACHINES}
        now={NOW}
        onAddMachine={() => undefined}
        onNavigate={navigate}
        onOpenPalette={() => undefined}
        presentation="column"
        projects={projects.projects(STUDIO.daemonId)}
        sessions={sources[0]?.slice.sessions ?? null}
      />
      <main className="flex min-w-0 flex-1 flex-col gap-2 p-panel text-ui text-fg">
        <p className="m-0 font-semibold">ivo · ferretry</p>
        <p className="m-0 text-muted">The open session's transcript, composer and Info all target studio.</p>
      </main>
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') === 'page' ? 'page' : 'bar';

// The laptop answered once, five minutes ago, then stopped: its rows are its last word.
await fleet.hydrate(LAPTOP);
clock = NOW;
laptopUp = false;
health.outage(LAPTOP.daemonId, {
  failures: [{ label: 'Direct', detail: 'laptop.example.test did not answer' }],
  daemonAbsent: false,
  relaysNeverOpened: false,
});
health.answered(STUDIO.daemonId);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <Scene scene={scene} />
    </StrictMode>,
  );
