import { type SessionAgendaSummary } from '../../../contract/wire.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaSnapshot } from '@ferretry/core-asks/contract';
import type { SessionView } from '../../../app/shell.ts';
import {
  type AgendaInbox,
  type AgendaInboxMachine,
  useAgendaInboxModel,
  useInboxMachines,
} from '../../../app/hooks/use-agenda-inbox.ts';
import type { DaemonAgendaClient } from '../../../app/lib/agenda-client.ts';
import { type DeferredTimers, DISMISS_ACTION } from '../../../app/lib/agenda-inbox.ts';
import { DaemonAgendaStore } from '../../../app/lib/agenda-store.ts';
import { AgendaRollupStore } from '../../../app/lib/agenda-rollup.ts';
import { type DaemonConnection, daemonConnection, daemonId } from '../../../app/shell.ts';
import type { DaemonSessionScope } from '../../../app/shell.ts';
import type { DaemonFleetStore, FleetSnapshot } from '../../../app/lib/ferret-store.ts';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { interact, type Mounted, mount } from '@ferretry/app/testing';
import { sessionView } from '../../support/app/sessions.ts';
import { settleUntil } from '@ferretry/app/testing';

const studio = daemonConnection({ daemonId: 'studio' });
const laptop = daemonConnection({ daemonId: 'laptop' });
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
  // Each machine's roll-up through its own client, named by host.
  const rollup = new AgendaRollupStore(daemon =>
    callFromFetch(async input => {
      const host = new URL(input).host.split('.')[0] ?? '';
      rolled.push(host);
      const held = rollups[host];
      // A machine the test gave no roll-up answers none, so the Inbox keeps reading that machine's boards.
      if (held === undefined) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({ sessions: Object.entries(held).map(([sessionId, items]) => ({ sessionId, items })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }, `https://${daemon.daemonId}.example.test`),
  );
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
  withdraw,
  onInbox,
}: {
  readonly client: DaemonAgendaClient;
  readonly machines: readonly AgendaInboxMachine[];
  readonly timers: DeferredTimers;
  readonly withdraw?: Parameters<typeof useAgendaInboxModel>[3];
  readonly onInbox: (inbox: AgendaInbox) => void;
}) {
  onInbox(useAgendaInboxModel(client, machines, timers, withdraw));
  return null;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useAgendaInboxModel', () => {
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
      'store' | 'rollup' | 'hydrate' | 'revalidate'
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
    expect(up.total).toBe(up.cards.length);
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
    view = await mount(
      <Probe
        client={client}
        machines={[{ connection: studio, name: 'Studio', sessions: [waiting('a', summary(3, 5))] }]}
        onInbox={value => (inbox = value)}
        timers={timers}
      />,
    );
    await settle();
    const read = inbox as unknown as AgendaInbox;
    expect(read.cards.map(entry => entry.item.id)).toEqual(['A4', 'A1']);
    expect(read.withFerret.map(entry => entry.item.id).sort()).toEqual(['A2', 'A3']);
    expect(read.parked.map(entry => entry.item.id)).toEqual(['A5']);
    expect(read.total).toBe(read.cards.length);
    expect(read.total).toBe(2);
  });
});

describe('a reply the owner takes back', () => {
  const replying = async (withdraw?: Parameters<typeof useAgendaInboxModel>[3]) => {
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
