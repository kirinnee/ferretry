/**
 * THE CARD A LINK OPENS, from Agenda's device view (shell contract S3): the shell's real fragment taker strips the
 * `#agenda/…` link and hands it whole to this one view, which opens the ask on the machine that runs the session.
 *
 * The links are built exactly as `agendaDeepLinkFragment` (Accounts' contract, `routes/task-plan.ts`) builds them —
 * `#agenda/<id>` then `session` and `machine` as URL search parameters — because that builder lives in another
 * plugin's contract this suite does not depend on.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { DaemonReach, NoReach } from '@ferretry/app';
import {
  deviceViewHarness,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import half from '../../../app/index.ts';
import { AGENDA_LINK_WAIT_MS, agendaDeepLinkView } from '../../../app/views/agenda-deep-link-view.tsx';

/** `agendaDeepLinkFragment(id, sessionId, machine)`, as Accounts builds it. */
const agendaLink = (id: string, sessionId?: string, machine?: string): string => {
  const query = new URLSearchParams();
  if (sessionId !== undefined) query.set('session', sessionId);
  if (machine !== undefined) query.set('machine', machine);
  const text = query.toString();
  return `#agenda/${encodeURIComponent(id)}${text === '' ? '' : `?${text}`}`;
};

/** One machine's Agenda client: its ferret list answers `sessions` (or never, while `pending`). */
function machineClient(daemon: string, sessions: readonly string[], options: { pending?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/ferrets') {
        if (options.pending === true) return await new Promise(() => {});
        return sessions.map(id => ({ id, name: id }));
      }
      return { boards: [], complete: true, items: [] };
    },
    subscribe: () => () => {},
  } as unknown as PluginClient;
  noteClientDaemon(client as never, daemon);
  return { client, calls };
}

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;

const rowOf = (daemon: string, client: PluginClient, locked = false): DaemonReach =>
  fakeReachRow({ daemon, client, locked, machine: `${daemon.slice(10, 11)}-host` });

const OFF_THERE: NoReach = { waiting: false, line: 'Agenda is off on this daemon.' };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** `paired`: the machines this device is paired with (default: the machines that have a row). */
async function open(
  href: string,
  rows: readonly DaemonReach[],
  paired: readonly string[] = rows.map(r => r.daemon),
  noReach: Readonly<Record<string, NoReach>> = {},
) {
  const harness = deviceViewHarness({ plugin: 'agenda', fragments: half.shell.fragments ?? [], href });
  harness.setPaired(paired);
  harness.setNoReach(noReach);
  harness.setRows(rows);
  const went: string[] = [];
  const View = agendaDeepLinkView({});
  view = await mount(
    <harness.Harness>
      <View navigate={to => void went.push(to)} />
    </harness.Harness>,
  );
  await settle();
  return { harness, went };
}

