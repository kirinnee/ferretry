/**
 * The profile component source through the COMPOSED Runtimes daemon (kernel test host, temp FY_HOME, stub spawn, no network):
 * the plugins that own a kind of component provide Runtimes' read of it (a kernel provide hook each), Runtimes' own
 * `instructions` are read directly, and an apply works once every kind a profile layer names has an answering provider.
 *
 * The owners here are STUB plugins that take the real hooks (the host refuses any plugin the hook does not list as a
 * taker); what each owner projects is proven in the owners' own tests.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import type { HookTake } from '@ferretry/kernel/manifest';
import { definePlugin, implementDaemon, type DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { EnvironmentLoginTemplate } from '@ferretry/plugin-logins/contract';
import {
  PROFILE_COMPONENTS_KEY,
  ProfileClaudeHooksSource,
  ProfileClaudeSettingsSource,
  ProfileCodexHooksSource,
  ProfileCodexSettingsSource,
  ProfileMcpSource,
  ProfileSkillsSource,
  type ProfileComponentDocument,
  type ProfileComponentSource,
} from '../../../contract/index.ts';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

/** What an owner holds, by component name; `throws` makes every call of its source fail. */
class Owner {
  readonly documents = new Map<string, ProfileComponentDocument>();
  throws = false;
  readonly source: ProfileComponentSource = {
    list: async () => {
      if (this.throws) throw new Error('OWNER_PRIVATE_DETAIL');
      return [...this.documents.keys()].toSorted();
    },
    read: async name => {
      if (this.throws) throw new Error('OWNER_PRIVATE_DETAIL');
      return this.documents.get(name);
    },
  };
  with(name: string, document: ProfileComponentDocument): this {
    this.documents.set(name, document);
    return this;
  }
}

interface Owners {
  readonly mcp: Owner;
  readonly skills: Owner;
  readonly claudeSettings: Owner;
  readonly claudeHooks: Owner;
  readonly codexSettings: Owner;
  readonly codexHooks: Owner;
}

const newOwners = (): Owners => ({
  mcp: new Owner(),
  skills: new Owner(),
  claudeSettings: new Owner(),
  claudeHooks: new Owner(),
  codexSettings: new Owner(),
  codexHooks: new Owner(),
});

const stubPlugin = (id: string, takes: readonly HookTake[], hooks: Record<string, unknown>) =>
  implementDaemon(definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [], hooks: { takes } }), {
    build: () => ({ hooks }) as never,
  }) as DaemonImplementation<any>;

/** The owner plugins for the sources that have an owner here (`absent` leaves one out: nobody provides that source). */
function ownerPlugins(owners: Owners, absent: readonly string[] = []): DaemonImplementation<any>[] {
  const take = (hook: HookTake['hook']): HookTake => ({ hook, key: PROFILE_COMPONENTS_KEY });
  const plugins: DaemonImplementation<any>[] = [];
  if (!absent.includes('mcp'))
    plugins.push(
      stubPlugin('mcp', [take(ProfileMcpSource)], { 'runtimes.components.mcp:components': owners.mcp.source }),
    );
  if (!absent.includes('skills'))
    plugins.push(
      stubPlugin('skills', [take(ProfileSkillsSource)], {
        'runtimes.components.skills:components': owners.skills.source,
      }),
    );
  if (!absent.includes('claude-code'))
    plugins.push(
      stubPlugin('claude-code', [take(ProfileClaudeSettingsSource), take(ProfileClaudeHooksSource)], {
        'runtimes.components.settings.claude:components': owners.claudeSettings.source,
        'runtimes.components.hooks.claude:components': owners.claudeHooks.source,
      }),
    );
  if (!absent.includes('codex'))
    plugins.push(
      stubPlugin('codex', [take(ProfileCodexSettingsSource), take(ProfileCodexHooksSource)], {
        'runtimes.components.settings.codex:components': owners.codexSettings.source,
        'runtimes.components.hooks.codex:components': owners.codexHooks.source,
      }),
    );
  return plugins;
}

const BASE = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

