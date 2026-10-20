/**
 * The sessions bar's row menu, on a page of its own (`?session-context-menu`): the real bar — a column
 * on a desktop, the open drawer on a phone — over a small fleet with one parent and its sub-ferrets,
 * whose rows open the real Actions registry (right-click, long-press, the Menu key). The daemon behind
 * it is answered inside the page and changes nothing.
 *
 * A page rather than a gallery card because the menu, the sheet and the drawer are fixed to the viewport.
 */

import type { SessionView } from '@ferretry/protocol';
import { sessionRowMenuRenderer } from '../src/features/session-actions/row-actions-host.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import { DaemonAccountPickerStore } from '../src/lib/account-picker-store.ts';
import { DaemonConnectionStore } from '../src/lib/connections.ts';
import { type DaemonId, daemonConnection } from '../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../src/lib/fleet-store.ts';
import { DaemonProjectsStore } from '../src/lib/projects-store.ts';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { SessionsBar } from '../src/shell/sessions-bar.tsx';
import { sessionView } from '../tests/support/sessions.ts';

export const isSessionContextMenuPage = (search: string): boolean =>
  new URLSearchParams(search).has('session-context-menu');

const DAEMON_ID = `fy_daemon_${'Cc'.repeat(21)}A`;
const CONNECTION = daemonConnection({
  daemonId: DAEMON_ID,
  baseUrl: 'https://workstation.example.test',
  deviceId: 'harness',
});
const NOW = '2026-01-01T00:00:00.000Z';
const row = (
  id: string,
  teammate: string | undefined,
  label: string,
  state: Partial<SessionView['state']> = {},
  parent?: string,
): SessionView =>
  sessionView(id, {
    config: { teammate: teammate as never, label, cwd: '/work/ferretry', ...(parent === undefined ? {} : { parent }) },
    state: { lastActivityAt: NOW, ...state },
  });

const SESSIONS: readonly SessionView[] = [
  row('hadi', 'hadi', 'Fix the stuck sign-in'),
  row('hadi-a', undefined, 'Read the auth flow', {}, 'hadi'),
  row('hadi-b', undefined, 'Write the regression test', { status: 'awaiting_user' }, 'hadi'),
  row('maryah', 'maryah', 'Wire the relay bundle', { status: 'completed' }),
];

const store = {
  connections: new DaemonConnectionStore({
    connections: [{ ...CONNECTION, pairedAt: 1, lastSelectedAt: 1 }],
    selectedDaemonId: CONNECTION.daemonId,
  }),
  clients: { client: async () => ({ request: async () => ({ capabilities: [], governed: false }) }) },
  fleet: new DaemonFleetStore({ list: async () => SESSIONS, get: async () => SESSIONS[0] as SessionView }),
  projects: new DaemonProjectsStore({ projects: async () => [] }),
  accountPicker: new DaemonAccountPickerStore({
    catalog: async () => ({ accounts: [] }),
    health: async () => ({ credentials: [] }),
    probe: async () => ({ credentials: [] }),
  } as never),
  carrier: { fetch: async () => Response.json({ passive: [], sessions: [] }) },
} as unknown as AppStore;

const renderMenu = sessionRowMenuRenderer(() => undefined);

export function SessionContextMenuHarness() {
  useAppViewport();
  const phone = useLayoutMode() === 'drawer';
  return (
    <StoreProvider store={store}>
      <div
        className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`}
        id="harness-session-context-menu"
      >
        <SessionsBar
          active={null}
          activeSessionId="hadi"
          daemonId={CONNECTION.daemonId as DaemonId}
          machineName="studio"
          machines={[{ daemonId: CONNECTION.daemonId as DaemonId, name: 'studio' }]}
          onAddMachine={() => {}}
          onClose={() => {}}
          onCollapse={() => {}}
          onNavigate={() => {}}
          onOpenPalette={() => {}}
          presentation={phone ? 'drawer' : 'column'}
          projects={[]}
          renderSessionMenu={renderMenu}
          sessions={SESSIONS}
        />
        {phone ? null : <main className="min-h-0 flex-1 p-panel text-cell text-muted">The page goes here.</main>}
      </div>
    </StoreProvider>
  );
}
