/**
 * The first run and Clone over real files, end to end: the host scan, the import, the real
 * provisioner's apply, the catalogue reading back what was written, then the export of that machine
 * copied onto a second one.
 *
 * Every path is inside a directory this test created, the person's "own" home is a temporary one, and
 * every credential is a placeholder, so no real harness setup, login or fleet is read or written.
 */
import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AccountModel,
  accountModelFiles,
  CLONE_BASE_FILE,
  EXPORT_KEYS_FILE,
  parseCloneBase,
  parseExportKeys,
  renderConfigFile,
  resolveDefaultRuntime,
} from '@ferretry/fleet';
import { CloneableSecretNameSchema, configSchemaModeline, FleetCloneBundleSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { fleetCatalogRoutes } from '../../../src/lib/runtime/mounts/fleet-catalog.ts';
import { fleetSetupRoutes } from '../../../src/lib/runtime/mounts/fleet-setup.ts';
import { SecretExportService, SecretImportService, SecretVault } from '../../../src/lib/secrets/index.ts';
import { resolveWardenLogin } from '../../../src/lib/warden/config.ts';
import { request } from '../../unit/api/support.ts';
import { CREDENTIALS, FakeSecretCipher, GRANTED, human, NARROWED } from '../../unit/runtime/mounts/support.ts';
import {
  applyChange,
  credentialBytes,
  crypto_,
  declared,
  exportedBundle,
  FAKE_CODEX_LOGIN,
  FAKE_LOGIN,
  FAKE_SECRET,
  filesUnder,
  HELD,
  heldBytes,
  identity,
  importHost,
  keysTheCopyNeeds,
  type Machine,
  MISSING,
  machine,
  OTHER_HELD,
  removeTemporary,
  signedInMachine,
  sourceMachine,
  unchanged,
  type Vault,
} from './clone-world.ts';

afterEach(removeTemporary);

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
  /**
   * A target signed in as `claude-you` (the id the source's own login has, so every copy meets a clash), with a
   * secret in the store and an environment login that holds a `${secret:GITHUB_TOKEN}` reference to it.
   */
  async function clashingTarget(name: string): Promise<Machine> {
    const target = await signedInTarget(name);
    target.secrets.set('GITHUB_TOKEN', FAKE_SECRET);
    const staged = await target.catalog.propose({
      kind: 'credential.add',
      id: 'keyed',
      harness: 'claude',
      store: 'environment',
      env: { ANTHROPIC_API_KEY: '${secret:GITHUB_TOKEN}' },
    } as never);
    await target.catalog.apply(staged.id, { governed: false } as never);
    return target;
  }

  const copy = async (on: Machine, mode: 'alongside' | 'replace', bundle: unknown): Promise<void> => {
    const staged = await on.catalog.propose({ kind: 'clone.import', mode, bundle } as never);
    await on.catalog.apply(staged.id, { governed: false } as never);
  };

  it.each(['alongside', 'replace'] as const)(
    'should leave a login of the same id, its sign-in, its secrets and its reference byte-identical across a %s copy',
    async mode => {
      // Arrange
      const source = await machine('studio', { claude: true });
      await importHost(source);
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      const target = await clashingTarget(`work-${mode}`);
      const before = await credentialBytes(target);
      should(Object.keys(before)).containEql('credentials/claude-you/.credentials.json');
      should(Object.keys(before)).containEql('config/logins/claude-you.yaml');
      should(before['config/logins/keyed.yaml']).not.be.undefined();
      should(Buffer.from(before['config/logins/keyed.yaml'] as string, 'hex').toString('utf8')).containEql(
        '${secret:GITHUB_TOKEN}',
      );

      // Act
      await copy(target, mode, bundle);

      // Assert: the login the person already signed in is untouched, to the byte, and so is every secret.
      const after = await credentialBytes(target);
      should(unchanged(before, after)).deepEqual(before);
      should(Object.keys(after).filter(key => key.startsWith('secret:'))).deepEqual(
        Object.keys(before).filter(key => key.startsWith('secret:')),
      );
      const record = path.join(target.fleet, CLONE_BASE_FILE);
      should((await stat(record)).mode & 0o777).equal(0o600);
      should(Object.keys(parseCloneBase(await readFile(record, 'utf8')).sources)).deepEqual(['self:daemon-source']);
    },
  );

  it('should keep them byte-identical after EACH copy: the first, the repeat Alongside, and a Replace (§14.4)', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await clashingTarget('work-linux');
    const before = await credentialBytes(target);

    // Act + Assert: after every copy, not only the last.
    for (const mode of ['alongside', 'alongside', 'replace'] as const) {
      await copy(target, mode, bundle);
      should(unchanged(before, await credentialBytes(target))).deepEqual(before);
    }
  });

  it('should file no content, no email and no secret in the record, and survive a second copy and a Replace', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await clashingTarget('work-linux');
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
      should(Object.keys(parseCloneBase(text).sources)).deepEqual(['self:daemon-source']);
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

    should(Object.keys(parseCloneBase(await readFile(record, 'utf8')).sources)).deepEqual(['self:daemon-source']);
  });

  it('should copy without a record, and leave the file alone, when the record exists but cannot be read', async () => {
    // Arrange: a DIRECTORY where the record file goes, so reading it fails with something other than "not there".
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await clashingTarget('work-linux');
    const record = path.join(target.fleet, CLONE_BASE_FILE);
    await mkdir(path.join(record, 'in-the-way'), { recursive: true });
    const before = await credentialBytes(target);

    // Act
    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(staged.id, { governed: false } as never);

    // Assert: the copy landed, the unreadable file is exactly what it was, and the sign-ins did not move.
    should(Object.keys((await declared(target)).runtimes)).containEql('claude-default');
    should((await stat(record)).isDirectory()).be.true();
    should(await readdir(record)).deepEqual(['in-the-way']);
    should(unchanged(before, await credentialBytes(target))).deepEqual(before);
  });

  it('should forget one source in the record alone, leaving the login and its secrets byte-identical', async () => {
    // Arrange
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    const target = await clashingTarget('work-linux');
    const record = path.join(target.fleet, CLONE_BASE_FILE);
    const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle });
    await target.catalog.apply(staged.id, { governed: false } as never);
    const before = await credentialBytes(target);

    // Act
    const forgot = await target.setup.forgetCloneSource('self:daemon-source');
    const forgotAgain = await target.setup.forgetCloneSource('self:daemon-source');

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
async function signedInTarget(name: string, emails?: Readonly<Record<string, string>>): Promise<Machine> {
  const target = await machine(name, { claude: false, ...(emails === undefined ? {} : { emails }) });
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

/**
 * A machine whose person is already signed in to Claude Code as `kirin@example.test` and to Codex as
 * `codex@example.test`, both logins kept in Ferretry's own store with a token on disk, each with a runtime.
 */
async function reusedLoginTarget(name: string): Promise<Machine> {
  const target = await machine(name, {
    claude: false,
    emails: { 'claude-kirin': 'kirin@example.test', 'codex-kirin': 'codex@example.test' },
  });
  const steps = [
    { kind: 'credential.add', id: 'claude-kirin', harness: 'claude' },
    { kind: 'credential.add', id: 'codex-kirin', harness: 'codex' },
    { kind: 'component.put', name: 'house', component: { kind: 'instructions' }, content: 'Be kind.\n', create: true },
    { kind: 'profile.put', name: 'plain', layers: ['instructions/house'], create: true },
    { kind: 'runtime.put', name: 'mine', credential: 'claude-kirin', profile: 'plain', agent: true, create: true },
    { kind: 'runtime.put', name: 'codex-mine', credential: 'codex-kirin', profile: 'plain', agent: true, create: true },
  ];
  for (const step of steps) {
    const staged = await target.catalog.propose(step as never);
    await target.catalog.apply(staged.id, { governed: false } as never);
  }
  for (const [id, file, token] of [
    ['claude-kirin', '.credentials.json', FAKE_LOGIN],
    ['codex-kirin', 'auth.json', FAKE_CODEX_LOGIN],
  ] as const) {
    const store = path.join(target.fleet, 'credentials', id);
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, file), token, { mode: 0o600 });
  }
  const claude = path.join(target.userHome, '.claude');
  await mkdir(claude, { recursive: true });
  await writeFile(path.join(claude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
  target.secrets.set('KEEP_ME', 'placeholder-secret-one');
  target.secrets.set('JEV_API_KEY', 'placeholder-secret-two');
  return target;
}

/** Everything that is a sign-in or a secret on a machine, as bytes, so a copy can be compared before and after. */
async function signInState(on: Machine): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  const read = async (root: string, keep: (file: string) => boolean, label: string): Promise<void> => {
    const files = await filesUnder(root).catch(() => [] as string[]);
    for (const file of files.filter(keep)) state[`${label}/${file}`] = await readFile(path.join(root, file), 'utf8');
  };
  await read(on.home.paths.config, file => file.startsWith('logins/'), 'config');
  await read(on.fleet, file => file.startsWith('credentials/'), 'fleet');
  await read(path.join(on.userHome, '.claude'), file => file === '.credentials.json', 'claude');
  for (const [name, value] of on.secrets) state[`secret/${name}`] = value;
  return state;
}

