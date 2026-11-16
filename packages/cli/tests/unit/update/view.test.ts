import { expect, test } from 'bun:test';
import { registry as compiledRegistry } from '../../../src/generated/commands.ts';
import { type DaemonTransport, InventoryCache } from '../../../src/lib/client.ts';
import { runFy } from '../../../src/lib/run.ts';
import { entry, fakeWorld, inventoryOf, registryOf } from '../fakes.ts';

test.each(['inventory', 'view'] as const)(
  'update view fails open within one 3 s budget when %s stalls',
  async stage => {
    const updates = compiledRegistry.plugins.find(plugin => plugin.id === 'updates');
    if (updates === undefined) throw new Error('Updates must be in the generated registry');
    const registry = registryOf(
      entry(updates.manifest, 'updates-hash', async () => {
        throw new Error('the shell must not load the plugin half');
      }),
    );
    const inventory = inventoryOf({ id: 'updates', contract: 'updates-hash' });
    const f = fakeWorld({ registry });
    let sent = 0;
    const transport: DaemonTransport = {
      send: async () => {
        sent++;
        return await new Promise(() => {});
      },
    };
    const world = {
      ...f.world,
      connect: async () => {
        const connection = await f.world.connect({ asOwner: false });
        return {
          ...connection,
          transport,
          inventory: new InventoryCache(async () => {
            if (stage === 'inventory') return await new Promise(() => {});
            // The view must get only the time left after the inventory, not a fresh 3 s.
            await Bun.sleep(1_600);
            return inventory;
          }),
        };
      },
      update: async (_options: unknown, view: { view(): Promise<unknown> }) => {
        const started = performance.now();
        expect(await view.view()).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(4_200);
        return 0;
      },
    };
    expect(await runFy(['update', '--yes', '--when-idle'], world)).toBe(0);
    expect(sent).toBe(stage === 'view' ? 1 : 0);
  },
  4_500,
);
