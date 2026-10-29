import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionItem, AttentionSnapshot, SessionAttentionSummary, SessionView } from '@ferretry/protocol';
import {
  type AttentionInbox,
  type AttentionInboxMachine,
  useAttentionInboxModel,
  useInboxMachines,
} from '../../src/hooks/use-attention-inbox.ts';
import type { DaemonAttentionClient } from '../../src/lib/attention-client.ts';
import { type DeferredTimers, DISMISS_ACTION, DONE_ACTION, inboxOptions } from '../../src/lib/attention-inbox.ts';
import { DaemonAttentionStore } from '../../src/lib/attention-store.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { DaemonFleetStore, FleetSnapshot } from '../../src/lib/fleet-store.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const studio = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const laptop = daemonConnection({ daemonId: 'laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-laptop' });
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();

const summary = (open: number, latest: number): SessionAttentionSummary => ({
  open,
  first: 'A1',
  ask: 'Rebase now?',
  latestAt: at(latest),
});

const waiting = (id: string, attention?: SessionAttentionSummary): SessionView =>
  sessionView(id, attention === undefined ? {} : { state: { attention } });

const item = (id: string, minutes: number, ask?: AttentionItem['ask']): AttentionItem =>
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
  }) as AttentionItem;

const board = (sessionId: string, items: readonly AttentionItem[]): AttentionSnapshot => ({
  v: 1,
  sessionId,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: at(0),
});

interface Call {
  readonly method: 'revalidate' | 'respond' | 'resolve' | 'dismiss';
  readonly daemonId: string;
  readonly sessionId: string;
  readonly detail?: unknown;
}

/** The one attention client, faked at its seams: a real store, and every call recorded. */
const fakeClient = (boards: Map<string, AttentionSnapshot>) => {
  const calls: Call[] = [];
  const store = new DaemonAttentionStore();
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
  } as unknown as DaemonAttentionClient;
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
  onInbox,
}: {
  readonly client: DaemonAttentionClient;
  readonly machines: readonly AttentionInboxMachine[];
  readonly timers: DeferredTimers;
  readonly onInbox: (inbox: AttentionInbox) => void;
}) {
  onInbox(useAttentionInboxModel(client, machines, timers));
  return null;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useAttentionInboxModel', () => {
  test('reads only unread boards, once per summary, and deals their cards newest first', async () => {
    const boards = new Map([
      ['studio/a', board('a', [item('A1', 1), item('A2', 6)])],
      ['laptop/b', board('b', [item('A1', 4)])],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AttentionInbox | null = null;
    const machines = (aOpen: number): readonly AttentionInboxMachine[] => [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(aOpen, 6)), waiting('quiet')] },
      { connection: laptop, name: 'Laptop', sessions: [waiting('b', summary(1, 4))] },
    ];
    const probe = (list: readonly AttentionInboxMachine[]) => (
      <Probe client={client} machines={list} onInbox={value => (inbox = value)} timers={timers} />
    );
    view = await mount(probe(machines(2)));
    await settle();

    const reads = () => calls.filter(call => call.method === 'revalidate').map(c => `${c.daemonId}/${c.sessionId}`);
    expect(reads()).toEqual(['studio/a', 'laptop/b']);
    const read = inbox as unknown as AttentionInbox;
    expect(read.total).toBe(3);
    expect(read.reading).toBe(false);
    expect(read.cards.map(card => `${card.daemonId}/${card.item.id}`)).toEqual(['studio/A2', 'laptop/A1', 'studio/A1']);

    // A fleet read that moved nothing about Attention reads no board and keeps the inbox's rows.
    const before = read.unread;
    await view.render(probe(machines(2)));
    await settle();
    expect(reads()).toHaveLength(2);
    expect((inbox as unknown as AttentionInbox).unread).toBe(before);

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

  test('sends a held answer to the right machine, by kind, when the window closes', async () => {
    const boards = new Map([
      ['studio/a', board('a', [item('A1', 1, { kind: 'permission' }), item('A2', 2), item('A3', 3)])],
    ]);
    const { client, calls } = fakeClient(boards);
    const { timers, fire } = manualTimers();
    let inbox: AttentionInbox | null = null;
    const machines: readonly AttentionInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(3, 3))] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = (): AttentionInbox => inbox as unknown as AttentionInbox;
    const card = (id: string) => read().cards.find(entry => entry.item.id === id);

    const permission = card('A1');
    const [approve] = permission === undefined ? [] : inboxOptions(permission.item);
    await interact(() => {
      if (permission !== undefined && approve !== undefined) read().deferred.schedule(permission, approve);
      const second = card('A2');
      if (second !== undefined) read().deferred.schedule(second, DISMISS_ACTION);
      const third = card('A3');
      if (third !== undefined) read().deferred.schedule(third, { kind: 'resolve', label: 'Done', note: 'shipped' });
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
    ]);
  });

  test('refuses an answer for a machine that is no longer paired, and sends what is held on unmount', async () => {
    const boards = new Map([['studio/a', board('a', [item('A1', 1), item('A2', 2)])]]);
    const { client, calls } = fakeClient(boards);
    const { timers } = manualTimers();
    let inbox: AttentionInbox | null = null;
    const machines: readonly AttentionInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(2, 2))] },
    ];
    const probe = (list: readonly AttentionInboxMachine[]) => (
      <Probe client={client} machines={list} onInbox={value => (inbox = value)} timers={timers} />
    );
    view = await mount(probe(machines));
    await settle();
    const read = (): AttentionInbox => inbox as unknown as AttentionInbox;
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
    let inbox: AttentionInbox | null = null;
    const machines: readonly AttentionInboxMachine[] = [
      { connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] },
    ];
    view = await mount(
      <Probe client={client} machines={machines} onInbox={value => (inbox = value)} timers={timers} />,
    );
    await settle();
    const read = (): AttentionInbox => inbox as unknown as AttentionInbox;
    const [only] = read().cards;
    await interact(() => {
      if (only !== undefined) read().deferred.schedule(only, DISMISS_ACTION);
    });
    await interact(() => window.dispatchEvent(new Event('pagehide')));
    await settle();
    expect(calls.filter(call => call.method === 'dismiss')).toHaveLength(1);
    expect(read().connectionFor(studio.daemonId)).toBe(studio);
  });

  test('says it is reading while an unread board has not arrived', async () => {
    const { client } = fakeClient(new Map());
    const { timers } = manualTimers();
    let inbox: AttentionInbox | null = null;
    view = await mount(
      <Probe
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a', summary(1, 1))] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    expect((inbox as unknown as AttentionInbox).reading).toBe(true);
    expect((inbox as unknown as AttentionInbox).cards).toEqual([]);
  });
});

describe('the Resolved filter reads', () => {
  const resolvedBoard = (sessionId: string): AttentionSnapshot => ({
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
    let inbox: AttentionInbox | null = null;
    const latest = (): AttentionInbox => inbox as unknown as AttentionInbox;
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
    let seen: readonly AttentionInboxMachine[] = [];
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