/** Every `auth.json` link under a directory (a Codex runtime's way to its login), as where it points. */
async function authLinks(root: string, relative = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, await authLinks(root, next));
    else if (entry.isSymbolicLink() && entry.name === 'auth.json') found[next] = await readlink(path.join(root, next));
  }
  return found;
}

describe('Clone reuses a login the target already has, and never touches it (design §14.4)', () => {
  /** The source machine, signed in to both CLIs under emails that differ from the target's only by case. */
  async function source(): Promise<ReturnType<typeof FleetCloneBundleSchema.parse>> {
    const studio = await machine('studio', {
      claude: true,
      emails: { 'claude-you': 'Kirin@Example.TEST', 'codex-you': 'Codex@Example.TEST' },
    });
    await importHost(studio);
    const steps = [
      { kind: 'credential.add', id: 'codex-you', harness: 'codex' },
      {
        kind: 'component.put',
        name: 'house',
        component: { kind: 'instructions' },
        content: 'Be kind.\n',
        create: true,
      },
      { kind: 'profile.put', name: 'plain', layers: ['instructions/house'], create: true },
      { kind: 'runtime.put', name: 'codex-copy', credential: 'codex-you', profile: 'plain', agent: true, create: true },
    ];
    for (const step of steps) {
      const staged = await studio.catalog.propose(step as never);
      await studio.catalog.apply(staged.id, { governed: false } as never);
    }
    return FleetCloneBundleSchema.parse(await studio.setup.exportBundle());
  }

  for (const mode of ['alongside', 'replace'] as const) {
    it(`should point the copied runtime at the existing login in ${mode} mode and leave its sign-in and secrets byte-identical`, async () => {
      // Arrange
      const bundle = await source();
      should(bundle.credentials.map(credential => credential.email).toSorted()).deepEqual([
        'Codex@Example.TEST',
        'Kirin@Example.TEST',
      ]);
      const target = await reusedLoginTarget('work-linux');
      const before = await signInState(target);
      const claudeToken = 'fleet/credentials/claude-kirin/.credentials.json';
      const codexToken = 'fleet/credentials/codex-kirin/auth.json';
      should(Object.keys(before)).containEql('claude/.credentials.json');
      should(Object.keys(before)).containEql('secret/KEEP_ME');
      should(before[claudeToken]).equal(FAKE_LOGIN);
      should(before[codexToken]).equal(FAKE_CODEX_LOGIN);
      const codexFile = path.join(target.fleet, 'credentials', 'codex-kirin', 'auth.json');
      const linksBefore = await authLinks(target.fleet);
      should(Object.values(linksBefore)).deepEqual([codexFile]);

      // Act
      const staged = await target.catalog.propose({ kind: 'clone.import', mode, bundle });
      const outcome = await target.catalog.apply(staged.id, { governed: false } as never);

      // Assert: no new slot, the copied runtime uses the login that was already here, nothing about it changed.
      should(outcome).containEql({ outcome: 'executed', executor: 'clone' });
      const summary = (outcome as { summary: string }).summary;
      should(summary).startWith('Copied 2 runtimes from studio. Already signed in here, no new sign-in: ');
      should(summary).containEql('kirin@example.test').and.containEql('codex@example.test');
      should(JSON.stringify(staged.preview)).containEql('kirin@example.test — already here, no new sign-in');
      should(JSON.stringify(staged.preview)).containEql('codex@example.test — already here, no new sign-in');
      const model = await declared(target);
      should(Object.keys(model.credentials).toSorted()).deepEqual(['claude-kirin', 'codex-kirin']);
      should(model.runtimes['claude-default']?.credential).equal('claude-kirin');
      should(model.runtimes['codex-copy']?.credential).equal('codex-kirin');
      should(await signInState(target)).deepEqual(before);

      // The copied Codex runtime's own auth.json is a link to the login that was already here, and every
      // link there is still points at that one file.
      const linksAfter = await authLinks(target.fleet);
      should(Object.keys(linksAfter).length).be.aboveOrEqual(2);
      should([...new Set(Object.values(linksAfter))]).deepEqual([codexFile]);
      if (mode === 'alongside') {
        for (const [link, destination] of Object.entries(linksBefore)) should(linksAfter[link]).equal(destination);
      }
    });
  }
});

