/**
 * The first run and Clone over real files, end to end: the host scan, the import, the real
 * provisioner's apply, the catalogue reading back what was written, then the export of that machine
 * copied onto a second one.
 *
 * Every path is inside a directory this test created, the person's "own" home is a temporary one, and
 * every credential is a placeholder, so no real harness setup, login or fleet is read or written.
 */
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FleetCloneBundleSchema } from '@ferretry/protocol';
import { resolveDefaultRuntime } from '@ferretry/fleet';
import should from 'should';
import { fileFleetCatalogDeps, readDeclaredAccountModel } from '../../../src/adapters/fleet/account-model-files.ts';
import { fileFleetSetupDeps } from '../../../src/adapters/fleet/setup-files.ts';
import { resolveWardenLogin } from '../../../src/lib/warden/config.ts';
import { FleetCatalogService } from '../../../src/lib/fleet/catalog-service.ts';
import { createFleetSetupSubsystem, type FleetSetupService } from '../../../src/lib/fleet/setup-service.ts';
import { type ConfigHome, configHome } from './config-files-fixture.ts';

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-setup-journey-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

/** A placeholder Claude login: shaped like one, worth nothing. */
const FAKE_LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'placeholder-access',
    refreshToken: 'placeholder-refresh',
    expiresAt: 4_102_444_800_000,
  },
});
const FAKE_SECRET = 'ghp_placeholderplaceholderplaceholder0000';

interface Machine {
  readonly home: ConfigHome;
  readonly fleet: string;
  readonly userHome: string;
  readonly setup: FleetSetupService;
  readonly catalog: FleetCatalogService;
  readonly secrets: Map<string, string>;
}

