/**
 * Notifications surfaces on one page each (`notifications-screenshot.ts` bundles this): the per-machine
 * list in Settings, the "notifications are off" banner, and the sessions bar with Needs you grouped on
 * or off. Real components, invented data; nothing leaves the page.
 */

import type { SessionView } from '@ferretry/protocol';
import { type ReactElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MachineNotificationList, NotificationsOffBanner } from '../src/features/settings/notification-machines.tsx';
import { daemonId } from '../src/lib/daemon-connection.ts';
import type { MachineNotificationRow } from '../src/lib/machine-notifications.ts';
import { daemonAttentionPath } from '../src/lib/pages/routes.ts';
import { SessionsBar } from '../src/shell/sessions-bar.tsx';
import { sessionView } from '../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-23T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const STUDIO = daemonId('studio');

const ROWS: readonly MachineNotificationRow[] = [
  {
    daemonId: 'studio',
    label: 'studio',
    status: 'on',
    statusText: 'On · this device',
    enrolledDevices: 2,
    shown: true,
  },
  { daemonId: 'laptop', label: 'laptop', status: 'off', statusText: 'Off', enrolledDevices: 0, shown: true },
  {
    daemonId: 'nas',
    label: 'nas',
    status: 'offline',
    statusText: 'Machine offline',
    enrolledDevices: null,
    shown: false,
  },
];

const noop = (): void => undefined;

function Settings(): ReactElement {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-md bg-bg p-panel" data-fixture="">
      <h1 className="m-0 text-title font-semibold">Notifications</h1>
      <MachineNotificationList
        busy={new Set()}
        canEnrol
        failures={{}}
        onDisable={noop}
        onEnable={noop}
        onToggleShown={noop}
        onTurnOnAll={noop}
        rows={ROWS}
      />
    </main>
  );
}

function Banner(): ReactElement {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-md bg-bg p-panel" data-fixture="">
      <NotificationsOffBanner busy={new Set()} canEnrol onEnable={noop} rows={ROWS.slice(1, 2)} />
    </main>
  );
}

const ferret = (
  id: string,
  teammate: string,
  label: string,
  attention?: { open: number; ask: string; minutes: number },
) =>
  sessionView(id, {
    config: { teammate: teammate as never, label, cwd: `/home/kirin/Workspace/${id}` },
    state: {
      lastActivityAt: ago(1),
      ...(attention === undefined
        ? {}
        : { attention: { open: attention.open, first: 'A1', ask: attention.ask, latestAt: ago(attention.minutes) } }),
    },
  });

const SESSIONS: readonly SessionView[] = [
  ferret('dw', 'wren', 'Docs sweep'),
  ferret('fr', 'ottilie', 'Attention inbox wiring', { open: 1, ask: 'Rebase onto main now?', minutes: 2 }),
  ferret('nl', 'zelda', 'Nightly benchmarks'),
  ferret('hm', 'hadi', 'Relay advertisement', { open: 2, ask: 'Restart the staging relay?', minutes: 9 }),
];

function Bar({ grouped }: { readonly grouped: boolean }): ReactElement {
  const [mode] = useState('all' as const);
  return (
    <div className="flex bg-bg" data-fixture="" style={{ height: 760 }}>
      <style>
        {
          '@media (max-width: 767px) { [data-sessions-bar="column"] { width: 100% !important; border-right: 0 !important; } }'
        }
      </style>
      <SessionsBar
        active={null}
        activeSessionId="dw"
        attentionHref={daemonAttentionPath(STUDIO)}
        attentionTotal={3}
        daemonId={STUDIO}
        groupNeedsYou={grouped}
        initialMode={mode}
        machineName="studio"
        machines={[{ daemonId: STUDIO, name: 'studio' }]}
        now={NOW}
        onAddMachine={noop}
        onClose={noop}
        onCollapse={noop}
        onExpand={noop}
        onNavigate={noop}
        onOpenPalette={noop}
        presentation="column"
        projects={[]}
        sessions={SESSIONS}
      />
    </div>
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'settings';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  view === 'banner' ? (
    <Banner />
  ) : view === 'group-on' ? (
    <Bar grouped />
  ) : view === 'group-off' ? (
    <Bar grouped={false} />
  ) : (
    <Settings />
  ),
);
