/**
 * The browser entry for the one-machine-down evidence: the owner's phone with TWO machines paired and
 * the page open on the one that is ASLEEP — the exact scene that used to fail as a whole.
 *
 *   Liftoff MBP  the machine on screen. Asleep: its daemon holds no rendezvous, every read fails with the
 *                transport's raw sentence, and its rows are this device's copy from 23:05.
 *   Liftoff EC2  answers every read.
 *
 * Real fleet, projects and usage stores, the real `useMachineSources`, the real app bar, tab bar,
 * sessions bar, Sessions page and connection pill. The health model is a fixed literal per machine, so
 * a capture never waits on a reconnect loop. Nothing leaves the page.
 *
 * `?scene=phone|desktop|single` (single: the Sessions list set to "This machine", so the outage is the
 * page's own status row), `?theme=<family>-<mode>`. Every name and session in it is fake.
 */

import type { SessionView } from '@ferretry/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsPage } from '../../../src/components/sessions-page.tsx';
import { ConnectionHealthNotice } from '../../../src/features/connection/connection-health-notice.tsx';
import { type ListedMachine, useMachineSources } from '../../../src/hooks/use-machine-sources.ts';
import type { ConnectionHealth, ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import { DaemonControlsStore } from '../../../src/lib/controls.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../../../src/lib/projects-store.ts';
import { DaemonUsageStore } from '../../../src/lib/usage-store.ts';
import { AppBar, AppTabBar } from '../../../src/shell/app-bar.tsx';
import { SessionsBar } from '../../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-10-22T23:21:00.000Z');
const CACHED_AT = Date.parse('2026-10-22T23:05:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const MBP = daemonConnection({
  daemonId: `fy_daemon_${'Mm'.repeat(21)}A`,
  baseUrl: 'http://127.0.0.1:7431',
  deviceId: 'device-on-mbp',
});
const EC2 = daemonConnection({
  daemonId: `fy_daemon_${'Ee'.repeat(21)}A`,
  baseUrl: 'https://ec2.example.test',
  deviceId: 'device-on-ec2',
});

const RAW =
  'could not reach fyd at http://127.0.0.1:7431 (this machine is reconnecting, so nothing was dialled for this request; the connection retries on its own schedule)';

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

const MBP_CACHED: readonly SessionView[] = [
  session('m-lizzette', 'lizzette', 'Ferretry', '/Users/kirin/ferretry', 18),
  session('m-reynolds', 'reynolds', 'EA Daily Briefing', '/Users/kirin/Obsidian/HQ', 25),
];
const EC2_SESSIONS: readonly SessionView[] = [
  session('e-hadi', 'hadi', 'Pick the migration strategy', '/home/kirin/ferretry', 2, { status: 'awaiting_question' }),
  session('e-ivo', 'ivo', 'Relay carrier bench', '/home/kirin/ferretry', 4),
  session('e-noa', 'noa', 'Tidy the weekly notes', '/home/kirin/Obsidian/HQ', 9),
];

const fleet = new DaemonFleetStore(
  {
    list: async daemon => {
      if (daemon.daemonId === EC2.daemonId) return EC2_SESSIONS;
      throw new Error(RAW);
    },
    get: async () => await Promise.reject(new Error('not in this scene')),
  },
  () => NOW,
);
const projects = new DaemonProjectsStore({
  projects: async daemon => {
    if (daemon.daemonId === MBP.daemonId) throw new Error(RAW);
    return [
      { name: 'ferretry', path: '/home/kirin/ferretry' },
      { name: 'HQ', path: '/home/kirin/Obsidian/HQ' },
    ];
  },
});
const usage = new DaemonUsageStore({ usage: async () => await Promise.reject(new Error('no usage here')) });
const controls = new DaemonControlsStore(undefined);

