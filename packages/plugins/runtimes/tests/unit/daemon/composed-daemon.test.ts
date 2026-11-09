/**
 * The Runtimes daemon as it is COMPOSED (`hostAssembly`, the daemon's default) through the kernel's test host: its
 * config and Logins are the host's fakes, and the `fleet` / `harness-home` roots are the kernel's REAL fenced roots over a
 * temp folder (never a real home), so the fleet folder a change writes is a folder this test can read.
 *
 * What is under test is the composition: a catalogue read answers real data, a real apply writes `manifest.json` and the
 * runtime's home through the provisioner and its config files through `writeAll`, the S43 / S144 fences and the S67 gate
 * hold through the routes, and a seam that is unavailable still answers in a sentence.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { endedSeams, fileAssembly } from '../../../daemon/host-assembly.ts';
import { hostAssembly, type RuntimesAssembler, runtimesDaemon, unavailableAssembly } from '../../../daemon/index.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { UNAVAILABLE } from '../../../daemon/lib/service/assembly.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

/** A sign-in's bytes: a test only ever asks whether they travelled. */
const INERT = 'INERT_SIGN_IN_FIXTURE';

const CONFIG = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

interface Composed {
  readonly host: TestHost;
  readonly world: FleetWorld;
  readonly stubbed: string[];
}

