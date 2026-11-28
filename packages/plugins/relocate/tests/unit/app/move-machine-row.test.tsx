/** U16: Actions offers a move to an available target, or source-only recovery when none is available. */
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
import type { MovedStore } from '../../../app/lib/moved-store.ts';
import { MovedDocumentSchema } from '../../../contract/index.ts';
import { createMoveMachineRowPanel, offersMove } from '../../../app/slots/move-machine-row.tsx';
import { fakeReachRow } from '@ferretry/app/testing';

ensureDom();

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const client = { call: async () => ({ moved: {} }) } as unknown as PluginClient;

async function mountRow(
  daemons: readonly string[],
  canControl = true,
  refused?: string,
  capability = 'fleet',
  store = createMovedStore(client),
) {
  noteClientDaemon(client, 'alpha');
  const harness = deviceViewHarness({ plugin: 'relocate', fragments: [] });
  harness.setRows(
    daemons.map(daemon => ({
      ...fakeReachRow({ daemon, client, machine: `${daemon}-box` }),
      ...(daemon === refused
        ? {
            authority: (asked: string) =>
              asked === capability
                ? { kind: 'refused' as const, refusal: 'device-not-granted' as const }
                : { kind: 'open' as const },
          }
        : {}),
    })),
  );
  const offers: (readonly [string, ActionsRowOffer | null])[] = [];
  const Panel = createMoveMachineRowPanel(client, store) as unknown as FC<Record<string, unknown>>;
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
  it('keeps the open move dialog mounted when its ledger becomes a stub, until Close is pressed', async () => {
    let ledger = MovedDocumentSchema.parse({ moved: {} });
    const listeners = new Set<() => void>();
    const store: MovedStore = {
      snapshot: () => ledger,
      subscribe: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      refresh: async () => undefined,
    };
    const offers = await mountRow(['alpha', 'beta'], true, undefined, 'fleet', store);
    await interact(async () => {
      await must(offers.at(-1)?.[1], 'move row').run();
    });
    const original = must(document.querySelector('[data-move-machine]'), 'open move dialog');
    await interact(async () => {
      ledger = MovedDocumentSchema.parse({
        moved: {
          f1: {
            daemonId: `fy_daemon_${'B'.repeat(43)}`,
            ferretId: 'g9',
            at: '2026-11-27T00:00:00.000Z',
          },
        },
      });
      for (const listener of listeners) listener();
    });
    expect(document.querySelector('[data-move-machine]')).toBe(original);
    expect(offers.at(-1)).toEqual(['move-machine', null]);
    await interact(async () => {
      must(original.querySelector<HTMLButtonElement>('button[aria-label="Close"]'), 'Close').click();
    });
    expect(document.querySelector('[data-move-machine]')).toBeNull();
    expect(document.querySelector('[data-moved-to]')?.textContent).toContain('Moved to another machine');
    expect(document.querySelector('[data-moved-to]')?.textContent).not.toContain('fy_daemon_');
  });
  it('is offered to a controlling caller with a source, including source-only recovery', () => {
    expect(offersMove(true, 2)).toBe(true);
    expect(offersMove(true, 1)).toBe(true);
    expect(offersMove(true, 0)).toBe(false);
    expect(offersMove(false, 3)).toBe(false);
  });

  it('opens recovery only when this is the only paired machine', async () => {
    const offers = await mountRow(['alpha']);
    await interact(async () => {
      await must(offers.at(-1)?.[1], 'recovery row').run();
    });
    expect(document.querySelector('[data-move-step="pick"]')?.textContent).toContain('No other machine is available');
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.querySelector('[data-move-release]')).toBeNull();
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
    expect(dialog.querySelector('[role="radiogroup"]')?.textContent).not.toContain('alpha-box');
    expect(dialog.querySelector('[data-move-release]')).toBeNull();
  });

  it('is withdrawn for a caller who may not control the ferret, even with two machines', async () => {
    const offers = await mountRow(['alpha', 'beta'], false);
    expect(offers.some(([, row]) => row !== null)).toBe(false);
  });

  for (const capability of ['fleet', 'filesystem'])
    it(`reads source ${capability} authority even when the host defaults canControl to true`, async () => {
      const offers = await mountRow(['alpha', 'beta'], true, 'alpha', capability);
      expect(offers.some(([, row]) => row !== null)).toBe(false);
    });

  for (const capability of ['fleet', 'filesystem'])
    it(`excludes a target whose ${capability} authority refuses the move`, async () => {
      const offers = await mountRow(['alpha', 'beta'], true, 'beta', capability);
      await interact(async () => {
        await must(offers.at(-1)?.[1], 'recovery row').run();
      });
      expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    });
});
