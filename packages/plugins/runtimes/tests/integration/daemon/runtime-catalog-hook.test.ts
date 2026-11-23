/**
 * `runtime.start`'s `catalog?` through the COMPOSED Runtimes daemon, asked the way Ferrets asks it (the kernel's
 * `hooks.provider(RuntimeStart, 'runtimes')`): the answer is the published view's models as the one
 * `RuntimeModelCatalog`, by runtime name or id, read-only and values-free. Real roots over a temp fleet folder.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { RuntimeModelCatalogSchema, RuntimeStart, type RuntimeStartSource } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type DaemonImplementation, definePlugin, type HookInvoker, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
  sampleLogin,
} from '@ferretry/plugin-logins/contract/testing';
import type { RuntimeView } from '../../../contract/wire/index.ts';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import { runtimeModelCatalog } from '../../../daemon/lib/runtime-model-catalog.ts';
import { cleanupWorlds, fleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const CONFIG = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default' } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default: 'claude-opus-5-5' } },
};

async function world() {
  let hooks: HookInvoker | undefined;
  const asker = implementDaemon(
    definePlugin({
      id: 'start-asker',
      title: 'Start asker',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { offers: [{ hook: RuntimeStart }] },
    }),
    {
      build: ctx => {
        hooks = ctx.hooks;
        return {};
      },
    },
  );
  const fleet = await fleetWorld();
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx =>
        hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: fleet.roots } } as never),
      ) as DaemonImplementation<any>,
      asker as DaemonImplementation<any>,
    ],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: CONFIG,
    ownerHome: fleet.person,
  });
  const source = hooks?.provider(RuntimeStart, 'runtimes') as RuntimeStartSource | 'unavailable' | undefined;
  if (source === undefined || source === 'unavailable') throw new Error('Runtimes provides no runtime.start');
  return { host, source };
}

describe('runtime.start catalog? through the composed daemon', () => {
  it('answers the published runtime’s models as the one RuntimeModelCatalog, by name and by id, the same as the mapper', async () => {
    const { host, source } = await world();
    try {
      const listed = (await host.request('GET', '/v1/runtimes')).json<{ runtimes: RuntimeView[] }>().runtimes;
      const view = listed.find(entry => entry.name === 'claude-default') as RuntimeView;

      const byName = await source.catalog?.('claude-default');
      const byId = await source.catalog?.(view.id);

      expect(byName).toEqual(runtimeModelCatalog(view));
      expect(byId).toEqual(byName);
      expect(RuntimeModelCatalogSchema.safeParse(byName).success).toBe(true);
      expect(byName?.harness).toBe('claude');
      // Its model set's two models, the set's default marked, each with a window.
      expect(byName?.choices.map(choice => [choice.value, choice.isDefault === true])).toEqual([
        ['claude-opus-5-5', true],
        ['claude-sonnet-5-5', false],
      ]);
      expect(byName?.choices.every(choice => typeof choice.context === 'number')).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it('says nothing for a runtime that is not published', async () => {
    const { host, source } = await world();
    try {
      expect(await source.catalog?.('ghost')).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

  it('is values-free: no credential, profile or wrapper of the runtime appears in the answer', async () => {
    const { host, source } = await world();
    try {
      const text = JSON.stringify(await source.catalog?.('claude-default'));

      // The login's id, the profile's name and the fleet folder are the runtime's, and none is a model fact.
      for (const leak of ['claude-you', '"default"', 'bin/', 'homes/', 'fleet']) expect(text).not.toContain(leak);
    } finally {
      await host.stop();
    }
  });
});
