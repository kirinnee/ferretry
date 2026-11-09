/**
 * `runtime.remove` through the COMPOSED daemon (`hostAssembly` over the kernel test host and real fenced roots, the same
 * harness as `composed-daemon.test.ts`). A removal is judged by the file it removes: the owner's is admitted and the
 * runtime is gone, and one an agent asks for is not applied. Before the fix a removal threw in `runtimeFileLoosens`
 * (`after` undefined) and every caller, the owner included, was held as "could not be judged".
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { hostAssembly, type RuntimesAssembler, runtimesDaemon } from '../../../daemon/index.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const CONFIG = {
  runtimes: {
    'claude-default': { login: 'claude-you', profile: 'default', agent: true },
    'claude-extra': { login: 'claude-you', profile: 'default', agent: true },
  },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

async function compose(standing: () => ReturnType<typeof ownerStanding>): Promise<TestHost> {
  const world = await fleetWorld();
  const real: RuntimesAssembler = ctx =>
    hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
  return await testHost({
    plugins: [runtimesDaemon(real) as DaemonImplementation<any>],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      loginChanges: fakeLoginChanges(),
    },
    gate: new StandInAdmission(standing),
    config: CONFIG,
    ownerHome: world.person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
}

const remove = { change: { kind: 'runtime.remove', name: 'claude-extra' } };

async function names(host: TestHost): Promise<string> {
  return JSON.stringify((await host.request('GET', '/v1/runtimes')).json());
}

describe('runtime.remove through the composed daemon', () => {
  it('the owner’s removal is admitted: applied, and the runtime is no longer listed', async () => {
    const host = await compose(() => ownerStanding());
    expect(await names(host)).toContain('claude-extra');

    const staged = await host.request('POST', '/v1/runtimes/proposals', { body: remove });
    expect([staged.status, staged.status === 200 ? '' : JSON.stringify(staged.json())]).toEqual([200, '']);
    const applied = await host.request('POST', `/v1/runtimes/proposals/${staged.json<{ id: string }>().id}/apply`, {
      body: {},
    });

    expect([applied.status, JSON.stringify(applied.json())]).toEqual([200, expect.stringContaining('applied')]);
    expect(JSON.stringify(applied.json())).not.toContain('could not be judged');
    const after = await names(host);
    expect(after).not.toContain('claude-extra');
    expect(after).toContain('claude-default');
  });

  it('an agent’s removal is not applied, and the runtime stays', async () => {
    const host = await compose(() => ferretStanding('f1' as never));

    const staged = await host.request('POST', '/v1/runtimes/proposals', { body: remove });
    const applied =
      staged.status === 200
        ? await host.request('POST', `/v1/runtimes/proposals/${staged.json<{ id: string }>().id}/apply`, { body: {} })
        : staged;

    expect(applied.status).toBeGreaterThanOrEqual(400);
    expect(await names(host)).toContain('claude-extra');
  });
});
