import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaSnapshot, SessionAgendaSummary, SessionView } from '@ferretry/protocol';
import {
  type AgendaInbox,
  type AgendaInboxMachine,
  useAgendaInboxModel,
  useInboxMachines,
} from '../../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { type DeferredTimers, DISMISS_ACTION, DONE_ACTION, inboxOptions } from '../../src/lib/agenda-inbox.ts';
import { DaemonAgendaStore } from '../../src/lib/agenda-store.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFleetStore, FleetSnapshot } from '../../src/lib/fleet-store.ts';
import '../support/dom.ts';
import { toTestCards } from '../../src/lib/to-test-inbox.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';
import { boardModelOf, card } from './board-support.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-laptop' });
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();

const summary = (open: number, latest: number): SessionAgendaSummary => ({
  open,
  first: 'A1',
  ask: 'Rebase now?',
  latestAt: at(latest),
});

const waiting = (id: string, agenda?: SessionAgendaSummary): SessionView =>
  sessionView(id, agenda === undefined ? {} : { state: { attention: agenda } });

const item = (id: string, minutes: number, ask?: AgendaItem['ask']): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: at(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    ...(ask === undefined ? {} : { ask }),
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
  readonly method: 'revalidate' | 'respond' | 'resolve' | 'dismiss' | 'discuss' | 'snooze' | 'unsnooze';
  readonly daemonId: string;
  readonly sessionId: string;
  readonly detail?: unknown;
}

