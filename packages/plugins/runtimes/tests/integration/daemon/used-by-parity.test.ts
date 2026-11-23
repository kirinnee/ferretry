/**
 * "Used by" is what `fy runtime ls` shows, through the COMPOSED Runtimes daemon: a ready login with the CLI installed and
 * no runtime file has a derived runtime, and the hook Logins asks (`logins.used-by`, `listed`) names it on a daemon that
 * has not read the catalogue yet (an unprimed command cache), exactly as the catalogue route lists it. Real roots over a
 * temp fleet folder; the CLI is a fixture path the test host finds.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type DaemonImplementation, definePlugin, type HookInvoker, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { LoginsUsedBy, type LoginUsers } from '@ferretry/plugin-logins/contract';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
  sampleLogin,
} from '@ferretry/plugin-logins/contract/testing';
import type { RuntimeView } from '../../../contract/wire/index.ts';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import { cleanupWorlds, fleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

async function world(executables: readonly string[]) {
  let hooks: HookInvoker | undefined;
  // Logins offers `logins.used-by`; this stands where Logins stands and asks it as Logins does.
  const asker = implementDaemon(
    definePlugin({
      id: 'logins',
      title: 'Logins',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { offers: [{ hook: LoginsUsedBy }] },
    }),
    {
      build: ctx => {
        hooks = ctx.hooks;
        return {};
      },
    },
  );
  const fleet = await fleetWorld();
  const logins = [sampleLogin('claude-you', { store: 'ferretry' })];
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx =>
        hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: fleet.roots } } as never),
      ) as DaemonImplementation<any>,
      asker as DaemonImplementation<any>,
    ],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins(logins),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    // No runtime file: the only runtime is the one derived from the ready login.
    config: { runtimes: {}, profiles: {}, 'model-sets': {} },
    ownerHome: fleet.person,
    executables,
    searchPath: '/fixture/bin',
  });
  const users = hooks?.provider(LoginsUsedBy, 'runtimes') as LoginUsers | 'unavailable' | undefined;
  if (users === undefined || users === 'unavailable' || users.listed === undefined)
    throw new Error('Runtimes lists no runtimes for Logins');
  return { host, logins, listed: users.listed };
}

describe('Logins’ "Used by" and `runtime ls` agree through the composed daemon', () => {
  it('names the derived runtime of a ready login whose CLI is installed, before any catalogue read, as the route lists it', async () => {
    const { host, logins, listed } = await world(['/fixture/bin/claude']);
    try {
      // Asked FIRST: nothing has primed the command lookups on this daemon yet.
      const shown = await listed(logins);

      const onRoute = (await host.request('GET', '/v1/runtimes')).json<{ runtimes: RuntimeView[] }>().runtimes;
      const routeNames = onRoute.filter(runtime => runtime.credential.id === 'claude-you').map(runtime => runtime.name);
      expect(routeNames).toEqual(['claude-you']);
      expect(shown).toEqual({ 'claude-you': routeNames });
    } finally {
      await host.stop();
    }
  });

  it('names none when the CLI is not installed, as the route lists none', async () => {
    const { host, logins, listed } = await world([]);
    try {
      const shown = await listed(logins);

      const onRoute = (await host.request('GET', '/v1/runtimes')).json<{ runtimes: RuntimeView[] }>().runtimes;
      expect(onRoute.filter(runtime => runtime.credential.id === 'claude-you')).toEqual([]);
      expect(shown).toEqual({ 'claude-you': [] });
    } finally {
      await host.stop();
    }
  });
});
