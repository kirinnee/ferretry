/**
 * The account model's catalogue over real files: `config.yaml` read with its digest, component
 * documents read and refused, and a reviewed change staged and applied by the real provisioner in a
 * temporary state home.
 *
 * The apply is the evidence for one question the design left open: may a change that ADDS a component
 * file also materialise a link to it, when that file does not exist until the same apply writes it?
 * It may. Preview never stats a link's source, and apply proves a source that is one of its own
 * documents from the document rather than from the disk — so the new file and every link to it land
 * together, inside one rollback boundary. No real harness, account or home is touched.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAccountModel, RETIRED_FLEET_CONFIG_SENTENCE, RetiredFleetConfigError, renderConfig } from '@ferretry/fleet';
import should from 'should';
import {
  documentRevision,
  fileFleetCatalogDeps,
  readAccountDocument,
  readComponentText,
} from '../../../src/adapters/fleet/account-model-files.ts';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { FleetCatalogService } from '../../../src/lib/fleet/catalog-service.ts';

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

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const LOCAL: CallerGovernance = {
  governed: false,
  passwordSet: false,
  confirmChange: false,
  decide: () => ({ allowed: true, refusal: 'granted' }),
} as never;

const MODEL = parseAccountModel({
  version: 2,
  credentials: { 'codex-slot': { harness: 'codex', store: 'ferretry' } },
  components: { mcp: { notes: { command: 'notes-server' } } },
  profiles: { default: { layers: ['mcp/notes'] } },
  runtimes: { 'codex-default': { credential: 'codex-slot', profile: 'default' } },
});

interface Machine {
  readonly root: string;
  readonly fleet: string;
  readonly service: FleetCatalogService;
  states: unknown[];
}

async function machine(): Promise<Machine> {
  const root = await temporary();
  const home = path.join(root, 'state');
  const fleet = path.join(home, 'fleet');
  const userHome = path.join(root, 'person');
  await mkdir(fleet, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await writeFile(path.join(fleet, 'config.yaml'), renderConfig(MODEL));
  const handle: Machine = { root, fleet, service: undefined as never, states: [] };
  const deps = fileFleetCatalogDeps({
    paths: { home: home as never, fleet, fleetManifest: path.join(fleet, 'manifest.json') },
    userHome,
    hostCodexHome: path.join(userHome, '.codex'),
    sessionStates: async () => handle.states,
    credentials: {
      list: async () => ({ format: 2, machine: 'studio', credentials: [] }),
      signOut: async () => {
        throw new Error('not exercised');
      },
    },
    confirmChange: async () => ({ kind: 'confirmed' }),
    locate: () => undefined,
    machineName: () => 'studio',
    clientName: 'fy',
  });
  return Object.assign(handle, { service: new FleetCatalogService(deps) });
}

describe('reading the account model from disk', () => {
  it('should read a version-2 configuration with the digest of its exact bytes', async () => {
    // Arrange
    const root = await temporary();
    const file = path.join(root, 'config.yaml');
    const text = renderConfig(MODEL);
    await writeFile(file, text);

    // Act
    const reading = await readAccountDocument(file);

    // Assert
    should(reading.format).equal('version-2');
    should(reading.revision).equal(sha256(text));
    should(Object.keys(reading.model.runtimes)).deepEqual(['codex-default']);
  });

  it('should read no file as an empty model', async () => {
    // Arrange
    const root = await temporary();

    // Act
    const none = await readAccountDocument(path.join(root, 'absent.yaml'));

    // Assert
    should(none).match({ format: 'none', revision: 'absent' });
    should(Object.keys(none.model.runtimes)).deepEqual([]);
  });

  it.each([
    ['version 1', 'version: 1\naccounts: []\n'],
    ['no version', 'agents: []\n'],
    ['empty', ''],
    ['an empty mapping', '{}\n'],
  ])('should refuse a configuration in the retired format (%s) and leave it byte-for-byte untouched', async (_, text) => {
    // Arrange
    const root = await temporary();
    const file = path.join(root, 'config.yaml');
    await writeFile(file, text);

    // Act
    const error = await readAccountDocument(file).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert — refused rather than converted, with the sentence that says how to set the machine up again.
    should(error).be.instanceOf(RetiredFleetConfigError);
    should((error as Error).message).equal(RETIRED_FLEET_CONFIG_SENTENCE(file));
    should(await readFile(file, 'utf8')).equal(text);
  });

  it('should throw for a configuration that exists and cannot be read', async () => {
    // Arrange
    const root = await temporary();

    // Act
    const error = await readAccountDocument(root).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(Error);
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
    const unreadable = await documentRevision(root).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

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
    const component = await host.service.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Main guidance.\n',
      create: true,
    });
    await host.service.apply(component.id, {}, LOCAL);

    // Act — a profile that now has it as a layer: the link's source exists only because of the last apply.
    const profile = await host.service.propose({
      kind: 'profile.put',
      name: 'default',
      layers: ['mcp/notes', 'instructions/main'],
      create: false,
    });
    const outcome = await host.service.apply(profile.id, {}, LOCAL);

    // Assert
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    const asset = path.join(host.fleet, 'assets', 'components', 'instructions', 'main.md');
    should(await readFile(asset, 'utf8')).equal('Main guidance.\n');
    const ids = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8'));
    const runtimeHome = path.join(host.fleet, 'homes', ids.runtimes['codex-default'].id);
    should(await readlink(path.join(runtimeHome, 'AGENTS.md'))).equal(asset);
    const written = await readAccountDocument(path.join(host.fleet, 'config.yaml'));
    should(written.model.profiles.default?.layers).deepEqual(['mcp/notes', 'instructions/main']);
    should((await host.service.machine(LOCAL)).runningSessions).equal(1);
  });

  it('should write a component file and link it in the SAME apply, when that apply is what creates the file', async () => {
    // Arrange: a profile already names instructions whose file is not on disk yet.
    const host = await machine();
    const withMissingFile = parseAccountModel({
      ...JSON.parse(JSON.stringify(MODEL)),
      components: { ...MODEL.components, instructions: { main: { file: 'components/instructions/main.md' } } },
      profiles: { default: { layers: ['mcp/notes', 'instructions/main'] } },
    });
    await writeFile(path.join(host.fleet, 'config.yaml'), renderConfig(withMissingFile));
    const asset = path.join(host.fleet, 'assets', 'components', 'instructions', 'main.md');

    // Act
    const staged = await host.service.propose({
      kind: 'component.put',
      name: 'main',
      component: { kind: 'instructions' },
      content: 'Written by this apply.\n',
      create: false,
    });
    const outcome = await host.service.apply(staged.id, {}, LOCAL);

    // Assert — the preview did not refuse the not-yet-written source, and the apply wrote both.
    should(outcome).match({ outcome: 'applied', apply: { outcome: 'committed' } });
    should(await readFile(asset, 'utf8')).equal('Written by this apply.\n');
    const ids = JSON.parse(await readFile(path.join(host.fleet, 'ids.json'), 'utf8'));
    should(await readlink(path.join(host.fleet, 'homes', ids.runtimes['codex-default'].id, 'AGENTS.md'))).equal(asset);
  });

  it('should refuse a stale change when the configuration was edited on the host after review', async () => {
    // Arrange
    const host = await machine();
    const staged = await host.service.propose({ kind: 'machine.settings', agentPermissions: 'skip' });
    await writeFile(path.join(host.fleet, 'config.yaml'), `${renderConfig(MODEL)}# edited by hand\n`);

    // Act
    const error = await host.service.apply(staged.id, {}, LOCAL).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).match({ code: 'fleet_change_stale' });
  });

  it('should answer the catalogue as unreadable on a retired configuration, naming the sentence, and touch nothing', async () => {
    // Arrange
    const host = await machine();
    const file = path.join(host.fleet, 'config.yaml');
    const text = 'version: 1\naccounts: []\n';
    await writeFile(file, text);

    // Act
    const [read, staged] = await Promise.all(
      [host.service.machine(LOCAL), host.service.propose({ kind: 'machine.settings', agentPermissions: 'skip' })].map(
        async work =>
          await work.then(
            () => undefined,
            (thrown: unknown) => thrown,
          ),
      ),
    );

    // Assert
    const expected = `this machine's fleet configuration could not be read: ${RETIRED_FLEET_CONFIG_SENTENCE(file)}`;
    should(read).match({ code: 'fleet_catalog_unreadable', message: expected });
    should(staged).match({ code: 'fleet_catalog_unreadable', message: expected });
    should(await readFile(file, 'utf8')).equal(text);
  });

  it('should refuse a change when ids.json exists and cannot be read, rather than minting new ids', async () => {
    // Arrange
    const host = await machine();
    await writeFile(path.join(host.fleet, 'ids.json'), '{ not json');

    // Act
    const error = await host.service.propose({ kind: 'machine.settings', agentPermissions: 'skip' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).be.instanceOf(Error);
  });
});
