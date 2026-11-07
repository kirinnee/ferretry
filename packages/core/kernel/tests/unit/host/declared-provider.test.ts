import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineHook } from '../../../contract/define.ts';
import type { HookInvoker } from '../../../manifest/implement.ts';
import { definePlugin, implementDaemon, skeletonDaemon } from '../../../manifest/index.ts';
import { HookEngine } from '../../../host/hooks.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';
import { silentLog } from './fixtures.ts';

const Hook = defineHook('test.provided', { mode: 'provide', key: z.enum(['one', 'missing']) });
const offerer = definePlugin({
  id: 'offerer',
  title: 'Offerer',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  hooks: { offers: [{ hook: Hook }] },
});
const taker = definePlugin({
  id: 'taker',
  title: 'Taker',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  hooks: { takes: [{ hook: Hook, key: 'one' }] },
});

test('declaredProvider distinguishes absent from declared but skeleton, failed or off', () => {
  const deadline = () => ({ promise: new Promise<'timeout'>(() => {}), cancel: () => {} });
  const { engine } = HookEngine.plan([offerer, taker], silentLog, deadline);
  const invoker = engine.invokerFor('offerer');
  expect(invoker.declaredProvider(Hook, 'missing')).toBeUndefined();
  expect(invoker.declaredProvider(Hook, 'one')).toBe('taker');
  expect(invoker.provider(Hook, 'one')).toBe('unavailable');
  engine.attach('taker', { 'test.provided:one': 'live' }, 'live');
  expect(invoker.provider(Hook, 'one')).toBe('live');
  engine.markFailed('taker');
  expect(invoker.declaredProvider(Hook, 'one')).toBe('taker');
  expect(invoker.provider(Hook, 'one')).toBe('unavailable');
  const off = HookEngine.plan([offerer], silentLog, deadline, [offerer, taker]).engine.invokerFor('offerer');
  expect(off.declaredProvider(Hook, 'one')).toBe('taker');
  expect(off.provider(Hook, 'one')).toBe('unavailable');
  expect(() => engine.invokerFor('taker').declaredProvider(Hook, 'one')).toThrow();
});

test('testHost declaredProvider preserves a skeleton declaration while provider stays unavailable', async () => {
  let hooks: HookInvoker | undefined;
  const host = await testHost({
    plugins: [
      implementDaemon(offerer, {
        build: ctx => {
          hooks = ctx.hooks;
          return {};
        },
      }),
      skeletonDaemon(taker),
    ],
  });
  expect(hooks?.declaredProvider(Hook, 'missing')).toBeUndefined();
  expect(hooks?.declaredProvider(Hook, 'one')).toBe('taker');
  expect(hooks?.provider(Hook, 'one')).toBe('unavailable');
  await host.stop();
});

test('testHost refuses a taker’s cloned same-name definition before building it', async () => {
  const fake = { ...Hook, key: z.string() };
  let built = false;
  const rogue = definePlugin({ ...taker, hooks: { takes: [{ hook: fake, key: 'one' }] } });
  await expect(
    testHost({
      plugins: [
        implementDaemon(offerer, { build: () => ({}) }),
        implementDaemon(rogue, {
          build: () => {
            built = true;
            return { hooks: { 'test.provided:one': {} } };
          },
        }),
      ],
    }),
  ).rejects.toThrow('refused hook definition');
  expect(built).toBe(false);
});

test('S? declared provider: through a real boot, a disabled taker stays declared and its provider is unavailable', async () => {
  const root = await mkdtemp(`${tmpdir()}/declared-provider-`);
  const home = `${root}/home`;
  const running: RunningHost[] = [];
  try {
    const boot = async (takerOn: boolean) => {
      let hooks: HookInvoker | undefined;
      const adapters: HostOptions['adapters'] = {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
      };
      const outcome = await bootHost({
        home,
        version: '5.0.0',
        adapters,
        enabled: id => takerOn || id !== 'taker',
        implementations: [
          implementDaemon(offerer, {
            build: ctx => {
              hooks = ctx.hooks;
              return {};
            },
          }),
          implementDaemon(taker, { build: () => ({ hooks: { 'test.provided:one': 'live' } }) }),
        ],
      });
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      running.push(outcome.host);
      return { host: outcome.host, hooks: hooks as HookInvoker };
    };
    const on = await boot(true);
    expect(on.hooks.declaredProvider(Hook, 'one')).toBe('taker');
    expect(on.hooks.provider(Hook, 'one')).toBe('live');
    await on.host.stop();
    const off = await boot(false);
    expect(off.host.plugins.get('taker')?.status).toBe('off');
    expect(off.hooks.declaredProvider(Hook, 'one')).toBe('taker');
    expect(off.hooks.provider(Hook, 'one')).toBe('unavailable');
    expect(off.hooks.declaredProvider(Hook, 'missing')).toBeUndefined();
  } finally {
    for (const host of running) await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
