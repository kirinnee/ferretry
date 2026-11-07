/**
 * `runtimesDaemon().build()` and the `runtimes` port it provides, through the kernel's test host (§7.8).
 *
 * The config is the test host's (`config/runtimes/*.yaml` and friends, parsed with the declared schemas); Ferrets is the
 * contract's fake; Logins is a stub of the one shape Runtimes reads (GAP(logins)); the catalogue and setup services are
 * stubs, because what is under test is the assembly: that every route key has a handler, that the port answers over the
 * files, and that a change to the files wakes the views.
 */
import { describe, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import {
  type CatalogInstallChange,
  RuntimeIdSchema,
  RuntimesChanged,
  RuntimesDefaultChanged,
  RuntimesPort,
} from '../../../contract/index.ts';
import { runtimesConformance } from '../../../contract/testing/index.ts';
import { type RuntimesAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import { UNAVAILABLE } from '../../../daemon/lib/service/assembly.ts';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import manifest from '../../../manifest.ts';

const login = sampleLogin;

const FILES = {
  runtimes: {
    'claude-default': { login: 'claude-you', profile: 'default', agent: true },
    'codex-work': { login: 'codex-work', profile: 'default' },
  },
  profiles: { default: { contents: [] } },
};

interface Built {
  readonly host: TestHost;
  readonly ferrets: FakeFerrets;
  readonly installs: CatalogInstallChange[];
}

async function build(
  options: {
    readonly config?: Record<string, unknown>;
    readonly logins?: readonly LoginView[];
    readonly assembled?: boolean;
  } = {},
): Promise<Built> {
  const ferrets = new FakeFerrets();
  const installs: CatalogInstallChange[] = [];
  const logins = options.logins ?? [login('claude-you'), login('codex-work', { harness: 'codex' })];
  const assembly = (): RuntimesAssembly => ({
    catalog: {
      installCatalogItem: async (change: CatalogInstallChange) => {
        installs.push(change);
        return {
          outcome: {
            outcome: 'applied',
            apply: {
              outcome: 'committed',
              result: {
                accountCount: 0,
                operationCount: 0,
                manifestPath: '/fy',
                prunedWrappers: [],
                sharedHistory: [],
              },
            },
          },
        };
      },
    } as unknown as RuntimesAssembly['catalog'],
    setup: {} as RuntimesAssembly['setup'],
  });
  const daemon = (
    options.assembled === false ? runtimesDaemon() : runtimesDaemon(assembly)
  ) as DaemonImplementation<any>;
  const host = await testHost({
    plugins: [daemon],
    fakes: { ferrets, logins: fakeLogins(logins), loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => ownerStanding()),
    config: options.config ?? FILES,
  });
  return { host, ferrets, installs };
}

describe('the runtimes daemon', () => {
  it('should answer a handler for every route the manifest declares', async () => {
    // Arrange
    const { host } = await build();
    const missing: string[] = [];

    // Act — a handler that exists answers something other than 404 (a refusal or a 200), never "no such route".
    for (const route of manifest.actions.routes) {
      const [method, path] = route.key.split(' ') as [string, string];
      const concrete = path.replace(':proposalId', 'fy_fprop_abcdefghijklmnopqrstuv').replace(':id', 'f-1');
      const response = await host.request(method, concrete, method === 'POST' ? { body: {} } : {});
      if (response.status === 404 && response.json<{ code?: string }>().code !== 'fleet_change_unknown')
        missing.push(route.key);
    }

    // Assert
    should(manifest.actions.routes).have.length(16);
    should(missing).deepEqual([]);
  });

  it('should answer a read in a sentence, not a stack, while the host seams are not wired', async () => {
    // Arrange
    const { host } = await build({ assembled: false });

    // Act
    const machine = await host.request('GET', '/v1/runtimes/machine');

    // Assert
    should(machine.status).equal(409);
    should(machine.json<{ error: string }>().error).containEql(UNAVAILABLE);
  });

  it('should provide a runtimes port that passes the conformance suite', async () => {
    // Arrange
    const { host } = await build();

    // Act
    const result = await runtimesConformance(() => host.provided(RuntimesPort));

    // Assert
    should(result.ok).be.true();
  });

  it('should list the runtimes in name order, each on the harness its login drives', async () => {
    // Arrange
    const { host } = await build();

    // Act
    const list = await host.provided(RuntimesPort).list();

    // Assert
    should(list.map(runtime => [runtime.id, runtime.harness, runtime.agent, runtime.launch.available])).deepEqual([
      ['claude-default', 'claude-code', true, true],
      ['codex-work', 'codex', false, true],
    ]);
  });

  it('should resolve the default setting, else claude-default when it is an agent runtime here', async () => {
    // Arrange
    const unset = await build();
    const named = await build({ config: { ...FILES, 'runtimes.yaml': { defaultRuntime: 'codex-work' } } });
    const noAgent = await build({
      config: { ...FILES, runtimes: { 'claude-default': { login: 'claude-you', profile: 'default' } } },
    });

    // Act / Assert
    should(await unset.host.provided(RuntimesPort).default()).equal('claude-default');
    should(await named.host.provided(RuntimesPort).default()).equal('codex-work');
    should(await noAgent.host.provided(RuntimesPort).default()).be.undefined();
  });

  it('should refuse a start in a sentence for each reason it cannot happen', async () => {
    // Arrange
    const { host } = await build({
      config: {
        runtimes: {
          'claude-default': { login: 'claude-you', profile: 'default', agent: true },
          off: { login: 'claude-you', profile: 'default', disabled: { reason: 'quota' } },
          orphan: { login: 'nobody', profile: 'default', harness: 'codex' },
          headless: { login: 'claude-you', profile: 'ghost' },
        },
        profiles: FILES.profiles,
      },
    });
    const port = host.provided(RuntimesPort);
    const refusal = async (name: string) => {
      const result = await port.resolve(RuntimeIdSchema.parse(name));
      return result.ok ? 'ok' : result.refusal;
    };

    // Act / Assert
    should(await refusal('claude-default')).equal('ok');
    should(await refusal('off')).equal('disabled');
    should(await refusal('orphan')).equal('no_login');
    should(await refusal('headless')).equal('no_profile');
    should(await refusal('missing')).equal('unknown');
    should(await port.resolve()).match({ ok: true });
  });

  it('should not offer a runtime whose login needs sign-in, or whose harness is not on the machine', async () => {
    // Arrange
    const { host } = await build({
      logins: [
        login('claude-you', { status: { ...sampleLogin('claude-you').status, word: 'needs_sign_in' } }),
        login('codex-work', { harness: 'codex' }),
      ],
    });

    // Act
    const list = await host.provided(RuntimesPort).list();
    const blocked = await host.provided(RuntimesPort).resolve(RuntimeIdSchema.parse('claude-default'));

    // Assert
    should(list[0]?.launch).match({ available: false, reason: 'Login claude-you needs sign-in' });
    should(blocked).match({ ok: false, refusal: 'not_signed_in' });
    should(list[1]?.launch.available).be.true();
  });

  it('should expire a block that has an end, with no edit', async () => {
    // Arrange
    const { host } = await build({
      config: {
        ...FILES,
        runtimes: {
          'claude-default': {
            login: 'claude-you',
            profile: 'default',
            disabled: { until: '2000-01-01T00:00:00.000Z' },
          },
        },
      },
    });

    // Act
    const [runtime] = await host.provided(RuntimesPort).list();

    // Assert
    should(runtime?.disabled).be.undefined();
    should(runtime?.launch.available).be.true();
  });

  it('should wake the views once, naming what moved, when a runtime file changes', async () => {
    // Arrange
    const { host } = await build();
    const before = host.published.length;

    // Act
    host.setConfig('runtimes', { ...FILES.runtimes, extra: { login: 'claude-you', profile: 'default' } });
    host.setConfig('runtimes', { ...FILES.runtimes, extra: { login: 'claude-you', profile: 'default' } });

    // Assert — the second write changed nothing, so it says nothing.
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesChanged.name, payload: { runtimes: ['extra'], profiles: [], modelSets: [] } },
    ]);
  });

  it('should wake the views when the default moves, naming the resolved one', async () => {
    // Arrange
    const { host } = await build();
    const before = host.published.length;

    // Act
    host.setConfig('runtimes.yaml', { defaultRuntime: 'codex-work' });
    await host.settle();
    await Promise.resolve();

    // Assert
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesDefaultChanged.name, payload: { defaultRuntime: 'codex-work' } },
    ]);
  });

  it('should publish the profile an installed catalog item landed in', async () => {
    // Arrange
    const { host, installs } = await build();
    const before = host.published.length;
    const change = { kind: 'catalog.install', profile: 'work' } as unknown as CatalogInstallChange;

    // Act
    const outcome = await host.provided(RuntimesPort).installCatalogItem(change);

    // Assert
    should(outcome.outcome).equal('committed');
    should(installs).deepEqual([change]);
    should(host.published.slice(before)).deepEqual([
      { event: RuntimesChanged.name, payload: { runtimes: [], profiles: ['work'], modelSets: [] } },
    ]);
  });
});
