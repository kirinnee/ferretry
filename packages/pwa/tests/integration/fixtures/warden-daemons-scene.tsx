/**
 * The browser entry for the Warden page across paired daemons: the REAL `WardenPage` with its daemon
 * filter, the REAL `WardenOverview` body per daemon and the REAL device-controls hook, over two fake
 * daemons' fixed statuses. Nothing here reads a network.
 *
 *   Liftoff EC2  busy: a seven-flag day, a revive, a running investigation and a flagged ferret.
 *   Liftoff MBP  quiet: two flags, one nudge, nothing running.
 *
 * `?theme=<family>-<mode>` picks the theme, `?daemons=1` pairs only the first daemon. The filter choice is
 * kept in `localStorage` through the real controls store, so a reload proves "remembered per device".
 */

import type { WardenAgendaView, WardenStatusView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';

import { WardenOverview } from '../../../src/features/warden/warden-overview.tsx';
import { useWardenDaemonScope } from '../../../src/hooks/use-warden-daemon-scope.ts';
import { DaemonControlsStore } from '../../../src/lib/controls.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { WardenPage, type WardenSurfaceProps } from '../../../src/lib/pages/warden-page.tsx';
import { sessionView } from '../../support/sessions.ts';
import {
  wardenAction,
  wardenAgenda,
  wardenAnomaly,
  wardenConfig,
  wardenFailover,
  wardenInvestigation,
  wardenStatus,
} from '../../support/warden.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const counts = (auto = 0, jev = 0, llm = 0) => ({ auto, jev, llm });
const day = (date: string, flags: number, moved = counts(), cleared = counts()) => ({
  day: date,
  flags,
  jevDecisions: flags,
  investigations: 0,
  jevUsd: 0,
  investigationUsd: 0,
  moved,
  cleared,
  stopped: counts(),
  asked: counts(),
});

const EC2 = daemonConnection({ daemonId: 'daemon-ec2', baseUrl: 'https://ec2.example.test', deviceId: 'a' });
const MBP = daemonConnection({ daemonId: 'daemon-mbp', baseUrl: 'https://mbp.example.test', deviceId: 'b' });

const busy: WardenStatusView = wardenStatus({
  config: wardenConfig(),
  lastSweepAt: '2026-07-31T11:59:00.000Z',
  failover: wardenFailover(),
  history: [
    day('2026-07-29', 6, counts(1, 2), counts(0, 3)),
    day('2026-07-30', 4, counts(2, 1)),
    day('2026-07-31', 7, counts(3, 4), counts(0, 2)),
  ],
  anomalies: [wardenAnomaly({ sessionId: 'ec2-a', teammate: 'maryah', detail: 'No monitor is attached.' })],
  investigations: [wardenInvestigation({ id: 'warden-1', targetSession: 'ec2-a' })],
  actions: [
    wardenAction({
      sessionId: 'ec2-a',
      action: 'restart',
      at: '2026-07-31T11:50:00.000Z',
      by: 'jev',
      confidence: 0.96,
      detail: 'Restarted its process; its terminal had closed.',
    }),
    wardenAction({
      sessionId: 'ec2-b',
      action: 'nudge',
      at: '2026-07-31T11:30:00.000Z',
      detail: 'Asked it to report.',
    }),
  ],
});

const quiet: WardenStatusView = wardenStatus({
  config: wardenConfig(),
  lastSweepAt: '2026-07-31T11:58:00.000Z',
  failover: wardenFailover(),
  history: [day('2026-07-30', 1), day('2026-07-31', 2, counts(1, 0), counts(0, 1))],
  actions: [
    wardenAction({
      sessionId: 'mbp-a',
      action: 'nudge',
      at: '2026-07-31T11:20:00.000Z',
      detail: 'Asked it to report.',
    }),
  ],
});

const STATUS = new Map<string, WardenStatusView>([
  [EC2.daemonId, busy],
  [MBP.daemonId, quiet],
]);
const SESSIONS = [
  sessionView('ec2-a', { config: { teammate: 'maryah' } }),
  sessionView('ec2-b', { config: { teammate: 'marin' } }),
  sessionView('mbp-a', { config: { teammate: 'kamila' } }),
];
const agenda: WardenAgendaView = wardenAgenda();

function Overview({ connection, machineName }: WardenSurfaceProps) {
  const status = STATUS.get(connection.daemonId);
  return (
    <WardenOverview
      connection={connection}
      {...(machineName === undefined ? {} : { machineName })}
      status={status === undefined ? { status: 'loading' } : { status: 'ready', view: status }}
      attention={{ status: 'ready', view: agenda }}
      sessions={SESSIONS}
      now={NOW}
      settingsHref={`/d/${connection.daemonId}/settings#warden`}
      onSweep={() => {}}
      onOpenReport={() => {}}
    />
  );
}

const controls = new DaemonControlsStore();
const machines = [
  { connection: EC2, name: 'Liftoff EC2' },
  { connection: MBP, name: 'Liftoff MBP' },
].slice(0, params.get('daemons') === '1' ? 1 : 2);

function Scene() {
  const { remembered, remember } = useWardenDaemonScope(controls);
  return (
    <div className="warden-scene">
      <WardenPage
        connection={EC2}
        slots={{ Overview }}
        machines={machines}
        remembered={remembered}
        onRemember={remember}
      />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  html, body, #root { height: 100%; margin: 0; }
  .warden-scene { box-sizing: border-box; display: flex; flex-direction: column; height: 100%; padding: 0 16px; }
  @media (min-width: 640px) { .warden-scene { padding: 0 20px; } }
`;
document.head.append(style);
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
