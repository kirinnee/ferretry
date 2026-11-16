import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { definePort, defineState } from '../../../contract/define.ts';
import { Carriers } from '../../../contract/kernel.ts';
import { bootHost } from '../../../host/host.ts';
import { acquireHomeLock, StateHomeLockedError } from '../../../host/state/home-lock.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock, testHost } from '../../../testing/index.ts';

const Tree = defineState({ name: 'pair-open', path: 'pair-open/*', store: 'opaque', format: 1 });
const manifest = definePlugin({
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { state: [Tree] },
});

test('P106 beforeListen awaits state work once under the home lock before local or carrier listeners', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-before-listen-`);
  const order: string[] = [];
  const plugin = implementDaemon(manifest, {
    build: ctx => ({
      beforeListen: async same => {
        expect(same).toBe(ctx);
        order.push('before');
        await expect(acquireHomeLock({ home, binary: 'fy' })).rejects.toBeInstanceOf(StateHomeLockedError);
        await ctx.kernel.state.createPrivateDirectory(Tree, 'swept');
        order.push('ready');
      },
    }),
  });
  const connections = implementDaemon(
    definePlugin({
      id: 'connections',
      title: 'Connections',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Carriers, key: 'direct' }] },
    }),
    {
      build: () => ({
        hooks: {
          'carriers:direct': {
            start: async () => {
              order.push('carrier');
            },
            status: () => ({ state: 'ready', sentence: 'fixture' }),
          },
        },
      }),
    },
  );
  const boot = await bootHost({
    home,
    version: '5.0.0',
    implementations: [plugin, connections],
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    listen: async () => {
      order.push('listen');
      expect(order).toEqual(['before', 'ready', 'listen']);
      return { addresses: [], stop: async () => {} };
    },
  });
  try {
    expect(boot.kind).toBe('running');
    expect(order).toEqual(['before', 'ready', 'listen', 'carrier']);
    if (boot.kind === 'running') await boot.host.stop();
    const lease = await acquireHomeLock({ home, binary: 'fy' });
    await lease.release();
  } finally {
    if (boot.kind === 'running') await boot.host.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('P106 testHost mirrors once-per-boot beforeListen and binds optional ports first', async () => {
  const order: string[] = [];
  const Check = definePort<{ readonly ready: boolean }>('boot-check');
  const plugin = implementDaemon(definePlugin({ ...manifest, uses: { check: Check } }), {
    build: ctx => ({
      beforeListen: async same => {
        expect(same).toBe(ctx);
        expect(ctx.uses.check.current()?.ready).toBe(true);
        if ((await ctx.kernel.state.stat(Tree, 'one')) === undefined)
          await ctx.kernel.state.createPrivateDirectory(Tree, 'one');
        order.push('swept');
      },
    }),
  });
  const host = await testHost({ plugins: [plugin], uses: { check: { ready: true } } });
  expect(order).toEqual(['swept']);
  const restarted = await host.restart();
  expect(order).toEqual(['swept', 'swept']);
  await restarted.stop();
});

test.each(['throw', 'timeout'] as const)(
  'P106 production beforeListen %s is bounded, logged and followed by listen',
  async mode => {
    const home = await mkdtemp(`${tmpdir()}/fy-before-listen-fault-`);
    const clock = fixedClock();
    const logs: string[] = [];
    let entered = (): void => {};
    const entry = new Promise<void>(resolve => {
      entered = resolve;
    });
    let listening = false;
    const plugin = implementDaemon(manifest, {
      build: () => ({
        beforeListen: async () => {
          entered();
          if (mode === 'throw') throw new Error('fixture');
          await new Promise<void>(() => {});
        },
      }),
    });
    const adapters = realAdapters(
      home,
      record => {
        logs.push(record.message);
      },
      { binary: 'fy' },
    );
    const starting = bootHost({
      home,
      version: '5.0.0',
      implementations: [plugin],
      adapters: { ...adapters, clock },
      listen: async () => {
        listening = true;
        return { addresses: [], stop: async () => {} };
      },
    });
    await entry;
    if (mode === 'timeout') {
      await clock.advance(4_999);
      expect(listening).toBe(false);
      await clock.advance(1);
    }
    const boot = await starting;
    try {
      expect(boot.kind).toBe('running');
      expect(listening).toBe(true);
      expect(
        logs.some(
          message => message.includes('beforeListen') && message.includes(mode === 'throw' ? 'failed' : 'timed out'),
        ),
      ).toBe(true);
    } finally {
      if (boot.kind === 'running') await boot.host.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test('P106 a throwing or timed-out beforeListen is logged and boot continues', async () => {
  const clock = fixedClock();
  const throwing = implementDaemon(manifest, {
    build: () => ({
      beforeListen: async () => {
        throw new Error('fixture failure');
      },
    }),
  });
  const host = await testHost({ plugins: [throwing], clock });
  expect(host.logs.some(line => line.message.includes('beforeListen'))).toBe(true);
  await host.stop();
  let entered = (): void => {};
  const entry = new Promise<void>(resolve => {
    entered = resolve;
  });
  const stuck = implementDaemon(manifest, {
    build: () => ({
      beforeListen: async () => {
        entered();
        await new Promise<void>(() => {});
      },
    }),
  });
  let returned = false;
  const starting = testHost({ plugins: [stuck], clock }).then(host => {
    returned = true;
    return host;
  });
  await entry;
  expect(returned).toBe(false);
  await clock.advance(5_000);
  const timed = await starting;
  expect(timed.logs.some(line => line.message.includes('beforeListen') && line.message.includes('timed out'))).toBe(
    true,
  );
  await timed.stop();
  expect(clock.pending()).toBe(0);
});
