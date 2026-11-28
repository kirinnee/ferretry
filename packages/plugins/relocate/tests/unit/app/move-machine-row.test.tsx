/** U16: "Move to another machine…" in the Actions menu appears only where there is another machine to move to. */
import { afterEach, describe, expect, it } from 'bun:test';
import type { FC } from 'react';
import {
  deviceViewHarness,
  ensureDom,
  interact,
  type Mounted,
  mount,
  must,
  noteClientDaemon,
} from '@ferretry/app/testing';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createMovedStore } from '../../../app/lib/moved-store.ts';
import { createMoveMachineRowPanel, offersMove } from '../../../app/slots/move-machine-row.tsx';
import { fakeReachRow } from '@ferretry/app/testing';

ensureDom();

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const client = { call: async () => ({ moved: {} }) } as unknown as PluginClient;

async function mountRow(daemons: readonly string[], canControl = true) {
  noteClientDaemon(client, 'alpha');
  const harness = deviceViewHarness({ plugin: 'relocate', fragments: [] });
  harness.setRows(daemons.map(daemon => fakeReachRow({ daemon, client, machine: `${daemon}-box` })));
  const offers: (readonly [string, ActionsRowOffer | null])[] = [];
  const Panel = createMoveMachineRowPanel(client, createMovedStore(client)) as unknown as FC<Record<string, unknown>>;
  await interact(async () => {
    mounted = await mount(
      <harness.Harness place="daemon">
        <Panel
          ferret="f1"
          name="Marin"
          canControl={canControl}
          offer={(id: string, row: ActionsRowOffer | null) => offers.push([id, row])}
        />
      </harness.Harness>,
    );
  });
  return offers;
}

describe('the move-machine row', () => {
  it('is offered only for a controlling caller with at least two machines', () => {
    expect(offersMove(true, 2)).toBe(true);
    expect(offersMove(true, 1)).toBe(false);
    expect(offersMove(false, 3)).toBe(false);
  });

  it('is withdrawn when this is the only paired machine', async () => {
    const offers = await mountRow(['alpha']);
    expect(offers.at(-1)).toEqual(['move-machine', null]);
    expect(offers.some(([, row]) => row !== null)).toBe(false);
  });

  it('is offered, in the move group, when a second machine is paired, and opens the picker from run', async () => {
    const offers = await mountRow(['alpha', 'beta']);
    const row = must(offers.at(-1)?.[1], 'the row');
    expect(row).toMatchObject({ id: 'move-machine', label: 'Move to another machine…', group: 'move', kind: 'run' });
    expect(document.body.querySelector('[data-move-machine]')).toBeNull();
    await interact(async () => {
      await row.run();
    });
    const dialog = must(document.body.querySelector('[data-move-machine]'), 'the dialog');
    expect(dialog.querySelector('[data-move-step="pick"]')).not.toBeNull();
    expect(dialog.textContent).toContain('beta-box');
    // the machine it is on is not a place to move to
    expect(dialog.textContent).not.toContain('alpha-box');
  });

  it('is withdrawn for a caller who may not control the ferret, even with two machines', async () => {
    const offers = await mountRow(['alpha', 'beta'], false);
    expect(offers.some(([, row]) => row !== null)).toBe(false);
  });
});
