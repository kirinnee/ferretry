import { describe, it } from 'bun:test';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import should from 'should';
import type { DaemonController, DaemonControlReads } from '../../src/lib/daemon/controller.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, inventoryOf, registryOf, skeletonEntry } from './fakes.ts';

const SCOPE = { minimum: 'operator', audit: { skip: 't' }, guard: { none: 't' }, caller: 'any' } as const;
const up = { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } } as const;
const down = { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'refused' } as const;

const updates = skeletonEntry(
  definePlugin({
    id: 'updates',
    title: 'Updates',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: { routes: [route('GET /v1/daemon/update', SCOPE)] },
  }),
  'h-updates',
);

const view = (midTurn: number) => ({
  current: '1.2.3',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: { kind: 'self', steps: [{ command: 'brew upgrade --cask ferretry' }], rollback: 'none' },
  check: {
    state: 'ok',
    checkedAt: '2026-10-18T09:00:00.000Z',
    latest: { version: '1.3.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.0' },
  },
  available: true,
  midTurn,
  autoInstall: false,
  job: null,
});

/** A world whose daemon controller restarts by asking how many ferrets are mid-turn. */
function restartWorld(probe: typeof up | typeof down) {
  const made = fakeWorld({
    registry: registryOf(updates),
    inventory: inventoryOf({ id: 'updates', contract: 'h-updates' }),
    probe,
  });
  const asked: number[] = [];
  const world = {
    ...made.world,
    daemon: (reads: DaemonControlReads) => ({
      controller: {
        restart: async () => {
          asked.push(await reads.turns.midTurn());
        },
      } as unknown as DaemonController,
      exitCode: () => 0,
    }),
  };
  return { ...made, world, asked };
}

describe('fy daemon restart counts the ferrets mid-turn', () => {
  it('reads the count from the daemon’s update view while it answers', async () => {
    const { world, asked, transport } = restartWorld(up);
    transport.replies.push({ status: 200, body: view(3) });

    should(await runFy(['daemon', 'restart'], world)).equal(0);

    should(asked).deepEqual([3]);
    should(transport.sent.map(request => request.path)).deepEqual(['/v1/daemon/update']);
  });

  it('counts none, and asks nothing, when the daemon is not answering', async () => {
    const { world, asked, transport, connects } = restartWorld(down);

    should(await runFy(['daemon', 'restart'], world)).equal(0);

    should(asked).deepEqual([0]);
    should(transport.sent).deepEqual([]);
    should(connects).deepEqual([]);
  });

  it('counts none when the daemon refuses the read', async () => {
    const { world, asked, transport } = restartWorld(up);
    transport.replies.push({ status: 500, body: { error: 'broken' } });

    should(await runFy(['daemon', 'restart'], world)).equal(0);

    should(asked).deepEqual([0]);
  });
});

describe('fy update without a local update adapter', () => {
  it('says so and is unavailable', async () => {
    const { world, io } = fakeWorld();

    should(await runFy(['update'], world)).equal(69);

    should(io.stderr()).equal('This fy has no local update adapters.\n');
  });
});

describe('fy plugin show names what a plugin may reach', () => {
  it('spells out the hosts and programs that installed items or a resolver name', async () => {
    const reaching = skeletonEntry(
      definePlugin({
        id: 'reaching',
        title: 'Reaching',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { network: [{ items: 'mcp' }, { resolver: 'relay' }], spawn: [{ items: 'mcp' }] },
      }),
      'h-reaching',
    );
    const { world, io } = fakeWorld({
      registry: registryOf(reaching),
      inventory: inventoryOf({ id: 'reaching', contract: 'h-reaching' }),
    });

    should(await runFy(['plugin', 'show', 'reaching'], world)).equal(0);

    should(io.stdout()).containEql(
      'network what installed mcp items name, the hosts its relay setting names; runs what installed mcp items name',
    );
  });
});
