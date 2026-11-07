/**
 * A `provides` entry may be a FACTORY built once for each plugin that needs it (§3.7), with that plugin's id and its
 * EFFECTIVE permissions; a plain value is shared exactly as before. The real boot and the test host do the same.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { definePort } from '../../../contract/define.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import {
  definePlugin,
  implementDaemon,
  type Needer,
  neederMayReach,
  neederMayRun,
  perNeeder,
} from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

interface Gadget {
  readonly for: string;
  readonly network: readonly unknown[];
  readonly spawn: readonly unknown[];
  readonly secrets: readonly string[];
}
const GadgetPort = definePort<Gadget>('gadget');
const SharedPort = definePort<{ readonly n: number }>('shared');

const provider = (id: string, core: boolean) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core,
    kinds: [],
    provides: { gadget: GadgetPort, shared: SharedPort },
    permissions: { network: ['*'], spawn: ['*'] },
  });
const needer = (id: string, permissions: Record<string, unknown>) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { gadget: GadgetPort, shared: SharedPort },
    permissions: permissions as never,
  });

function plugins(built: { count: number }, got: Record<string, { gadget: Gadget; shared: { n: number } }>) {
  const shared = { n: 1 };
  const makers = [
    implementDaemon(provider('gadgets', false), {
      build: () => ({
        provides: {
          gadget: perNeeder<Gadget>((who: Needer) => {
            built.count += 1;
            return {
              for: who.id,
              network: who.permissions.network ?? [],
              spawn: who.permissions.spawn ?? [],
              secrets: who.permissions.secrets ?? [],
            };
          }),
          shared,
        },
      }),
    }),
    ...(['alpha', 'beta'] as const).map(id =>
      implementDaemon(needer(id, { network: ['*', 'api.alpha.test'], spawn: ['*', 'ls'], secrets: ['A_KEY'] }), {
        build: ctx => {
          got[id] = ctx.needs as never;
          return {};
        },
      }),
    ),
  ];
  return makers;
}

test('per-needer: the test host builds the factory once per needing plugin, with its effective permissions', async () => {
  const built = { count: 0 };
  const got: Record<string, { gadget: Gadget; shared: { n: number } }> = {};
  const host = await testHost({ plugins: plugins(built, got) });
  // Each plugin is handed its own; a '*' from a plugin that is not core was dropped before the factory saw it.
  expect(got.alpha?.gadget).toEqual({ for: 'alpha', network: ['api.alpha.test'], spawn: ['ls'], secrets: ['A_KEY'] });
  expect(got.beta?.gadget.for).toBe('beta');
  expect(got.alpha?.gadget).not.toBe(got.beta?.gadget);
  expect(built.count).toBe(2);
  // Reading it again for the same plugin builds nothing new and answers the same value.
  expect(host.provided(GadgetPort, 'alpha')).toBe(got.alpha?.gadget as Gadget);
  expect(host.provided(GadgetPort, 'alpha')).toBe(host.provided(GadgetPort, 'alpha'));
  expect(built.count).toBe(2);
  // A plain value stays shared by every needer.
  expect(got.alpha?.shared).toBe(got.beta?.shared as { n: number });
  // No plugin named: the caller is the kernel, which is core (its '*' stays).
  expect(host.provided(GadgetPort).for).toBe('kernel');
  await host.stop();
});

test('per-needer: a real boot builds the factory once per needing plugin and keeps plain values shared', async () => {
  const root = await mkdtemp(`${tmpdir()}/per-needer-`);
  const home = `${root}/home`;
  let running: RunningHost | undefined;
  try {
    const built = { count: 0 };
    const got: Record<string, { gadget: Gadget; shared: { n: number } }> = {};
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    };
    const outcome = await bootHost({ home, version: '5.0.0', adapters, implementations: plugins(built, got) });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    running = outcome.host;
    expect(built.count).toBe(2);
    expect(got.alpha?.gadget.for).toBe('alpha');
    expect(got.beta?.gadget.for).toBe('beta');
    // (a live port wraps what it hands out, so arrays are read through their values)
    expect(Object.values(got.alpha?.gadget.network ?? {})).toEqual(['api.alpha.test']);
    expect(Object.values(got.alpha?.gadget.spawn ?? {})).toEqual(['ls']);
    expect(got.alpha?.gadget).not.toBe(got.beta?.gadget);
    // a plain value is handed as it is (each need gets its own live wrapper, as before), not built per needer
    expect([got.alpha?.shared.n, got.beta?.shared.n]).toEqual([1, 1]);
  } finally {
    await running?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('per-needer: a factory that throws leaves that need unmet, as if its provider were not running', async () => {
  const root = await mkdtemp(`${tmpdir()}/per-needer-`);
  const home = `${root}/home`;
  let running: RunningHost | undefined;
  try {
    let builtNeeder = false;
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    };
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters,
      implementations: [
        implementDaemon(provider('gadgets', false), {
          build: () => ({
            provides: {
              gadget: perNeeder<Gadget>(() => {
                throw new Error('no');
              }),
              shared: { n: 1 },
            },
          }),
        }),
        implementDaemon(needer('alpha', {}), {
          build: () => {
            builtNeeder = true;
            return {};
          },
        }),
      ],
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    running = outcome.host;
    expect(builtNeeder).toBe(false);
    expect(running.plugins.get('alpha')?.status).toBe('failed');
  } finally {
    await running?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('per-needer: the reach a provider narrows to reads only literal entries, and a wildcard is not one', () => {
  const who: Needer = {
    id: 'tenant',
    permissions: {
      network: ['api.a.test', '*.b.test', { items: 'skill' as never }],
      spawn: ['tmux', { resolver: 'x' } as never],
    },
    ownedSecretReferences: () => new Set(),
  };
  expect(neederMayReach(who, 'api.a.test')).toBe(true);
  expect(neederMayReach(who, 'x.b.test')).toBe(true);
  expect(neederMayReach(who, 'b.test')).toBe(false);
  expect(neederMayReach(who, 'api.other.test')).toBe(false);
  expect(neederMayRun(who, 'tmux')).toBe(true);
  expect(neederMayRun(who, '/usr/bin/tmux')).toBe(true);
  expect(neederMayRun(who, 'bash')).toBe(false);
});

/** A plugin that needs the gadget AND may use it, so one token reaches the same needer by two roads. */
const bothWays = (id: string) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { gadget: GadgetPort },
    uses: { again: GadgetPort },
    permissions: { network: ['api.gamma.test'] },
  });

