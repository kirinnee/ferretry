/**
 * The browser entry for the machine-reorder evidence: the REAL sessions bar over three fake machines
 * that all answer, the real saved-order hook and the real controls record kept in this page's
 * localStorage, so a reload proves the order is the device's. Nothing here reads a network.
 *
 * `?scene=bar|drawer` picks the desktop column or the phone's drawer; `?theme=<family>-<mode>` the theme.
 * Navigation is recorded (`window.__machineReorder.navigations`), never followed.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useMachineOrder } from '../../../src/hooks/use-machine-order.ts';
import { type MachineSource, machineDisplayOrder } from '../../../src/lib/all-machines.ts';
import { browserControlsStorage, DaemonControlsStore } from '../../../src/lib/controls.ts';
import { type DaemonId, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { moveMachine } from '../../../src/lib/machine-order.ts';
import { SessionsBar } from '../../../src/shell/sessions-bar.tsx';
import { sessionView } from '../../support/sessions.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const machine = (name: string, pairedAt: number) => ({
  ...daemonConnection({
    daemonId: `fy_daemon_${name.slice(0, 2).repeat(21)}A`,
    baseUrl: `https://${name}.example.test`,
    deviceId: `device-on-${name}`,
  }),
  name,
  pairedAt,
});

const MACHINES = [machine('studio', 1), machine('laptop', 2), machine('pibox', 3)];

const rows = (prefix: string, count: number, cwd: string) =>
  Array.from({ length: count }, (_, index) =>
    sessionView(`${prefix}-${index}`, {
      config: {
        teammate: ['ivo', 'hadi', 'lea', 'ora'][index % 4] ?? 'ivo',
        name: `Task ${index + 1}`,
        cwd,
        mode: 'interactive',
      },
      state: { lastActivityAt: minutesAgo(index + 1) },
    }),
  );

const SESSIONS: Readonly<Record<string, ReturnType<typeof rows>>> = {
  studio: rows('s', 3, '/home/k/ferretry'),
  laptop: rows('l', 2, '/Users/k/site'),
  pibox: rows('p', 2, '/srv/home'),
};

const sourceOf = (record: (typeof MACHINES)[number]): MachineSource => ({
  daemonId: record.daemonId,
  name: record.name,
  reach: 'online',
  projects: [],
  slice: { sessions: SESSIONS[record.name] ?? [], byId: new Map(), status: 'ready', error: null },
});

interface Evidence {
  readonly ids: Readonly<Record<string, string>>;
  readonly navigations: string[];
}
const evidence: Evidence = {
  ids: Object.fromEntries(MACHINES.map(record => [record.name, record.daemonId])),
  navigations: [],
};
(globalThis as { __machineReorder?: Evidence }).__machineReorder = evidence;

const controls = new DaemonControlsStore(browserControlsStorage());
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const drawer = params.get('scene') === 'drawer';

function Scene() {
  const order = useMachineOrder(controls);
  const shown = machineDisplayOrder(MACHINES, order.saved);
  const first = MACHINES[0];
  const onMove = (id: DaemonId, target: DaemonId, edge: 'before' | 'after') =>
    order.commit(
      moveMachine(
        shown.map(record => record.daemonId),
        id,
        target,
        edge,
      ),
    );
  return (
    <div
      className={`kt-shell flex overflow-hidden ${drawer ? 'flex-col' : 'flex-row'}`}
      data-scene={drawer ? 'drawer' : 'bar'}
    >
      <SessionsBar
        active={null}
        activeSessionId={null}
        daemonId={first?.daemonId as DaemonId}
        machineName="studio"
        machineSources={shown.map(sourceOf)}
        machines={shown.map(record => ({ daemonId: record.daemonId, name: record.name }))}
        now={NOW}
        onAddMachine={() => undefined}
        onClose={() => undefined}
        onMoveMachine={onMove}
        onNavigate={to => evidence.navigations.push(to)}
        onOpenPalette={() => undefined}
        presentation={drawer ? 'drawer' : 'column'}
        projects={[]}
        sessions={SESSIONS.studio ?? null}
      />
      <main className="flex min-w-0 flex-1 flex-col gap-2 p-panel text-ui text-fg">
        <p className="m-0 font-semibold">Machines</p>
        <p className="m-0 text-muted">Drag a machine heading by its grip to reorder.</p>
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
