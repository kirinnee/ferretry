/**
 * The Inbox over a machine that rolls up every conversation's items (`agenda.open.1`): the shell's REAL inbox
 * (`useAgendaInboxModel`) over 44 conversations — six owner threads and 38 sub-ferrets under them — each holding a
 * snoozed item, a few replied, all read from `GET /v1/agenda/open` in two pages. Far more than the 30 most recent.
 * Rows name the owner's thread, never the sub-ferret; the Snoozed badge and the header are the length of the list.
 *
 * Built and screenshotted by `inbox-rollup-screenshot.ts`.
 */

import { type AgendaItem, DAEMON_FEATURES, type SessionView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import { type AgendaInboxMachine, useAgendaInboxModel } from '../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../src/lib/agenda-client.ts';
import { DaemonAgendaStore } from '../src/lib/agenda-store.ts';
import { AgendaRollupStore } from '../src/lib/agenda-rollup.ts';
import { AgendaWireDirectory } from '../src/lib/agenda-wire.ts';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { AppBar, AppTabBar } from '../src/shell/app-bar.tsx';
import { SessionsBarAgenda } from '../src/shell/sessions-bar-agenda.tsx';
import { healthOf } from '../tests/support/health.ts';
import { sessionView } from '../tests/support/sessions.ts';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });

const THREADS: readonly (readonly [string, string])[] = [
  ['Billing rewrite', 'ada'],
  ['Credentials redesign', 'khristina'],
  ['Relay advertisement', 'hadi'],
  ['Release train', 'kai'],
  ['Durian migration', 'zoe'],
  ['Pairing a second phone', 'judson'],
];
const WORK = [
  'Revive Button Flaky',
  'Fix the nightly benchmark',
  'Rotate the staging key',
  'Tidy the changelog',
  'Check the deploy approval',
  'Trim the snapshot tests',
  'Port the old importer',
];
const ASKS = [
  'Approve the rollout?',
  'Keep the old importer?',
  'Which region first?',
  'Ship the patch tonight?',
  'Merge before the freeze?',
];
const CALLSIGNS = ['vena', 'moe', 'tarn', 'pike', 'oro', 'lux', 'bram', 'sefa'];

const roots: SessionView[] = THREADS.map(([name, teammate], index) =>
  sessionView(`root-${index}`, { config: { name, teammate } }),
);
const kids: SessionView[] = Array.from({ length: 38 }, (_, index) =>
  sessionView(`kid-${index}`, {
    config: {
      name: `${WORK[index % WORK.length]}`,
      teammate: `${CALLSIGNS[index % CALLSIGNS.length]}${index}`,
      parent: `root-${index % THREADS.length}`,
    } as never,
  }),
);
const SESSIONS = [...roots, ...kids];

const parked = (id: string, subject: string, index: number): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    sourceSeq: 1,
    subject,
    why: 'Waiting on the owner.',
    waitingSince: ago(600 + index),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    parked:
      index % 11 === 5
        ? { reason: 'replied', at: ago(30 + index) }
        : { reason: 'snoozed', at: ago(30 + index), until: new Date(NOW + (index + 2) * 3_600_000).toISOString() },
  }) as AgendaItem;

const rolled = SESSIONS.map((view, index) => ({
  sessionId: view.config.id,
  items: [parked('A1', ASKS[index % ASKS.length] as string, index)],
}));

const rollup = new AgendaRollupStore(async input => {
  const after = new URL(String(input)).searchParams.get('after');
  const sorted = [...rolled].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const cut = 24;
  const page =
    after === null
      ? { sessions: sorted.slice(0, cut), next: sorted[cut - 1]?.sessionId }
      : { sessions: sorted.slice(cut) };
  return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
});

const wires = new AgendaWireDirectory();
wires.note(studio.daemonId, {
  kind: 'read',
  health: healthOf('4.240.0', [DAEMON_FEATURES.agendaWire, DAEMON_FEATURES.agendaOpen]),
});
const client = {
  store: new DaemonAgendaStore(),
  wires,
  rollup,
  revalidate: async () => undefined,
} as unknown as DaemonAgendaClient;

const MACHINES: readonly AgendaInboxMachine[] = [{ connection: studio, name: 'Studio', sessions: SESSIONS }];

function Shell({ phone }: { readonly phone: boolean }) {
  const inbox = useAgendaInboxModel(client, MACHINES);
  return (
    <div className={`kt-shell flex h-dvh overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`} data-fixture="">
      {phone ? null : (
        <aside className="fy-sbar flex w-72 shrink-0 flex-col gap-2 border-r border-line p-3" data-fixture-sidebar="">
          <SessionsBarAgenda current href="/inbox" onNavigate={() => undefined} rail={false} total={inbox.total} />
        </aside>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-main="">
        <AppBar
          active="attention"
          agendaCount={inbox.total}
          crumbs={[{ label: 'Inbox' }]}
          daemon={studio.daemonId}
          onNavigate={() => undefined}
          onOpenPalette={() => undefined}
          onOpenSidebar={() => undefined}
          tabBarShown={phone}
        />
        <div className="min-h-0 flex-1 overflow-auto px-1 sm:px-3">
          <AgendaInboxPage inbox={inbox} now={NOW} onNavigate={() => undefined} phone={phone} reducedMotion />
        </div>
        {phone ? (
          <AppTabBar
            active="attention"
            agendaCount={inbox.total}
            daemon={studio.daemonId}
            onNavigate={() => undefined}
            onOpenPalette={() => undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(<Shell phone={window.innerWidth < 768} />);
