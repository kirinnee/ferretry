/**
 * The first run and Clone over real files, end to end: the host scan, the import, the real
 * provisioner's apply, the catalogue reading back what was written, then the export of that machine
 * copied onto a second one.
 *
 * Every path is inside a directory this test created, the person's "own" home is a temporary one, and
 * every credential is a placeholder, so no real harness setup, login or fleet is read or written.
 */
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FleetCloneBundleSchema } from '@ferretry/protocol';
import {
  CLONE_BASE_FILE,
  EXPORT_KEYS_FILE,
  parseCloneBase,
  parseExportKeys,
  resolveDefaultRuntime,
} from '@ferretry/fleet';
import should from 'should';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { fleetCatalogRoutes } from '../../../src/lib/runtime/mounts/fleet-catalog.ts';
import { CREDENTIALS, GRANTED, human } from '../../unit/runtime/mounts/support.ts';
import { request } from '../../unit/api/support.ts';
import { fileFleetCatalogDeps, readDeclaredAccountModel } from '../../../src/adapters/fleet/account-model-files.ts';
import { fileFleetSetupDeps } from '../../../src/adapters/fleet/setup-files.ts';
import { resolveWardenLogin } from '../../../src/lib/warden/config.ts';
import { FleetCatalogService } from '../../../src/lib/fleet/catalog-service.ts';
import { FleetPublication } from '../../../src/lib/fleet/publication.ts';
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
    publication: new FleetPublication(),
  });
  const setup = createFleetSetupSubsystem(
    fileFleetSetupDeps({
      catalog: catalogDeps,
      daemonId: () => 'daemon-source',
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
    should(model.credentials['claude-you']).match({ harness: 'claude', store: 'ferretry', clonedFrom: 'studio' });
    should(model.credentials['claude-you']?.clonedFromKey).equal(
      bundle.version === 2 ? bundle.keys['login/claude-you'] : undefined,
    );
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

describe('the last-copied record over real files', () => {
  const FAKE_SIGN_IN = JSON.stringify({
    claudeAiOauth: { accessToken: 'placeholder-signed-in', refreshToken: 'placeholder-refresh' },
  });

  /** Everything a signed-in login and its secrets are, as bytes: its file, its sign-in, its secret values. */
  async function credentialBytes(on: Machine): Promise<Record<string, string>> {
    const sign = path.join(on.fleet, 'credentials');
    const files = await filesUnder(sign);
    const bytes: Record<string, string> = {};
    for (const file of files) bytes[`credentials/${file}`] = await readFile(path.join(sign, file), 'utf8');
    // The login's declaration may be re-rendered by the apply; what it MEANS must not move.
    bytes['logins/work'] = JSON.stringify((await declared(on)).credentials.work);
    for (const [name, value] of on.secrets) bytes[`secret:${name}`] = value;
    return bytes;
  }

  /** A target with its own signed-in login ("work") and a secret, beside everything a copy may write. */
  async function signedInTarget(name: string): Promise<Machine> {
    const target = await targetWithOwnDefault(name);
    await mkdir(path.join(target.fleet, 'credentials', 'work'), { recursive: true });
    await writeFile(path.join(target.fleet, 'credentials', 'work', '.credentials.json'), FAKE_SIGN_IN, { mode: 0o600 });
    target.secrets.set('GITHUB_TOKEN', FAKE_SECRET);
    return target;
  }

  it.each(['alongside', 'replace'] as const)(
    'should leave a signed-in login and its secrets byte-identical across a %s copy that writes the record',
    async mode => {
      // Arrange
      const source = await machine('studio', { claude: true });
      await importHost(source);
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      const target = await signedInTarget('work-linux');
      const before = await credentialBytes(target);
      should(Object.keys(before)).containEql('credentials/work/.credentials.json');

      // Act
      const staged = await target.catalog.propose({ kind: 'clone.import', mode, bundle });
      await target.catalog.apply(staged.id, { governed: false } as never);

      // Assert: the login the person already signed in is untouched, to the byte, and so is every secret.
      const after = await credentialBytes(target);
      should(after).deepEqual(before);
      const record = path.join(target.fleet, CLONE_BASE_FILE);
      should((await stat(record)).mode & 0o777).equal(0o600);
      should(Object.keys(parseCloneBase(await readFile(record, 'utf8')).sources)).deepEqual(['daemon-source']);
    },
  );

  it('should file no content, no email and no secret in the record, and survive a second copy and a Replace', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await signedInTarget('work-linux');
    const record = path.join(target.fleet, CLONE_BASE_FILE);

    // Act
    const first = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(first.id, { governed: false } as never);
    const afterFirst = await readFile(record, 'utf8');
    const again = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(again.id, { governed: false } as never);
    const replace = await target.catalog.propose({ kind: 'clone.import', mode: 'replace', bundle });
    await target.catalog.apply(replace.id, { governed: false } as never);

    // Assert
    for (const text of [afterFirst, await readFile(record, 'utf8')]) {
      should(text).not.containEql('Be kind.');
      should(text).not.containEql('Review it.');
      should(text).not.containEql(FAKE_SECRET);
      should(text).not.containEql('placeholder');
      should(Object.keys(parseCloneBase(text).sources)).deepEqual(['daemon-source']);
    }
    const model = await declared(target);
    should(Object.keys(model.runtimes)).deepEqual(['claude-default']);
  });

  it('should treat a damaged record as absent and replace it with a fresh one', async () => {
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await machine('work-linux', { claude: false });
    const record = path.join(target.fleet, CLONE_BASE_FILE);
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, '{ not json', { mode: 0o600 });

    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(staged.id, { governed: false } as never);

    should(Object.keys(parseCloneBase(await readFile(record, 'utf8')).sources)).deepEqual(['daemon-source']);
  });

  it('should forget one source in the record alone, leaving the login and its secrets byte-identical', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await signedInTarget('work-linux');
    const record = path.join(target.fleet, CLONE_BASE_FILE);
    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(staged.id, { governed: false } as never);
    const before = await credentialBytes(target);

    // Act
    const forgot = await target.setup.forgetCloneSource('daemon-source');
    const forgotAgain = await target.setup.forgetCloneSource('daemon-source');

    // Assert
    should(forgot).be.true();
    should(forgotAgain).be.false();
    should(Object.keys(parseCloneBase(await readFile(record, 'utf8')).sources)).deepEqual([]);
    should((await stat(record)).mode & 0o777).equal(0o600);
    should(await credentialBytes(target)).deepEqual(before);
  });
});

