import { afterEach, describe, expect, test } from 'bun:test';
import {
  type AgendaItem,
  type AgendaSnapshot,
  DAEMON_FEATURES,
  type SessionAgendaSummary,
  type SessionView,
} from '@ferretry/protocol';
import {
  type AgendaInbox,
  type AgendaInboxMachine,
  useAgendaInboxModel,
  useInboxMachines,
} from '../../src/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { type DeferredTimers, DISMISS_ACTION, DONE_ACTION, inboxOptions } from '../../src/lib/agenda-inbox.ts';
import { DaemonAgendaStore } from '../../src/lib/agenda-store.ts';
import { AgendaRollupStore } from '../../src/lib/agenda-rollup.ts';
import { AgendaWireDirectory } from '../../src/lib/agenda-wire.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFleetStore, FleetSnapshot } from '../../src/lib/fleet-store.ts';
import '../support/dom.ts';
import { toTestCards } from '../../src/lib/to-test-inbox.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { sessionView } from '../support/sessions.ts';
import { settleUntil } from '../support/settle.ts';
import { laptop as boardLaptop, boardModelOf, card } from './board-support.ts';

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
  sessionView(id, agenda === undefined ? {} : { state: { agenda: agenda } });

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
const fakeClient = (
  boards: Map<string, AgendaSnapshot>,
  /** What each machine's roll-up answers: its conversations' items by session id. */
  rollups: Record<string, Record<string, readonly AgendaItem[]>> = {},
) => {
  const rolled: string[] = [];
  const rollup = new AgendaRollupStore(async input => {
    const host = new URL(String(input)).host.split('.')[0] ?? '';
    rolled.push(host);
    const held = rollups[host];
    // A machine the test gave no roll-up answers none, so the Inbox keeps reading that machine's boards.
    if (held === undefined) return new Response('{}', { status: 404 });
    return new Response(
      JSON.stringify({ sessions: Object.entries(held).map(([sessionId, items]) => ({ sessionId, items })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
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
    wires: new AgendaWireDirectory(),
    rollup,
    hydrate: record('revalidate'),
    revalidate: record('revalidate'),
    respond: record('respond'),
    resolve: record('resolve'),
    dismiss: record('dismiss'),
    discuss: record('discuss'),
    snooze: record('snooze'),
    unsnooze: record('unsnooze'),
  } satisfies Pick<
    DaemonAgendaClient,
    | 'store'
    | 'wires'
    | 'rollup'
    | 'hydrate'
    | 'revalidate'
    | 'respond'
    | 'resolve'
    | 'dismiss'
    | 'discuss'
    | 'snooze'
    | 'unsnooze'
  > as unknown as DaemonAgendaClient;
  return { client, calls, rolled };
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
  withdraw,
  onInbox,
}: {
  readonly client: DaemonAgendaClient;
  readonly machines: readonly AgendaInboxMachine[];
  readonly timers: DeferredTimers;
  readonly toTest?: AgendaInbox['toTest'];
  readonly withdraw?: Parameters<typeof useAgendaInboxModel>[4];
  readonly onInbox: (inbox: AgendaInbox) => void;
}) {
  onInbox(useAgendaInboxModel(client, machines, timers, toTest, withdraw));
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

  test('gives a card ask the card’s How to test from the board it already reads, for that machine only', async () => {
    const { client } = fakeClient(new Map());
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const rows = toTestCards(
      await boardModelOf([card('F1', { laneId: 'tested', howToTest: '1. Try it.' }), card('F2', { laneId: 'tested' })]),
    );
    view = await mount(
      <Probe client={client} machines={[]} onInbox={value => (inbox = value)} timers={timers} toTest={rows} />,
    );
    await settle();
    const read = inbox as unknown as AgendaInbox;
    const machine = must(rows[0], 'a row').card.daemonId;
    expect(read.howToTestFor?.(machine, 'F1')).toBe('1. Try it.');
    expect(read.howToTestFor?.(machine, 'F2')).toBe('');
    expect(read.howToTestFor?.(machine, 'F9')).toBeNull();
    expect(read.howToTestFor?.('another-machine' as typeof machine, 'F1')).toBeNull();
  });

  describe('the health switch for gate items', () => {
    const gateItemFor = (cardId: string): AgendaItem =>
      ({
        ...item('A1', 1),
        raisedBy: 'daemon',
        raisedBySession: null,
        kind: 'choice',
        ask: { kind: 'multiple-choice', options: [{ label: 'Done' }, { label: 'Not good' }] },
        gate: {
          cardId,
          laneId: 'tested',
          laneName: 'Try it',
          entry: 1,
          projectId: 'p1',
          options: [
            { id: 'o0', label: 'Done', outcome: 'close' },
            { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
          ],
        },
      }) as AgendaItem;

    const run = async (flag: boolean, gate: AgendaItem = gateItemFor('F1'), snoozeF1 = false) => {
      const { client } = fakeClient(new Map([[`${boardLaptop.daemonId}/g`, board('g', [gate])]]));
      client.wires.note(boardLaptop.daemonId, {
        kind: 'read',
        health: healthOf('4.110.0', flag ? [DAEMON_FEATURES.boardGateItems] : []),
      });
      const { timers } = manualTimers();
      let inbox: AgendaInbox | null = null;
      const rows = toTestCards(
        await boardModelOf([
          card(
            'F1',
            snoozeF1
              ? { laneId: 'tested', snoozed: { until: '2999-01-01T00:00:00.000Z', laneId: 'tested' } }
              : { laneId: 'tested' },
          ),
          card('F2', { laneId: 'tested' }),
        ]),
      );
      view = await mount(
        <Probe
          client={client}
          machines={[{ connection: boardLaptop, name: 'Laptop', sessions: [waiting('g', summary(1, 1))] }]}
          onInbox={value => (inbox = value)}
          timers={timers}
          toTest={rows}
        />,
      );
      await settle();
      const read = inbox as unknown as AgendaInbox;
      return read;
    };

    test('on a machine that advertises gate items the row its gate item covers is not shown; the others stay', async () => {
      const read = await run(true);
      expect(read.cards.map(entry => entry.item.id)).toEqual(['A1']);
      expect(read.toTest.map(row => row.card.task.id)).toEqual(['F2']);
    });

    test('a gate item that is snoozed or replied still stands in for its card, awake or snoozed', async () => {
      const parkedGate = (parked: AgendaItem['parked']): AgendaItem => ({ ...gateItemFor('F1'), parked }) as AgendaItem;
      const snoozed = await run(true, parkedGate({ reason: 'snoozed', at: at(5), until: at(50) }), true);
      expect(snoozed.toTestSnoozed).toEqual([]);
      expect(snoozed.toTest.map(row => row.card.task.id)).toEqual(['F2']);
      expect(snoozed.total).toBe(1);
      await view?.unmount();
      const replied = await run(true, parkedGate({ reason: 'replied', at: at(9) }));
      expect(replied.toTest.map(row => row.card.task.id)).toEqual(['F2']);
      expect(replied.parked.map(entry => entry.item.id)).toEqual(['A1']);
    });

    test('without the flag, every to-test row stays, as before', async () => {
      const read = await run(false);
      expect(read.toTest.map(row => row.card.task.id).sort()).toEqual(['F1', 'F2']);
    });
  });

  describe('the health switch for card asks', () => {
    const run = async (advertising: readonly (typeof boardLaptop)[], upgrade = false) => {
      const { client } = fakeClient(new Map());
      upgraded = () =>
        client.wires.note(boardLaptop.daemonId, {
          kind: 'read',
          health: healthOf('4.120.0', [DAEMON_FEATURES.agendaCardAsks]),
        });
      client.wires.note(boardLaptop.daemonId, { kind: 'read', health: healthOf('4.110.0') });
      for (const machine of advertising)
        client.wires.note(machine.daemonId, {
          kind: 'read',
          health: healthOf('4.120.0', [DAEMON_FEATURES.agendaCardAsks]),
        });
      const { timers } = manualTimers();
      let inbox: AgendaInbox | null = null;
      const rows = toTestCards(
        await boardModelOf([
          card('F1', { laneId: 'tested' }),
          card('F2', { laneId: 'tested', snoozed: { until: '2999-01-01T00:00:00.000Z', laneId: 'tested' } }),
        ]),
      );
      view = await mount(
        <Probe
          client={client}
          machines={[{ connection: boardLaptop, name: 'Laptop', sessions: [] }]}
          onInbox={value => (inbox = value)}
          timers={timers}
          toTest={rows}
        />,
      );
      await settle();
      if (upgrade) {
        await interact(() => upgraded());
        await settle();
      }
      return inbox as unknown as AgendaInbox;
    };
    let upgraded: () => void = () => undefined;

    test('a machine that starts advertising card asks after the page is open drops its To-test list at once', async () => {
      const read = await run([], true);
      expect(read.toTest).toEqual([]);
      expect(read.toTestSnoozed).toEqual([]);
      expect(read.total).toBe(0);
    });

    test('on a machine that advertises card asks there is no To-test list: awake, snoozed or counted', async () => {
      const read = await run([boardLaptop]);
      expect(read.toTest).toEqual([]);
      expect(read.toTestSnoozed).toEqual([]);
      expect(read.total).toBe(0);
    });

    test('on a machine that does not, every row stays, awake and snoozed, and counts', async () => {
      const read = await run([]);
      expect(read.toTest.map(row => row.card.task.id)).toEqual(['F1']);
      expect(read.toTestSnoozed.map(row => row.card.task.id)).toEqual(['F2']);
      expect(read.total).toBe(1);
    });

    test('another machine advertising card asks takes nothing from this machine’s rows', async () => {
      const read = await run([studio]);
      expect(read.toTest.map(row => row.card.task.id)).toEqual(['F1']);
      expect(read.toTestSnoozed.map(row => row.card.task.id)).toEqual(['F2']);
    });
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

  test('reads each machine’s own agenda and lists it first, counted, from its own board', async () => {
    const boards = new Map([
      ['studio/machine-agenda', board('machine-agenda', [{ ...item('A7', 3), notice: true } as AgendaItem])],
      ['studio/a', board('a', [item('A1', 1)])],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
      { connection: laptop, name: 'Laptop', sessions: [waiting('quiet')] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = inbox as unknown as AgendaInbox;
    const polled = calls.filter(call => call.method === 'revalidate' && call.sessionId === 'machine-agenda');
    expect([...new Set(polled.map(call => call.daemonId))].sort()).toEqual(['laptop', 'studio']);
    expect(read.unread.map(entry => entry.view.config.id)).toEqual(['machine-agenda', 'a']);
    expect(read.total).toBe(2);
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

    const reads = () =>
      calls
        .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
        .map(c => `${c.daemonId}/${c.sessionId}`);
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
    expect(
      calls
        .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
        .map(call => call.sessionId),
    ).toEqual(['a']);
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
      ['respond', ['A1', { kind: 'permission', decision: 'approve' }, undefined, undefined, undefined, 1]],
      ['dismiss', ['A2', undefined, 1]],
      ['resolve', ['A3', 'shipped', 1]],
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
      [second?.item.id, undefined, 1],
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

  test('says it is reading while an unread board is on its first read', async () => {
    const { client } = fakeClient(new Map());
    // The read is in flight and stays so.
    const inFlight = {
      ...client,
      hydrate: () => new Promise<void>(() => undefined),
      revalidate: () => new Promise<void>(() => undefined),
    } satisfies Pick<
      DaemonAgendaClient,
      'store' | 'wires' | 'rollup' | 'hydrate' | 'revalidate'
    > as unknown as DaemonAgendaClient;
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    view = await mount(
      <Probe
        client={inFlight}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    expect((inbox as unknown as AgendaInbox).reading).toBe(true);
    expect((inbox as unknown as AgendaInbox).cards).toEqual([]);
    expect((inbox as unknown as AgendaInbox).unavailable).toEqual([]);
    // Until it lands the conversation counts what its summary says.
    expect((inbox as unknown as AgendaInbox).total).toBe(1);
  });

  test('stops reading when a machine cannot be read, names it, keeps counting its items, and reads it again', async () => {
    const boards = new Map([['studio/a', board('a', [item('A1', 1)])]]);
    const { client, calls } = fakeClient(boards);
    const { timers, fire } = manualTimers();
    let inbox: AgendaInbox | null = null;
    view = await mount(
      <Probe
        client={client}
        machines={[
          { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
          { connection: laptop, name: 'Laptop', sessions: [waiting('b', summary(2, 2)), waiting('c', summary(1, 3))] },
        ]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    const down = inbox as unknown as AgendaInbox;
    expect(down.reading).toBe(false);
    expect(down.cards.map(card => card.item.id)).toEqual(['A1']);
    expect(down.unavailable).toEqual([{ daemonId: laptop.daemonId, machineName: 'Laptop', items: 3 }]);
    expect(down.total).toBe(1 + 3);

    // The machine answers; the retry reads its boards, and the Inbox lists what it counted.
    boards.set('laptop/b', board('b', [item('A1', 4), item('A2', 5)]));
    boards.set('laptop/c', board('c', [item('A1', 6)]));
    await interact(() => fire());
    await settle();
    const up = inbox as unknown as AgendaInbox;
    const reads = calls
      .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
      .map(call => `${call.daemonId}/${call.sessionId}`);
    // Newest first, as the inbox lists them; the two that failed are read again.
    expect(reads).toEqual(['laptop/c', 'laptop/b', 'studio/a', 'laptop/c', 'laptop/b']);
    expect(up.reading).toBe(false);
    expect(up.unavailable).toEqual([]);
    expect(up.total).toBe(4);
    expect(up.total).toBe(up.cards.length + up.toTest.length);
  });

  test('counts what the page lists once the boards are read, whatever the summaries said', async () => {
    const askedForInfo = (id: string): AgendaItem =>
      ({ ...item(id, 2), waitingOn: 'ferret', askedAt: at(3), waitingFor: 'info' }) as AgendaItem;
    const notice = { ...item('A4', 4), notice: true } as AgendaItem;
    const snoozed = { ...item('A5', 5), parked: { reason: 'snoozed', at: at(5), until: at(50) } } as AgendaItem;
    // The daemon's summary: three open (A1 and the two waiting for more information), the notification and the
    // snoozed item left out. The deck: A1 and the notification.
    const boards = new Map([
      ['studio/a', board('a', [item('A1', 1), askedForInfo('A2'), askedForInfo('A3'), notice, snoozed])],
    ]);
    const { client } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const rows = toTestCards(await boardModelOf([card('F1', { laneId: 'tested' })]));
    view = await mount(
      <Probe
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a', summary(3, 5))] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
        toTest={rows}
      />,
    );
    await settle();
    const read = inbox as unknown as AgendaInbox;
    expect(read.cards.map(entry => entry.item.id)).toEqual(['A4', 'A1']);
    expect(read.withFerret.map(entry => entry.item.id).sort()).toEqual(['A2', 'A3']);
    expect(read.parked.map(entry => entry.item.id)).toEqual(['A5']);
    expect(read.total).toBe(read.cards.length + read.toTest.length);
    expect(read.total).toBe(3);
  });
});

describe('a reply the owner takes back', () => {
  const replying = async (withdraw?: Parameters<typeof useAgendaInboxModel>[4]) => {
    const { client, calls } = fakeClient(new Map([['studio/a', board('a', [item('A1', 1)])]]));
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const machines: readonly AgendaInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
    ];
    view = await mount(
      <Probe
        client={client}
        machines={machines}
        onInbox={value => (inbox = value)}
        timers={timers}
        withdraw={withdraw}
      />,
    );
    await settle();
    const read = (): AgendaInbox => inbox as unknown as AgendaInbox;
    return { calls, read };
  };

  test('hides the card at once, withdraws the waiting message from its machine, and unsnoozes the item there', async () => {
    const taken: string[] = [];
    const { calls, read } = await replying(async (card, sendId) => {
      taken.push(`${card.daemonId}/${card.view.config.id}/${sendId}`);
      return 'withdrawn';
    });
    const first = read().cards[0];
    if (first === undefined) throw new Error('no card');
    await interact(async () => {
      read().replied.mark(first, { words: 'later', sendId: 'm1', disposition: 'queued' });
    });
    await settle();
    expect(read().cards).toEqual([]);
    expect(read().parked.map(each => each.key)).toEqual([first.key]);
    expect(read().repliedState.entries).toHaveLength(1);

    await interact(async () => read().replied.undo());
    await settle();
    expect(taken).toEqual(['studio/a/m1']);
    expect(calls.some(call => call.method === 'unsnooze' && call.sessionId === 'a')).toBe(true);
    expect(read().repliedState.restores).toEqual([{ key: first.key, text: 'later' }]);
    expect(read().cards.map(each => each.key)).toEqual([first.key]);
  });

  test('says so when this browser has no way to withdraw, and still brings the card back', async () => {
    const { calls, read } = await replying();
    const first = read().cards[0];
    if (first === undefined) throw new Error('no card');
    await interact(async () => {
      read().replied.mark(first, { words: 'later', sendId: 'm1', disposition: 'queued' });
    });
    await interact(async () => read().replied.undo());
    await settle();
    expect(read().repliedState.notice?.kind).toBe('refused');
    expect(calls.some(call => call.method === 'unsnooze')).toBe(true);
  });

  test('says it could not put the card back when its machine is no longer paired', async () => {
    const { read } = await replying(async () => 'withdrawn');
    const first = read().cards[0];
    if (first === undefined) throw new Error('no card');
    const stranger = { ...first, daemonId: daemonId('gone'), key: 'gone/a/A1' };
    await interact(async () => {
      read().replied.mark(stranger, { words: 'later', sendId: 'm1', disposition: 'queued' });
    });
    await interact(async () => read().replied.undo());
    await settle();
    expect(read().repliedState.notice).toMatchObject({ kind: 'not-back' });
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
        .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
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
  test('hands a conversation its resolved records, so a merged-away agenda keeps its title', async () => {
    const { client } = fakeClient(new Map([['studio/a', resolvedBoard('a')]]));
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    const latest = (): AgendaInbox => inbox as unknown as AgendaInbox;
    view = await mount(
      <Probe
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a')] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    expect(latest().recordsOf?.(studio.daemonId, 'a')).toEqual([]);
    await interact(async () => latest().loadResolved());
    await settle();
    expect(
      latest()
        .recordsOf?.(studio.daemonId, 'a')
        ?.map(record => record.id),
    ).toEqual(['A1']);
    expect(latest().recordsOf?.(studio.daemonId, 'unread')).toEqual([]);
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
        .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
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

describe('the roll-up lists every conversation’s parked items', () => {
  const snoozedItem = (id: string): AgendaItem =>
    ({ ...item(id, 1), parked: { reason: 'snoozed', at: at(2), until: at(600) } }) as AgendaItem;
  const mountWith = async (client: DaemonAgendaClient, machines: readonly AgendaInboxMachine[]) => {
    const { timers } = manualTimers();
    let inbox: AgendaInbox | null = null;
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settleUntil(
      () => machines.every(({ connection }) => client.rollup.getSnapshot().complete.has(connection.daemonId)),
      'all machine roll-ups published',
      interact,
    );
    return () => inbox as unknown as AgendaInbox;
  };
  const oldBoard = sessionView('old', { config: { parent: 'root' } as never });
  const root = sessionView('root', { config: { name: 'Billing rewrite', teammate: 'ada' } });

  test('lists an old conversation’s snoozed item from the roll-up, named for its root, and says the list is whole', async () => {
    const { client, rolled } = fakeClient(new Map(), { studio: { old: [snoozedItem('A4')] } });
    const latest = await mountWith(client, [{ connection: studio, name: 'Studio', sessions: [root, oldBoard] }]);
    await settle();
    expect(rolled).toEqual(['studio']);
    expect(latest().parked.map(card => [card.view.config.id, card.item.id, card.root?.config.id])).toEqual([
      ['old', 'A4', 'root'],
    ]);
    expect(latest().parkedWhole).toBe(true);
  });

  describe('a card that says it merged another in', () => {
    const merged = (id: string): AgendaItem => ({ ...snoozedItem(id), mergedFrom: ['A2'] }) as AgendaItem;
    const withRecord = (): AgendaSnapshot => ({
      ...board('old', [merged('A4')]),
      resolved: [
        {
          ...item('A2', 0),
          resolvedAt: at(3),
          resolvedBy: 'human',
          resolvedBySession: null,
          resolvedByName: null,
          resolutionNote: null,
          disposition: 'done',
        } as never,
      ],
    });

    test('reads that one conversation\u2019s board once, so the merged-away agenda keeps its title', async () => {
      const { client, calls } = fakeClient(new Map([['studio/old', withRecord()]]), {
        studio: { old: [merged('A4')], other: [snoozedItem('A9')] },
      });
      const latest = await mountWith(client, [
        {
          connection: studio,
          name: 'Studio',
          sessions: [root, oldBoard, sessionView('other', { config: { parent: 'root' } as never })],
        },
      ]);
      await settle();
      const reads = (): string[] =>
        calls
          .filter(call => call.method === 'revalidate' && call.sessionId !== 'machine-agenda')
          .map(call => call.sessionId);
      expect(reads()).toEqual(['old']);
      expect(
        latest()
          .recordsOf?.(studio.daemonId, 'old')
          ?.map(record => record.id),
      ).toEqual(['A2']);
      await settle();
      expect(reads()).toEqual(['old']);
    });

    test('asks again when that read failed', async () => {
      const { client, calls } = fakeClient(new Map(), { studio: { old: [merged('A4')] } });
      const asked = client.revalidate.bind(client);
      let failures = 1;
      client.revalidate = async (...args: Parameters<typeof asked>): Promise<void> => {
        if (failures > 0 && args[1].sessionId === 'old') {
          failures -= 1;
          calls.push({ method: 'revalidate', daemonId: args[0].daemonId, sessionId: 'old' });
          throw new Error('offline');
        }
        return asked(...args);
      };
      const latest = await mountWith(client, [{ connection: studio, name: 'Studio', sessions: [root, oldBoard] }]);
      await settle();
      await interact(async () => latest().loadResolved());
      await settle();
      expect(calls.filter(call => call.sessionId === 'old').length).toBeGreaterThanOrEqual(2);
    });
  });

  test('prefers a board this device holds over the roll-up for the same conversation', async () => {
    const held = new Map([['studio/old', board('old', [snoozedItem('A9')])]]);
    const { client } = fakeClient(held, { studio: { old: [snoozedItem('A4')] } });
    const latest = await mountWith(client, [{ connection: studio, name: 'Studio', sessions: [root, oldBoard] }]);
    await interact(async () => latest().loadResolved());
    await settle();
    expect(latest().parked.map(card => card.item.id)).toEqual(['A9']);
  });

  test('reads the roll-up again when the owner opens a filter beyond Open, and says it is reading', async () => {
    const { client, rolled } = fakeClient(new Map(), { studio: { old: [snoozedItem('A4')] } });
    const latest = await mountWith(client, [{ connection: studio, name: 'Studio', sessions: [root, oldBoard] }]);
    await interact(async () => latest().loadResolved());
    await settleUntil(() => !latest().resolvedReading, 'resolved roll-up read finished', interact);
    expect(rolled).toEqual(['studio', 'studio']);
    expect(latest().resolvedReading).toBe(false);
  });
});