const ASLEEP: ConnectionHealthState = {
  kind: 'reconnecting',
  since: NOW - 16 * 60_000,
  attempt: 23,
  nextAttemptAt: NOW + 8_000,
  failures: [
    { label: 'Direct', detail: 'http://127.0.0.1:7431 refused the connection (1006)' },
    { label: 'Hosted relay', detail: 'no daemon holds this rendezvous (4404)' },
  ],
  cause: 'daemon-unreachable',
  stalled: true,
};
const CONNECTED: ConnectionHealthState = { kind: 'connected' };
const health: ConnectionHealth = {
  state: daemon => (daemon === MBP.daemonId ? ASLEEP : CONNECTED),
  subscribe: () => () => undefined,
  retryNow: () => undefined,
  onRecovered: () => () => undefined,
};

const MACHINES: readonly ListedMachine[] = [
  { connection: MBP, name: 'Liftoff MBP' },
  { connection: EC2, name: 'Liftoff EC2' },
];
const NEW_SESSION_MACHINES = MACHINES.map(machine => ({ daemonId: machine.connection.daemonId, name: machine.name }));

interface Evidence {
  readonly navigations: string[];
}
const evidence: Evidence = { navigations: [] };
(globalThis as { __oneMachineDown?: Evidence }).__oneMachineDown = evidence;
const navigate = (to: string): void => {
  evidence.navigations.push(to);
};

function Page({ single }: { readonly single: boolean }) {
  const sources = useMachineSources({ fleet, projects, connectionHealth: health }, MACHINES);
  return (
    <SessionsPage
      clock={{ now: () => NOW, intervalMs: 3_600_000, hold: true }}
      connection={MBP}
      connectionHealth={health}
      controls={controls}
      fleet={fleet}
      machineName="Liftoff MBP"
      onNavigate={navigate}
      onOpenWardenReport={() => undefined}
      projects={projects}
      usage={usage}
      wardenStatus={async () => await Promise.reject(new Error('no warden here'))}
      {...(single
        ? {}
        : {
            machineConnections: MACHINES.map(machine => machine.connection),
            machineSources: sources,
            newSessionMachines: NEW_SESSION_MACHINES,
          })}
    />
  );
}

function Scene({ scene }: { readonly scene: 'phone' | 'desktop' | 'single' }) {
  const sources = useMachineSources({ fleet, projects, connectionHealth: health }, MACHINES);
  const notice = <ConnectionHealthNotice health={health} machines={NEW_SESSION_MACHINES} now={() => NOW} />;
  if (scene === 'desktop')
    return (
      <div className="kt-shell flex flex-row overflow-hidden" data-scene="desktop">
        <SessionsBar
          active={null}
          activeSessionId={null}
          daemonId={MBP.daemonId}
          initialMode="all"
          machineName="Liftoff MBP"
          machineSources={sources}
          machines={NEW_SESSION_MACHINES}
          now={NOW}
          onAddMachine={() => undefined}
          onNavigate={navigate}
          onOpenPalette={() => undefined}
          presentation="column"
          projects={[]}
          sessions={sources[0]?.slice.sessions ?? null}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {notice}
          <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
            <Page single={false} />
          </div>
        </div>
      </div>
    );
  return (
    <div className="kt-shell flex flex-col overflow-hidden" data-scene={scene}>
      <AppBar
        active="sessions"
        crumbs={[{ label: 'Sessions' }]}
        daemon={MBP.daemonId}
        onNavigate={navigate}
        onOpenPalette={() => undefined}
        onOpenSidebar={() => undefined}
        sessionCount={MBP_CACHED.length}
        tabBarShown
      />
      {notice}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-1">
        <Page single={scene === 'single'} />
      </div>
      <AppTabBar active="sessions" daemon={MBP.daemonId} onNavigate={navigate} onOpenPalette={() => undefined} />
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') === 'desktop' ? 'desktop' : params.get('scene') === 'single' ? 'single' : 'phone';

// The MBP's rows are this device's copy from 23:05; its live read then fails, as the owner's did.
fleet.seed(MBP, MBP_CACHED, CACHED_AT);
await fleet.hydrate(MBP).catch(() => undefined);
await fleet.hydrate(EC2);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <Scene scene={scene} />
    </StrictMode>,
  );
