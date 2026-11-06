/**
 * The shell's REAL Inbox (`useAgendaInboxModel`) over one machine with cards waiting for a try, as that machine's health
 * says it handles them (the integration scene `tests/integration/fixtures/inbox-card-asks-scene.tsx` imports it):
 *
 *   ?machine=modern   health lists `agenda.card-asks.1`: a card's ask is an agenda item, so the Inbox has no To test list
 *   ?machine=older    health does not: the Inbox keeps To test rows, their count, the quick-answer step and a snoozed row
 *
 * Same cards, same open question; only the health differs. The answers of the machine are invented, nothing is sent.
 */

import { type AgendaItem, type AgendaSnapshot, DAEMON_FEATURES } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import { useAgendaInboxModel } from '../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../src/lib/agenda-client.ts';
import { AgendaRollupStore } from '../src/lib/agenda-rollup.ts';
import { DaemonAgendaStore } from '../src/lib/agenda-store.ts';
import { AgendaWireDirectory } from '../src/lib/agenda-wire.ts';
import type { DaemonConnection } from '../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../src/lib/daemon-scope.ts';
import { toTestCards } from '../src/lib/to-test-inbox.ts';
import { AppBar, AppTabBar } from '../src/shell/app-bar.tsx';
import { SessionsBarAgenda } from '../src/shell/sessions-bar-agenda.tsx';
import { healthOf } from '../tests/support/health.ts';
import { sessionView } from '../tests/support/sessions.ts';
import { boardModelOf, card, laptop } from '../tests/unit/board-support.ts';

const MODERN = new URLSearchParams(location.search).get('machine') !== 'older';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const SESSION_ID = 'fr';

const QUESTION = {
  id: 'A12',
  source: 'agent-raised',
  sourceRef: null,
  sourceSeq: 1,
  subject: 'Which relay region should the hosted default use?',
  why: 'The directory advertises one region per release.',
  waitingSince: ago(40),
  howToResolve: 'Pick a region.',
  raisedBy: 'agent',
  raisedBySession: SESSION_ID,
  raisedByName: 'johnnie',
  ask: { kind: 'multiple-choice', options: [{ label: 'Frankfurt' }, { label: 'Singapore' }] },
} as unknown as AgendaItem;

const BOARD: AgendaSnapshot = {
  v: 1,
  sessionId: SESSION_ID,
  items: [QUESTION],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: ago(0),
};
const SESSION = sessionView(SESSION_ID, {
  config: { name: 'Release cut', teammate: 'johnnie' } as never,
  state: { agenda: { open: 1, first: 'A12', ask: QUESTION.subject, latestAt: ago(40) } } as never,
});

const store = new DaemonAgendaStore();
const wires = new AgendaWireDirectory();
wires.note(laptop.daemonId, {
  kind: 'read',
  health: healthOf('4.120.0', MODERN ? [DAEMON_FEATURES.agendaCardAsks] : []),
});
const loadBoard = async (_daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> => {
  if (scope.sessionId === SESSION_ID) store.applySnapshot(scope, BOARD);
};
const client = {
  store,
  wires,
  rollup: new AgendaRollupStore(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
  hydrate: loadBoard,
  revalidate: loadBoard,
} satisfies Pick<
  DaemonAgendaClient,
  'store' | 'wires' | 'rollup' | 'hydrate' | 'revalidate'
> as unknown as DaemonAgendaClient;

const tested = (id: string, title: string, minutes: number, extra: Record<string, unknown> = {}) =>
  card(id, {
    laneId: 'tested',
    title,
    howToTest: '1. Open the app.\n2. Try it on a second phone.',
    shippedIn: { version: '5.4.0', tag: 'v5.4.0', at: ago(minutes) },
    ...extra,
  });
const TO_TEST = toTestCards(
  await boardModelOf([
    tested('F61', 'Pairing a second phone', 90),
    tested('F58', 'Faster board loading', 60 * 26),
    tested('F70', 'Offline banner wording', 60 * 30, {
      snoozed: { until: new Date(Date.now() + 5 * 3_600_000).toISOString(), laneId: 'tested' },
    }),
  ]),
);
const MACHINES = [{ connection: laptop, name: 'Laptop', sessions: [SESSION] }];

function Shell({ phone }: { readonly phone: boolean }) {
  const inbox = useAgendaInboxModel(client, MACHINES, undefined, TO_TEST);
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
          daemon={laptop.daemonId}
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
            daemon={laptop.daemonId}
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