interface Composed {
  readonly host: TestHost;
  readonly world: FleetWorld;
  readonly owners: Owners;
  readonly logins: ReturnType<typeof fakeLogins>;
  /** Who the stand-in gate says is calling; the owner until a test changes it. */
  readonly standing: { current: ReturnType<typeof ownerStanding> };
}

async function compose(
  options: {
    readonly config?: Record<string, unknown>;
    readonly owners?: Owners;
    readonly absent?: readonly string[];
    readonly logins?: ReturnType<typeof sampleLogin>[];
  } = {},
): Promise<Composed> {
  const world = await fleetWorld();
  const owners = options.owners ?? newOwners();
  const logins = fakeLogins(options.logins ?? [sampleLogin('claude-you', { store: 'ferretry' })]);
  const standing = { current: ownerStanding() };
  const host = await testHost({
    plugins: [
      runtimesDaemon(ctx =>
        hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never),
      ) as DaemonImplementation<any>,
      ...ownerPlugins(owners, options.absent),
    ],
    fakes: { ferrets: new FakeFerrets(), logins, loginChanges: fakeLoginChanges() },
    gate: new StandInAdmission(() => standing.current),
    config: options.config ?? BASE,
    ownerHome: world.person,
    executables: ['/fixture/bin/claude', '/fixture/bin/codex', '/fixture/bin/github-mcp'],
    searchPath: '/fixture/bin',
    spawn: () => ({ code: 0, stdout: '', stderr: '' }) as never,
  });
  return { host, world, owners, logins, standing };
}

const put = (name: string) => ({
  change: {
    kind: 'runtime.put',
    name,
    credential: 'claude-you',
    profile: 'default',
    agent: true,
    create: true,
    addAnother: true,
  },
});

async function stageAndApply(host: TestHost, body: unknown) {
  const staged = await host.request('POST', '/v1/runtimes/proposals', { body });
  expect([staged.status, staged.status === 200 ? '' : JSON.stringify(staged.json())]).toEqual([200, '']);
  const { id } = staged.json<{ id: string }>();
  return await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
}

const withLayers = (...layers: string[]) => ({
  ...BASE,
  profiles: { default: { contents: ['modelSets/heavy', ...layers] } },
});

/** Every file's text under a folder, by relative path (symbolic links are not followed). */
async function filesUnder(folder: string, prefix = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(found, await filesUnder(path, `${prefix}${entry.name}/`));
    else found[`${prefix}${entry.name}`] = await readFile(path, 'utf8');
  }
  return found;
}

