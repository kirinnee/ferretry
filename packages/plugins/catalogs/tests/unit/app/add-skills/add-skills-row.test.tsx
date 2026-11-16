/** The Actions ▾ row "Add skills…", offered through Ferrets' `ferrets.actions-row` slot: the same way in as Skills' "+ Add skills". */
import { describe, expect, it } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, mount, must, noteClientDaemon, RouterProvider } from '@ferretry/app/testing';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { act, type FunctionComponent, Suspense } from 'react';
import half from '../../../../app/index.ts';
import { placeQuery } from '../../../../app/lib/add-skills-address.ts';
import manifest from '../../../../manifest.ts';
import { settle } from '../support/dom-form.ts';

const INVENTORY = {
  ferretId: 'f1',
  harness: 'codex',
  folder: '/work/app',
  runtime: 'box',
  skills: ['a', 'b', 'c'].map((name, index) => ({
    name,
    description: `${name} skill`,
    harness: 'codex',
    scope: index === 1 ? 'user' : 'project',
    path: `/work/app/.codex/skills/${name}/SKILL.md`,
    runtimes: ['box'],
  })),
  truncated: false,
};

/**
 * Mounts the row for a ferret and returns what it offered. `answer` scripts the ferret's inventory read. It waits for the
 * row's own first offer (an event, not a count of event-loop turns, which are microseconds and say nothing about how long
 * React takes to flush the mount); a row that is never offered ends at the test's own timeout.
 */
const mountRow = async (
  answer: () => Promise<unknown>,
  props: Record<string, unknown> = {},
  href: (daemon: string, plugin: string, screen: string, params?: Record<string, string>) => string | undefined = (
    daemon,
    _plugin,
    _screen,
    params,
  ) => `/d/${daemon}/catalogs/add-skills/${params?.ferret}`,
) => {
  const calls: unknown[] = [];
  const client = {
    call: async (route: string, init: unknown) => {
      calls.push([route, init]);
      return await answer();
    },
  } as never;
  noteClientDaemon(client, 'alpha');
  const offers: (readonly [string, ActionsRowOffer | null])[] = [];
  let offered = (): void => {};
  const firstOffer = new Promise<void>(resolve => {
    offered = resolve;
  });
  const built = half.build?.({ manifest: half.manifest, client });
  const Panel = built?.panels?.['add-skills-row'] as unknown as FunctionComponent<Record<string, unknown>>;
  const view = await mount(
    <RouterProvider>
      <Suspense fallback={null}>
        <ScreenHrefProvider href={href}>
          <Panel
            ferret="f1"
            name="Marin"
            canControl
            offer={(id: string, row: ActionsRowOffer | null) => {
              offers.push([id, row]);
              offered();
            }}
            {...props}
          />
        </ScreenHrefProvider>
      </Suspense>
    </RouterProvider>,
  );
  await firstOffer;
  return { offers, calls, view };
};

/**
 * An `act` scope somebody else still holds open (the previous file's last test, in the one process the unit tier shares):
 * React flushes nothing a nested `act` queues until that scope closes, so the row is not offered for as many event-loop
 * turns as the holder takes — turns are microseconds, not time, which is what a counted wait mistakes for "never".
 */
const holdActScope = async (turns: number): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
  });
};

const run = async (row: ActionsRowOffer | null | undefined): Promise<void> => {
  const offered = must(row, 'the row');
  await interact(async () => {
    await offered.run();
  });
  await settle();
};