/** The one agenda client, faked at its seams: a real store, and every call recorded. */
const fakeClient = (boards: Map<string, AgendaSnapshot>) => {
  const calls: Call[] = [];
  const store = new DaemonAgendaStore();
  const record =
    (method: Call['method']) =>
    async (daemon: DaemonConnection, scope: DaemonSessionScope, ...detail: unknown[]): Promise<void> => {
      calls.push({ method, daemonId: daemon.daemonId, sessionId: scope.sessionId, detail });
      if (method === 'revalidate') {
        const value = boards.get(`${daemon.daemonId}/${scope.sessionId}`);
        if (value !== undefined) store.applySnapshot(scope, value);
      }
    };
  const client = {
    store,
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

/** A hand-cranked undo window. */
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
  const fire = (): void => {
    for (const run of due.splice(0)) run();
  };
  return { timers, fire };
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function Probe({
  client,
  machines,
  timers,
  toTest,
  onInbox,
}: {
  readonly client: DaemonAgendaClient;
  readonly machines: readonly AgendaInboxMachine[];
  readonly timers: DeferredTimers;
  readonly toTest?: AgendaInbox['toTest'];
  readonly onInbox: (inbox: AgendaInbox) => void;
}) {
  onInbox(useAgendaInboxModel(client, machines, timers, toTest));
  return null;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useAgendaInboxModel', () => {
  test('counts the cards waiting for a try with the unread agenda items, and holds them apart', async () => {
    const { client } = fakeClient(new Map());
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const rows = toTestCards(await boardModelOf([card('F1', { laneId: 'tested' }), card('F2', { laneId: 'tested' })]));
    view = await mount(
      <Probe client={client} machines={[]} onInbox={value => (inbox = value)} timers={timers} toTest={rows} />,
    );
    await settle();
    const read = inbox as unknown as AgendaInbox;
    expect(read.total).toBe(2);
    expect(read.toTest.map(row => row.card.task.id).sort()).toEqual(['F1', 'F2']);
    expect(read.cards).toEqual([]);
  });

  test('puts a snoozed card aside, out of the count, and brings it back when its time is up', async () => {
    const { client } = fakeClient(new Map());
    let clock = Date.parse('2026-08-02T12:00:00.000Z');
    const armed: { readonly run: () => void; readonly after: number }[] = [];
    const timers: DeferredTimers = {
      setTimeout: (run, after) => {
        armed.push({ run, after });
        return armed.length;
      },
      clearTimeout: () => undefined,
      now: () => clock,
    };
    let inbox: AgendaInbox | null = null;
    const rows = toTestCards(
      await boardModelOf([
        card('F1', { laneId: 'tested' }),
        card('F2', { laneId: 'tested', snoozed: { until: '2026-08-02T13:00:00.000Z', laneId: 'tested' } }),
      ]),
    );
    view = await mount(
      <Probe client={client} machines={[]} onInbox={value => (inbox = value)} timers={timers} toTest={rows} />,
    );
    await settle();
    const asleep = inbox as unknown as AgendaInbox;
    expect(asleep.total).toBe(1);
    expect(asleep.toTest.map(row => row.card.task.id)).toEqual(['F1']);
    expect(asleep.toTestSnoozed.map(row => row.card.task.id)).toEqual(['F2']);
    const wake = armed.at(-1);
    expect(wake?.after).toBe(3_600_000 + 50);

    clock = Date.parse('2026-08-02T13:00:01.000Z');
    await interact(async () => wake?.run());
    await settle();
    const awake = inbox as unknown as AgendaInbox;
    expect(awake.total).toBe(2);
    expect(awake.toTest.map(row => row.card.task.id).sort()).toEqual(['F1', 'F2']);
    expect(awake.toTestSnoozed).toEqual([]);
  });

  test('names each card to test by the task its ferret was given, from the sessions the fleet holds', async () => {
    const { client } = fakeClient(new Map());
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const rows = toTestCards(await boardModelOf([card('F1', { laneId: 'tested' })]));
    const owner = rows[0]?.card.task.owner ?? '';
    const machines: readonly AgendaInboxMachine[] = [
      {
        connection: studio,
        name: 'Studio',
        sessions: [sessionView(owner, { config: { name: 'Credentials Build Lead', teammate: 'zoe' } })],
      },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} toTest={rows} />,
    );
    await settle();
    expect((inbox as unknown as AgendaInbox).toTest.map(row => row.taskName)).toEqual(['Credentials Build Lead']);
  });

  test('reads only unread boards, once per summary, and deals their cards newest first', async () => {
    const boards = new Map([
      ['studio/a', board('a', [item('A1', 1), item('A2', 6)])],
      ['laptop/b', board('b', [item('A1', 4)])],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines = (aOpen: number): readonly AgendaInboxMachine[] => [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(aOpen, 6)), waiting('quiet')] },
      { connection: laptop, name: 'Laptop', sessions: [waiting('b', summary(1, 4))] },
    ];
    const probe = (list: readonly AgendaInboxMachine[]) => (
      <Probe client={client} machines={list} onInbox={value => (inbox = value)} timers={timers} />
    );
    view = await mount(probe(machines(2)));
    await settle();

    const reads = () => calls.filter(call => call.method === 'revalidate').map(c => `${c.daemonId}/${c.sessionId}`);
    expect(reads()).toEqual(['studio/a', 'laptop/b']);
    const read = inbox as unknown as AgendaInbox;
    expect(read.total).toBe(3);
    expect(read.reading).toBe(false);
    expect(read.cards.map(card => `${card.daemonId}/${card.item.id}`)).toEqual(['studio/A2', 'laptop/A1', 'studio/A1']);

    // A fleet read that moved nothing about Attention reads no board and keeps the inbox's rows.
    const before = read.unread;
    await view.render(probe(machines(2)));
    await settle();
    expect(reads()).toHaveLength(2);
    expect((inbox as unknown as AgendaInbox).unread).toBe(before);

    // A summary that moved reads exactly that board again.
    await view.render(probe(machines(1)));
    await settle();
    expect(reads()).toEqual(['studio/a', 'laptop/b', 'studio/a']);

    // A conversation that stopped being unread is forgotten, so coming back reads it afresh.
    await view.render(probe([{ connection: studio, name: 'Studio', sessions: [waiting('a')] }]));
    await settle();
    await view.render(probe(machines(1)));
    await settle();
    expect(reads().filter(entry => entry === 'studio/a')).toHaveLength(3);
  });

  test('reads the board of a conversation whose only open item is in discussion, and deals it apart', async () => {
    const talking = {
      ...item('A1', 1),
      waitingOn: 'ferret',
      askedAt: at(2),
      waitingFor: 'discussion',
    } as AgendaItem;
    const { client, calls } = fakeClient(new Map([['studio/a', board('a', [talking])]]));
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', { ...summary(1, 1), discussing: 1 })] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();

    const read = inbox as unknown as AgendaInbox;
    expect(calls.filter(call => call.method === 'revalidate').map(call => call.sessionId)).toEqual(['a']);
    expect(read.total).toBe(0);
    expect(read.cards).toEqual([]);
    expect(read.withFerret.map(card => `${card.daemonId}/${card.item.id}`)).toEqual(['studio/A1']);
  });

  test('sends a held answer to the right machine, by kind, when the window closes', async () => {
    const boards = new Map([
      ['studio/a', board('a', [item('A1', 1, { kind: 'permission' }), item('A2', 2), item('A3', 3), item('A4', 4)])],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers, fire } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(3, 3))] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = (): AgendaInbox => inbox as unknown as AgendaInbox;
    const card = (id: string) => read().cards.find(entry => entry.item.id === id);

    const permission = card('A1');
    const [approve] = permission === undefined ? [] : inboxOptions(permission.item);
    await interact(() => {
      if (permission !== undefined && approve !== undefined) read().deferred.schedule(permission, approve);
      const second = card('A2');
      if (second !== undefined) read().deferred.schedule(second, DISMISS_ACTION);
      const third = card('A3');
      if (third !== undefined) read().deferred.schedule(third, { kind: 'resolve', label: 'Done', note: 'shipped' });
      const fourth = card('A4');
      if (fourth !== undefined) read().deferred.schedule(fourth, { kind: 'discuss', label: 'Discuss', note: 'why?' });
    });
    // Held: nothing sent, and the held cards are off the deck.
    expect(calls.filter(call => call.method !== 'revalidate')).toEqual([]);
    expect(read().cards).toEqual([]);

    await interact(() => fire());
    await settle();
    expect(calls.filter(call => call.method !== 'revalidate').map(call => [call.method, call.detail])).toEqual([
      ['respond', ['A1', { kind: 'permission', decision: 'approve' }]],
      ['dismiss', ['A2', undefined]],
      ['resolve', ['A3', 'shipped']],
      ['discuss', ['A4', 'why?']],
    ]);
  });

  test('keeps parked items out of the cards and deals them to parked, and sends a snooze and an unsnooze by kind', async () => {
    const parkedItem = (id: string, minutes: number, parked: AgendaItem['parked']): AgendaItem =>
      ({ ...item(id, minutes), parked }) as AgendaItem;
    const boards = new Map([
      [
        'studio/a',
        board('a', [
          item('A1', 1),
          parkedItem('A2', 2, { reason: 'snoozed', at: at(5), until: at(50) }),
          parkedItem('A3', 3, { reason: 'replied', at: at(9) }),
        ]),
      ],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers, fire } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 3))] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = (): AgendaInbox => inbox as unknown as AgendaInbox;
    expect(read().cards.map(card => card.item.id)).toEqual(['A1']);
    expect(read().parked.map(card => card.item.id)).toEqual(['A3', 'A2']);

    const [replied] = read().parked;
    const snoozing = read().cards[0];
    await interact(() => {
      if (snoozing !== undefined)
        read().deferred.schedule(snoozing, { kind: 'snooze', label: 'Snooze', until: at(40) });
      if (replied !== undefined) read().deferred.schedule(replied, { kind: 'unsnooze', label: 'Back to my list' });
    });
    expect(read().parked.map(card => card.item.id)).toEqual(['A2']);
    await interact(() => fire());
    await settle();
    expect(calls.filter(call => call.method !== 'revalidate').map(call => [call.method, call.detail])).toEqual([
      ['snooze', ['A1', at(40)]],
      ['unsnooze', ['A3']],
    ]);
  });

  test('refuses an answer for a machine that is no longer paired, and sends what is held on unmount', async () => {
    const boards = new Map([['studio/a', board('a', [item('A1', 1), item('A2', 2)])]]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(2, 2))] },
    ];
    const probe = (list: readonly AgendaInboxMachine[]) => (
      <Probe client={client} machines={list} onInbox={value => (inbox = value)} timers={timers} />
    );
    view = await mount(probe(machines));
    await settle();
    const read = (): AgendaInbox => inbox as unknown as AgendaInbox;
    const [first, second] = read().cards;

    // Unpaired: the commit has no machine to go to, so the card comes back with why.
    await interact(() => {
      if (first !== undefined) read().deferred.schedule(first, DONE_ACTION);
    });
    await view.render(probe([]));
    await interact(() => read().deferred.flush());
    await settle();
    expect(read().deferredState.failed.map(failure => failure.message)).toEqual([
      'That machine is no longer paired with this browser.',
    ]);

    // Paired again, an answer still held is SENT when the shell goes away, never dropped.
    await view.render(probe(machines));
    await settle();
    await interact(() => {
      if (second !== undefined) read().deferred.schedule(second, DONE_ACTION);
    });
    await view.unmount();
    view = null;
    await settle();
    expect(second?.item.id).toBe('A1');
    expect(calls.filter(call => call.method === 'resolve').map(call => call.detail)).toEqual([
      [second?.item.id, undefined],
    ]);
  });

  test('sends what is held when the page is hidden for good', async () => {
    const boards = new Map([['studio/a', board('a', [item('A1', 1)])]]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = (): AgendaInbox => inbox as unknown as AgendaInbox;
    const [only] = read().cards;
    await interact(() => {
      if (only !== undefined) read().deferred.schedule(only, DISMISS_ACTION);
    });
    await interact(() => window.dispatchEvent(new Event('pagehide')));
    await settle();
    expect(calls.filter(call => call.method === 'dismiss')).toHaveLength(1);
    expect(read().connectionFor(studio.daemonId)).toBe(studio);
  });

  describe('when the page goes to the background', () => {
    const setVisibility = (state: DocumentVisibilityState) =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    afterEach(() => setVisibility('visible'));

    const heldDismiss = async (client: DaemonAgendaClient) => {
      const { timers } = manualTimers();
      let inbox: AgendaInbox | null = null;
      const machines: readonly AgendaInboxMachine[] = [
        { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
      ];
      view = await mount(
        <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
      );
      await settle();
      const [only] = (inbox as unknown as AgendaInbox).cards;
      await interact(() => {
        if (only !== undefined) (inbox as unknown as AgendaInbox).deferred.schedule(only, DISMISS_ACTION);
      });
    };

    test('should send what is held when the page becomes hidden, as a phone does when the app is left', async () => {
      const boards = new Map([['studio/a', board('a', [item('A1', 1)])]]);
      const { client, calls } = fakeClient(boards);
      await heldDismiss(client);
      setVisibility('hidden');
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle();
      expect(calls.filter(call => call.method === 'dismiss')).toHaveLength(1);
    });

    test('should keep holding while the page is visible, so the undo window stays open', async () => {
      const boards = new Map([['studio/a', board('a', [item('A1', 1)])]]);
      const { client, calls } = fakeClient(boards);
      await heldDismiss(client);
      setVisibility('visible');
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
      await settle();
      expect(calls.filter(call => call.method === 'dismiss')).toHaveLength(0);
    });
  });

  test('says it is reading while an unread board has not arrived', async () => {
    const { client } = fakeClient(new Map());
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    view = await mount(
      <Probe
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    expect((inbox as unknown as AgendaInbox).reading).toBe(true);
    expect((inbox as unknown as AgendaInbox).cards).toEqual([]);
  });
});

describe('the Resolved filter reads', () => {
  const resolvedBoard = (sessionId: string): AgendaSnapshot => ({
    ...board(sessionId, []),
    resolved: [
      {
        ...item('A1', 0),
        resolvedAt: at(3),
        resolvedBy: 'human',
        resolvedBySession: null,
        resolvedByName: null,
        resolutionNote: null,
        disposition: 'done',
      } as never,
    ],
  });

  test('loadResolved reads the boards not yet held, once at a time, and then lists their records', async () => {
    const { client, calls } = fakeClient(new Map([['studio/a', resolvedBoard('a')]]));
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const latest = (): AgendaInbox => inbox as unknown as AgendaInbox;
    view = await mount(
      <Probe
        client={client}
        machines={[
          { connection: studio, name: 'Studio', sessions: [waiting('a')] },
          { connection: laptop, name: 'Laptop', sessions: [waiting('b')] },
        ]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    expect(latest().resolved).toEqual([]);
    await interact(async () => {
      latest().loadResolved();
      latest().loadResolved();
    });
    await settle();
    expect(
      calls
        .filter(call => call.method === 'revalidate')
        .map(call => call.sessionId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(latest().resolvedReading).toBe(false);
    expect(latest().resolved.map(row => [row.view.config.id, row.record.id])).toEqual([['a', 'A1']]);
    const before = calls.length;
    await interact(async () => latest().loadResolved());
    await settle();
    expect(calls.length).toBe(before + 1);
  });
  test('skips a board whose machine was unpaired after the read was asked for', async () => {
    const { client, calls } = fakeClient(new Map([['studio/a', resolvedBoard('a')]]));
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const latest = (): AgendaInbox => inbox as unknown as AgendaInbox;
    const element = (machines: readonly AgendaInboxMachine[]) => (
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />
    );
    view = await mount(
      element([
        { connection: studio, name: 'Studio', sessions: [waiting('a')] },
        { connection: laptop, name: 'Laptop', sessions: [waiting('b')] },
      ]),
    );
    await settle();
    const askedBeforeUnpairing = latest().loadResolved;
    await view.render(element([{ connection: studio, name: 'Studio', sessions: [waiting('a')] }]));
    await settle();

    await interact(async () => askedBeforeUnpairing());
    await settle();
    expect(
      calls
        .filter(call => call.method === 'revalidate')
        .map(call => call.daemonId)
        .sort(),
    ).toEqual(['studio']);
    expect(latest().resolvedReading).toBe(false);
  });
});

describe('useInboxMachines', () => {
  test('pairs each machine with its last session list, null before a read', async () => {
    let snapshot: FleetSnapshot = { daemons: new Map() };
    const listeners = new Set<() => void>();
    const fleet = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
    } as unknown as DaemonFleetStore;
    let seen: readonly AgendaInboxMachine[] = [];
    const pairings = [
      { connection: studio, name: 'Studio' },
      { connection: laptop, name: 'Laptop' },
    ];
    function Machines() {
      seen = useInboxMachines(fleet, pairings);
      return null;
    }
    view = await mount(<Machines />);
    expect(seen.map(machine => machine.sessions)).toEqual([null, null]);

    const sessions = [waiting('a')];
    await interact(() => {
      snapshot = {
        daemons: new Map([
          [studio.daemonId, { sessions, byId: new Map(), status: 'ready', error: null }],
        ]) as FleetSnapshot['daemons'],
      };
      for (const listener of listeners) listener();
    });
    expect(seen.map(machine => [machine.name, machine.sessions])).toEqual([
      ['Studio', sessions],
      ['Laptop', null],
    ]);
  });
});
