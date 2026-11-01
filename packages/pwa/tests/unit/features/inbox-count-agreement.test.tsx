/**
 * EVERY INBOX COUNT IS ONE NUMBER, AND "UPDATING" ENDS. The shell's inbox, built from a fleet like the owner's —
 * several machines, plain notifications, items waiting on a ferret for more information, a snoozed item, a gate
 * card, a card to test, and one machine that does not answer — drawn by every surface that shows the count: the
 * sidebar's Inbox entry, the top bar, the phone's tab bar and the Inbox page's heading.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaItem, AgendaSnapshot, SessionAgendaSummary, SessionView } from '@ferretry/protocol';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { type AgendaInboxMachine, useAgendaInboxModel } from '../../../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../../../src/lib/agenda-client.ts';
import type { DeferredTimers } from '../../../src/lib/agenda-inbox.ts';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import { AgendaWireDirectory } from '../../../src/lib/agenda-wire.ts';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { type ToTestCard, toTestCards } from '../../../src/lib/to-test-inbox.ts';
import { AppBar, AppTabBar } from '../../../src/shell/app-bar.tsx';
import { SessionsBarAgenda } from '../../../src/shell/sessions-bar-agenda.tsx';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';
import { boardModelOf, card } from '../board-support.ts';

const ec2 = daemonConnection({ daemonId: 'ec2', baseUrl: 'https://ec2.example.test', deviceId: 'd-ec2' });
const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-laptop' });
const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const at = (minutes: number): string => new Date(Date.UTC(2026, 7, 1, 10, minutes)).toISOString();
const summary = (open: number, latest: number): SessionAgendaSummary => ({
  open,
  first: 'A1',
  ask: 'Pick one',
  latestAt: at(latest),
});
const waiting = (id: string, name: string, agenda: SessionAgendaSummary): SessionView =>
  sessionView(id, { config: { teammate: name.toLowerCase(), name }, state: { attention: agenda } });
const board = (sessionId: string, items: readonly AgendaItem[]): AgendaSnapshot => ({
  v: 1,
  sessionId,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: at(0),
});
const askedForInfo = (id: string, minutes: number): AgendaItem =>
  agendaItem(id, { waitingSince: at(minutes), waitingOn: 'ferret', askedAt: at(minutes + 1), waitingFor: 'info' });
const gateItem = agendaItem('A1', {
  subject: 'Gated workflows for cards',
  waitingSince: at(7),
  raisedBy: 'daemon',
  raisedBySession: null,
  kind: 'choice',
  ask: choices('Done', 'Not good'),
  gate: {
    cardId: 'F9',
    laneId: 'tested',
    laneName: 'Try it',
    entry: 1,
    projectId: 'p1',
    options: [
      { id: 'o0', label: 'Done', outcome: 'close' },
      { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
} as Partial<AgendaItem>);

/**
 * What the daemons hold. The session lists carry the daemon's summaries — which leave notifications out and keep
 * the items waiting for more information in — and the boards carry the items themselves.
 */
const BOARDS = new Map<string, AgendaSnapshot>([
  [
    'ec2/khristina',
    board('khristina', [
      agendaItem('A1', { subject: 'Credentials redesign', waitingSince: at(5), ask: choices('Ship', 'Hold') }),
      agendaItem('A2', { subject: 'Release went out', waitingSince: at(6), notice: true }),
      askedForInfo('A3', 2),
      askedForInfo('A4', 3),
    ]),
  ],
  ['ec2/judson', board('judson', [gateItem])],
  [
    'studio/zoe',
    board('zoe', [
      agendaItem('A1', { subject: 'Rebase now?', waitingSince: at(4) }),
      agendaItem('A2', { waitingSince: at(1), parked: { reason: 'snoozed', at: at(2), until: at(90) } }),
    ]),
  ],
]);

const MACHINES: readonly AgendaInboxMachine[] = [
  {
    connection: ec2,
    name: 'Liftoff EC2',
    sessions: [waiting('khristina', 'Khristina', summary(3, 5)), waiting('judson', 'Judson', summary(1, 7))],
  },
  { connection: studio, name: 'Studio', sessions: [waiting('zoe', 'Zoe', summary(1, 4))] },
  // The laptop is asleep: its list is this device's cached copy, and every board read times out.
  { connection: laptop, name: 'Laptop', sessions: [waiting('kai', 'Kai', summary(3, 8))] },
];

interface Gate {
  readonly release: () => void;
}

