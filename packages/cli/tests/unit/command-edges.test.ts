import { describe, it } from 'bun:test';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import should from 'should';
import type { DaemonController, DaemonControlReads } from '../../src/lib/daemon/controller.ts';
import { runFy } from '../../src/lib/run.ts';
import { passMidTurn } from '../../src/lib/update/mid-turn.ts';
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

/**
 * A world whose daemon controller restarts through the real mid-turn gate, over the reader this verb builds: what a
 * restart would have said, and whether it would have gone ahead.
 */
function restartWorld(probe: typeof up | typeof down) {
  const made = fakeWorld({
    registry: registryOf(updates),
    inventory: inventoryOf({ id: 'updates', contract: 'h-updates' }),
    probe,
  });
  const asked: number[] = [];
  const said: string[] = [];
  const restarted: boolean[] = [];
  const world = {
    ...made.world,
    daemon: (reads: DaemonControlReads) => ({
      controller: {
        restart: async (options: { whenIdle?: boolean } = {}) => {
          await passMidTurn(
            {
              midTurn: async () => {
                const count = await reads.turns.midTurn();
                asked.push(count);
                return count;
              },
              sleep: async () => undefined,
              warn: line => said.push(line),
            },
            options.whenIdle === true,
            'restarting',
          );
          restarted.push(true);
        },
      } as unknown as DaemonController,
      exitCode: () => 0,
    }),
  };
  return { ...made, world, asked, said, restarted };
}

describe('fy daemon restart counts the ferrets mid-turn', () => {
  it('reads the count from the daemon’s update view while it answers', async () => {
    const { world, asked, said, transport } = restartWorld(up);
    transport.replies.push({ status: 200, body: view(3) });

    should(await runFy(['daemon', 'restart'], world)).equal(0);

    should(asked).deepEqual([3]);
    should(said[0]).containEql('3 ferrets are mid-turn; they keep running');
    should(transport.sent.map(request => request.path)).deepEqual(['/v1/daemon/update']);
  });

  it('counts none, and asks nothing, when the daemon is not answering, with or without --when-idle', async () => {
    const { world, asked, transport, connects, restarted } = restartWorld(down);

    should(await runFy(['daemon', 'restart'], world)).equal(0);
    should(await runFy(['daemon', 'restart', '--when-idle'], world)).equal(0);

    should(asked).deepEqual([0, 0]);
    should(restarted).deepEqual([true, true]);
    should(transport.sent).deepEqual([]);
    should(connects).deepEqual([]);
  });

  it('counts none when the daemon refuses the read, and goes ahead without --when-idle', async () => {
    const { world, transport, restarted, said } = restartWorld(up);
    transport.replies.push({ status: 500, body: { error: 'broken' } });

    should(await runFy(['daemon', 'restart'], world)).equal(0);

    should(restarted).deepEqual([true]);
    should(said).deepEqual([]);
  });

  it('with --when-idle refuses, restarting nothing, when the daemon is up but its count cannot be read', async () => {
    for (const unreadable of [
      { status: 500, body: { error: 'broken' } },
      { status: 200, body: { not: 'a view' } },
      new Error('timed out'),
    ]) {
      const { world, transport, restarted, io } = restartWorld(up);
      transport.replies.push(unreadable);

      should(await runFy(['daemon', 'restart', '--when-idle'], world)).equal(1);

      should(restarted).deepEqual([]);
      should(io.stderr()).containEql('could not read how many ferrets are mid-turn, so nothing was restarted');
      should(io.stderr()).containEql('leave out --when-idle');
    }
  });

  it('with --when-idle waits while ferrets are mid-turn, then goes ahead, and says when none is', async () => {
    const waits = restartWorld(up);
    waits.transport.replies.push({ status: 200, body: view(2) }, { status: 200, body: view(0) });
    should(await runFy(['daemon', 'restart', '--when-idle'], waits.world)).equal(0);
    should(waits.asked).deepEqual([2, 0]);
    should(waits.said[0]).containEql('waiting until every ferret is idle before restarting');
    should(waits.restarted).deepEqual([true]);

    const idle = restartWorld(up);
    idle.transport.replies.push({ status: 200, body: view(0) });
    should(await runFy(['daemon', 'restart', '--when-idle'], idle.world)).equal(0);
    should(idle.said).deepEqual(['no ferret is mid-turn']);
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