test('per-needer: a real boot hands one needer the same built value however often it asks (needs and uses.current() twice)', async () => {
  const root = await mkdtemp(`${tmpdir()}/per-needer-`);
  const home = `${root}/home`;
  let running: RunningHost | undefined;
  try {
    const built = { count: 0 };
    let ctx: { needs: { gadget: Gadget }; uses: { again: { current(): Gadget | undefined } } } | undefined;
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    };
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters,
      implementations: [
        ...plugins(built, {}).slice(0, 1),
        implementDaemon(bothWays('gamma'), {
          build: made => {
            ctx = made as never;
            return {};
          },
        }),
      ],
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    running = outcome.host;
    // One build for the `needs` bind...
    expect(built.count).toBe(1);
    // ...and asking again through `uses` (twice) builds nothing more: the memo answers.
    const first = ctx?.uses.again.current();
    const second = ctx?.uses.again.current();
    expect(first?.for).toBe('gamma');
    expect(built.count).toBe(1);
    expect(second?.for).toBe('gamma');
  } finally {
    await running?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('per-needer: the test host keeps a fake, a uses entry and the loaded provider’s own value in separate slots', async () => {
  // Both are FACTORIES that answer a distinct object per build: a plain value is never cached, so only a factory can
  // show whether two sources share a slot (a shared slot would hand the second source the first one's object).
  const answers = (source: string) =>
    perNeeder<Gadget>(who => ({ for: `${source}:${who.id}`, network: [], spawn: [], secrets: [] }));
  const fake = answers('fake');
  const viaUses = answers('uses');
  let ctx: { needs: { gadget: Gadget }; uses: { again: { current(): Gadget | undefined } } } | undefined;
  const host = await testHost({
    plugins: [
      implementDaemon(bothWays('gamma'), {
        build: made => {
          ctx = made as never;
          return {};
        },
      }),
    ],
    fakes: { gadget: fake },
    uses: { again: viaUses },
  });
  // Same token, same needer, two roads: the first one built did not take the shared slot.
  const needed = ctx?.needs.gadget;
  const used = ctx?.uses.again.current();
  expect(needed?.for).toBe('fake:gamma');
  expect(used?.for).toBe('uses:gamma');
  expect(used).not.toBe(needed);
  // Each slot still memoises: asking again answers the object built the first time.
  expect(ctx?.uses.again.current()).toBe(used as Gadget);
  expect(ctx?.needs.gadget).toBe(needed as Gadget);
  await host.stop();
});
