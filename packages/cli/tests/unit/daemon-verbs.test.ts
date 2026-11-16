import { describe, it } from 'bun:test';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import should from 'should';
import type { DaemonController, DaemonControlReads } from '../../src/lib/daemon/controller.ts';
import { RESET_ROUTES } from '../../src/lib/daemon/reset-inventory.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, inventoryOf, registryOf, skeletonEntry } from './fakes.ts';

const SCOPE = { minimum: 'operator', audit: { skip: 't' }, guard: { none: 't' }, caller: 'any' } as const;

/** The three owners of the routes a reset counts through, declared so a call would really connect. */
const owners = () =>
  registryOf(
    ...(
      [
        ['vault', RESET_ROUTES.secrets],
        ['access', RESET_ROUTES.devices],
        ['ferrets', RESET_ROUTES.ferrets],
      ] as const
    ).map(([id, key]) =>
      skeletonEntry(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: true,
          kinds: [],
          actions: { routes: [route(key, SCOPE)] },
        }),
        `h-${id}`,
      ),
    ),
  );

function resetWorld(probe: 'up' | 'down') {
  const made = fakeWorld({
    registry: owners(),
    inventory: inventoryOf(
      { id: 'vault', contract: 'h-vault' },
      { id: 'access', contract: 'h-access' },
      { id: 'ferrets', contract: 'h-ferrets' },
    ),
    probe:
      probe === 'up'
        ? { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } }
        : { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' },
  });
  const counted: unknown[] = [];
  const world = {
    ...made.world,
    daemon: (reads: DaemonControlReads) => ({
      controller: {
        reset: async () => {
          counted.push(await reads.resetInventory.count());
        },
      } as unknown as DaemonController,
      exitCode: () => 0,
    }),
  };
  return { ...made, world, counted };
}

describe('fy daemon reset reads its counts only while the daemon answers', () => {
  it('V-0236 a daemon that died before the counts start is not started by them: no connection, no daemon launched', async () => {
    const { world, counted, connects, transport } = resetWorld('down');
    should(await runFy(['daemon', 'reset', '--yes'], world)).equal(0);
    should(counted).deepEqual([undefined]);
    should(connects).deepEqual([]);
    should(transport.sent).deepEqual([]);
  });

  it('V-0236 while it answers, each count goes through its owner’s declared route', async () => {
    const { world, counted, transport } = resetWorld('up');
    transport.replies.push(
      { status: 200, body: { secrets: [{}, {}] } },
      { status: 200, body: { devices: [{}], hostLocal: true } },
      { status: 200, body: [{}, {}, {}] },
    );
    should(await runFy(['daemon', 'reset', '--yes'], world)).equal(0);
    should(counted).deepEqual([{ secrets: 2, devices: 1, ferrets: 3 }]);
    should(transport.sent.map(request => request.path)).deepEqual(['/v1/secrets', '/v1/pair/devices', '/v1/ferrets']);
  });
});
