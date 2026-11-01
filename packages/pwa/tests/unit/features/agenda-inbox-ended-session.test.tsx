import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaSnapshot, SessionAgendaSummary, SessionView } from '@ferretry/protocol';
import { AgendaInboxPage } from '../../../src/features/agenda/agenda-inbox-page.tsx';
import { type AgendaInbox, type AgendaInboxMachine, useAgendaInboxModel } from '../../../src/hooks/use-agenda-inbox.ts';
import { AgendaWireDirectory } from '../../../src/lib/agenda-wire.ts';
import type { DaemonAgendaClient } from '../../../src/lib/agenda-client.ts';
import type { DeferredTimers } from '../../../src/lib/agenda-inbox.ts';
import { DaemonAgendaStore } from '../../../src/lib/agenda-store.ts';
import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { DEFAULT_LIST_FILTER, sessionsBarView } from '../../../src/shell/sessions-bar-model.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { sessionView } from '../../support/sessions.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 30, 15, minutes)).toISOString();

const summary = (extra: Partial<SessionAgendaSummary> = {}): SessionAgendaSummary => ({
  open: 1,
  first: 'A1',
  ask: 'Which lanes should the board have?',
  latestAt: at(5),
  ...extra,
});

/** A ferret whose session is over (`failed` is the red one on the sidebar), with an agenda summary still on it. */
const ended = (id: string, status: 'failed' | 'stopped', agenda: SessionAgendaSummary): SessionView =>
  sessionView(id, {
    config: { teammate: id, name: 'Lane proposal', cwd: `/work/${id}`, mode: 'interactive' },
    state: { status, attention: agenda },
  } as never);

const item = (id: string, extra: object = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Lane proposal',
    why: 'The board needs lanes.',
    waitingSince: at(5),
    howToResolve: 'Pick one.',
    ask: { kind: 'multiple-choice', options: [{ label: 'Two lanes' }, { label: 'Three lanes' }] },
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    ...extra,
  }) as AgendaItem;

const board = (sessionId: string, items: readonly AgendaItem[]): AgendaSnapshot => ({
  v: 1,
  sessionId,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: at(0),
});

interface Call {
  readonly method: string;
  readonly sessionId: string;
  readonly itemId?: unknown;
}

const fakeClient = (boards: ReadonlyMap<string, AgendaSnapshot>) => {
  const calls: Call[] = [];
  const store = new DaemonAgendaStore();
  const record =
    (method: string) =>
    async (_daemon: DaemonConnection, scope: DaemonSessionScope, itemId?: unknown): Promise<void> => {
      calls.push({ method, sessionId: scope.sessionId, itemId });
      if (method === 'revalidate') {
        const value = boards.get(scope.sessionId);
        if (value !== undefined) store.applySnapshot(scope, value);
      }
    };
  const client = {
    store,
    wires: new AgendaWireDirectory(),
    revalidate: record('revalidate'),
    respond: record('respond'),
    resolve: record('resolve'),
    dismiss: record('dismiss'),
    discuss: record('discuss'),
    snooze: record('snooze'),
    unsnooze: record('unsnooze'),
  } as unknown as DaemonAgendaClient;
  return { client, calls };
};

const manualTimers = () => {
  const due: (() => void)[] = [];
  const timers: DeferredTimers = {
    setTimeout: run => {
      due.push(run);
      return due.length;
    },
    clearTimeout: () => undefined,
    now: () => 0,
  };
  return {
    timers,
    fire: (): void => {
      for (const run of due.splice(0)) run();
    },
  };
};

function InboxPage({
  client,
  machines,
  timers,
  onNavigate,
}: {
  readonly client: DaemonAgendaClient;
  readonly machines: readonly AgendaInboxMachine[];
  readonly timers: DeferredTimers;
  readonly onNavigate: (to: string) => void;
}) {
  const inbox: AgendaInbox = useAgendaInboxModel(client, machines, timers);
  return <AgendaInboxPage inbox={inbox} now={Date.parse(at(30))} onNavigate={onNavigate} phone={false} reducedMotion />;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('an open agenda item on a session that has ended (&B59)', () => {
  const sessions = [
    ended('home-manager', 'failed', summary()),
    ended('retired', 'stopped', summary({ ask: 'Ship it?', latestAt: at(4) })),
  ];

  test('stays in the sidebar under Needs you with its badge, though the session is over', () => {
    const bar = sessionsBarView(sessions, [], DEFAULT_LIST_FILTER);
    expect(bar.needsYou.map(row => row.config.id)).toEqual(['home-manager', 'retired']);
    expect(bar.hiddenStopped).toBe(0);
  });

  test('appears in the Inbox and is dismissed through the daemon, whatever state its session is in', async () => {
    const { client, calls } = fakeClient(
      new Map([
        ['home-manager', board('home-manager', [item('A1')])],
        ['retired', board('retired', [item('A1', { subject: 'Ship it?' })])],
      ]),
    );
    const { timers, fire } = manualTimers();
    const navigated: string[] = [];
    view = await mount(
      <InboxPage
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions }]}
        onNavigate={to => navigated.push(to)}
        timers={timers}
      />,
    );
    await settle();

    expect(calls.filter(call => call.method === 'revalidate').map(call => call.sessionId)).toEqual([
      'home-manager',
      'retired',
    ]);
    const rows = [...view.container.querySelectorAll('[data-agenda-row]')];
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.getAttribute('href'))).toContain('/d/studio/session/home-manager?agenda=A1');

    await interact(() => (rows[0] as HTMLElement).click());
    await settle();
    const open = must(view.container.querySelector('.fy-attn-deck__top [data-agenda-view]'), 'the open item');
    await interact(() =>
      must(open.querySelector<HTMLButtonElement>('[data-agenda-info-toggle]'), 'the about button').click(),
    );
    await interact(() =>
      must(open.querySelector<HTMLButtonElement>('[data-inbox-tool="not-needed"]'), 'Not needed…').click(),
    );
    await interact(() => fire());
    await settle();

    const dismissals = calls.filter(call => call.method === 'dismiss');
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]?.itemId).toBe('A1');
    expect(['home-manager', 'retired']).toContain(dismissals[0]?.sessionId ?? '');
  });

  test('an item the ended ferret can never pick up is still listed under With ferrets', async () => {
    const waitingOnFerret = item('A1', { waitingOn: 'ferret', askedAt: at(6), waitingFor: 'info' });
    const orphan = ended('home-manager', 'failed', summary({ open: 1 }));
    const { client } = fakeClient(new Map([['home-manager', board('home-manager', [waitingOnFerret])]]));
    const { timers } = manualTimers();
    view = await mount(
      <InboxPage
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [orphan] }]}
        onNavigate={() => undefined}
        timers={timers}
      />,
    );
    await settle();
    expect(view.container.querySelector('[data-agenda-section="with-ferrets"]')).not.toBeNull();
  });
});
