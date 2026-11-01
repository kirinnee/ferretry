/**
 * The Inbox count and "Updating", end to end: the shell's REAL inbox (`useAgendaInboxModel`) over a fleet like the
 * owner's — three machines, plain notifications, items waiting on a ferret for more information, a snoozed item, a
 * gate card and a card to test — with one machine whose board reads fail after a while, as a sleeping machine's do.
 * The sidebar's Inbox entry, the top bar, the tab bar and the page's heading all draw the count it gives.
 *
 * Built and screenshotted by `inbox-count-screenshot.ts`; `?hold=1` keeps every read in flight.
 */

import type { AgendaItem, AgendaSnapshot, SessionAgendaSummary, SessionView } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../src/features/agenda/agenda-inbox-page.tsx';
import { type AgendaInboxMachine, useAgendaInboxModel } from '../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../src/lib/agenda-client.ts';
import { DaemonAgendaStore } from '../src/lib/agenda-store.ts';
import { AgendaWireDirectory } from '../src/lib/agenda-wire.ts';
import { type DaemonConnection, daemonConnection } from '../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../src/lib/daemon-scope.ts';
import { type ToTestCard, toTestCards, withTaskName } from '../src/lib/to-test-inbox.ts';
import { AppBar, AppTabBar } from '../src/shell/app-bar.tsx';
import { SessionsBarAgenda } from '../src/shell/sessions-bar-agenda.tsx';
import { sessionView } from '../tests/support/sessions.ts';
import { card as boardCard, boardModelOf } from '../tests/unit/board-support.ts';

const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const ec2 = daemonConnection({ daemonId: 'ec2', baseUrl: 'https://ec2.example.test', deviceId: 'd-ec2' });
const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-laptop' });

const summary = (open: number, latest: number): SessionAgendaSummary => ({
  open,
  first: 'A1',
  ask: 'Pick one',
  latestAt: ago(latest),
});
const waiting = (id: string, name: string, teammate: string, agenda: SessionAgendaSummary): SessionView =>
  sessionView(id, { config: { teammate, name }, state: { attention: agenda } });

const item = (id: string, extra: Partial<AgendaItem> & { readonly minutes: number }): AgendaItem => {
  const { minutes, ...rest } = extra;
  return {
    id,
    source: 'agent-raised',
    sourceRef: null,
    sourceSeq: 1,
    subject: `Ask ${id}`,
    why: 'Because it needs you.',
    waitingSince: ago(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    ...rest,
  } as AgendaItem;
};
const choice = (...labels: string[]): AgendaItem['ask'] => ({
  kind: 'multiple-choice',
  options: labels.map(label => ({ label })),
});
const board = (sessionId: string, items: readonly AgendaItem[]): AgendaSnapshot => ({
  v: 1,
  sessionId,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: ago(0),
});
const askedForInfo = (id: string, minutes: number): AgendaItem =>
  item(id, { minutes, subject: 'Which region?', waitingOn: 'ferret', askedAt: ago(minutes - 1), waitingFor: 'info' });

const BOARDS = new Map<string, AgendaSnapshot>([
  [
    'ec2/khristina',
    board('khristina', [
      item('A1', {
        minutes: 12,
        subject: 'Credentials redesign',
        why: 'Try it: you need Ferretry 4.219.0 or later.',
        kind: 'choice',
        ask: choice('Ship it', 'Hold'),
      }),
      item('A2', { minutes: 9, subject: 'Release 4.222.0 went out', notice: true }),
      askedForInfo('A3', 30),
      askedForInfo('A4', 40),
    ]),
  ],
  [
    'ec2/judson',
    board('judson', [
      item('A1', {
        minutes: 5,
        subject: 'Gated workflows for cards',
        raisedBy: 'daemon',
        raisedBySession: null,
        kind: 'choice',
        ask: choice('Done', 'Not good'),
        gate: {
          cardId: 'F31',
          laneId: 'tested',
          laneName: 'Try it',
          entry: 1,
          projectId: 'p1',
          options: [
            { id: 'o0', label: 'Done', outcome: 'close' },
            { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
          ],
        },
      } as Partial<AgendaItem> & { readonly minutes: number }),
    ]),
  ],
  [
    'studio/zoe',
    board('zoe', [
      item('A1', { minutes: 20, subject: 'Rebase onto main now?' }),
      item('A2', {
        minutes: 60,
        subject: 'Rotate the key',
        parked: { reason: 'snoozed', at: ago(50), until: ago(-240) },
      }),
    ]),
  ],
]);

const MACHINES: readonly AgendaInboxMachine[] = [
  {
    connection: ec2,
    name: 'Liftoff EC2',
    sessions: [
      waiting('khristina', 'Cred R3c-5 Rules CLI', 'khristina', summary(3, 9)),
      waiting('judson', 'Gated Workflows Lead', 'judson', summary(1, 5)),
    ],
  },
  { connection: studio, name: 'Studio', sessions: [waiting('zoe', 'Durian Lead', 'zoe', summary(1, 20))] },
  // Asleep: its list is this device's cached copy, and its board reads give up, as they do after 20s.
  { connection: laptop, name: 'Laptop', sessions: [waiting('kai', 'Diene Work', 'kai', summary(3, 2))] },
];

const hold = new URLSearchParams(location.search).get('hold') === '1';
const after = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

const store = new DaemonAgendaStore();
const client = {
  store,
  wires: new AgendaWireDirectory(),
  revalidate: async (daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> => {
    if (hold) return new Promise<void>(() => undefined);
    if (daemon.daemonId === laptop.daemonId) {
      await after(400);
      store.fail(scope);
      throw new Error('did not answer within 20s');
    }
    await after(150);
    const value = BOARDS.get(`${daemon.daemonId}/${scope.sessionId}`);
    if (value !== undefined) store.applySnapshot(scope, value);
  },
} as unknown as DaemonAgendaClient;

const TO_TEST: readonly ToTestCard[] = toTestCards(
  await boardModelOf([boardCard('F61', { laneId: 'tested', owner: 'judson', title: 'Pairing a second phone' })]),
).map(row => withTaskName(row, new Map([['judson', 'Gated Workflows Lead']])));

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
          daemon={ec2.daemonId}
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
            daemon={ec2.daemonId}
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
