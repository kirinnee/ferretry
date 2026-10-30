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
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAccountModel, RETIRED_FLEET_CONFIG_SENTENCE, RetiredFleetConfigError } from '@ferretry/fleet';
import should from 'should';
import {
  documentRevision,
  fileFleetCatalogDeps,
  readComponentText,
  readConfigAccountDocument,
  readDeclaredAccountModel,
  sessionStatusOf,
} from '../../../src/adapters/fleet/account-model-files.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { FleetCatalogService, type FleetCatalogServiceDeps } from '../../../src/lib/fleet/catalog-service.ts';
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
  /** Every file the provisioner acknowledged, by path relative to the configuration directory. */
  readonly acknowledged: { readonly path: string; readonly text: string }[];
  states: unknown[];
}

const locations = (home: ConfigHome) => ({ configDirectory: home.paths.config, fleetDirectory: home.paths.fleet });

async function machine(
  model = MODEL,
  sessionRecords?: Required<Pick<FleetCatalogServiceDeps, 'sessionRecords' | 'renameSessions'>>,
): Promise<Machine> {
  const root = await temporary();
  const home = await configHome(path.join(root, 'state'));
  const userHome = path.join(root, 'person');
  await mkdir(userHome, { recursive: true });
  await writeModelFiles(home.paths.config, model);
  const acknowledged: { path: string; text: string }[] = [];
  const handle: Machine = {
    ...home,
    root,
    fleet: home.paths.fleet,
    config: home.paths.config,
    catalog: undefined as never,
    deps: undefined as never,
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
    },
    configDirectory: home.paths.config,
    ...(sessionRecords === undefined ? {} : { sessionRecords }),
  });
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

    // Act
    const texts = await Promise.all(
      ['main.md', 'huge.md', 'missing.md', '.'].map(async name => await readComponentText(path.join(root, name))),
    );

    // Assert
    should(texts).deepEqual(['Main guidance.\n', undefined, undefined, undefined]);
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