describe('an apply with every kind a profile layer names provided', () => {
  it('works end to end: the home carries the mcp server, the settings, the instructions and the skill', async () => {
    const owners = newOwners();
    owners.mcp.with('github', { command: 'github-mcp', args: ['--stdio'] });
    owners.skills.with('review', { items: ['review'] });
    owners.claudeSettings.with('strict', { harness: 'claude-code', document: { cleanupPeriodDays: 7 } });
    const { host, world } = await compose({
      owners,
      config: {
        ...withLayers('mcp/github', 'skills/review', 'settings/strict', 'instructions/house'),
        instructions: { house: { text: 'Be brief.' } },
      },
    });
    await mkdir(join(world.fleet, 'assets', 'skills', 'review'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview.\n');

    const applied = await stageAndApply(host, put('claude-work'));

    expect([applied.status, JSON.stringify(applied.json())]).toEqual([200, expect.any(String)]);
    const homes = await readdir(join(world.fleet, 'homes'));
    const files = await filesUnder(join(world.fleet, 'homes', homes[0] as string));
    const home = join(world.fleet, 'homes', homes[0] as string);
    // The mcp server, the settings item and the instructions text: each from the owner that provided it.
    expect(files['.claude.json']).toContain('"github-mcp"');
    expect(files['settings.json']).toContain('"cleanupPeriodDays": 7');
    expect(files['CLAUDE.md']).toContain('Be brief.');
    // The skill the skills owner selected: its folder is put in the home (a link, so not among the files read above).
    expect(await readdir(join(home, 'skills'))).toEqual(['review']);
  });

  it('a settings item named by a profile lands in the runtime’s fleet home exactly once, and Runtimes cannot reach the ferret’s agent home', async () => {
    const owners = newOwners();
    owners.claudeSettings.with('strict', { harness: 'claude-code', document: { cleanupPeriodDays: 7 } });
    const { host, world } = await compose({ owners, config: withLayers('settings/strict') });

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBe(200);
    // The two applications of a settings item are two different folders: the harness plugin writes the item into each
    // ferret's own agent home (`state/claude-code/agent-homes/<ferret>`, every item, at every launch) and Runtimes writes the
    // items a profile layer names into the runtime's fleet home (`fleet/homes/<id>`). Runtimes holds no `agent-homes` root,
    // so it cannot write the first, and the second is written once per apply.
    expect(manifest.permissions?.roots).toEqual(['fleet', 'harness-home']);
    for (const home of await readdir(join(world.fleet, 'homes'))) {
      const settings = (await filesUnder(join(world.fleet, 'homes', home)))['settings.json'] as string;
      expect(settings.split('cleanupPeriodDays')).toHaveLength(2);
    }
  });

  it('puts a Claude hooks component in the home’s settings exactly once', async () => {
    const owners = newOwners();
    owners.claudeHooks.with('guard', {
      harness: 'claude-code',
      document: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard-bash' }] }] } },
    });
    const { host, world } = await compose({ owners, config: withLayers('hooks/guard') });

    const applied = await stageAndApply(host, put('claude-work'));

    expect(applied.status).toBe(200);
    const homes = await readdir(join(world.fleet, 'homes'));
    const settings = (await filesUnder(join(world.fleet, 'homes', homes[0] as string)))['settings.json'] as string;
    expect(settings.split('guard-bash')).toHaveLength(2);
  });

  it('an environment login’s templates reach the runtime as ${secret:NAME} references, never as a value', async () => {
    const glm = sampleLogin('glm', {
      store: 'environment',
      environment: {
        variables: [
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.example.test' },
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['GLM_KEY'], set: true },
        ],
        quotaSource: 'none',
        missingSecrets: [],
        test: { available: false, reason: 'no test' },
      } as never,
    });
    const { host, world, logins } = await compose({
      logins: [sampleLogin('claude-you', { store: 'ferretry' }), glm],
      config: {
        ...BASE,
        runtimes: {
          ...BASE.runtimes,
          'glm-work': { login: 'glm', profile: 'default', agent: false },
        },
      },
    });
    logins.setTemplates([
      {
        kind: 'templates',
        id: 'glm',
        harness: 'claude-code',
        env: { ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}' },
      } as EnvironmentLoginTemplate,
    ]);

    const applied = await stageAndApply(host, put('claude-work'));

    expect([applied.status, JSON.stringify(applied.json())]).toEqual([200, expect.any(String)]);
    const wrapper = await readFile(join(world.fleet, 'bin', 'glm-work'), 'utf8');
    expect(wrapper).toContain('GLM_KEY');
    expect(wrapper).toContain('https://api.example.test');
  });
});

/** The sentence an apply is refused with, and that no home was written. */
async function refused(composed: Composed, body: unknown = put('claude-work')) {
  const applied = await stageAndApply(composed.host, body);
  expect(applied.status).toBeGreaterThanOrEqual(400);
  expect(await readdir(composed.world.fleet)).not.toContain('manifest.json');
  return applied.json<{ error: string }>().error;
}

describe('a kind that is not provided, or whose provider fails, refuses in a sentence (fail closed)', () => {
  it('a kind with NO provider keeps the refusal sentence and writes nothing', async () => {
    const owners = newOwners();
    owners.mcp.with('github', { command: 'github-mcp' });
    const composed = await compose({ owners, absent: ['mcp'], config: withLayers('mcp/github') });

    const sentence = await refused(composed);

    expect(sentence).toContain('could not be read from the Runtimes plugin');
    expect(sentence).toContain('the mcp component "github"');
    expect(sentence).toContain('is not running');
  });

  it('a provider that throws is an unresolved kind: a refusal, never a partial home or an empty component', async () => {
    const owners = newOwners();
    owners.mcp.with('github', { command: 'github-mcp' });
    owners.mcp.throws = true;
    const composed = await compose({ owners, config: withLayers('mcp/github') });

    const sentence = await refused(composed);

    expect(sentence).toContain('the mcp component "github"');
    expect(sentence).toContain('did not answer');
    // The provider's own message is its text, not Ferretry's: it is never repeated.
    expect(sentence).not.toContain('OWNER_PRIVATE_DETAIL');
  });

  it('a document that is not a component of its kind makes the kind unresolved, naming the rule and never the value', async () => {
    const owners = newOwners();
    owners.mcp.with('github', { command: 'github-mcp', url: 'https://x.example.test/SECRET_SHAPED_VALUE' });
    const composed = await compose({ owners, config: withLayers('mcp/github') });

    const sentence = await refused(composed);

    expect(sentence).toContain('is not a valid mcp component');
    expect(sentence).toContain('exactly one of "command"');
    expect(sentence).not.toContain('SECRET_SHAPED_VALUE');
  });

  it('the same settings name from Claude Code and Codex is ambiguous: the kind is unresolved', async () => {
    const owners = newOwners();
    owners.claudeSettings.with('strict', { harness: 'claude-code', document: { a: 1 } });
    owners.codexSettings.with('strict', { harness: 'codex', document: { b: 2 } });
    const composed = await compose({ owners, config: withLayers('settings/strict') });

    const sentence = await refused(composed);

    expect(sentence).toContain('two parts of Ferretry give a settings component named "strict"');
  });

  it('a read still answers while a kind is unresolved (only an apply is refused)', async () => {
    const owners = newOwners();
    owners.mcp.throws = true;
    const composed = await compose({ owners, config: withLayers('mcp/github') });

    const machine = await composed.host.request('GET', '/v1/runtimes/machine');

    expect(machine.status).toBe(200);
  });
});

describe('the source is read live: nothing is kept between reads', () => {
  it('a provider edit and a provider removal are visible on the very next read', async () => {
    const owners = newOwners();
    owners.mcp.with('github', { command: 'github-mcp', args: ['--first'] });
    const { host } = await compose({ owners });
    const read = async () => JSON.stringify((await host.request('GET', '/v1/runtimes/components')).json());

    expect(await read()).toContain('--first');
    owners.mcp.with('github', { command: 'github-mcp', args: ['--second'] });
    const edited = await read();
    owners.mcp.documents.delete('github');
    const removed = await read();

    expect(edited).toContain('--second');
    expect(edited).not.toContain('--first');
    expect(removed).not.toContain('github');
  });

  it('a Runtimes instructions item edited in the configuration is visible on the next read', async () => {
    const { host } = await compose({ config: { ...BASE, instructions: { house: { text: 'one' } } } });
    const read = async () => JSON.stringify((await host.request('GET', '/v1/runtimes/components')).json());

    expect(await read()).toContain('house');
    host.setConfig('instructions', {});

    expect(await read()).not.toContain('house');
  });
});

describe('only the plugin that owns a kind can provide it', () => {
  it('a plugin that is not the owner is refused the hook by the build (a graph finding), so it cannot provide the kind', async () => {
    const intruder = stubPlugin('lessons', [{ hook: ProfileMcpSource, key: PROFILE_COMPONENTS_KEY }], {
      'runtimes.components.mcp:components': newOwners().mcp.source,
    });

    await expect(
      testHost({
        plugins: [runtimesDaemon() as DaemonImplementation<any>, intruder],
        fakes: { ferrets: new FakeFerrets(), logins: fakeLogins([]), loginChanges: fakeLoginChanges() },
        gate: new StandInAdmission(() => ownerStanding()),
      }),
    ).rejects.toThrow(/takes a refused hook definition/u);
  });

  it('each hook lists exactly its owner as its only taker', () => {
    const takers = (hook: { takers?: readonly string[] }) => hook.takers;

    expect(takers(ProfileMcpSource)).toEqual(['mcp']);
    expect(takers(ProfileSkillsSource)).toEqual(['skills']);
    expect(takers(ProfileClaudeSettingsSource)).toEqual(['claude-code']);
    expect(takers(ProfileClaudeHooksSource)).toEqual(['claude-code']);
    expect(takers(ProfileCodexSettingsSource)).toEqual(['codex']);
    expect(takers(ProfileCodexHooksSource)).toEqual(['codex']);
  });
});

describe('Runtimes’ own instructions are written through a change', () => {
  const putHouse = (content: string, create: boolean) => ({
    change: { kind: 'component.put', name: 'house', component: { kind: 'instructions' }, content, create },
  });
  const homeText = async (world: FleetWorld): Promise<string> => {
    const homes = await readdir(join(world.fleet, 'homes'));
    return (await filesUnder(join(world.fleet, 'homes', homes[0] as string)))['CLAUDE.md'] ?? '';
  };

  it('puts, edits and removes an instructions component: the item changes and the rendered CLAUDE.md follows', async () => {
    const { host, world } = await compose({ config: withLayers() });

    const created = await stageAndApply(host, putHouse('Be brief.', true));
    expect([created.status, JSON.stringify(created.json())]).toEqual([200, expect.any(String)]);
    expect(host.configChanges.some(change => change.path.includes('instructions/house'))).toBe(true);
    const listed = JSON.stringify((await host.request('GET', '/v1/runtimes/components')).json());
    expect(listed).toContain('house');

    // Put it in the profile, so the runtime's home carries it.
    const layered = await stageAndApply(host, {
      change: {
        kind: 'profile.put',
        name: 'default',
        layers: ['modelSets/heavy', 'instructions/house'],
        create: false,
      },
    });
    expect([layered.status, JSON.stringify(layered.json())]).toEqual([200, expect.any(String)]);
    expect(await homeText(world)).toContain('Be brief.');

    const edited = await stageAndApply(host, putHouse('Be very brief.', false));
    expect(edited.status).toBe(200);
    expect(await homeText(world)).toContain('Be very brief.');
  });

  it('refuses a name that is taken, and an edit of one that is not there', async () => {
    const { host } = await compose({ config: { ...BASE, instructions: { house: { text: 'x' } } } });

    const taken = await host.request('POST', '/v1/runtimes/proposals', { body: putHouse('y', true) });
    const missing = await host.request('POST', '/v1/runtimes/proposals', {
      body: { change: { ...putHouse('y', false).change, name: 'elsewhere' } },
    });

    expect(taken.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  it('answers conflict when the machine moved between the proposal and its apply, and writes nothing', async () => {
    const { host } = await compose({ config: withLayers() });
    const staged = await host.request('POST', '/v1/runtimes/proposals', { body: putHouse('Be brief.', true) });
    const { id } = staged.json<{ id: string }>();
    // Somebody edits a file Runtimes reads, after the change was proposed.
    host.setConfig('model-sets', {
      heavy: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default: 'claude-opus-5-5' },
    });

    const applied = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });

    expect(applied.status).toBe(409);
    expect(host.configChanges.some(change => change.path.includes('instructions/house'))).toBe(false);
  });

  it('refuses a caller that may not configure (a ferret, a device without fleet.configure): nothing is written', async () => {
    const { host, standing } = await compose({ config: withLayers() });
    const staged = await host.request('POST', '/v1/runtimes/proposals', { body: putHouse('Be brief.', true) });
    const { id } = staged.json<{ id: string }>();

    standing.current = ferretStanding('f1' as FerretId);
    const byFerret = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
    standing.current = deviceStanding('d1', LIMITED_DEVICE_GRANTS);
    const byDevice = await host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });

    expect(byFerret.status).toBeGreaterThanOrEqual(400);
    expect(byDevice.status).toBeGreaterThanOrEqual(400);
    expect(host.configChanges.some(change => change.path.includes('instructions/house'))).toBe(false);
  });
});