/** The composed daemon over the real roots of a fleet world; `assemble` swaps the composition (the unavailable one). */
async function compose(
  options: {
    readonly assemble?: RuntimesAssembler;
    readonly config?: Record<string, unknown>;
    readonly logins?: ReturnType<typeof sampleLogin>[];
    readonly executables?: readonly string[];
  } = {},
): Promise<Composed> {
  const world = await fleetWorld();
  const stubbed: string[] = [];
  const real: RuntimesAssembler = ctx =>
    (options.assemble ?? hostAssembly)({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
  const host = await testHost({
    plugins: [runtimesDaemon(real) as DaemonImplementation<any>],
    fakes: {
      ferrets: new FakeFerrets(),
      logins: fakeLogins(options.logins ?? [sampleLogin('claude-you', { store: 'ferretry' })]),
      loginChanges: fakeLoginChanges(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: options.config ?? CONFIG,
    ownerHome: world.person,
    executables: options.executables ?? ['/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    // A stub for every spawn: nothing is ever started, and a test sees what was asked.
    spawn: (program, args) => {
      stubbed.push([program, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' } as never;
    },
  });
  return { host, world, stubbed };
}

const put = (name: string, extra: Record<string, unknown> = {}) => ({
  change: {
    kind: 'runtime.put',
    name,
    credential: 'claude-you',
    profile: 'default',
    agent: true,
    create: true,
    addAnother: true,
    ...extra,
  },
});

/** Stages a change and applies it as the owner; answers the apply's response. */
async function stageAndApply(host: TestHost, body: unknown) {
  const staged = await host.request('POST', '/v1/runtimes/proposals', { body });
  expect([staged.status, staged.status === 200 ? '' : JSON.stringify(staged.json())]).toEqual([200, '']);
  const { id } = staged.json<{ id: string }>();
  return await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
}

describe('a catalogue read through the composed daemon', () => {
  it('answers real data from the files, not the plain sentence of an unavailable assembly', async () => {
    const { host } = await compose();

    const machine = await host.request('GET', '/v1/runtimes/machine');
    const runtimes = await host.request('GET', '/v1/runtimes');
    const profiles = await host.request('GET', '/v1/runtimes/profiles');

    expect(machine.status).toBe(200);
    expect(machine.json<{ setUp: boolean; format: string }>()).toMatchObject({ setUp: true, format: 'present' });
    expect(runtimes.status).toBe(200);
    expect(JSON.stringify(runtimes.json())).toContain('claude-default');
    expect(profiles.status).toBe(200);
    expect(JSON.stringify(profiles.json())).toContain('modelSets/heavy');
  });

  it('answers in a sentence, not a stack, when the composition falls back to the unavailable assembly (fail closed)', async () => {
    const { host } = await compose({ assemble: unavailableAssembly });

    const machine = await host.request('GET', '/v1/runtimes/machine');

    expect(machine.status).toBe(409);
    expect(machine.json<{ error: string }>().error).toContain(UNAVAILABLE);
  });

  it('answers a login that is not there as the files’ own problem, in a sentence naming the rule', async () => {
    const { host } = await compose({ logins: [] });

    const machine = await host.request('GET', '/v1/runtimes/machine');

    expect(machine.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(machine.json())).toContain('uses unknown credential');
  });
});

describe('a real apply through the composed daemon', () => {
  it('R-0295 writes fleet/manifest.json and the runtime’s home through the provisioner, and its file through writeAll', async () => {
    const { host, world } = await compose();

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBe(200);
    expect(applied.json<{ outcome: string }>().outcome).toBe('applied');
    const manifest = JSON.parse(await readFile(join(world.fleet, 'manifest.json'), 'utf8')) as {
      runtimes: { name: string; wrapper: string }[];
      accounts: { home: string }[];
    };
    expect(manifest.runtimes.map(runtime => runtime.name).toSorted()).toEqual(['claude-default', 'claude-work']);
    // One harness home per runtime under fleet/homes/<id>, each a real folder the manifest names.
    expect(manifest.accounts).toHaveLength(2);
    for (const account of manifest.accounts) expect((await stat(account.home)).isDirectory()).toBe(true);
    expect((await readdir(join(world.fleet, 'homes'))).length).toBe(2);
    // The wrappers are published in bin/, and the config file landed all-or-none in the host's config.
    expect((await readdir(join(world.fleet, 'bin'))).toSorted()).toEqual(['claude-default', 'claude-work']);
    const list = await host.request('GET', '/v1/runtimes');
    expect(JSON.stringify(list.json())).toContain('claude-work');
    // A Claude home runs `fy statusline` (Runtimes' own copy of the one spelling), and the wrapper execs the located claude.
    const homeFiles = await readdir(manifest.accounts[0]?.home ?? '');
    const settings = await Promise.all(
      homeFiles
        .filter(name => name.endsWith('.json'))
        .map(async name => await readFile(join(manifest.accounts[0]?.home ?? '', name), 'utf8')),
    );
    expect(settings.join('\n')).toContain("'fy' statusline");
    expect(await readFile(join(world.fleet, 'bin', 'claude-work'), 'utf8')).toContain('/fixture/bin/claude');
  });

  it('S144 a real apply links a login’s sign-in folder and never copies or reads it: its bytes are in no home, no wrapper and no manifest', async () => {
    const { host, world } = await compose();
    await mkdir(join(world.fleet, 'credentials', 'claude-you'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'claude-you', '.credentials.json'), INERT);

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBe(200);
    const everything = async (folder: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) found.push(...(await everything(path)));
        else found.push(await readFile(path, 'utf8'));
      }
      return found;
    };
    for (const folder of ['homes', 'bin'])
      expect((await everything(join(world.fleet, folder))).join('\n')).not.toContain(INERT);
    expect(await readFile(join(world.fleet, 'manifest.json'), 'utf8')).not.toContain(INERT);
    expect(JSON.stringify(applied.json())).not.toContain(INERT);
  });

  it('answers the daemon’s DEFAULT composition with real data too (the unavailable assembly is no longer the default)', async () => {
    const host = await testHost({
      plugins: [runtimesDaemon() as DaemonImplementation<any>],
      fakes: {
        ferrets: new FakeFerrets(),
        logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
        loginChanges: fakeLoginChanges(),
      },
      gate: new StandInAdmission(() => ownerStanding()),
      config: CONFIG,
    });

    const machine = await host.request('GET', '/v1/runtimes/machine');

    expect(machine.status).toBe(200);
    expect(machine.json<{ setUp: boolean }>().setUp).toBe(true);
  });

  it('names each tool the host’s lookup found, and the command to run for one it did not', async () => {
    const found = await compose();
    const missing = await compose({ executables: [] });

    const withTools = (await found.host.request('GET', '/v1/runtimes/setup/scan')).json<{
      tools: { harness: string; installed: boolean }[];
    }>();
    const withoutTools = (await missing.host.request('GET', '/v1/runtimes/setup/scan')).json<{
      tools: { harness: string; installed: boolean }[];
    }>();

    expect(withTools.tools.map(tool => [tool.harness, tool.installed])).toEqual([
      ['claude-code', true],
      ['codex', true],
    ]);
    expect(withoutTools.tools.map(tool => [tool.harness, tool.installed])).toEqual([
      ['claude-code', false],
      ['codex', false],
    ]);
  });

  it('refuses an apply in a sentence while a part of the model stands in for a document Runtimes cannot read', async () => {
    const { host, world } = await compose({
      config: { ...CONFIG, profiles: { default: { contents: ['modelSets/heavy', 'mcp/github'] } } },
    });

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(applied.json())).toContain('could not be read from the Runtimes plugin');
    expect(JSON.stringify(applied.json())).toContain('mcp component');
    expect(JSON.stringify(applied.json())).toContain('github');
    expect(await readdir(world.fleet)).not.toContain('manifest.json');
  });

  it('refuses a change that edits a component another plugin owns, and writes nothing', async () => {
    const { host, world } = await compose();

    const staged = await host.request('POST', '/v1/runtimes/proposals', {
      body: {
        change: {
          kind: 'component.put',
          name: 'house-server',
          component: { kind: 'mcp', command: 'house-mcp' },
          create: true,
        },
      },
    });

    expect(staged.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(staged.json())).toContain('house-server');
    expect(JSON.stringify(staged.json())).toContain('another part of Ferretry owns or that Runtimes does not write');
    expect(await readdir(world.fleet)).not.toContain('manifest.json');
  });

  it('never lets an error be swallowed into success: a refused apply answers an error and leaves no manifest', async () => {
    const { host, world } = await compose();
    const staged = await host.request('POST', '/v1/runtimes/proposals', { body: put('claude-work') });
    const { id } = staged.json<{ id: string }>();
    // A plain file where the homes folder must be made: the provisioner cannot place a home, and says so.
    await writeFile(join(world.fleet, 'homes'), 'not a folder');

    const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });

    // Said as an error, or as an apply that was rolled back: never as a committed one.
    const body = applied.json<{ outcome?: string; apply?: { outcome?: string } }>();
    expect(applied.status >= 400 || (body.outcome === 'applied' && body.apply?.outcome !== 'committed')).toBe(true);
    expect(await readdir(world.fleet)).not.toContain('manifest.json');
  });
});

describe('the fences hold through the composed path', () => {
  it('S43 the first-run scan never follows a document that is a link out of the harness home, through the composed host', async () => {
    const { host, world } = await compose();
    await writeFile(join(world.person, '.codex', 'auth.json'), INERT);
    await writeFile(join(world.person, '.claude', 'CLAUDE.md'), '# rules');
    await rm(join(world.person, '.claude', 'CLAUDE.md'));
    await symlink(join(world.person, '.codex', 'auth.json'), join(world.person, '.claude', 'CLAUDE.md'));

    const scan = await host.request('GET', '/v1/runtimes/setup/scan');

    expect(scan.status).toBe(200);
    expect(JSON.stringify(scan.json())).not.toContain(INERT);
    expect(JSON.stringify(scan.json())).toContain('links');
  });

  it('S144 the first-run scan never returns or opens a sign-in file, even one named inside a skill folder, through the composed host', async () => {
    const { host, world } = await compose();
    await mkdir(join(world.person, '.claude', 'skills', 'tidy'), { recursive: true });
    await writeFile(join(world.person, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\n---\nTidy.');
    await writeFile(join(world.person, '.claude', 'skills', 'tidy', 'auth.json'), INERT);

    const scan = await host.request('GET', '/v1/runtimes/setup/scan');

    expect(scan.status).toBe(200);
    expect(JSON.stringify(scan.json())).not.toContain(INERT);
    // The skill's digest cannot have covered the sign-in file's bytes: changing them leaves the scan unchanged.
    expect(JSON.stringify(scan.json())).toContain('tidy');
    await writeFile(join(world.person, '.claude', 'skills', 'tidy', 'auth.json'), `${INERT}-changed`);
    const again = await host.request('GET', '/v1/runtimes/setup/scan');
    expect(JSON.stringify(again.json())).toBe(JSON.stringify(scan.json()));
  });

  it('S67 every apply runs its file mutation inside the one publication gate, and the published fleet is read between applies', async () => {
    const gate = new (class extends FleetPublication {
      readonly mutations: string[] = [];
      override async publishing<T>(apply: () => Promise<T>): Promise<T> {
        this.mutations.push('publishing');
        return await super.publishing(apply);
      }
      override async reading<T>(read: () => Promise<T>): Promise<T> {
        this.mutations.push('reading');
        return await super.reading(read);
      }
    })();
    const { host } = await compose({
      assemble: ctx => ({ ...fileAssembly(ctx as never, gate), ended: endedSeams(ctx.kernel, gate) }),
    });

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBe(200);
    expect(gate.mutations.filter(step => step === 'publishing').length).toBeGreaterThanOrEqual(1);
    // The republish compares against the published manifest, which is read through the gate too.
    expect(gate.mutations).toContain('reading');
  });

  it('S67 two applies at once land one at a time: one commits, the other is refused, and the manifest holds only the committed one', async () => {
    const { host, world } = await compose();
    const first = await host.request('POST', '/v1/runtimes/proposals', { body: put('claude-one') });
    const second = await host.request('POST', '/v1/runtimes/proposals', { body: put('claude-two') });
    const firstId = first.json<{ id: string }>().id;
    const secondId = second.json<{ id: string }>().id;

    const results = await Promise.all([
      host.request('POST', `/v1/runtimes/proposals/${firstId}/apply`, { body: {} }),
      host.request('POST', `/v1/runtimes/proposals/${secondId}/apply`, { body: {} }),
    ]);

    const committed = results.filter(result => result.status === 200);
    expect(committed).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(world.fleet, 'manifest.json'), 'utf8')) as {
      runtimes: { name: string }[];
    };
    expect(manifest.runtimes.map(runtime => runtime.name).filter(name => name !== 'claude-default')).toHaveLength(1);
    // No apply claim is left behind: whatever refused released it.
    expect((await readdir(world.fleet)).filter(name => name.includes('.lock'))).toEqual([]);
  });
});