/** The one agenda client at its seams: a real store; reads answer from BOARDS, the laptop's fail. */
const fakeClient = (hold: Gate[] | null = null) => {
  const store = new DaemonAgendaStore();
  const revalidate = async (daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> => {
    if (hold !== null) await new Promise<void>(release => hold.push({ release }));
    if (daemon.daemonId === laptop.daemonId) {
      store.fail(scope);
      throw new Error('did not answer within 20s');
    }
    const value = BOARDS.get(`${daemon.daemonId}/${scope.sessionId}`);
    if (value !== undefined) store.applySnapshot(scope, value);
  };
  return { store, wires: new AgendaWireDirectory(), revalidate } as unknown as DaemonAgendaClient;
};

const quietTimers: DeferredTimers = { setTimeout: () => 0, clearTimeout: () => undefined, now: () => NOW };

function Surfaces({ client, toTest }: { readonly client: DaemonAgendaClient; readonly toTest: readonly ToTestCard[] }) {
  const inbox = useAgendaInboxModel(client, MACHINES, quietTimers, toTest);
  return (
    <div data-total={inbox.total}>
      <SessionsBarAgenda current href="/inbox" onNavigate={() => undefined} rail={false} total={inbox.total} />
      <AppBar
        active="attention"
        agendaCount={inbox.total}
        crumbs={[{ label: 'Inbox' }]}
        daemon={ec2.daemonId}
        onOpenPalette={() => undefined}
      />
      <AppTabBar active="attention" agendaCount={inbox.total} daemon={ec2.daemonId} onOpenPalette={() => undefined} />
      <AgendaInboxPage inbox={inbox} now={NOW} onNavigate={() => undefined} phone={false} />
    </div>
  );
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
};

const counts = (mounted: Mounted) => {
  const of = (selector: string): string | null =>
    mounted.container.querySelector(`${selector} [data-unread-badge]`)?.getAttribute('data-count') ?? null;
  return {
    sidebar: of('[data-sbar-agenda]'),
    page: of('h1.fy-attn-inbox__title'),
    tabBar: mounted.container.querySelector('.kt-tabbar__badge[data-unread-badge]')?.getAttribute('data-count') ?? null,
    topBar: [...mounted.container.querySelectorAll('header [data-unread-badge]')].map(badge =>
      badge.getAttribute('data-count'),
    ),
  };
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the Inbox count across the shell', () => {
  it('shows one number on the sidebar, the top bar, the tab bar and the page, and clears Updating once read', async () => {
    const toTest = toTestCards(await boardModelOf([card('F2', { laneId: 'tested' })]));
    view = await mount(<Surfaces client={fakeClient()} toTest={toTest} />);
    await settle();

    // Liftoff EC2: Credentials redesign and its notification (2), the gate card (1). Studio: Rebase now? (1) — the
    // snoozed item is not counted. Laptop: 3 by its summary, its boards unreadable. One card to test.
    const total = String(2 + 1 + 1 + 3 + 1);
    expect(view.container.querySelector('[data-total]')?.getAttribute('data-total')).toBe(total);
    const shown = counts(view);
    expect(shown.sidebar).toBe(total);
    expect(shown.page).toBe(total);
    expect(shown.tabBar).toBe(total);
    expect(shown.topBar.length).toBeGreaterThan(0);
    for (const count of shown.topBar) expect(count).toBe(total);

    // Nothing is in flight: no Updating, and the laptop says it could not be read instead of spinning.
    expect(view.container.querySelector('[data-agenda-updating]')).toBeNull();
    const unreadable = view.container.querySelector('[data-agenda-unreadable]');
    expect(unreadable?.textContent).toContain('Couldn’t read 3 items on Laptop. Trying again.');
  });

  it('says Updating only while a first read is in flight, and stops when the reads settle — the failed one too', async () => {
    const held: Gate[] = [];
    view = await mount(<Surfaces client={fakeClient(held)} toTest={[]} />);
    await settle();
    expect(view.container.querySelector('[data-agenda-updating], [data-agenda-reading]')).not.toBeNull();
    // Until the boards answer, every surface counts the summaries, and they agree.
    const before = counts(view);
    expect(before.sidebar).toBe(String(3 + 1 + 1 + 3));
    expect(before.page).toBe(before.sidebar);

    await interact(() => {
      for (const read of held.splice(0)) read.release();
    });
    await settle();
    expect(view.container.querySelector('[data-agenda-updating]')).toBeNull();
    expect(view.container.querySelector('[data-agenda-reading]')).toBeNull();
    const after = counts(view);
    expect(after.sidebar).toBe(String(2 + 1 + 1 + 3));
    expect(after.page).toBe(after.sidebar);
    expect(after.tabBar).toBe(after.sidebar);
  });
});