describe('a catalog install over real files cannot leave the skill folder', () => {
  const ORIGIN = {
    publisher: `fy_daemon_${'A'.repeat(43)}`,
    publisherName: 'kirin-box',
    catalogId: `cat_${'c'.repeat(22)}`,
    catalogName: 'Catalog',
    itemId: `itm_${'s'.repeat(22)}`,
    kind: 'skill',
    name: 'pdf-tools',
    version: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  } as const;
  const install = (files: { path: string; content: string }[]) =>
    ({
      kind: 'catalog.install',
      name: 'pdf-tools',
      component: { kind: 'skills', items: ['pdf-tools'] },
      files,
      profile: 'plain',
      installedFrom: ORIGIN,
      replace: false,
    }) as never;

  /** A machine with one profile, which is what a catalog item is installed into. */
  async function withProfile(): Promise<Machine> {
    const on = await machine('studio', { claude: false });
    const component = await on.catalog.propose({
      kind: 'component.put',
      name: 'house',
      component: { kind: 'instructions' },
      content: 'Be kind.\n',
      create: true,
    } as never);
    await on.catalog.apply(component.id, { governed: false } as never);
    const profile = await on.catalog.propose({
      kind: 'profile.put',
      name: 'plain',
      layers: ['instructions/house'],
      create: true,
    });
    await on.catalog.apply(profile.id, { governed: false } as never);
    return on;
  }

  it('should refuse the kind on the public proposals route, writing nothing anywhere', async () => {
    const on = await withProfile();
    const before = [...(await filesUnder(on.home.paths.config)), ...(await filesUnder(on.fleet))];
    const dispatcher = new ApiDispatcher(new ApiRouter(fleetCatalogRoutes(on.catalog)), CREDENTIALS, GRANTED);

    const staged = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/proposals',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ change: install([{ path: '../../../../config/x.yaml', content: 'owned: 1\n' }]) }),
      }),
    );

    should(staged.status).equal(400);
    should([...(await filesUnder(on.home.paths.config)), ...(await filesUnder(on.fleet))]).deepEqual(before);
  });

  it('should refuse a path out of the skill folder even when called internally, and write nothing', async () => {
    const on = await withProfile();
    const before = [...(await filesUnder(on.home.paths.config)), ...(await filesUnder(on.fleet))];

    const attempt = on.catalog.installCatalogItem(
      install([{ path: '../../../../config/x.yaml', content: 'owned: 1\n' }]),
      { governed: false } as never,
    );

    await attempt.then(
      () => should.fail(undefined, undefined, 'expected a refusal'),
      (error: Error) => should(error.name).equal('FleetCatalogRefusal'),
    );
    should([...(await filesUnder(on.home.paths.config)), ...(await filesUnder(on.fleet))]).deepEqual(before);
  });

  it('should write a well-formed skill under its own folder in the assets directory, and only there', async () => {
    const on = await withProfile();
    const before = new Set(await filesUnder(on.fleet));

    await on.catalog.installCatalogItem(
      install([
        { path: 'SKILL.md', content: '---\nname: pdf-tools\n---\n' },
        { path: 'scripts/split.sh', content: 'echo split\n' },
      ]),
      { governed: false } as never,
    );

    const added = (await filesUnder(on.fleet)).filter(file => !before.has(file));
    should(added.filter(file => file.startsWith('assets/')).toSorted()).deepEqual([
      'assets/skills/pdf-tools/SKILL.md',
      'assets/skills/pdf-tools/scripts/split.sh',
    ]);
    should(await readFile(path.join(on.fleet, 'assets/skills/pdf-tools/scripts/split.sh'), 'utf8')).equal(
      'echo split\n',
    );
  });
});

