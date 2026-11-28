/**
 * The account model's catalogue over real files: the configuration files read through the daemon's
 * own configuration service, a retired `fleet/config.yaml` refused, component documents read and
 * refused, the writes a reviewed change makes, and that change staged and applied by the real
 * provisioner in a temporary state home.
 *
 * The apply is the evidence for one question the design left open: may a change that ADDS a component
 * file also materialise a link to it, when that file does not exist until the same apply writes it?
 * It may. Preview never stats a link's source, and apply proves a source that is one of its own
 * documents from the document rather than from the disk — so the new file and every link to it land
 * together, inside one rollback boundary. No real harness, account or home is touched.
 */
import { afterEach, describe, it } from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseAccountModel,
  RETIRED_FLEET_CONFIG_SENTENCE,
  RetiredFleetConfigError,
  runtimeIdsPath,
} from '@ferretry/fleet';
import should from 'should';
import {
  documentRevision,
  fileFleetCatalogDeps,
  readComponentText,
  readConfigAccountDocument,
  readDeclaredAccountModel,
  sessionStatusOf,
} from '../../../src/adapters/fleet/account-model-files.ts';
import { ManifestAccountInventory } from '../../../src/adapters/core/manifest-account-inventory.ts';
import { RuntimeAwareAccountInventory, RuntimeIdsFile } from '../../../src/adapters/fleet/runtime-ids-file.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileSecretDocumentStore } from '../../../src/adapters/secrets/file-secret-document-store.ts';
import { LOGIN_SECRETS_DOCUMENT } from '../../../src/adapters/secrets/file-login-index-store.ts';
import { FileSecretKey, WebCryptoSecretCipher } from '../../../src/adapters/secrets/webcrypto-secret-cipher.ts';
import { LIMITED_DEVICE_GRANTS, SecretNameSchema } from '@ferretry/protocol';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../../src/lib/fleet/catalog-service.ts';
import { FleetPublication, PublishedFleetInventory } from '../../../src/lib/fleet/publication.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { fleetCatalogRoutes } from '../../../src/lib/runtime/mounts/fleet-catalog.ts';
import { CapabilityGrantService, DEFAULT_CAPABILITY_GRANTS } from '../../../src/lib/grants/index.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { CREDENTIALS, GRANTED, human } from '../../unit/runtime/mounts/support.ts';
import { type ConfigHome, configHome, sha256, writeModelFiles } from './config-files-fixture.ts';

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-account-files-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

const LOCAL: CallerGovernance = {
  governed: false,
  decide: () => ({ allowed: true, refusal: 'granted' }),
} as never;

const MODEL = parseAccountModel({
  version: 2,
  credentials: { 'codex-slot': { harness: 'codex', store: 'ferretry' } },
  components: { mcp: { notes: { command: 'notes-server' } } },
  profiles: { default: { layers: ['mcp/notes'] } },
  runtimes: { 'codex-default': { credential: 'codex-slot', profile: 'default' } },
});

const SETTINGS = {
  kind: 'machine.settings',
  agentPermissions: 'skip',
  defaultRuntime: null,
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
} as const;

interface Machine extends ConfigHome {
  readonly root: string;
  readonly fleet: string;
  readonly config: string;
  readonly catalog: FleetCatalogService;
  readonly deps: FleetCatalogServiceDeps;
  /** The publication every apply of this machine runs exclusively under. */
  readonly publication: FleetPublication;
  /** Every file the provisioner acknowledged, by path relative to the configuration directory. */
  readonly acknowledged: { readonly path: string; readonly text: string }[];
  states: unknown[];
}

const locations = (home: ConfigHome) => ({ configDirectory: home.paths.config, fleetDirectory: home.paths.fleet });

