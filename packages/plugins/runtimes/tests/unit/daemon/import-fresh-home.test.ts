/**
 * The setup import on a FRESH home, twice in a row, through the composed daemon over the kernel's real roots:
 * the first proposal answers 200 although no `assets/` folder exists yet (H1), and after Claude is applied the next scan
 * and a Codex import still answer 200, because the apply left a model whose profile names components that exist (H2).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLoginEnvImport, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import { hostAssembly, type RuntimesAssembler, runtimesDaemon } from '../../../daemon/index.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

async function fresh(): Promise<{ host: TestHost; world: FleetWorld }> {
  const world = await fleetWorld();
  const person = world.person;
  await writeFile(join(person, '.claude', 'CLAUDE.md'), 'Be kind to Claude.\n');
  await writeFile(join(person, '.claude', 'settings.json'), '{"model":"claude-opus-5-5","theme":"dark"}');
  await mkdir(join(person, '.claude', 'skills', 'review'), { recursive: true });
  await writeFile(join(person, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview.\n');
  await writeFile(
    join(person, '.claude.json'),
    JSON.stringify({ mcpServers: { notes: { command: 'notes-server', args: ['--stdio'] } } }),
  );
  await writeFile(join(person, '.codex', 'AGENTS.md'), 'Be brisk with Codex.\n');
  await writeFile(join(person, '.codex', 'config.toml'), 'model = "gpt-6.1-sol"\n');
  const real: RuntimesAssembler = ctx =>
    hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
  const host = await testHost({
    plugins: [runtimesDaemon(real) as DaemonImplementation<any>],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins([]),
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    // The owner at the machine confirms what an import loosens, as Gate's judge does for the host's admin token.
    gate: Object.assign(new StandInAdmission(() => ownerStanding()), { judgeConfigWrite: () => 'apply' as const }),
    config: {},
    ownerHome: person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  return { host, world };
}

async function importTool(host: TestHost, tool: 'claude-code' | 'codex'): Promise<void> {
  const staged = await host.request('POST', '/v1/runtimes/proposals', {
    body: { change: { kind: 'setup.import', include: [tool] } },
  });
  expect([staged.status, staged.status === 200 ? '' : JSON.stringify(staged.json())]).toEqual([200, '']);
  const { id } = staged.json<{ id: string }>();
  const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
  expect([applied.status, applied.status === 200 ? '' : JSON.stringify(applied.json())]).toEqual([200, '']);
}

describe('the setup import on a fresh home', () => {
  it('proposes with no assets folder yet (H1)', async () => {
    const { host, world } = await fresh();
    await Bun.$`test ! -e ${join(world.fleet, 'assets')}`;

    const staged = await host.request('POST', '/v1/runtimes/proposals', {
      body: { change: { kind: 'setup.import', include: ['claude-code'] } },
    });

    expect([staged.status, staged.status === 200 ? '' : JSON.stringify(staged.json())]).toEqual([200, '']);
  });

  it('scans and imports the second tool after the first was applied, and the model still assembles (H2)', async () => {
    const { host } = await fresh();

    await importTool(host, 'claude-code');
    const scan = await host.request('GET', '/v1/runtimes/setup/scan');
    expect([scan.status, scan.status === 200 ? '' : JSON.stringify(scan.json())]).toEqual([200, '']);
    await importTool(host, 'codex');

    const reloaded = await host.request('GET', '/v1/runtimes/profiles');
    expect([reloaded.status, reloaded.status === 200 ? '' : JSON.stringify(reloaded.json())]).toEqual([200, '']);
    const rescanned = await host.request('GET', '/v1/runtimes/setup/scan');
    expect(rescanned.status).toBe(200);
    // The instructions live in the item Runtimes owns, so the profile that names them reads them back.
    expect(JSON.stringify(reloaded.json())).toContain('instructions/main');
  });
});
