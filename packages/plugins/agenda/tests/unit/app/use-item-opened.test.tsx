/**
 * Opening an ask is told to the `agenda.item-opened` hook (Access provides it) with the machine's seen mark in hand:
 * the ferret and the ask reach it, nothing is posted until the provider makes the mark, a provider that fails changes
 * nothing, and with no provider (or a value without the shape) nothing is said. The machine is the OPENED CARD's: a
 * card of machine B opened on a page of machine A is told to B's provider and marked seen through B's client, A's
 * provider and A's client hear nothing, and a machine this device holds no client for is not told at all.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, noteClientDaemon, WithAppHooks } from '@ferretry/app/testing';
import { AGENDA_ITEM_OPENED_HOOK, type AgendaSeenMark } from '../../../contract/app-hooks.ts';
import { useItemOpened } from '../../../app/hooks/use-item-opened.tsx';
import { AgendaFleet } from '../../../app/lib/agenda-fleet.ts';
import { daemonId } from '../../../app/shell.ts';

ensureDom();

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const spin = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const routes: string[] = [];
const client = {
  call: async (route: string) => {
    routes.push(route);
    return { cleared: true, tags: [] };
  },
} as never;

const open = async (provided: Record<string, unknown>): Promise<void> => {
  routes.length = 0;
  let tell: (ferret: string, ask: string) => void = () => undefined;
  let host: unknown = null;
  function Probe() {
    const itemOpened = useItemOpened({ daemon: daemonId('home'), client });
    tell = (ferret, ask) => itemOpened.onOpened(daemonId('home'), ferret, ask);
    host = itemOpened.host;
    return <>{itemOpened.host}</>;
  }
  mounted = await mount(
    <WithAppHooks provided={provided}>
      <Probe />
    </WithAppHooks>,
  );
  expect(host).toBeNull();
  await interact(() => tell('f1', 'A3'));
  await spin();
};

describe('useItemOpened', () => {
  it('tells the provider which ferret and which ask were opened, and posts nothing until it makes the mark', async () => {
    const told: string[] = [];
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async (ferret: string, ask: string) => void told.push(`${ferret}/${ask}`),
    });
    expect(told).toEqual(['f1/A3']);
    expect(routes).toEqual([]);
  });

  it('hands the provider the machine’s seen mark, which posts Agenda’s own route when made', async () => {
    const answers: unknown[] = [];
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async (_f: string, _a: string, seen: AgendaSeenMark) => answers.push(await seen()),
    });
    expect(routes).toEqual(['POST /v1/push/seen']);
    expect(answers).toEqual([{ cleared: true, tags: [] }]);
  });

  it('does not mind a provider that fails', async () => {
    let called = 0;
    await open({
      [AGENDA_ITEM_OPENED_HOOK]: async () => {
        called += 1;
        throw new Error('no push worker');
      },
    });
    expect(called).toBe(1);
  });

  it('says nothing when no provider gives the hook, or the value is not a function', async () => {
    await open({});
    await mounted?.unmount();
    await open({ [AGENDA_ITEM_OPENED_HOOK]: { not: 'a function' } });
    expect(routes).toEqual([]);
  });
});

describe('useItemOpened on the opened card’s machine', () => {
  const A = daemonId(`fy_daemon_${'a'.repeat(43)}`);
  const B = daemonId(`fy_daemon_${'b'.repeat(43)}`);
  const C = daemonId(`fy_daemon_${'c'.repeat(43)}`);

  /** A machine's own client (it records what it is sent) and its own provider (it records what it is told). */
  const machine = (daemon: string) => {
    const posted: unknown[] = [];
    const told: string[] = [];
    const machineClient = {
      call: async (route: string, init?: { body?: unknown }) => {
        // The runtime's own reads (the ferret list) are not seen marks.
        if (route !== 'POST /v1/push/seen') return [];
        posted.push(init?.body);
        return { cleared: true, tags: [] };
      },
      subscribe: () => () => undefined,
    };
    noteClientDaemon(machineClient, daemon);
    const hook = async (ferret: string, ask: string, seen: AgendaSeenMark) => {
      told.push(`${ferret}/${ask}`);
      await seen();
    };
    return { client: machineClient, posted, told, hook };
  };

  const openOn = async (card: string) => {
    const a = machine(A);
    const b = machine(B);
    const fleet = new AgendaFleet();
    fleet.runtimeOf(a.client as never).ferrets.stop();
    fleet.runtimeOf(b.client as never).ferrets.stop();
    let tell: (daemon: typeof A, ferret: string, ask: string) => void = () => undefined;
    function Probe() {
      const itemOpened = useItemOpened({ daemon: A, client: a.client as never }, fleet);
      tell = itemOpened.onOpened;
      return <>{itemOpened.host}</>;
    }
    mounted = await mount(
      <WithAppHooks
        provided={{}}
        onDaemon={{ [A]: { [AGENDA_ITEM_OPENED_HOOK]: a.hook }, [B]: { [AGENDA_ITEM_OPENED_HOOK]: b.hook } }}
      >
        <Probe />
      </WithAppHooks>,
    );
    await interact(() => tell(card === 'B' ? B : card === 'C' ? C : A, 'machine-agenda', 'A2'));
    await spin();
    return { a, b };
  };

  it('tells a card of machine B to B’s provider and marks it seen through B’s client, leaving A alone', async () => {
    const { a, b } = await openOn('B');
    expect(b.told).toEqual(['machine-agenda/A2']);
    expect(b.posted).toEqual([{ sessionId: 'machine-agenda', agendaId: 'A2' }]);
    expect(a.told).toEqual([]);
    expect(a.posted).toEqual([]);
  });

  it('still tells a card of the page’s own machine to that machine', async () => {
    const { a, b } = await openOn('A');
    expect(a.told).toEqual(['machine-agenda/A2']);
    expect(a.posted).toEqual([{ sessionId: 'machine-agenda', agendaId: 'A2' }]);
    expect(b.told).toEqual([]);
    expect(b.posted).toEqual([]);
  });

  it('says nothing for a machine this device holds no client for, rather than using the page’s', async () => {
    const { a, b } = await openOn('C');
    expect([a.told, a.posted, b.told, b.posted]).toEqual([[], [], [], []]);
  });

  it('announces each open, even of the same ask twice', async () => {
    const a = machine(A);
    let tell: (daemon: typeof A, ferret: string, ask: string) => void = () => undefined;
    function Probe() {
      const itemOpened = useItemOpened({ daemon: A, client: a.client as never });
      tell = itemOpened.onOpened;
      return <>{itemOpened.host}</>;
    }
    mounted = await mount(
      <WithAppHooks provided={{ [AGENDA_ITEM_OPENED_HOOK]: a.hook }}>
        <Probe />
      </WithAppHooks>,
    );
    await interact(() => tell(A, 'f1', 'A3'));
    await spin();
    await interact(() => tell(A, 'f1', 'A3'));
    await spin();
    expect(a.told).toEqual(['f1/A3', 'f1/A3']);
  });
});