describe('catalogs: Actions › Add skills… row', () => {
  it('is declared in the Actions slot beside the way in to Skills’ tab', () => {
    expect(manifest.ui?.panels?.map(panel => `${panel.slot}/${panel.id}`)).toEqual([
      'skills.add/add-skills',
      'ferrets.actions-row/add-skills-row',
      'skills.row/skills-row',
      'mcp.row/mcp-row',
      'mcp.install/mcp-install',
    ]);
    const built = half.build?.({ manifest: half.manifest, client: { call: async () => ({}) } as never });
    expect(Object.keys(built?.panels ?? {})).toEqual([
      'add-skills',
      'add-skills-row',
      'skills-row',
      'mcp-row',
      'mcp-install',
    ]);
  });

  it('offers one row to a caller who may control the ferret, and goes to the page with the ferret’s place from run', async () => {
    const { offers, calls, view } = await mountRow(async () => INVENTORY);
    expect(offers).toHaveLength(1);
    const row = must(offers[0]?.[1], 'the row');
    expect(row).toMatchObject({ id: 'add-skills', label: 'Add skills…', group: 'ferret', kind: 'run' });
    expect(calls).toEqual([]);
    await run(row);
    expect(calls).toEqual([['GET /v1/ferrets/:ferretId/skills/inventory', { params: { ferretId: 'f1' } }]]);
    expect(`${globalThis.location.pathname}${globalThis.location.search}`).toBe(
      `/d/alpha/catalogs/add-skills/f1${placeQuery({
        ferret: 'f1',
        folder: '/work/app',
        harness: 'codex',
        runtime: 'box',
        scopes: ['project', 'user'],
      })}`,
    );
    await view.unmount();
  });

  it('goes to the page with no place when the daemon will not say where the ferret works, and omits an absent runtime', async () => {
    const refused = await mountRow(async () => Promise.reject(new Error('down')));
    await run(refused.offers[0]?.[1]);
    expect(`${globalThis.location.pathname}${globalThis.location.search}`).toBe('/d/alpha/catalogs/add-skills/f1');
    await refused.view.unmount();
    const { runtime: _runtime, ...noRuntime } = INVENTORY;
    const bare = await mountRow(async () => noRuntime);
    await run(bare.offers[0]?.[1]);
    expect(globalThis.location.search).not.toContain('runtime=');
    expect(globalThis.location.search).toContain('folder=%2Fwork%2Fapp');
    await bare.view.unmount();
  });

  it('offers the row once React has flushed it, however many event-loop turns that takes', async () => {
    const held = holdActScope(3_000);
    try {
      const { offers, view } = await mountRow(async () => INVENTORY);
      expect(offers).toHaveLength(1);
      await view.unmount();
    } finally {
      await held;
    }
  });

  it('withdraws the row for a caller who may not control the ferret', async () => {
    const { offers, view } = await mountRow(async () => INVENTORY, { canControl: false });
    expect(offers).toEqual([['add-skills', null]]);
    await view.unmount();
  });

  it('offers nothing when no screen has that address, or the props are not the slot’s', async () => {
    const unaddressed = await mountRow(
      async () => INVENTORY,
      {},
      () => undefined,
    );
    expect(unaddressed.offers).toEqual([['add-skills', null]]);
    await unaddressed.view.unmount();
    const client = { call: async () => ({}) } as never;
    noteClientDaemon(client, 'alpha');
    const built = half.build?.({ manifest: half.manifest, client });
    const Panel = built?.panels?.['add-skills-row'] as unknown as FunctionComponent<Record<string, unknown>>;
    const view = await mount(
      <RouterProvider>
        <Suspense fallback={null}>
          <Panel />
        </Suspense>
      </RouterProvider>,
    );
    await settle();
    await settle();
    expect(document.body.textContent).toBe('');
    await view.unmount();
  });

  it('does nothing from run when the page’s address has gone by the time it is asked', async () => {
    let live = true;
    const { offers, view } = await mountRow(
      async () => INVENTORY,
      {},
      (daemon, _plugin, _screen, params) => (live ? `/d/${daemon}/catalogs/add-skills/${params?.ferret}` : undefined),
    );
    live = false;
    globalThis.history.replaceState(null, '', '/before');
    await run(offers[0]?.[1]);
    expect(globalThis.location.pathname).toBe('/before');
    await view.unmount();
  });
});