describe('a repeat copy (update) over real files', () => {
  const apply = async (on: Machine, change: unknown, governed = false) => {
    const staged = await on.catalog.propose(change as never);
    return await on.catalog.apply(staged.id, { governed } as never);
  };

  const instructionsName = async (on: Machine): Promise<string> => {
    const [name] = Object.keys((await declared(on)).components.instructions);
    if (name === undefined) throw new Error('expected an instructions component');
    return name;
  };

  const editInstructions = async (on: Machine, content: string): Promise<void> => {
    const name = await instructionsName(on);
    await apply(on, { kind: 'component.put', name, component: { kind: 'instructions' }, content, create: false });
  };

  const instructionsFile = async (on: Machine): Promise<string> =>
    await readFile(
      path.join(on.fleet, 'assets', 'components', 'instructions', `${await instructionsName(on)}.md`),
      'utf8',
    );

  /** The source after its own import, and a target that took its first copy. */
  async function copiedPair(): Promise<{ source: Machine; target: Machine }> {
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const target = await machine('work-linux', { claude: false });
    const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle });
    return { source, target };
  }

  const exported = async (source: Machine) => FleetCloneBundleSchema.parse(await source.setup.exportBundle());

  const update = async (
    target: Machine,
    source: Machine,
    decisions: Record<string, 'take' | 'keep'> = {},
    governed = false,
  ) => {
    const bundle = await exported(source);
    const review = await target.setup.reviewClone({ bundle });
    return {
      review,
      outcome: await apply(
        target,
        { kind: 'clone.import', mode: 'update', bundle, reviewed: review.fingerprint, decisions },
        governed,
      ),
    };
  };

  /** Every file under the target's assets, with its bytes. */
  const assetBytes = async (on: Machine): Promise<Record<string, string>> => {
    const root = path.join(on.fleet, 'assets');
    const bytes: Record<string, string> = {};
    for (const file of await filesUnder(root)) bytes[file] = await readFile(path.join(root, file), 'utf8');
    return bytes;
  };

  it('should copy twice with nothing changed and list every item as already the same, writing no asset', async () => {
    const { source, target } = await copiedPair();
    const before = await assetBytes(target);

    const bundle = await exported(source);
    const review = await target.setup.reviewClone({ bundle });
    should(review.items).deepEqual([]);
    should(review.same.count).be.above(0);
    await update(target, source);

    should(await assetBytes(target)).deepEqual(before);
  });

  it('should say "changed here" for an item edited here, and leave its bytes alone', async () => {
    const { source, target } = await copiedPair();
    await editInstructions(target, 'Edited here.\n');

    const review = await target.setup.reviewClone({ bundle: await exported(source) });
    const item = review.items.find(row => row.kind === 'instructions');
    should(item?.outcome).equal('mine');
    await update(target, source);

    should(await instructionsFile(target)).equal('Edited here.\n');
  });

  it('should apply an item edited on the source', async () => {
    const { source, target } = await copiedPair();
    await editInstructions(source, 'Edited on the source.\n');

    const { review } = await update(target, source);

    should(review.items.find(row => row.kind === 'instructions')?.outcome).equal('theirs');
    should(await instructionsFile(target)).equal('Edited on the source.\n');
  });

  it('should honour the choice for an item edited on both sides, in both directions', async () => {
    const { source, target } = await copiedPair();
    await editInstructions(source, 'Edited on the source.\n');
    await editInstructions(target, 'Edited here.\n');
    const ref = `instructions/${await instructionsName(target)}`;
    const bundle = await exported(source);
    const review = await target.setup.reviewClone({ bundle });
    should(review.items.find(row => row.ref === ref)?.choice).be.undefined();

    await target.catalog
      .propose({
        kind: 'clone.import',
        mode: 'update',
        bundle,
        reviewed: review.fingerprint,
        decisions: {},
      } as never)
      .then(
        () => should.fail(undefined, undefined, 'expected the unchosen item to be refused'),
        (error: Error) => should(error.message).containEql(ref),
      );
    should(await instructionsFile(target)).equal('Edited here.\n');

    await apply(target, {
      kind: 'clone.import',
      mode: 'update',
      bundle,
      reviewed: review.fingerprint,
      decisions: { [ref]: 'keep' },
    });
    should(await instructionsFile(target)).equal('Edited here.\n');

    // Keeping settles it: the next review calls it changed here, and only keep is allowed.
    const reviewAgain = await target.setup.reviewClone({ bundle });
    should(reviewAgain.items.find(row => row.ref === ref)?.outcome).equal('mine');

    // The other direction, from a fresh both-changed state.
    const fresh = await copiedPair();
    await editInstructions(fresh.source, 'Edited on the source.\n');
    await editInstructions(fresh.target, 'Edited here.\n');
    const freshBundle = await exported(fresh.source);
    const freshReview = await fresh.target.setup.reviewClone({ bundle: freshBundle });
    await apply(fresh.target, {
      kind: 'clone.import',
      mode: 'update',
      bundle: freshBundle,
      reviewed: freshReview.fingerprint,
      decisions: { [ref]: 'take' },
    });
    should(await instructionsFile(fresh.target)).equal('Edited on the source.\n');
  });

  it('should still link an item renamed by hand on both machines', async () => {
    const { source, target } = await copiedPair();
    await apply(source, { kind: 'runtime.rename', name: 'claude-default', to: 'claude-studio' });
    await apply(target, { kind: 'runtime.rename', name: 'claude-default', to: 'claude-mine' });

    const review = await target.setup.reviewClone({ bundle: await exported(source) });

    should(review.items.filter(row => row.kind === 'runtime' && row.outcome === 'new')).deepEqual([]);
    should((await declared(target)).runtimes['claude-mine']).not.be.undefined();
  });

  it('should refuse an apply whose review is stale', async () => {
    const { source, target } = await copiedPair();
    await editInstructions(source, 'Edited on the source.\n');
    const bundle = await exported(source);
    const review = await target.setup.reviewClone({ bundle });
    await editInstructions(target, 'Edited here after the review.\n');

    await target.catalog
      .propose({
        kind: 'clone.import',
        mode: 'update',
        bundle,
        reviewed: review.fingerprint,
        decisions: {},
      } as never)
      .then(
        () => should.fail(undefined, undefined, 'expected a stale review to be refused'),
        (error: Error) => should(error.message).equal('Something changed since you reviewed. Review again.'),
      );
    should(await instructionsFile(target)).equal('Edited here after the review.\n');
  });

  it('should refuse a governed device without fleet.configure, on the review route', async () => {
    const { source, target } = await copiedPair();
    const dispatcher = new ApiDispatcher(new ApiRouter(fleetSetupRoutes(target.setup)), CREDENTIALS, NARROWED);

    const answered = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/clone/review',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: await exported(source) }),
      }),
    );

    should(answered.status).equal(403);
  });

  it('should leave a signed-in login and its secrets byte-identical across an update', async () => {
    const { source, target } = await copiedPair();
    const store = path.join(target.fleet, 'credentials', 'claude-you');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
    target.secrets.set('GITHUB_TOKEN', FAKE_SECRET);
    const before = await signedInState(target);
    await editInstructions(source, 'Edited on the source.\n');

    await update(target, source);

    should(await signedInState(target)).deepEqual(before);
  });

  // ── Security review regressions (#F544) ──

  it('should remove a file the source dropped from a folder it took, and leave the rest of the folder', async () => {
    // Arrange: the source's skill carries a second file at the first copy, then drops it.
    const source = await machine('studio', { claude: true });
    await writeFile(path.join(source.userHome, '.claude', 'skills', 'review', 'notes.md'), 'Old notes.\n');
    await importHost(source);
    const target = await machine('work-linux', { claude: false });
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await exported(source) });
    const skill = path.join(target.fleet, 'assets', 'skills', 'review');
    should(await readFile(path.join(skill, 'notes.md'), 'utf8')).equal('Old notes.\n');
    await rm(path.join(source.fleet, 'assets', 'skills', 'review', 'notes.md'));

    // Act
    const { review } = await update(target, source);

    // Assert: listed as removed, gone from disk, the rest untouched, and the next review has nothing to say.
    should(review.items.flatMap(row => row.files)).containEql({
      path: 'skills/review/notes.md',
      change: 'removed',
      lines: { added: 0, removed: 2 },
    });
    await stat(path.join(skill, 'notes.md')).then(
      () => should.fail(undefined, undefined, 'expected the removed file to be gone'),
      (error: NodeJS.ErrnoException) => should(error.code).equal('ENOENT'),
    );
    should(await readFile(path.join(skill, 'SKILL.md'), 'utf8')).containEql('Review it.');
    should((await target.setup.reviewClone({ bundle: await exported(source) })).items).deepEqual([]);
  });

  it('should link old copies by name and leave a signed-in login and its secrets byte-identical', async () => {
    // Arrange: a signed-in target that took a copy before origin keys existed (a version 1 bundle).
    const source = await machine('studio', { claude: true });
    await importHost(source);
    const target = await signedInTarget('work-linked');
    const before = await signedInState(target);
    const current = await exported(source);
    if (current.version !== 2) throw new Error('expected a version 2 bundle');
    const { daemon: _daemon, keys: _keys, ...rest } = current;
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: { ...rest, version: 1 } });

    // Act: the repeat copy finds the old copies by name.
    const { review } = await update(target, source);

    // Assert
    should(review.same.probable).be.above(0);
    should(await signedInState(target)).deepEqual(before);
    const linked = Object.values((await declared(target)).components.instructions).filter(
      component => component.clonedFromKey !== undefined,
    );
    should(linked.length).be.above(0);
  });

  it('should reuse the signed-in login with the same email, in another case, and leave it byte-identical', async () => {
    // Arrange: the source's login is signed in as Kirin@Example.TEST; the target already holds that account as
    // an unlinked, signed-in login (no origin key, so only the email can pair them).
    const source = await machine('studio', { claude: true, emails: { 'claude-you': 'Kirin@Example.TEST' } });
    await importHost(source);
    const target = await signedInTarget('work-email', { 'claude-you': 'kirin@example.test' });
    const bundle = await exported(source);
    should(bundle.credentials.map(credential => credential.email)).deepEqual(['Kirin@Example.TEST']);
    const before = await signedInState(target);
    const loginsBefore = Object.keys((await declared(target)).credentials);

    // Act
    const review = await target.setup.reviewClone({ bundle });
    await apply(target, { kind: 'clone.import', mode: 'update', bundle, reviewed: review.fingerprint, decisions: {} });

    // Assert: the review said the login is already here, no slot or login was added, the copied runtime uses it,
    // and everything that makes it signed in is exactly as it was.
    should(review.logins).deepEqual([{ sourceId: 'claude-you', outcome: 'matched', target: 'claude-you' }]);
    const model = await declared(target);
    should(Object.keys(model.credentials)).deepEqual(loginsBefore);
    should(model.runtimes['claude-default']?.credential).equal('claude-you');
    should(await signedInState(target)).deepEqual(before);
  });

  for (const choice of ['keep', 'remove'] as const) {
    it(`should ${choice} an item the source dropped and leave a signed-in login and its secrets byte-identical`, async () => {
      // Arrange: the source had an instructions component nothing layers, copied once, then deleted it.
      const source = await machine('studio', { claude: true });
      await importHost(source);
      await apply(source, {
        kind: 'component.put',
        name: 'extra',
        component: { kind: 'instructions' },
        content: 'Extra.\n',
        create: true,
      });
      const target = await signedInTarget(`work-gone-${choice}`);
      await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await exported(source) });
      should((await declared(target)).components.instructions.extra).not.be.undefined();
      await apply(source, { kind: 'component.remove', componentKind: 'instructions', name: 'extra' });
      const before = await signedInState(target);
      const bundle = await exported(source);
      const review = await target.setup.reviewClone({ bundle });
      should(review.items.find(row => row.ref === 'instructions/extra')).match({ outcome: 'gone', choice: 'keep' });

      // Act
      await apply(target, {
        kind: 'clone.import',
        mode: 'update',
        bundle,
        reviewed: review.fingerprint,
        decisions: { 'instructions/extra': choice },
      });

      // Assert
      const after = (await declared(target)).components.instructions.extra;
      if (choice === 'remove') should(after).be.undefined();
      else should(after).not.be.undefined();
      should(await signedInState(target)).deepEqual(before);
    });
  }

  /** Rename an instructions component (and, when named, a profile) by editing the config files, as an owner would. */
  async function renameByHand(on: Machine, component: string, to: string, profile?: { from: string; to: string }) {
    const model = await declared(on);
    const config = on.home.paths.config;
    const { [component]: moved, ...others } = model.components.instructions;
    if (moved === undefined) throw new Error(`expected instructions/${component}`);
    const relayer = (layers: readonly string[]) =>
      layers.map(layer => (layer === `instructions/${component}` ? `instructions/${to}` : layer));
    const profiles = Object.fromEntries(
      Object.entries(model.profiles).map(([name, value]) => [
        name === profile?.from ? profile.to : name,
        { ...value, layers: relayer(value.layers) },
      ]),
    );
    const runtimes = Object.fromEntries(
      Object.entries(model.runtimes).map(([name, value]) => [
        name,
        value.profile === profile?.from ? { ...value, profile: profile.to } : value,
      ]),
    );
    const renamed = {
      ...model,
      components: { ...model.components, instructions: { ...others, [to]: moved } },
      profiles,
      runtimes,
    } as AccountModel;
    await rm(path.join(config, 'components', 'instructions', `${component}.yaml`));
    if (profile !== undefined) await rm(path.join(config, 'profiles', `${profile.from}.yaml`));
    for (const [file, { address, value }] of accountModelFiles(renamed)) {
      const touched =
        file === `components/instructions/${to}.yaml` || file.startsWith('profiles/') || file.startsWith('runtimes/');
      const text = touched ? renderConfigFile(file, address, value, undefined) : undefined;
      if (text !== undefined) await writeFile(path.join(config, file), text, { mode: 0o600 });
    }
  }

  it('should still link a component renamed by hand in its YAML on the source', async () => {
    // Arrange
    const { source, target } = await copiedPair();
    const mine = Object.keys((await declared(target)).components.instructions).toSorted();
    const name = await instructionsName(source);
    await renameByHand(source, name, `${name}-renamed`);
    should((await declared(source)).components.instructions[`${name}-renamed`]).not.be.undefined();

    // Act
    const { review } = await update(target, source);

    // Assert: nothing new, nothing gone, and no second copy under another name.
    should(review.items).deepEqual([]);
    should(Object.keys((await declared(target)).components.instructions).toSorted()).deepEqual(mine);
  });

  it('should still link a component and a profile renamed by hand in their YAML here', async () => {
    // Arrange
    const { source, target } = await copiedPair();
    const name = await instructionsName(target);
    const [profile] = Object.keys((await declared(target)).profiles);
    if (profile === undefined) throw new Error('expected a profile');
    await renameByHand(target, name, `${name}-mine`, { from: profile, to: `${profile}-mine` });
    const renamed = await declared(target);
    should(renamed.components.instructions[`${name}-mine`]).not.be.undefined();
    should(renamed.profiles[`${profile}-mine`]).not.be.undefined();

    // Act
    const { review } = await update(target, source);

    // Assert
    should(review.items).deepEqual([]);
    should(Object.keys((await declared(target)).profiles)).deepEqual(Object.keys(renamed.profiles));
  });

  // ── Settings merged key by key (smart re-copy, PR 7) ──

  describe('the settings of a repeat copy', () => {
    const WARDEN_MINE =
      '# Mine: Jev stays off.\nenabled: true # keep on\nlayers:\n  jev: false # off on purpose\n  llm: false\nintervalMinutes: 5\n';
    const WARDEN_THEIRS = WARDEN_MINE.replace('jev: false # off on purpose', 'jev: true').replace(
      'intervalMinutes: 5',
      'intervalMinutes: 10',
    );
    const allowed = (governed: boolean, refusals: Record<string, 'not-granted' | 'step-up-required'> = {}) =>
      ({
        governed,
        decide: (demand: { capability: string }) => {
          const refusal = refusals[demand.capability] ?? 'granted';
          return { allowed: refusal === 'granted', refusal };
        },
      }) as never;

    const writeOwn = async (on: Machine, file: string, text: string): Promise<void> => {
      const written = await on.home.service.write(file, text, undefined, true, 'owner');
      should(written.outcome).equal('applied');
    };
    const disk = async (on: Machine, file: string): Promise<string> =>
      await readFile(path.join(on.home.paths.config, file), 'utf8');

    /** Review, then stage and apply an update that carries these settings, for this caller. */
    async function settingsUpdate(
      target: Machine,
      source: Machine,
      settings: { path: string; text: string }[],
      settingsDecisions: Record<string, Record<string, 'take' | 'keep'>> | undefined,
      governance: unknown,
    ) {
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      const review = await target.setup.reviewClone({ bundle, settings: settings as never }, governance as never);
      const staged = await target.catalog.propose(
        {
          kind: 'clone.import',
          mode: 'update',
          bundle,
          reviewed: review.fingerprint,
          decisions: {},
          settings,
          ...(settingsDecisions === undefined ? {} : { settingsDecisions }),
        } as never,
        { governance, freshStepUp: false, agent: false, spend: () => undefined } as never,
      );
      return { review, outcome: await target.catalog.apply(staged.id, governance as never) };
    }

    async function pair() {
      const source = await machine('studio', { claude: true });
      await importHost(source);
      const target = await machine('work-linux', { claude: false });
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      const staged = await target.catalog.propose({ kind: 'clone.import', mode: 'alongside', bundle } as never);
      await target.catalog.apply(staged.id, { governed: false } as never);
      await writeOwn(target, 'warden.yaml', WARDEN_MINE);
      return { source, target };
    }

    it('should hold a merge that loosens for a remote device, keep the tighter version in effect, and put it into effect once confirmed', async () => {
      const { source, target } = await pair();
      const { review, outcome } = await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: WARDEN_THEIRS }],
        { 'warden.yaml': { 'layers.jev': 'take', intervalMinutes: 'take' } },
        allowed(true),
      );

      should(review.settings[0]?.keys.find(key => key.key === 'layers.jev')?.loosens).equal(true);
      should((outcome as { summary: string }).summary).containEql('held until you confirm');
      // Written, and exactly this machine's file with the two values changed: its comments and key order
      // survive. Every file Ferretry writes starts with its schema modeline, so the merge adds that one line.
      should(await disk(target, 'warden.yaml')).equal(
        `${configSchemaModeline({ kind: 'warden' })}\n\n${WARDEN_MINE.replace(
          'jev: false # off on purpose',
          'jev: true # off on purpose',
        ).replace('intervalMinutes: 5', 'intervalMinutes: 10')}`,
      );
      // …but the tighter version is still in effect, and the loosening waits.
      const snapshot = await target.home.service.load();
      should(snapshot.evaluation.effective.warden.layers.jev).equal(false);
      const [held] = snapshot.evaluation.pending;
      should(held?.path).equal('warden.yaml');
      should(await target.home.service.confirm('warden.yaml', held?.etag as string)).equal(true);
      should((await target.home.service.load()).evaluation.effective.warden.layers.jev).equal(true);
    });

    it('should put the same merge into effect at once at the machine', async () => {
      const { source, target } = await pair();
      await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: WARDEN_THEIRS }],
        { 'warden.yaml': { 'layers.jev': 'take', intervalMinutes: 'take' } },
        allowed(false),
      );
      const snapshot = await target.home.service.load();
      should(snapshot.evaluation.effective.warden.layers.jev).equal(true);
      should(snapshot.evaluation.pending).deepEqual([]);
    });

    it('should keep what is kept: a key the person keeps changes nothing and the file stays byte-identical', async () => {
      const { source, target } = await pair();
      await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: WARDEN_THEIRS }],
        { 'warden.yaml': { 'layers.jev': 'keep', intervalMinutes: 'keep' } },
        allowed(true),
      );
      should(await disk(target, 'warden.yaml')).equal(WARDEN_MINE);
    });

    it('should refuse a file the caller may not write, writing no settings file at all', async () => {
      const { source, target } = await pair();
      await writeOwn(target, 'learning.yaml', 'enabled: true\n');
      const governance = allowed(true, { warden: 'not-granted' });
      const settings = [
        { path: 'warden.yaml', text: WARDEN_THEIRS },
        { path: 'learning.yaml', text: 'enabled: false\n' },
      ];
      const bundle = FleetCloneBundleSchema.parse(await source.setup.exportBundle());
      const review = await target.setup.reviewClone({ bundle, settings: settings as never }, governance);
      should(review.settings.find(entry => entry.path === 'warden.yaml')?.refused).containEql('warden.yaml');

      await target.catalog
        .propose(
          {
            kind: 'clone.import',
            mode: 'update',
            bundle,
            reviewed: review.fingerprint,
            decisions: {},
            settings,
            settingsDecisions: { 'warden.yaml': { intervalMinutes: 'take' }, 'learning.yaml': { enabled: 'take' } },
          } as never,
          { governance, freshStepUp: false, agent: false, spend: () => undefined } as never,
        )
        .then(
          () => should.fail(undefined, undefined, 'expected the file to be refused'),
          (error: Error) => should(error.message).containEql('may not change warden.yaml'),
        );
      should(await disk(target, 'warden.yaml')).equal(WARDEN_MINE);
      should(await disk(target, 'learning.yaml')).equal('enabled: true\n');
    });

    it('should refuse an apply that leaves a key both sides changed undecided, writing nothing', async () => {
      const { source, target } = await pair();
      await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: WARDEN_MINE }],
        { 'warden.yaml': {} },
        allowed(false),
      );
      await writeOwn(target, 'warden.yaml', WARDEN_MINE.replace('intervalMinutes: 5', 'intervalMinutes: 15'));
      const before = await disk(target, 'warden.yaml');
      await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: WARDEN_THEIRS.replace('jev: true', 'jev: false') }],
        undefined,
        allowed(false),
      ).then(
        () => should.fail(undefined, undefined, 'expected the undecided key to be refused'),
        (error: Error) => should(error.message).containEql('warden.yaml: intervalMinutes'),
      );
      should(await disk(target, 'warden.yaml')).equal(before);
    });

    it('should refuse a carried file that would not check on this machine, naming the problem and writing nothing', async () => {
      const { source, target } = await pair();
      const before = await disk(target, 'warden.yaml');
      await settingsUpdate(
        target,
        source,
        [{ path: 'warden.yaml', text: `${WARDEN_THEIRS}investigation:\n  note: nothing\n` }],
        { 'warden.yaml': { 'layers.jev': 'take', intervalMinutes: 'take', 'investigation.note': 'take' } },
        allowed(false),
      ).then(
        () => should.fail(undefined, undefined, 'expected the unchecked file to be refused'),
        (error: Error) => {
          should(error.message).containEql('warden.yaml');
          should(error.message).containEql('would not check');
          should(error.message).containEql('Unrecognized key');
        },
      );
      should(await disk(target, 'warden.yaml')).equal(before);
    });

    it('should take only the controls chosen, and nothing else of machine.yaml', async () => {
      const { source, target } = await pair();
      const before = (await target.home.service.load()).evaluation.effective.model.machine;
      await settingsUpdate(
        target,
        source,
        [{ path: 'controls', text: JSON.stringify({ agentControl: { files: false, browsers: false } }) }],
        { controls: { 'agentControl.files': 'take', 'agentControl.browsers': 'keep' } },
        allowed(false),
      );
      const after = (await target.home.service.load()).evaluation.effective.model.machine;
      should(after.agentControl.files).equal(false);
      should(after.agentControl.browsers).equal(before.agentControl.browsers);
      should({ ...after, agentControl: { ...after.agentControl, files: before.agentControl.files } }).deepEqual(before);
    });

    it('should leave a signed-in login and its secrets byte-identical across a settings merge, taking and keeping (§14.4)', async () => {
      for (const choice of ['take', 'keep'] as const) {
        const { source, target } = await pair();
        const store = path.join(target.fleet, 'credentials', 'claude-you');
        await mkdir(store, { recursive: true });
        await writeFile(path.join(store, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
        target.secrets.set('GITHUB_TOKEN', FAKE_SECRET);
        await writeOwn(target, 'voice.yaml', 'postProcessing:\n  provider: off\n');
        const before = await signedInState(target);

        await settingsUpdate(
          target,
          source,
          [
            { path: 'warden.yaml', text: `${WARDEN_THEIRS}guard:\n  model: \${secret:GITHUB_TOKEN}\n` },
            { path: 'voice.yaml', text: 'postProcessing:\n  provider: groq\n' },
            { path: 'controls', text: JSON.stringify({ agentControl: { files: false } }) },
          ],
          {
            'warden.yaml': { 'layers.jev': choice, intervalMinutes: choice, 'guard.model': choice },
            'voice.yaml': { 'postProcessing.provider': choice },
            controls: { 'agentControl.files': choice },
          },
          allowed(false),
        );

        should(await signedInState(target)).deepEqual(before);
      }
    });
  });
});