async function machine(
  model = MODEL,
  sessionRecords?: Required<Pick<FleetCatalogServiceDeps, 'sessionRecords' | 'renameSessions'>>,
  beforeBoot?: (home: ConfigHome) => Promise<void>,
): Promise<Machine> {
  const root = await temporary();
  const home = await configHome(path.join(root, 'state'));
  const userHome = path.join(root, 'person');
  await mkdir(userHome, { recursive: true });
  await writeModelFiles(home.paths.config, model);
  await beforeBoot?.(home);
  const acknowledged: { path: string; text: string }[] = [];
  const handle: Machine = {
    ...home,
    root,
    fleet: home.paths.fleet,
    config: home.paths.config,
    catalog: undefined as never,
    deps: undefined as never,
    publication: new FleetPublication(),
    acknowledged,
    states: [],
  };
  const deps = fileFleetCatalogDeps({
    paths: home.paths,
    userHome,
    hostCodexHome: path.join(userHome, '.codex'),
    sessionStatuses: async () => handle.states.flatMap(raw => sessionStatusOf(raw) ?? []),
    credentials: {
      list: async () => ({ format: 2, machine: 'studio', credentials: [] }),
      signOut: async () => {
        throw new Error('not exercised');
      },
    },
    locate: () => undefined,
    machineName: () => 'studio',
    clientName: 'fy',
    config: {
      inEffect: async () => await home.service.inEffect(),
      load: async () => await home.service.load(),
      acknowledge: (file, text) => {
        acknowledged.push({ path: file, text });
        home.service.acknowledge(file, text);
      },
      acknowledgeRemoval: file => home.service.acknowledgeRemoval(file),
    },
    configDirectory: home.paths.config,
    ...(sessionRecords === undefined ? {} : { sessionRecords }),
    publication: handle.publication,
  });
  await deps.sourceFenceReady;
  return Object.assign(handle, { catalog: new FleetCatalogService(deps), deps });
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

describe('reading the account model from the configuration files', () => {
  it('should read the per-file layout as a version-2 model, at the revision of the fleet files in effect', async () => {
    // Arrange
    const host = await machine();

    // Act
    const reading = await readConfigAccountDocument(host.service, locations(host));
    const fleetRevision = (await host.service.load()).evaluation.fleetRevision;

    // Assert
    should(reading.format).equal('version-2');
    should(reading.revision).equal(fleetRevision);
    should(reading.revision).not.equal('absent');
    should(Object.keys(reading.model.runtimes)).deepEqual(['codex-default']);
    should(await readDeclaredAccountModel(host.service, locations(host))).deepEqual(reading.model);
  });

  it('should read a machine with no fleet files as an empty model, and declare nothing', async () => {
    // Arrange
    const home = await configHome(await temporary());

    // Act
    const none = await readConfigAccountDocument(home.service, locations(home));
    const declared = await readDeclaredAccountModel(home.service, locations(home));

    // Assert
    should(none).match({ format: 'none', revision: 'absent' });
    should(Object.keys(none.model.runtimes)).deepEqual([]);
    should(declared).be.undefined();
  });

  it.each([
    ['a file', false],
    ['a link', true],
  ])('should refuse a retired fleet/config.yaml (%s) with the sentence and leave it untouched', async (_, asLink) => {
    // Arrange
    const host = await machine();
    const file = path.join(host.fleet, 'config.yaml');
    const text = 'version: 2\ncredentials: {}\n';
    if (asLink) {
      const target = path.join(host.root, 'elsewhere.yaml');
      await writeFile(target, text);
      await symlink(target, file);
    } else {
      await writeFile(file, text);
    }

    // Act
    const read = await failure(readConfigAccountDocument(host.service, locations(host)));
    const declared = await failure(readDeclaredAccountModel(host.service, locations(host)));

    // Assert — refused rather than converted, with the sentence that says how to set the machine up again.
    should(read).be.instanceOf(RetiredFleetConfigError);
    should((read as Error).message).equal(RETIRED_FLEET_CONFIG_SENTENCE(file));
    should(declared).be.instanceOf(RetiredFleetConfigError);
    should(await readFile(file, 'utf8')).equal(text);
  });

  it('should throw when whether a retired file exists cannot even be asked', async () => {
    // Arrange — the fleet directory is a file, so asking about a path inside it is not "absent".
    const home = await configHome(await temporary());
    const notADirectory = path.join(home.paths.home, 'not-a-directory');
    await writeFile(notADirectory, '');

    // Act
    const error = await failure(
      readConfigAccountDocument(home.service, { configDirectory: home.paths.config, fleetDirectory: notADirectory }),
    );

    // Assert
    should(error).be.instanceOf(Error);
    should(error).not.be.instanceOf(RetiredFleetConfigError);
  });

  it('should write a changed file key by key, keeping the owner comments, against the etag it was read at', async () => {
    // Arrange
    const host = await machine();
    const profile = path.join(host.config, 'profiles', 'default.yaml');
    const commented = `${await readFile(profile, 'utf8')}# the owner's note\n`;
    await writeFile(profile, commented);
    const reading = await readConfigAccountDocument(host.service, locations(host));
    const next = parseAccountModel({
      ...JSON.parse(JSON.stringify(MODEL)),
      components: { mcp: { notes: { command: 'notes-server' }, more: { command: 'more-server' } } },
      profiles: { default: { layers: ['mcp/notes', 'mcp/more'] } },
    });

    // Act
    const writes = reading.documents(next);

    // Assert — one edit and one new file, nothing removed, every one private.
    should(writes.map(write => path.relative(host.config, write.path)).toSorted()).deepEqual([
      'components/mcp/more.yaml',
      'profiles/default.yaml',
    ]);
    const edit = writes.find(write => write.path === profile);
    should(edit).match({ expect: sha256(commented), mode: 0o600 });
    should(edit?.content).containEql("# the owner's note");
    should(edit?.content).containEql('mcp/more');
    should(edit).not.have.property('remove');
    const created = writes.find(write => write.path.endsWith('more.yaml'));
    should(created).match({ expect: 'absent', mode: 0o600 });
    should(created?.content).containEql('command: more-server');
  });

  it('should remove the file of a component the next model drops, against its etag', async () => {
    // Arrange
    const host = await machine();
    const component = path.join(host.config, 'components', 'mcp', 'notes.yaml');
    const reading = await readConfigAccountDocument(host.service, locations(host));
    const next = parseAccountModel({
      ...JSON.parse(JSON.stringify(MODEL)),
      components: { mcp: {} },
      profiles: { default: { layers: [] } },
    });

    // Act
    const writes = reading.documents(next);

    // Assert
    should(writes.find(write => write.path === component)).deepEqual({
      path: component,
      content: '',
      mode: 0o600,
      expect: sha256(await readFile(component, 'utf8')),
      remove: true,
    });
  });

  it('should read a component file, and report a missing, oversized or non-file one as nothing', async () => {
    // Arrange
    const root = await temporary();
    await writeFile(path.join(root, 'main.md'), 'Main guidance.\n');
    await writeFile(path.join(root, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));

    const home = await temporary();
    const fence = { homes: [home], open: [] };

    // Act
    const texts = await Promise.all(
      ['main.md', 'huge.md', 'missing.md', '.'].map(
        async name => await readComponentText(path.join(root, name), fence),
      ),
    );

    // Assert
    should(texts).deepEqual(['Main guidance.\n', undefined, undefined, undefined]);
  });

  it('should read nothing from inside the state home, named directly or through a link, but read its asset tree', async () => {
    // Arrange: the daemon's admin token, a link to it from outside, and an asset inside the home.
    const home = await temporary();
    const outside = await temporary();
    await writeFile(path.join(home, 'api-token'), 'fy_admin_secret\n');
    await mkdir(path.join(home, 'fleet', 'assets'), { recursive: true });
    await writeFile(path.join(home, 'fleet', 'assets', 'CLAUDE.md'), 'Shared guidance.\n');
    await symlink(path.join(home, 'api-token'), path.join(outside, 'innocent.md'));
    const fence = { homes: [home], open: [path.join(home, 'fleet', 'assets')] };

    // Act
    const texts = await Promise.all(
      [
        path.join(home, 'api-token'),
        path.join(outside, 'innocent.md'),
        path.join(home, 'fleet', 'assets', 'CLAUDE.md'),
      ].map(async file => await readComponentText(file, fence)),
    );

    // Assert
    should(texts).deepEqual([undefined, undefined, 'Shared guidance.\n']);
  });

  it('should say what a document is now: its digest, absent, or a refusal when it cannot be read', async () => {
    // Arrange
    const root = await temporary();
    await writeFile(path.join(root, 'a.md'), 'A\n');

    // Act
    const present = await documentRevision(path.join(root, 'a.md'));
    const absent = await documentRevision(path.join(root, 'b.md'));
    const unreadable = await failure(documentRevision(root));

    // Assert
    should(present).equal(sha256('A\n'));
    should(absent).equal('absent');
    should(unreadable).be.instanceOf(Error);
  });
});

describe('a reviewed change applied by the real provisioner', () => {
  it('should write a new component file and the link to it in one apply, with the runtime that uses it', async () => {
    // Arrange
    const host = await machine();
    host.states = [{ id: 's1', status: 'running', turn: 0 }, { not: 'a state' }];
    const component = await host.catalog.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Main guidance.\n',
      create: true,
    });
    await host.catalog.apply(component.id, LOCAL);

    // Act — a profile that now has it as a layer: the link's source exists only because of the last apply.
    const profile = await host.catalog.propose({
      kind: 'profile.put',
      name: 'default',
      layers: ['mcp/notes', 'instructions/main'],
      create: false,
    });
    const outcome = await host.catalog.apply(profile.id, LOCAL);

    // Assert
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    const asset = path.join(host.fleet, 'assets', 'components', 'instructions', 'main.md');
    should(await readFile(asset, 'utf8')).equal('Main guidance.\n');
    const ids = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8'));
    const runtimeHome = path.join(host.fleet, 'homes', ids.runtimes['codex-default'].id);
    should(await readlink(path.join(runtimeHome, 'AGENTS.md'))).equal(asset);
    const written = await readDeclaredAccountModel(host.service, locations(host));
    should(written?.profiles.default?.layers).deepEqual(['mcp/notes', 'instructions/main']);
    should((await stat(path.join(host.config, 'profiles', 'default.yaml'))).mode & 0o777).equal(0o600);
    should((await host.catalog.machine(LOCAL)).runningSessions).equal(1);
  });

  it('should never let a read of the published fleet land while an apply has the manifest moved aside', async () => {
    // Arrange — a fleet already published, and a reader built the way the daemon builds its one inventory.
    const host = await machine();
    const component = await host.catalog.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Main guidance.\n',
      create: true,
    });
    await host.catalog.apply(component.id, LOCAL);
    const files = new StateFileSystem(host.paths);
    const published = new PublishedFleetInventory(
      new RuntimeAwareAccountInventory(
        new ManifestAccountInventory(files, host.paths.fleetManifest),
        new RuntimeIdsFile(files, runtimeIdsPath(host.fleet)),
      ),
      host.publication,
    );
    const profile = await host.catalog.propose({
      kind: 'profile.put',
      name: 'default',
      layers: ['mcp/notes', 'instructions/main'],
      create: false,
    });

    // Act — read as often as the event loop allows for as long as the apply runs. Ungated, a read here
    // lands between the manifest moved aside and its replacement linked in, and finds no fleet at all.
    let applying = true;
    const applied = host.catalog.apply(profile.id, LOCAL).finally(() => {
      applying = false;
    });
    const seen: { accounts: number; named: boolean; planned: boolean }[] = [];
    while (applying)
      seen.push({
        accounts: (await published.accounts()).length,
        named: (await published.ids()) !== undefined,
        // The catalogue's own planning read: a gap here would re-mint every runtime's id.
        planned: (await host.deps.ids()) !== undefined,
      });
    const outcome = await applied;

    // Assert — every read found the one published runtime and its ids, before the apply or after it.
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(seen.length).be.above(0);
    should(seen.filter(read => read.accounts !== 1 || !read.named || !read.planned)).deepEqual([]);
  });

  it('should write a component file and link it in the SAME apply, when that apply is what creates the file', async () => {
    // Arrange: a profile already names instructions whose file is not on disk yet.
    const host = await machine(
      parseAccountModel({
        ...JSON.parse(JSON.stringify(MODEL)),
        components: { ...MODEL.components, instructions: { main: { file: 'components/instructions/main.md' } } },
        profiles: { default: { layers: ['mcp/notes', 'instructions/main'] } },
      }),
    );
    const asset = path.join(host.fleet, 'assets', 'components', 'instructions', 'main.md');

    // Act
    const staged = await host.catalog.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Written by this apply.\n',
      create: false,
    });
    const outcome = await host.catalog.apply(staged.id, LOCAL);

    // Assert — the preview did not refuse the not-yet-written source, and the apply wrote both.
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(await readFile(asset, 'utf8')).equal('Written by this apply.\n');
    const ids = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8'));
    should(await readlink(path.join(host.fleet, 'homes', ids.runtimes['codex-default'].id, 'AGENTS.md'))).equal(asset);
  });

  it('should acknowledge only the configuration files an apply writes, never its assets or removals', async () => {
    // Arrange
    const host = await machine();
    const added = await host.catalog.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Main guidance.\n',
      create: true,
    });

    // Act — one apply that writes a config file and an asset, then one that removes the config file.
    await host.catalog.apply(added.id, LOCAL);
    const afterAdd = [...host.acknowledged];
    const removed = await host.catalog.propose({
      kind: 'component.remove',
      componentKind: 'instructions',
      name: 'main',
    });
    await host.catalog.apply(removed.id, LOCAL);

    // Assert — the exact text that landed was acknowledged before it landed, and nothing else.
    should(afterAdd.map(entry => entry.path)).deepEqual(['components/instructions/main.yaml']);
    should(afterAdd[0]?.text).containEql('file: components/instructions/main.md');
    should(host.acknowledged).deepEqual(afterAdd);
    should(await failure(stat(path.join(host.config, 'components', 'instructions', 'main.yaml')))).match({
      code: 'ENOENT',
    });
  });

  it('should put a reviewed loosening into effect at once rather than hold it for confirmation', async () => {
    // Arrange
    const host = await machine();
    const staged = await host.catalog.propose({
      ...SETTINGS,
      agentControl: { ...SETTINGS.agentControl, ferretrySettings: true },
    });

    // Act
    const outcome = await host.catalog.apply(staged.id, LOCAL);
    const { evaluation } = await host.service.load();

    // Assert
    should(outcome).match({ outcome: 'applied' });
    should(evaluation.pending).deepEqual([]);
    should(evaluation.effective.model.machine.agentControl.ferretrySettings).be.true();
    should(host.acknowledged).deepEqual([
      { path: 'machine.yaml', text: await readFile(path.join(host.config, 'machine.yaml'), 'utf8') },
    ]);
  });

  it('should refuse a stale change when a configuration file was edited on the host after review', async () => {
    // Arrange
    const host = await machine();
    const staged = await host.catalog.propose(SETTINGS);
    const profile = path.join(host.config, 'profiles', 'default.yaml');
    await writeFile(profile, `${await readFile(profile, 'utf8')}# edited by hand\n`);

    // Act
    const error = await failure(host.catalog.apply(staged.id, LOCAL));

    // Assert
    should(error).match({ code: 'fleet_change_stale' });
  });

  it('should answer the catalogue as unreadable while a retired configuration is there, naming the sentence, and touch nothing', async () => {
    // Arrange
    const host = await machine();
    const file = path.join(host.fleet, 'config.yaml');
    const text = 'version: 1\naccounts: []\n';
    await writeFile(file, text);

    // Act
    const [read, staged] = await Promise.all([
      failure(host.catalog.machine(LOCAL)),
      failure(host.catalog.propose(SETTINGS)),
    ]);

    // Assert
    const expected = `this machine's fleet configuration could not be read: ${RETIRED_FLEET_CONFIG_SENTENCE(file)}`;
    should(read).match({ code: 'fleet_catalog_unreadable', message: expected });
    should(staged).match({ code: 'fleet_catalog_unreadable', message: expected });
    should(await readFile(file, 'utf8')).equal(text);
  });

  it('should rename a runtime in one apply: its file with its comments, its id, its wrapper and the Warden login naming it', async () => {
    // Arrange — published once, so the runtime has an id, a config directory and a wrapper.
    const renames: unknown[] = [];
    const host = await machine(MODEL, {
      sessionRecords: async () => [
        { id: 's-1', name: 'Fisher', harness: 'codex', agent: 'codex-default', status: 'running' },
      ],
      renameSessions: async rename => {
        renames.push(rename);
        return 1;
      },
    });
    await host.catalog.apply((await host.catalog.propose(SETTINGS)).id, LOCAL);
    const runtimeFile = path.join(host.config, 'runtimes', 'codex-default.yaml');
    await writeFile(runtimeFile, `# the Codex I launch\n${await readFile(runtimeFile, 'utf8')}`);
    await writeFile(path.join(host.config, 'warden.yaml'), 'accounts:\n  - agent: codex-default\n');
    await host.service.load();
    const before = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8')).runtimes['codex-default'];

    // Act
    const staged = await host.catalog.propose({ kind: 'runtime.rename', name: 'codex-default', to: 'codex-work' });
    const outcome = await host.catalog.apply(staged.id, LOCAL);

    // Assert
    should(staged.preview).match({ runningSessions: [{ id: 's-1', name: 'Fisher', harness: 'codex' }] });
    should(renames).deepEqual([
      {
        from: 'codex-default',
        to: 'codex-work',
        fromWrapper: path.join(host.fleet, 'bin', 'codex-default'),
        toWrapper: path.join(host.fleet, 'bin', 'codex-work'),
      },
    ]);
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(await readFile(path.join(host.config, 'runtimes', 'codex-work.yaml'), 'utf8')).startWith(
      '# the Codex I launch\n',
    );
    should(await failure(stat(runtimeFile))).match({ code: 'ENOENT' });
    const ids = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8'));
    should(ids.runtimes['codex-work']).deepEqual({ id: before.id, formerNames: ['codex-default'] });
    should(ids.runtimes['codex-default']).be.undefined();
    should((await stat(path.join(host.fleet, 'homes', before.id))).isDirectory()).be.true();
    should((await stat(path.join(host.fleet, 'bin', 'codex-work'))).isFile()).be.true();
    should(await failure(stat(path.join(host.fleet, 'bin', 'codex-default')))).match({ code: 'ENOENT' });
    should(await readFile(path.join(host.config, 'warden.yaml'), 'utf8')).match(/agent: codex-work/);
    should((await host.service.inEffect()).evaluation.effective.warden.accounts).deepEqual([{ agent: 'codex-work' }]);
  });

  it('should refuse a change when ids.json exists and cannot be read, rather than minting new ids', async () => {
    // Arrange
    const host = await machine();
    await writeFile(path.join(host.fleet, 'ids.json'), '{ not json');

    // Act
    const error = await failure(host.catalog.propose(SETTINGS));

    // Assert
    should(error).be.instanceOf(Error);
  });

  it('should refuse to read ids when ids.json is present but is not a readable file, rather than reading none', async () => {
    // Arrange — the ids document's place is taken by a directory, so the read fails with something other than ENOENT.
    const host = await machine();
    await mkdir(path.join(host.fleet, 'ids.json'), { recursive: true });

    // Act
    const error = await failure(host.deps.ids());

    // Assert
    should((error as NodeJS.ErrnoException).code).equal('EISDIR');
  });
});