describe("Agenda's device view", () => {
  it('declares the agenda key, and its one device view', () => {
    expect(half.shell.fragments).toEqual([{ form: 'keyed', key: 'agenda' }]);
    expect(Object.keys(half.shell.device ?? {})).toEqual(['deep-link', 'notification-filter']);
  });

  it('takes the whole link off the address and opens the ask on the machine the link names', async () => {
    const a = machineClient(A, ['x']);
    const b = machineClient(B, ['sess-1']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1', B)}`, [
      rowOf(A, a.client),
      rowOf(B, b.client),
    ]);
    expect(harness.address()).toBe('/app/');
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('with no machine named, opens on the machine whose session list holds the session, once', async () => {
    const a = machineClient(A, ['x']);
    const b = machineClient(B, ['sess-1']);
    const { went } = await open(`/app/${agendaLink('A8', 'sess-1')}`, [rowOf(A, a.client), rowOf(B, b.client)]);
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('reads no machine while no link waits', async () => {
    const a = machineClient(A, ['x']);
    const { went } = await open('/app/', [rowOf(A, a.client)]);
    expect(went).toEqual([]);
    expect(a.calls).toEqual([]);
  });

  it('a locked machine is "not this one": the link opens on the other, and nothing prompts', async () => {
    const locked = machineClient(A, ['sess-1']);
    const open2 = machineClient(B, ['sess-1']);
    const { went } = await open(`/app/${agendaLink('A8', 'sess-1')}`, [
      rowOf(A, locked.client, true),
      rowOf(B, open2.client),
    ]);
    expect(locked.calls).toEqual([]);
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('a link only a locked machine might run is dropped, not waited on', async () => {
    const locked = machineClient(A, ['sess-1']);
    const other = machineClient(B, ['x']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1')}`, [
      rowOf(A, locked.client, true),
      rowOf(B, other.client),
    ]);
    expect(went).toEqual([]);
    expect(locked.calls).toEqual([]);
    // It was dropped, not left waiting: a machine that runs the session appearing afterwards opens nothing.
    harness.setRows([rowOf(A, locked.client, true), rowOf(B, machineClient(B, ['sess-1']).client)]);
    await settle();
    expect(went).toEqual([]);
  });

  it('waits while a machine has not answered, then gives up after two minutes', async () => {
    const slow = machineClient(A, [], { pending: true });
    const realSetTimeout = globalThis.setTimeout;
    const waits: (() => void)[] = [];
    globalThis.setTimeout = ((run: () => void, ms?: number) => {
      // The link's own wait (the shell's two-minute hold on the address uses the same span and is caught too).
      if (ms === AGENDA_LINK_WAIT_MS) {
        waits.push(run);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(run, ms);
    }) as typeof setTimeout;
    try {
      const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1')}`, [rowOf(A, slow.client)]);
      expect(went).toEqual([]);
      expect(waits.length).toBeGreaterThan(0);
      await interact(() => {
        for (const run of waits.splice(0)) run();
      });
      // The dropped link does not open when a machine that runs its session appears afterwards.
      harness.setRows([rowOf(B, machineClient(B, ['sess-1']).client)]);
      await settle();
      expect(went).toEqual([]);
      // A second link after the first was dropped is taken afresh.
      harness.setRows([rowOf(A, machineClient(A, ['sess-2']).client)]);
      await interact(() => harness.arrive(`/app/${agendaLink('A9', 'sess-2')}`));
      await settle();
      expect(went).toEqual([`/d/${A}/agenda/sess-2/A9`]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('M1 a link taken on a cold open, while no machine has a row yet, still opens when the rows arrive', async () => {
    const a = machineClient(A, ['x']);
    const b = machineClient(B, ['sess-1']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1')}`, [], [A, B]);
    expect(went).toEqual([]);
    await interact(() => harness.setRows([rowOf(A, a.client), rowOf(B, b.client)]));
    await settle();
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('M1 a link that names machine B waits while only A has a row, then opens on B once B connects', async () => {
    const a = machineClient(A, ['x']);
    const b = machineClient(B, ['sess-1']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1', B)}`, [rowOf(A, a.client)], [A, B]);
    expect(went).toEqual([]);
    await interact(() => harness.setRows([rowOf(A, a.client), rowOf(B, b.client)]));
    await settle();
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('R2-m3 a link naming a paired machine where Agenda is off opens that machine’s page at once, not after two minutes', async () => {
    const a = machineClient(A, ['x']);
    const { went } = await open(`/app/${agendaLink('A8', 'sess-1', B)}`, [rowOf(A, a.client)], [A, B], {
      [B]: OFF_THERE,
    });
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('R2-m3 an unnamed link is not held up by a machine where Agenda will never have a row', async () => {
    const a = machineClient(A, ['x']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-9')}`, [rowOf(A, a.client)], [A, B], {
      [B]: OFF_THERE,
    });
    expect(went).toEqual([]);
    // It was decided (no machine runs it) and dropped, not left waiting on B.
    harness.setRows([rowOf(A, a.client), rowOf(B, machineClient(B, ['sess-9']).client)]);
    await settle();
    expect(went).toEqual([]);
  });

  it('R2-m3 a machine still being reached is waited for, and opens the moment the shell says it will never have a row', async () => {
    const a = machineClient(A, ['x']);
    const { harness, went } = await open(`/app/${agendaLink('A8', 'sess-1', B)}`, [rowOf(A, a.client)], [A, B], {
      [B]: { waiting: true, line: 'Checking what this daemon offers…' },
    });
    expect(went).toEqual([]);
    await interact(() => harness.setNoReach({ [B]: OFF_THERE }));
    await settle();
    expect(went).toEqual([`/d/${B}/agenda/sess-1/A8`]);
  });

  it('M1 a link no paired machine runs is dropped once every paired machine has answered', async () => {
    const a = machineClient(A, ['x']);
    const { went } = await open(`/app/${agendaLink('A8', 'sess-9')}`, [rowOf(A, a.client)], [A]);
    expect(went).toEqual([]);
  });

  it('drops a link no machine runs, and a link that names no session, without navigating', async () => {
    const a = machineClient(A, ['x']);
    const stale = await open(`/app/${agendaLink('A8', 'sess-9')}`, [rowOf(A, a.client)]);
    expect(stale.went).toEqual([]);
    await view?.unmount();
    const bare = await open(`/app/${agendaLink('A8')}`, [rowOf(A, a.client)]);
    expect(bare.went).toEqual([]);
    expect(bare.harness.address()).toBe('/app/');
  });
});
