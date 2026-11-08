/**
 * THE INBOX OVER EVERY MACHINE (shell contract S2, GAP agenda-inbox-machines): one agenda client shared by every
 * machine's runtime, each call routed to the machine it is for; the Agenda page counts and deals every unlocked
 * machine's items, and a locked machine is a line that says so with an Unlock — it is not read.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { type AgendaItem, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import type { DaemonReach } from '@ferretry/app';
import {
  deviceViewHarness,
  ensureDom,
  fakeReachRow,
  interact,
  type Mounted,
  mount,
  noteClientDaemon,
  RouterProvider,
  settleUntil,
} from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ComponentType, Suspense } from 'react';
import app from '../../../app/index.ts';
import { AgendaFleet, fleetIn, mergedFleet } from '../../../app/lib/agenda-fleet.ts';
import type { DaemonFleetStore, FleetSnapshot } from '../../../app/lib/ferret-store.ts';
import { type DaemonId, daemonConnection } from '../../../app/lib/machine.ts';
import manifest from '../../../manifest.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

ensureDom();

// The half's views chunk, loaded once up front: the page then waits on its machines, not on module evaluation.
beforeAll(async () => {
  await import('../../../app/views/surfaces.tsx');
});

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;
const C = `fy_daemon_${'c'.repeat(43)}`;
const at = '2026-08-01T11:00:00.000Z';

/** One machine: its own agenda holds `items`; every call it is asked is recorded. */
function machine(daemon: string, items: readonly AgendaItem[]) {
  const calls: string[] = [];
  const client = {
    call: async (route: string) => {
      calls.push(route);
      if (route === 'GET /v1/machine/agenda')
        return {
          v: 1,
          sessionId: MACHINE_AGENDA_ID,
          items,
          resolved: [],
          count: items.length,
          parseErrors: 0,
          updatedAt: at,
        };
      if (route === 'GET /v1/ferrets') return [];
      throw new Error(`no route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  noteClientDaemon(client as never, daemon);
  return { client, calls };
}

const machineScope = (daemon: string) => ({ daemonId: daemon as DaemonId, sessionId: MACHINE_AGENDA_ID });

describe('the fleet', () => {
  it('builds one runtime per client, all over one agenda client, and routes each call to its own machine', async () => {
    const fleet = new AgendaFleet();
    const a = machine(A, [agendaItem('A1')]);
    const b = machine(B, [agendaItem('A2')]);
    const onA = fleet.runtimeOf(a.client);
    expect(fleet.runtimeOf(a.client)).toBe(onA);
    const onB = fleet.runtimeOf(b.client);
    expect(onA.agenda).toBe(fleet.agenda);
    expect(onB.agenda).toBe(fleet.agenda);
    await fleet.agenda.hydrate(onB.connection, machineScope(B));
    expect(b.calls).toEqual(['GET /v1/machine/agenda']);
    expect(a.calls).toEqual([]);
    expect(fleet.agenda.store.status(machineScope(B))).toBe('ready');
    onA.ferrets.stop();
    onB.ferrets.stop();
  });

  it('a machine it holds no client for is not reached: the read fails, nothing is asked', async () => {
    const fleet = new AgendaFleet();
    const a = machine(A, []);
    fleet.runtimeOf(a.client).ferrets.stop();
    await fleet.agenda.hydrate(daemonConnection({ daemonId: C }), machineScope(C)).catch(() => undefined);
    expect(fleet.agenda.store.status(machineScope(C))).not.toBe('ready');
    expect(a.calls).toEqual([]);
  });

  it('a new client for a known machine drops what the old one read, and takes over its calls', async () => {
    const fleet = new AgendaFleet();
    const first = machine(A, [agendaItem('A1')]);
    const runtime = fleet.runtimeOf(first.client);
    await fleet.agenda.hydrate(runtime.connection, machineScope(A));
    expect(fleet.agenda.store.status(machineScope(A))).toBe('ready');
    const again = machine(A, [agendaItem('A9')]);
    const repaired = fleet.runtimeOf(again.client);
    expect(fleet.agenda.store.status(machineScope(A))).not.toBe('ready');
    await fleet.agenda.hydrate(repaired.connection, machineScope(A));
    expect(again.calls).toEqual(['GET /v1/machine/agenda']);
    expect(first.calls).toEqual(['GET /v1/machine/agenda']);
    runtime.ferrets.stop();
    repaired.ferrets.stop();
  });

  it('is one per holder', () => {
    const holder = {};
    expect(fleetIn(holder)).toBe(fleetIn(holder));
    expect(fleetIn({})).not.toBe(fleetIn(holder));
  });
});

describe('mergedFleet', () => {
  const store = (id: string) => {
    let snapshot: FleetSnapshot = { daemons: new Map([[id as DaemonId, { sessions: null }]]) };
    const listeners = new Set<() => void>();
    const it: DaemonFleetStore & { move: () => void; listening: () => number } = {
      subscribe: listener => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      move: () => {
        snapshot = { daemons: new Map([[id as DaemonId, { sessions: [] }]]) };
        for (const listener of listeners) listener();
      },
      listening: () => listeners.size,
    };
    return it;
  };

  it('reads every machine as one, the same snapshot until one moves, and stops listening to all', () => {
    const a = store(A);
    const b = store(B);
    const merged = mergedFleet([a, b]);
    const first = merged.getSnapshot();
    expect([...first.daemons.keys()] as string[]).toEqual([A, B]);
    expect(merged.getSnapshot()).toBe(first);
    let heard = 0;
    const stop = merged.subscribe(() => {
      heard += 1;
    });
    b.move();
    expect(heard).toBe(1);
    const second = merged.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.daemons.get(B as DaemonId)?.sessions).toEqual([]);
    stop();
    expect(a.listening() + b.listening()).toBe(0);
  });
});

describe('the Agenda page over every machine', () => {
  let view: Mounted | null = null;
  afterEach(async () => {
    await view?.unmount();
    view = null;
    window.history.replaceState({}, '', '/');
  });

  it('lists every unlocked machine’s items, and a locked machine as a line with an Unlock, unread', async () => {
    const a = machine(A, [agendaItem('A1', { subject: 'Ship the laptop build' })]);
    const b = machine(B, [agendaItem('A2', { subject: 'Rotate the server key' })]);
    const c = machine(C, [agendaItem('A3', { subject: 'Never read' })]);
    let unlocked = 0;
    const rows: DaemonReach[] = [
      fakeReachRow({ daemon: A, client: a.client, machine: 'laptop' }),
      fakeReachRow({ daemon: B, client: b.client, machine: 'server' }),
      {
        ...fakeReachRow({ daemon: C, client: c.client, machine: 'studio', locked: true }),
        unlock: async () => {
          unlocked += 1;
          return true;
        },
      },
    ];
    const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
    harness.setRows(rows);
    // The half the shell builds for machine A, and machine B's: both share the half's fleet.
    const onA = app.build?.({ manifest, client: a.client });
    app.build?.({ manifest, client: b.client });
    const Screen = onA?.screens.agenda as unknown as ComponentType<Record<string, unknown>>;
    view = await mount(
      <harness.Harness place="daemon">
        <RouterProvider>
          <Suspense fallback={null}>
            <Screen params={{}} />
          </Suspense>
        </RouterProvider>
      </harness.Harness>,
    );
    const root = view.container;
    const text = (): string => root.textContent ?? '';
    await settleUntil(
      () => text().includes('Ship the laptop build') && text().includes('Rotate the server key'),
      () => `both machines' items did not draw; drew: ${text()}`,
      interact,
    );
    expect(text()).not.toContain('Never read');
    expect(c.calls).toEqual([]);
    const locked = root.querySelector('[data-agenda-locked] [data-daemon]');
    expect(locked?.getAttribute('data-daemon')).toBe(C);
    expect(locked?.textContent).toContain('Locked — unlock studio to see its items');
    await interact(() => locked?.querySelector('button')?.click());
    expect(unlocked).toBe(1);
  });
});