describe('remote component credential boundary', () => {
  const values = [
    '7b3c91af0826d54e10f9ab7d62483c5e91ad02fb',
    'aZ9kL2mN8pQ4rS6tU0vW3xY5zA7bC1dE9fG2hI4jK6M=',
    'FAKEopaque0123456789abcdefXYZ123456789',
  ];
  const sources = ['fleet/credentials/C1/auth.json', 'state/secrets.key', 'state/login-secrets.json'];
  const bodies = [
    JSON.stringify({ tokens: { access_token: values[0] } }),
    values[1] as string,
    JSON.stringify({ github: { value: values[2] } }),
  ];

  const answer = async (host: Machine, loopback: boolean): Promise<string> => {
    const api = new ApiDispatcher(new ApiRouter(fleetCatalogRoutes(host.catalog)), CREDENTIALS, GRANTED);
    const response = await api.dispatch(
      request({
        path: '/v1/fleet/components',
        loopback,
        clientAddress: '127.0.0.1',
        headers: { ...human, host: '127.0.0.1' },
      }),
    );
    should(response.status).equal(200);
    return JSON.stringify(jsonBody(response));
  };

  for (const operation of ['mv', 'cp'] as const) {
    it(`should hide every fake credential after ${operation} into a declared component directory`, async () => {
      // Arrange — files exist before boot; no catalogue read precedes the move.
      const generatedBodies = [...bodies];
      let generatedValues: readonly string[] = [];
      const model = parseAccountModel({
        version: 2,
        components: {
          instructions: Object.fromEntries(sources.map((_, i) => [`fake${i}`, { file: `components/fake${i}.md` }])),
          settings: {
            auth: { harness: 'claude', file: 'components/fake0.md' },
            login: { harness: 'claude', file: 'components/fake2.md' },
          },
          hooks: { auth: { harness: 'claude', file: 'components/fake0.md' } },
        },
      });
      const host = await machine(model, undefined, async home => {
        const files = new StateFileSystem(home.paths);
        const document = new FileSecretDocumentStore(home.paths, files, LOGIN_SECRETS_DOCUMENT);
        const key = new FileSecretKey(document.keyFile, files, () =>
          Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + 17) % 256),
        );
        const cipher = new WebCryptoSecretCipher(key, () =>
          Uint8Array.from({ length: 12 }, (_, i) => (i * 13 + 19) % 256),
        );
        const sealed = await cipher.seal(SecretNameSchema.parse('SYNTHETIC_LOGIN'), 'synthetic login password');
        await document.write({
          v: 1,
          cipher: cipher.algorithm,
          entries: {
            SYNTHETIC_LOGIN: { ...sealed, createdAt: '2026-11-28T00:00:00Z', updatedAt: '2026-11-28T00:00:00Z' },
          },
        });
        generatedBodies[1] = await readFile(document.keyFile, 'utf8');
        generatedBodies[2] = await readFile(path.join(home.paths.state, LOGIN_SECRETS_DOCUMENT), 'utf8');
        generatedValues = [values[0] as string, generatedBodies[1].trim(), sealed.iv, sealed.ciphertext];
        should(generatedValues[1]).have.length(44);
        for (const [i, source] of sources.entries()) {
          const file = path.join(home.paths.home, source);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, generatedBodies[i] as string);
        }
      });
      const destination = path.join(host.paths.fleet, 'assets/components');
      await mkdir(destination, { recursive: true });
      for (const [i, source] of sources.entries()) {
        const from = path.join(host.paths.home, source);
        const to = path.join(destination, `fake${i}.md`);
        if (operation === 'mv') await rename(from, to);
        else await copyFile(from, to);
      }

      // Act
      const remote = await answer(host, false);
      const local = await answer(host, true);

      // Assert — copies have fresh identities; each unnamed value must still be hidden.
      for (const value of generatedValues) should(remote).not.containEql(value);
      for (const [i] of sources.entries()) {
        should(await host.deps.readAsset(path.join(destination, `fake${i}.md`))).equal(generatedBodies[i]);
      }
      if (operation === 'cp') should(local).containEql('‹hidden›');
      else should(local).not.containEql('not served remotely');
    });
  }

  it('should retain boot and rotated key identities after both source paths disappear', async () => {
    // Arrange
    const host = await machine(MODEL, undefined, async home => {
      await writeFile(path.join(home.paths.state, 'secrets.key'), values[1] as string);
    });
    const directory = path.join(host.paths.fleet, 'assets');
    await mkdir(directory, { recursive: true });
    const key = path.join(host.paths.state, 'secrets.key');
    const oldKey = path.join(directory, 'old.md');
    const newKey = path.join(directory, 'new.md');
    await rename(key, oldKey);
    await writeFile(key, values[0] as string);
    // A refresh sees a replacement identity without forgetting the boot identity.
    await host.deps.readRemoteAsset?.(oldKey);
    await rename(key, newKey);

    // Act + Assert — repeated path misses never drop either identity.
    for (let attempt = 0; attempt < 2; attempt++) {
      should(await host.deps.readRemoteAsset?.(oldKey)).be.undefined();
      should(await host.deps.readRemoteAsset?.(newKey)).be.undefined();
      should(await host.deps.readAsset(oldKey)).equal(values[1]);
      should(await host.deps.readAsset(newKey)).equal(values[0]);
    }
  });

  it('should refuse an escaping symlink remotely, preserve local text and serve a normal sibling', async () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      components: {
        instructions: {
          escape: { file: 'components/escape.md' },
          normal: { file: 'components/normal.md' },
          state: { file: 'components/state.md' },
        },
      },
    });
    const host = await machine(model);
    const directory = path.join(host.paths.fleet, 'assets/components');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(host.root, 'outside.md'), 'outside private prose');
    await writeFile(path.join(host.paths.state, 'other.md'), 'inside state prose');
    await symlink(path.join(host.root, 'outside.md'), path.join(directory, 'escape.md'));
    await symlink(path.join(host.paths.state, 'other.md'), path.join(directory, 'state.md'));
    await writeFile(path.join(directory, 'normal.md'), '# Normal component\nUseful instructions.');

    // Act
    const remote = await answer(host, false);
    const local = await answer(host, true);

    // Assert — forged Host and peer look local; the carrier says otherwise.
    should(remote).not.containEql('outside private prose');
    should(remote).not.containEql('inside state prose');
    should(remote).containEql('contentUnavailable');
    should(remote).containEql('not served remotely');
    should(remote).containEql('# Normal component');
    should(local).containEql('outside private prose');
    should(local).not.containEql('not served remotely');
  });

  it('should use remote bodies for a limited device on a loopback peer, including a caller-chosen conflict', async () => {
    const fake = values[1] as string;
    const model = parseAccountModel({
      version: 2,
      credentials: { login: { harness: 'claude', store: 'host' } },
      components: {
        settings: {
          moved: { harness: 'claude', file: 'components/moved.json' },
          copied: { harness: 'claude', file: 'components/copied.json' },
          other: { harness: 'claude', file: 'components/other.json' },
        },
      },
      profiles: { conflict: { layers: ['settings/moved', 'settings/copied', 'settings/other'] } },
      runtimes: { worker: { credential: 'login', profile: 'conflict' } },
    });
    const host = await machine(model, undefined, async home => {
      await writeFile(
        path.join(home.paths.state, 'login-secrets.json'),
        JSON.stringify({ theme: 'private moved value' }),
      );
    });
    const directory = path.join(host.paths.fleet, 'assets/components');
    await mkdir(directory, { recursive: true });
    await rename(path.join(host.paths.state, 'login-secrets.json'), path.join(directory, 'moved.json'));
    await writeFile(path.join(directory, 'copied.json'), JSON.stringify({ theme: fake }));
    await writeFile(path.join(directory, 'other.json'), JSON.stringify({ theme: 'light' }));
    const grants = new CapabilityGrantService({
      document: { read: async () => DEFAULT_CAPABILITY_GRANTS, written: async () => [], write: async () => undefined },
      clock: { nowMs: () => Date.parse('2026-11-28T00:00:00.000Z') },
      audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clientName: 'fy',
    });
    await grants.refresh();
    const credentials = { ...CREDENTIALS, devices: { has: () => true, grants: () => LIMITED_DEVICE_GRANTS } };
    let localReads = 0;
    let remoteReads = 0;
    const catalog = new FleetCatalogService({
      ...host.deps,
      readAsset: async file => {
        localReads++;
        return await host.deps.readAsset(file);
      },
      readRemoteAsset: async file => {
        remoteReads++;
        return await host.deps.readRemoteAsset?.(file);
      },
    });
    const api = new ApiDispatcher(new ApiRouter(fleetCatalogRoutes(catalog)), credentials, grants);
    for (const endpoint of ['components', 'profiles', 'runtimes', 'profiles/preview']) {
      const preview = endpoint.endsWith('preview');
      const response = await api.dispatch(
        request({
          path: `/v1/fleet/${endpoint}`,
          method: preview ? 'POST' : 'GET',
          loopback: true,
          device: { deviceId: 'limited', appSession: 'limited-app' },
          ...(preview
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ layers: ['settings/moved', 'settings/copied', 'settings/other'] }),
              }
            : {}),
        }),
      );
      should(response.status).equal(200);
      const body = JSON.stringify(jsonBody(response));
      should(body).not.containEql(fake);
      should(body).not.containEql('private moved value');
      if (preview || endpoint === 'profiles') should(body).containEql('overrides');
    }
    should(localReads).equal(0);
    should(remoteReads).be.above(0);
    const forbidden = await api.dispatch(
      request({
        path: '/v1/fleet/proposals',
        method: 'POST',
        loopback: true,
        device: { deviceId: 'limited', appSession: 'limited-app' },
        body: '{}',
      }),
    );
    should(forbidden.status).equal(403);
  });

  it('should preserve benign code identifiers and inline Markdown images in local and remote component content', async () => {
    const benign =
      'Call `isUserVerifyingPlatformAuthenticatorAvailable()`.\n![dot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)\n';
    const host = await machine(
      parseAccountModel({ version: 2, components: { instructions: { benign: { file: 'components/benign.md' } } } }),
    );
    const file = path.join(host.paths.fleet, 'assets/components/benign.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, benign);
    for (const remote of [false, true]) {
      const catalog = await host.catalog.components(remote);
      should(catalog.kinds.flatMap(group => group.components).find(row => row.name === 'benign')?.content).deepEqual({
        form: 'text',
        text: benign,
        redacted: false,
      });
    }
  });
});