/** A placeholder token for a login that is already signed in on the target; worth nothing. */
const TARGET_TOKEN = JSON.stringify({
  claudeAiOauth: { accessToken: 'target-access', refreshToken: 'target-refresh' },
});
const TARGET_SECRET = 'ghp_targetplaceholderplaceholder000000000';

/**
 * A target that is signed in: the login `claude-you` (the id the source's own login has, so a copy has
 * to deal with a clash), its credential-store entry with a placeholder token, and a secret the store holds.
 */
async function signedInTarget(name: string): Promise<Machine> {
  const target = await machine(name, { claude: false });
  const steps = [
    { kind: 'credential.add', id: 'claude-you', harness: 'claude' },
    { kind: 'component.put', name: 'house', component: { kind: 'instructions' }, content: 'Be kind.\n', create: true },
    { kind: 'profile.put', name: 'plain', layers: ['instructions/house'], create: true },
    {
      kind: 'runtime.put',
      name: 'claude-kirin',
      credential: 'claude-you',
      profile: 'plain',
      agent: true,
      create: true,
    },
  ];
  for (const step of steps) {
    const staged = await target.catalog.propose(step as never);
    await target.catalog.apply(staged.id, { governed: false } as never);
  }
  const store = path.join(target.fleet, 'credentials', 'claude-you');
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, '.credentials.json'), TARGET_TOKEN, { mode: 0o600 });
  target.secrets.set('TARGET_TOKEN', TARGET_SECRET);
  return target;
}

/** Everything that makes the login `claude-you` signed in here: store entry, secret store, config entry. */
async function signedInState(on: Machine): Promise<unknown> {
  const store = path.join(on.fleet, 'credentials', 'claude-you');
  const entries: Record<string, string> = {};
  for (const file of await filesUnder(store)) entries[file] = (await readFile(path.join(store, file))).toString('hex');
  return {
    store: entries,
    secrets: Object.fromEntries([...on.secrets].toSorted()),
    login: await readFile(path.join(on.home.paths.config, 'logins', 'claude-you.yaml'), 'utf8'),
  };
}

describe('importing a version 2 bundle never touches a login that is signed in here (§14.4)', () => {
  for (const mode of ['alongside', 'replace'] as const) {
    it(`should leave the target's login, its token file and its secrets byte-identical on a ${mode} copy`, async () => {
      // Arrange: a version 2 bundle from a set-up source, and a target whose login is signed in.
      const source = await machine('studio', { claude: true });
      await importHost(source);
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      should(bundle.version).equal(2);
      const target = await signedInTarget(`work-${mode}`);
      const before = await signedInState(target);
      should(before).match({ store: { '.credentials.json': Buffer.from(TARGET_TOKEN).toString('hex') } });

      // Act
      const staged = await target.catalog.propose({ kind: 'clone.import', mode, bundle });
      const outcome = await target.catalog.apply(staged.id, { governed: false } as never);

      // Assert: the copy happened, and the signed-in login is exactly as it was.
      should(outcome).match({ outcome: 'executed', executor: 'clone' });
      should(await signedInState(target)).deepEqual(before);
    });
  }
});

describe('the export writes its origin keys into state over real files', () => {
  it('should answer version 2 and keep export-keys.json under the fleet directory, private and secret-free', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const keysPath = path.join(source.fleet, EXPORT_KEYS_FILE);
    await rm(keysPath, { force: true });

    // Act
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());

    // Assert
    if (bundle.version !== 2) throw new Error('expected a version 2 bundle');
    should(bundle.daemon).equal('daemon-source');
    const text = await readFile(keysPath, 'utf8');
    const stored = parseExportKeys(text);
    should(Object.keys(stored.items).length).be.above(0);
    for (const [reference, entry] of Object.entries(stored.items)) should(bundle.keys[reference]).equal(entry.key);
    should((await stat(keysPath)).mode & 0o077).equal(0);
    should(text).not.containEql(FAKE_SECRET);
    should(JSON.stringify(bundle)).not.containEql(FAKE_SECRET);
    should(JSON.stringify(bundle)).not.containEql('placeholder-access');

    // A second export keeps every key, and the config files never name one.
    const again = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    if (again.version !== 2) throw new Error('expected a version 2 bundle');
    should(again.keys).deepEqual(bundle.keys);
    for (const file of await filesUnder(source.home.paths.config)) {
      should(await readFile(path.join(source.home.paths.config, file), 'utf8')).not.containEql(
        Object.values(bundle.keys)[0] as string,
      );
    }
  });

  it('should still answer when export-keys.json cannot be written', async () => {
    // Arrange: a FILE where the setup directory would go, so the write fails.
    const source = await machine('studio', { claude: true });
    await importHost(source);
    await rm(path.join(source.fleet, 'setup'), { recursive: true, force: true });
    await writeFile(path.join(source.fleet, 'setup'), 'in the way');

    // Act
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());

    // Assert
    if (bundle.version !== 2) throw new Error('expected a version 2 bundle');
    should(Object.keys(bundle.keys).length).be.above(0);
  });
});
