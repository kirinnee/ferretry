/**
 * Runtimes hears that a ferret stopped and asks each harness's own plugin (its kit's `onFerretChanged`) to look after its
 * runtime; Runtimes itself names no harness. The Codex plugin's own follow-up is proved in its tests.
 */
import { describe, it } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { fakeLoginChanges, fakeLoginEnvImport, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import type { KitEndHost, RuntimesHarnessKit } from '../../../contract/index.ts';
import { runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { RuntimeEnd } from '../../../daemon/lib/service/runtime-end.ts';

const HOST = { homesDirectory: () => '/fy/fleet/homes' } as KitEndHost;

describe('RuntimeEnd', () => {
  it('should hand a ferret change, and what it stands on, to every kit that answers one', async () => {
    const calls: string[] = [];
    const ferrets = new FakeFerrets();
    const kit = (name: string): RuntimesHarnessKit => ({
      onFerretChanged: async (input, change) => {
        calls.push(`${name} ${change.ferret} ${String(input.host === HOST)} ${String(input.ferrets === ferrets)}`);
      },
    });
    const end = new RuntimeEnd({
      ferrets,
      host: HOST,
      kits: () =>
        new Map<string, RuntimesHarnessKit>([
          ['claude', kit('claude')],
          ['codex', kit('codex')],
        ]),
      launchFailed: () => undefined,
    });

    await end.onChanged({ ferret: 'f1', state: 'stopped' });

    should(calls).deepEqual(['claude f1 true true', 'codex f1 true true']);
  });

  it('should pass over a harness whose plugin is off or whose kit follows nothing', async () => {
    const calls: string[] = [];
    const end = new RuntimeEnd({
      ferrets: new FakeFerrets(),
      host: undefined,
      kits: () => new Map<string, RuntimesHarnessKit>([['claude', {}]]),
      launchFailed: () => calls.push('told'),
    });
    const none = new RuntimeEnd({
      ferrets: new FakeFerrets(),
      host: undefined,
      kits: () => new Map(),
      launchFailed: () => calls.push('told'),
    });

    await end.onChanged({ ferret: 'f1', state: 'stopped' });
    await none.onChanged({ ferret: 'f1', state: 'stopped' });

    should(calls).deepEqual([]);
  });
});

describe('the Runtimes daemon, booted with Ferrets and no other plugin', () => {
  it('should keep listening and change nothing while the host offers no follow-up seams', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('c1'), harness: 'codex', runtime: 'codex-work', state: 'stopped' });
    const host = await testHost({
      plugins: [runtimesDaemon(unavailableAssembly) as DaemonImplementation<any>],
      fakes: {
        ferrets,
        logins: fakeLogins([]),
        loginChanges: fakeLoginChanges(),
        loginEnvImport: fakeLoginEnvImport(),
        vault: new FakeVault(),
      },
      gate: new StandInAdmission(() => ownerStanding()),
      config: { runtimes: {}, profiles: {} },
    });
    const before = host.published.length;

    host.emit(FerretsChanged, { ferret: 'c1', generation: 1, state: 'stopped' });
    await host.settle();

    should(host.published.length).equal(before);
  });
});