describe('whether the launcher scripts on disk are the ones a plan would write', () => {
  const plan = (...operations: unknown[]) => ({ operations }) as never;

  it('should say current only when every wrapper under the bin directory already holds its planned content', async () => {
    // Arrange
    const host = await machine();
    const bin = host.deps.layout.binDirectory;
    const wrapper = path.join(bin, 'claude-default');
    const planned = { kind: 'file', path: wrapper, content: '#!/bin/sh\nexec /opt/h/claude "$@"\n', mode: 0o755 };
    const outsider = {
      kind: 'file',
      path: path.join(host.root, 'elsewhere.txt'),
      content: 'never written',
      mode: 0o600,
    };
    const prune = { kind: 'prune', path: bin, marker: 'managed', keep: [] };

    // Act
    const absent = await host.deps.wrappersCurrent?.(plan(planned));
    await mkdir(bin, { recursive: true });
    await writeFile(wrapper, '#!/bin/sh\nexec claude "$@"\n');
    const stale = await host.deps.wrappersCurrent?.(plan(planned));
    await writeFile(wrapper, planned.content);
    const current = await host.deps.wrappersCurrent?.(plan(prune, planned, outsider));

    // Assert — a file outside the bin directory and a non-file operation never count against it
    should(absent).be.false();
    should(stale).be.false();
    should(current).be.true();
  });
});