// ── The whole app copy, over real files and a real secret directory (design §14.4) ───────────────────

/**
 * The app copies in one fixed order, each step through the route the browser uses: the reviewed fleet change, then
 * the settings files it ticked, then the agent controls, then the keys the copied setup names, sealed for one
 * passkey. Each step runs here through the same code the daemon runs: the real provisioner on real files, the real
 * configuration service, and the real secret import and export over a real secret directory (a fake cipher and an
 * in-memory document, so its timestamps and sealed entries are the daemon's own). A sign-in is a file a person
 * signed in with; the account, its sign-in, its 2FA keys, their sealed seeds and a registered passkey are the
 * daemon's own account index, sealed document and passkey document, seeded with fake data and read back through the
 * daemon's own readers (`account-stores-fixture.ts`). The copy never reads any of them, so each is compared as bytes.
 */
describe('the whole app copy leaves a signed-in login, its secrets, its factors and the defaults byte-identical', () => {
  const LEARNING = 'enabled: false\n';
  const apply = applyChange;

  /** What a copy made before keys existed looks like: the same bundle as version 1. */
  const legacyBundle = async (source: Machine) => {
    const current = await exportedBundle(source);
    if (current.version !== 2) throw new Error('expected a version 2 bundle');
    const { daemon: _daemon, keys: _keys, ...rest } = current;
    return { ...rest, version: 1 as const };
  };

  interface Choices {
    /** What the person decided in the review, by item. */
    readonly decisions?: Record<string, 'take' | 'keep' | 'remove'>;
    /** Which existing login each sign-in uses. */
    readonly logins?: Record<string, string>;
    /** A link-only finish: the reviewed change and nothing else. */
    readonly linkOnly?: boolean;
  }

  /**
   * The app's copy, step by step. `mode` is the Existing-setup choice; an Update names the review it came from.
   * Returns what the key import said, so a test can assert that nothing held was replaced.
   */
  async function appCopy(
    target: Machine,
    vault: Vault,
    from: { source: Machine; vault: Vault },
    mode: 'update' | 'alongside' | 'replace',
    choices: Choices = {},
  ) {
    const bundle = await exportedBundle(from.source);
    // 1. The fleet.
    if (mode === 'update') {
      const review = await target.setup.reviewClone({ bundle });
      await apply(target, {
        kind: 'clone.import',
        mode,
        bundle,
        decisions: choices.decisions ?? {},
        ...(choices.logins === undefined ? {} : { logins: choices.logins }),
        reviewed: review.fingerprint,
      });
    } else {
      await apply(target, { kind: 'clone.import', mode, bundle });
    }
    if (choices.linkOnly === true) return undefined;
    // 2. A settings file, written whole against what is here now.
    const file = await target.home.service.file('learning.yaml');
    await target.home.service.write('learning.yaml', LEARNING, file.etag, false, 'owner');
    // 3. The agent controls, with the default the fleet copy already decided read back.
    await apply(target, {
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: (await declared(target)).machine.defaultRuntime ?? null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
    });
    // 4. The keys the copied setup names that the source holds and this machine does not, sealed for one passkey.
    const names = keysTheCopyNeeds(
      bundle,
      (await from.vault.directory.list()).map(secret => secret.name),
      (await vault.directory.list()).map(secret => secret.name),
    ).map(name => CloneableSecretNameSchema.parse(name));
    const here = await identity();
    const there = await identity();
    const clock = { now: () => '2026-10-20T10:00:00.000Z' };
    const importing = new SecretImportService({
      crypto: crypto_,
      identity: { load: async () => here },
      directory: vault.directory,
      clock,
    });
    const exporting = new SecretExportService({
      crypto: crypto_,
      identity: { load: async () => there },
      vault: new SecretVault(from.vault.documents, new FakeSecretCipher()),
      clock,
    });
    const offer = await importing.open();
    const sealed = await exporting.seal(offer.importId, { offer, names });
    return { names, result: await importing.complete(offer.importId, sealed.bundle) };
  }

  /** The held entries, to the byte, and the key the copy was allowed to add. */
  const provedUntouched = async (
    target: Machine,
    vault: Vault,
    before: Record<string, string>,
    keys: Awaited<ReturnType<typeof appCopy>>,
  ): Promise<void> => {
    for (const key of [
      'credentials/claude-kirin/.credentials.json',
      'state/login-entries.json',
      'state/login-secrets.json',
      'state/passkeys.json',
      'credentials/codex-kirin/auth.json',
      'config/logins/claude-kirin.yaml',
      'config/logins/keyed.yaml',
      'config/account-defaults.yaml',
      'host/.claude/.credentials.json',
      `vault/${HELD}`,
      `vault/${OTHER_HELD}`,
    ])
      should(Object.keys(before)).containEql(key);
    should(Buffer.from(before['config/logins/keyed.yaml'] as string, 'hex').toString('utf8')).containEql(
      `\${secret:${HELD}}`,
    );
    should(unchanged(before, await heldBytes(target, vault))).deepEqual(before);
    if (keys === undefined) return;
    // The key it lacked arrived; nothing it held was named, replaced or rewritten.
    should(keys.names).deepEqual([MISSING]);
    should(keys.result.imported).deepEqual([MISSING]);
    should(keys.result.kept).deepEqual([]);
    should(Object.keys((await vault.documents.read())?.entries ?? {}).toSorted()).deepEqual(
      [HELD, MISSING, OTHER_HELD].toSorted(),
    );
  };

  for (const mode of ['alongside', 'replace'] as const) {
    it(`should leave them alone through a ${mode} copy: fleet, then a settings file, controls and a sealed key`, async () => {
      const from = await sourceMachine(false);
      const { target, vault } = await signedInMachine(`work-${mode}`, false);
      const before = await heldBytes(target, vault);

      const keys = await appCopy(target, vault, from, mode);

      await provedUntouched(target, vault, before, keys);
      should(Object.keys((await declared(target)).runtimes)).containEql('claude-default');
    });
  }

  it('should leave them alone through an Update that takes what the source changed', async () => {
    const from = await sourceMachine(false);
    const { target, vault } = await signedInMachine('work-update', false);
    const before = await heldBytes(target, vault);
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await exportedBundle(from.source) });
    const [name] = Object.keys((await declared(from.source)).components.instructions);
    if (name === undefined) throw new Error('expected an instructions component');
    await apply(from.source, {
      kind: 'component.put',
      name,
      component: { kind: 'instructions' },
      content: 'Edited on the source.\n',
      create: false,
    });

    const keys = await appCopy(target, vault, from, 'update');

    await provedUntouched(target, vault, before, keys);
    const copied = await readFile(
      path.join(target.fleet, 'assets', 'components', 'instructions', `${name}.md`),
      'utf8',
    );
    should(copied).equal('Edited on the source.\n');
  });

  for (const decision of ['keep', 'remove'] as const) {
    it(`should leave them alone when the person chooses to ${decision} an item the source dropped`, async () => {
      const from = await sourceMachine(true);
      const { target, vault } = await signedInMachine(`work-gone-${decision}`, false);
      const before = await heldBytes(target, vault);
      await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await exportedBundle(from.source) });
      should(Object.keys((await declared(target)).runtimes)).containEql('claude-extra');
      await apply(from.source, { kind: 'runtime.remove', name: 'claude-extra' });
      const review = await target.setup.reviewClone({ bundle: await exportedBundle(from.source) });
      should(review.items.find(row => row.ref === 'runtime/claude-extra')?.outcome).equal('gone');

      const keys = await appCopy(target, vault, from, 'update', {
        decisions: decision === 'remove' ? { 'runtime/claude-extra': 'remove' } : {},
      });

      await provedUntouched(target, vault, before, keys);
      const runtimes = Object.keys((await declared(target)).runtimes);
      should(runtimes.includes('claude-extra')).equal(decision === 'keep');
    });
  }

  it('should leave them alone when the person names which existing login a sign-in uses', async () => {
    const from = await sourceMachine(false);
    const { target, vault } = await signedInMachine('work-picked', true);
    const before = await heldBytes(target, vault);
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await legacyBundle(from.source) });
    const review = await target.setup.reviewClone({ bundle: await exportedBundle(from.source) });
    const ask = review.logins.find(login => login.sourceId === 'claude-you');
    should(ask?.outcome).equal('ask');
    should(ask?.candidates).deepEqual(['claude-kirin', 'claude-kirin-2']);

    const keys = await appCopy(target, vault, from, 'update', { logins: { 'claude-you': 'claude-kirin-2' } });

    await provedUntouched(target, vault, before, keys);
  });

  it('should leave them alone when an old copy is only linked, and write nothing but the link', async () => {
    const from = await sourceMachine(false);
    const { target, vault } = await signedInMachine('work-linked', false);
    const before = await heldBytes(target, vault);
    await apply(target, { kind: 'clone.import', mode: 'alongside', bundle: await legacyBundle(from.source) });
    const assets = async (): Promise<string[]> => await filesUnder(path.join(target.fleet, 'assets'));
    const assetsBefore = await assets();
    const review = await target.setup.reviewClone({ bundle: await exportedBundle(from.source) });
    should(review.items).deepEqual([]);
    should(review.same.probable).be.above(0);

    const keys = await appCopy(target, vault, from, 'update', { linkOnly: true });

    should(keys).be.undefined();
    await provedUntouched(target, vault, before, undefined);
    should(await assets()).deepEqual(assetsBefore);
    should((await target.setup.reviewClone({ bundle: await exportedBundle(from.source) })).items).deepEqual([]);
  });
});