async function machine(name: string, options: { readonly claude: boolean }): Promise<Machine> {
  const root = await temporary();
  const home = await configHome(path.join(root, 'state'));
  const fleet = home.paths.fleet;
  const userHome = path.join(root, 'person');
  await mkdir(userHome, { recursive: true });
  if (options.claude) {
    const claude = path.join(userHome, '.claude');
    await mkdir(path.join(claude, 'skills', 'review'), { recursive: true });
    await writeFile(path.join(claude, 'CLAUDE.md'), 'Be kind.\n');
    await writeFile(path.join(claude, 'settings.json'), JSON.stringify({ env: { GITHUB_TOKEN: FAKE_SECRET } }));
    await writeFile(path.join(claude, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview it.\n');
    await writeFile(path.join(claude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
  }
  const secrets = new Map<string, string>();
  const credentials = {
    list: async () => ({ format: 2 as const, machine: name, credentials: [] }),
    signOut: async () => {
      throw new Error('not exercised');
    },
  };
  const catalogDeps = fileFleetCatalogDeps({
    paths: home.paths,
    userHome,
    config: home.service,
    configDirectory: home.paths.config,
    sessionStatuses: async () => [],
    credentials,
    locate: harness => (harness === 'claude' && options.claude ? '/bin/sh' : undefined),
    machineName: () => name,
    clientName: 'fy',
  });
  const setup = createFleetSetupSubsystem(
    fileFleetSetupDeps({
      catalog: catalogDeps,
      credentials: {
        material: async () => ({ outcome: 'missing' }),
        storedMaterial: async () => (options.claude ? { outcome: 'found', blob: FAKE_LOGIN } : { outcome: 'missing' }),
      } as never,
      tools: { plans: () => [], install: async () => [] },
      secrets: {
        list: async () => [...secrets.keys()].map(secret => ({ name: secret })),
        put: async (secret, value) => {
          secrets.set(secret, value);
        },
      },
    }),
  );
  const catalog = new FleetCatalogService({ ...catalogDeps, executors: setup.executors });
  return { home, fleet, userHome, setup, catalog, secrets };
}

/** The import a person chooses, staged and applied through the catalogue the way the app and `fy daemon import` do it. */
async function importHost(on: Awaited<ReturnType<typeof machine>>): Promise<unknown> {
  const staged = await on.catalog.propose({ kind: 'setup.import' });
  return await on.catalog.apply(staged.id, { governed: false } as never);
}

/** The model the machine's configuration files declare now. */
async function declared(on: Machine) {
  const model = await readDeclaredAccountModel(on.home.service, {
    configDirectory: on.home.paths.config,
    fleetDirectory: on.fleet,
  });
  should(model).not.be.undefined();
  return model as NonNullable<typeof model>;
}

/** Every file under a directory, relative to it. */
async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, next)));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

describe('the first run and Clone over real files', () => {
  it('should import the host setup when asked, sharing the login in place and copying no credential', async () => {
    // Arrange
    const studio = await machine('studio', { claude: true });

    // Act
    const result = await importHost(studio);

    // Assert: a version-2 configuration whose login is the host's own, and a runtime that launches as an agent.
    should(result).deepEqual({
      outcome: 'executed',
      executor: 'setup',
      summary: 'studio is ready · 1 runtime created: claude-default.',
    });
    const model = await declared(studio);
    should(model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host' });
    should(model.runtimes['claude-default']).deepEqual({
      credential: 'claude-you',
      profile: 'claude-default',
      agent: true,
    });
    should(await lstat(path.join(studio.fleet, 'bin', 'claude-default'))).be.ok();
    should(await lstat(path.join(studio.fleet, 'assets', 'skills', 'review', 'SKILL.md'))).be.ok();

    // The secret went to the store and nowhere else; no credential file was copied into the fleet.
    should(studio.secrets.get('GITHUB_TOKEN')).equal(FAKE_SECRET);
    for (const root of [studio.fleet, studio.home.paths.config]) {
      for (const file of await filesUnder(root)) {
        should(path.basename(file)).not.equal('.credentials.json');
        should(await readFile(path.join(root, file), 'utf8')).not.containEql(FAKE_SECRET);
      }
    }
    // Every fact lives in its own file under config/, and nothing in the retired single file.
    should(await filesUnder(studio.home.paths.config)).containEql('logins/claude-you.yaml');
    should(await filesUnder(studio.fleet)).not.containEql('config.yaml');
    should(studio.home.logged.pending).deepEqual([]);

    // The catalogue reads back exactly what the import wrote.
    const runtimes = await studio.catalog.runtimes();
    should(runtimes.runtimes.map(runtime => runtime.name)).deepEqual(['claude-default']);
  });

  it('should make the first runtime created on a bare machine its default runtime', async () => {
    // Arrange: a machine with one login and one profile and no runtime.
    const bare = await machine('bare', { claude: false });
    const login = await bare.catalog.propose({ kind: 'credential.add', id: 'work', harness: 'claude' });
    await bare.catalog.apply(login.id, { governed: false } as never);
    const component = await bare.catalog.propose({
      kind: 'component.put',
      name: 'house',
      component: { kind: 'instructions' },
      content: 'Be kind.\n',
      create: true,
    } as never);
    await bare.catalog.apply(component.id, { governed: false } as never);
    const profile = await bare.catalog.propose({
      kind: 'profile.put',
      name: 'plain',
      layers: ['instructions/house'],
      create: true,
    });
    await bare.catalog.apply(profile.id, { governed: false } as never);

    // Act: the runtime goes through the same propose/apply route the app uses.
    const staged = await bare.catalog.propose({
      kind: 'runtime.put',
      name: 'first',
      credential: 'work',
      profile: 'plain',
      agent: true,
      create: true,
    });
    await bare.catalog.apply(staged.id, { governed: false } as never);

    // Assert: it is the default, so the Warden's login resolves to it instead of "not set".
    const model = await declared(bare);
    should(model.machine.defaultRuntime).equal('first');
    should(resolveWardenLogin({ accounts: [] } as never, ['first'], resolveDefaultRuntime(model))).match({
      usable: true,
      login: { source: 'machine_default', available: ['first'] },
    });
  });

  it('should copy one machine onto another as a reviewed change, each login an empty slot', async () => {
    // Arrange: a set-up source and a bare target.
    const studio = await machine('studio', { claude: true });
    await importHost(studio);
    const bundle = FleetCloneBundleSchema.parse(await studio.setup.exportBundle());
    const target = await machine('work-linux', { claude: false });

    // Act: staged and applied through the catalogue, as the browser does it.
    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    const outcome = await target.catalog.apply(staged.id, { governed: false } as never);

    // Assert
    should(staged.preview).match({ kind: 'executor', executor: 'clone' });
    should(outcome).deepEqual({
      outcome: 'executed',
      executor: 'clone',
      summary: 'Copied 1 runtime from studio. Sign in once for 1 runtime: claude-you.',
    });
    const model = await declared(target);
    should(model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'ferretry', clonedFrom: 'studio' });
    should(Object.keys(model.runtimes)).deepEqual(['claude-default']);
    should(await readFile(path.join(target.fleet, 'assets', 'skills', 'review', 'SKILL.md'), 'utf8')).containEql(
      'Review it.',
    );
    // History is not copied, and neither is any login.
    should(await filesUnder(path.join(target.fleet))).not.containEql('credentials/claude-you/.credentials.json');
  });
});

/** A machine that already has a setup of its own, whose default runtime the source does not have. */
async function targetWithOwnDefault(name: string): Promise<Machine> {
  const target = await machine(name, { claude: false });
  const steps = [
    { kind: 'credential.add', id: 'work', harness: 'claude' },
    { kind: 'component.put', name: 'house', component: { kind: 'instructions' }, content: 'Be kind.\n', create: true },
    { kind: 'profile.put', name: 'plain', layers: ['instructions/house'], create: true },
    { kind: 'runtime.put', name: 'claude-kirin', credential: 'work', profile: 'plain', agent: true, create: true },
  ];
  for (const step of steps) {
    const staged = await target.catalog.propose(step as never);
    await target.catalog.apply(staged.id, { governed: false } as never);
  }
  should((await declared(target)).machine.defaultRuntime).equal('claude-kirin');
  return target;
}

describe('Clone and the default runtime for new agents over real files', () => {
  it('should replace a setup whose own default is removed by taking the copy default, not refuse', async () => {
    // Arrange
    const source = await machine('ip-172-27-76-90', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await targetWithOwnDefault('AMER-D22HXVF42W');

    // Act
    const staged = await target.catalog.propose({
      kind: 'clone.import',
      mode: 'replace',
      bundle,
      names: { source: 'Liftoff EC2', target: 'Liftoff MBP' },
    });
    const outcome = await target.catalog.apply(staged.id, { governed: false } as never);

    // Assert: the copy is applied, the target can read it, and the default is one of the copied runtimes.
    should(outcome).match({ outcome: 'executed', executor: 'clone' });
    const model = await declared(target);
    should(Object.keys(model.runtimes)).deepEqual(['claude-default']);
    should(model.machine.defaultRuntime).equal('claude-default');
    should(JSON.stringify(staged.preview)).containEql('Liftoff MBP');
    should(JSON.stringify(staged.preview)).not.containEql('AMER-D22HXVF42W');
  });

  it('should leave the default unset when the person chose none, and still write a readable setup', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await targetWithOwnDefault('work-linux');

    // Act
    const staged = await target.catalog.propose({
      kind: 'clone.import',
      mode: 'replace',
      bundle,
      defaultRuntime: null,
    });
    await target.catalog.apply(staged.id, { governed: false } as never);

    // Assert
    const model = await declared(target);
    should(model.machine.defaultRuntime).be.undefined();
  });

  it('should keep the target default on an alongside copy and take the chosen runtime under its new name', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const kept = await targetWithOwnDefault('work-linux');
    const chosen = await targetWithOwnDefault('work-mac');

    // Act
    const keptStaged = await kept.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await kept.catalog.apply(keptStaged.id, { governed: false } as never);
    const chosenStaged = await chosen.catalog.propose({
      kind: 'clone.import',
      mode: 'alongside',
      bundle,
      defaultRuntime: 'claude-default',
    });
    await chosen.catalog.apply(chosenStaged.id, { governed: false } as never);

    // Assert
    should((await declared(kept)).machine.defaultRuntime).equal('claude-kirin');
    const model = await declared(chosen);
    should(Object.keys(model.runtimes).toSorted()).deepEqual(['claude-default', 'claude-kirin']);
    should(model.machine.defaultRuntime).equal('claude-default');
  });
});
