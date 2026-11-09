/**
 * A change whose fleet plan fails AFTER its configuration file landed, through the COMPOSED daemon (`hostAssembly` over
 * the kernel test host and real fenced roots, the same harness as `composed-daemon.test.ts`). The file is the source of
 * truth and is not rolled back with the plan, so the outcome must name it, and the sentence a person reads must never
 * say "Nothing changed" while a runtime file sits on disk waiting for the next apply.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { renderChangeOutcome } from '../../../cli/lib/fleet/account-render.ts';
import type { AccountChangeOutcome } from '../../../contract/index.ts';
import { hostAssembly, type RuntimesAssembler, runtimesDaemon } from '../../../daemon/index.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const CONFIG = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

/** A composed daemon whose fleet folder holds a FILE where the bin folder goes, so the provisioner fails mid-plan. */
async function composeWithBlockedBin(): Promise<TestHost> {
  const world = await fleetWorld();
  await mkdir(world.fleet, { recursive: true });
  await writeFile(join(world.fleet, 'bin'), 'not a folder');
  const real: RuntimesAssembler = ctx =>
    hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
  return await testHost({
    plugins: [runtimesDaemon(real) as DaemonImplementation<any>],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      loginChanges: fakeLoginChanges(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: CONFIG,
    ownerHome: world.person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
}

describe('a failure after the configuration landed, through the composed daemon', () => {
  it('C2 should name the landed configuration file on a rolled-back apply and never say nothing changed', async () => {
    const host = await composeWithBlockedBin();
    const staged = await host.request('POST', '/v1/runtimes/proposals', {
      body: {
        change: {
          kind: 'runtime.put',
          name: 'claude-work',
          credential: 'claude-you',
          profile: 'default',
          agent: true,
          create: true,
          addAnother: true,
        },
      },
    });
    expect(staged.status).toBe(200);

    const applied = await host.request('POST', `/v1/runtimes/proposals/${staged.json<{ id: string }>().id}/apply`, {
      body: {},
    });

    const outcome = applied.json<AccountChangeOutcome>();
    expect(applied.status).toBe(200);
    if (outcome.outcome !== 'applied') throw new Error(`expected an applied outcome, got ${outcome.outcome}`);
    // The file really is on disk (the runtime is listed) …
    expect(JSON.stringify((await host.request('GET', '/v1/runtimes')).json())).toContain('claude-work');
    // … so the outcome names it …
    expect(outcome.apply.outcome).toBe('rolled-back');
    const landed = outcome.apply.outcome === 'rolled-back' ? (outcome.apply.configurationLanded ?? []) : [];
    expect(landed.length).toBe(1);
    expect(landed[0]).toContain('claude-work.yaml');
    // … and the sentence a person reads says it stays, instead of "Nothing changed".
    const rendered = renderChangeOutcome(outcome);
    expect(rendered.ok).toBe(false);
    expect(rendered.text).not.toContain('Nothing changed');
    expect(rendered.text).toContain(landed[0] as string);
    expect(rendered.text).toContain('NOT rolled back');
  });
});
