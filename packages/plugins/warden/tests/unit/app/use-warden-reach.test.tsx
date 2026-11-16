/**
 * THE WARDEN PAGE RE-READS WHEN ANOTHER MACHINE'S ROW ARRIVES OR LEAVES (R2-m2): a read that already gave up with the
 * machine's own sentence must not stay on screen until the next 30 s tick once that machine's Warden row appears, and a
 * row that goes must show at once too. The page's polls restart when the reach changes, so the reach changes when a row
 * does — and not for anything else.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { NoReach } from '@ferretry/app';
import { deviceViewHarness, fakeReachRow, interact, type Mounted, mount } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback } from 'react';
import { useWardenPoll } from '../../../app/hooks/use-warden-poll.ts';
import { useWardenReach } from '../../../app/hooks/use-warden-reach.ts';
import { type DaemonConnection, daemonConnection } from '../../../app/lib/machine.ts';
import type { DaemonReach } from '../../../app/lib/warden-client-context.tsx';

const home = daemonConnection({ daemonId: 'd1', daemonName: 'laptop' });
const d2 = daemonConnection({ daemonId: 'd2', daemonName: 'desk' });
const own = { call: async () => 'own' } as unknown as PluginClient;
const OFF: NoReach = { waiting: false, line: 'Warden is off on this daemon.' };

const harnessOf = () => deviceViewHarness({ plugin: 'warden', fragments: [] });
/** A machine's row: the same client every time, as the shell keeps one per connection. */
const clients = new Map<string, PluginClient>();
const rowOf = (daemon: string) => {
  const client = clients.get(daemon) ?? ({ call: async () => daemon } as unknown as PluginClient);
  clients.set(daemon, client);
  return fakeReachRow({ daemon, client, online: true });
};

/** One stable "no ticks" clock: a new one each render would restart the poll by itself. */
const noTicks = (): (() => void) => () => {};

const seen: { reach?: DaemonReach; renders: number } = { renders: 0 };

/** The reach, and what the page's poll of `d2` says through it. */
function Page({ reads }: { readonly reads: string[] }) {
  const { reach } = useWardenReach(home, own);
  seen.reach = reach;
  seen.renders += 1;
  const read = useCallback(
    async (daemon: DaemonConnection) => {
      reads.push(daemon.daemonId);
      await reach(daemon);
      return 'read';
    },
    [reach, reads],
  );
  const state = useWardenPoll(d2, read, { every: noTicks });
  return <output>{state.status === 'error' ? `error:${state.reason}` : state.status}</output>;
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const said = (): string | null | undefined => view?.container.querySelector('output')?.textContent;

describe('useWardenReach', () => {
  it('R2-m2 a read that gave up reads again at once when the machine’s row arrives, with no tick', async () => {
    const harness = harnessOf();
    harness.setNoReach({ d2: OFF });
    const reads: string[] = [];
    view = await mount(
      <harness.Harness place="daemon">
        <Page reads={reads} />
      </harness.Harness>,
    );
    await settle();
    expect(said()).toBe('error:Warden is off on this daemon.');
    expect(reads).toEqual(['d2']);
    await interact(() => {
      harness.setNoReach({});
      harness.setRows([rowOf('d2')]);
    });
    await settle();
    expect(reads).toEqual(['d2', 'd2']);
    expect(said()).toBe('ready');
  });

  it('R2-m2 a row that leaves is read again at once too', async () => {
    const harness = harnessOf();
    harness.setRows([rowOf('d2')]);
    const reads: string[] = [];
    view = await mount(
      <harness.Harness place="daemon">
        <Page reads={reads} />
      </harness.Harness>,
    );
    await settle();
    expect(said()).toBe('ready');
    await interact(() => {
      harness.setNoReach({ d2: OFF });
      harness.setRows([]);
    });
    await settle();
    expect(reads).toEqual(['d2', 'd2']);
    // The good answer stays, marked stale, with the machine's own sentence — and it shows now, not at the next tick.
    expect(said()).toBe('stale');
  });

  it('the reach stays the same while no row comes or goes', async () => {
    const harness = harnessOf();
    harness.setRows([rowOf('d2')]);
    const reads: string[] = [];
    view = await mount(
      <harness.Harness place="daemon">
        <Page reads={reads} />
      </harness.Harness>,
    );
    await settle();
    const first = seen.reach;
    // The same machine's row rebuilt (its feed moved) is no reason to read again.
    await interact(() =>
      harness.setRows([fakeReachRow({ daemon: 'd2', client: clients.get('d2') as PluginClient, online: false })]),
    );
    await settle();
    expect(seen.reach).toBe(first);
    expect(reads).toEqual(['d2']);
  });
});
