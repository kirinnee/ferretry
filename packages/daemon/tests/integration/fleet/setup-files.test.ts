/**
 * A machine's setup over real files: a folder read as text, the asset tree's skill items, and the
 * collaborators the setup service is composed from — the host scan and the secret store — in temporary
 * directories.
 *
 * Every path is inside a directory this test created and the person's "own" home is a temporary one,
 * so no real harness setup, login or fleet is read. Every credential is a placeholder.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FleetLayout } from '@ferretry/fleet';
import type { StoredCredentialMaterialReader } from '@ferretry/fleet/adapters';
import should from 'should';
import {
  fileFleetSetupDeps,
  MAX_FOLDER_FILE_BYTES,
  MAX_FOLDER_FILES,
  readTextFolder,
  skillItemsIn,
} from '../../../src/adapters/fleet/setup-files.ts';
import type { SetupCatalogDeps } from '../../../src/lib/fleet/setup-service.ts';

const NOW = 1_800_000_000_000;

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-setup-files-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })),
  );
});

const sha256 = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

describe('reading a folder as text', () => {
  it('should read nested files relative to the folder, in order, and enter neither version control nor the harness bundle', async () => {
    // Arrange
    const root = await temporary();
    await mkdir(path.join(root, 'notes', 'deep'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, '.system'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), '# skill');
    await writeFile(path.join(root, 'notes', 'one.md'), 'one');
    await writeFile(path.join(root, 'notes', 'deep', 'two.md'), 'two');
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref');
    await writeFile(path.join(root, '.system', 'bundled.md'), 'bundled');
    await writeFile(path.join(root, 'node_modules', 'dep.js'), 'dep');

    // Act
    const reading = await readTextFolder(root);

    // Assert
    should(reading.files).deepEqual([
      { path: 'SKILL.md', content: '# skill' },
      { path: 'notes/deep/two.md', content: 'two' },
      { path: 'notes/one.md', content: 'one' },
    ]);
    should(reading.skipped).deepEqual([]);
  });

  it('should skip a link, a file that is not text and a file that is too large, each with its reason', async () => {
    // Arrange
    const root = await temporary();
    await writeFile(path.join(root, 'real.md'), 'real');
    await symlink(path.join(root, 'real.md'), path.join(root, 'link.md'));
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    await writeFile(path.join(root, 'huge.txt'), 'a'.repeat(MAX_FOLDER_FILE_BYTES + 1));
    await writeFile(path.join(root, 'limit.txt'), 'a'.repeat(MAX_FOLDER_FILE_BYTES));

    // Act
    const reading = await readTextFolder(root);

    // Assert
    should(reading.files.map(file => file.path)).deepEqual(['limit.txt', 'real.md']);
    should(reading.skipped).deepEqual([
      { path: 'binary.bin', reason: 'it is not text' },
      { path: 'huge.txt', reason: 'it is too large' },
      { path: 'link.md', reason: 'it is a link or a special file' },
    ]);
  });

  it('should carry the files up to the limit and name every file past it', async () => {
    // Arrange
    const root = await temporary();
    const names = Array.from({ length: MAX_FOLDER_FILES + 2 }, (_, index) => `f${String(index).padStart(4, '0')}.md`);
    await Promise.all(names.map(async name => await writeFile(path.join(root, name), name)));

    // Act
    const reading = await readTextFolder(root);

    // Assert
    should(reading.files).have.length(MAX_FOLDER_FILES);
    should(reading.files[0]?.path).equal('f0000.md');
    should(reading.skipped).deepEqual(
      names.slice(MAX_FOLDER_FILES).map(name => ({ path: name, reason: 'the folder has too many files' })),
    );
  });

  it('should read a folder that does not exist, or is a file, as empty', async () => {
    // Arrange
    const root = await temporary();
    await writeFile(path.join(root, 'plain.md'), 'text');

    // Act
    const absent = await readTextFolder(path.join(root, 'nowhere'));
    const file = await readTextFolder(path.join(root, 'plain.md'));

    // Assert
    should(absent).deepEqual({ files: [], skipped: [] });
    should(file).deepEqual({ files: [], skipped: [] });
  });

  it('should rethrow a failure that is not a missing folder rather than call it empty', async () => {
    // Arrange: a link that points at itself, which readdir refuses with ELOOP
    const root = await temporary();
    const loop = path.join(root, 'loop');
    await symlink(loop, loop);

    // Act
    const reading = readTextFolder(loop);

    // Assert
    await should(reading).be.rejected();
  });
});

describe('listing the skill items of a store', () => {
  it('should list the folders, sorted, and neither a file nor a hidden folder', async () => {
    // Arrange
    const root = await temporary();
    await mkdir(path.join(root, 'zeta'));
    await mkdir(path.join(root, 'alpha'));
    await mkdir(path.join(root, '.system'));
    await writeFile(path.join(root, 'README.md'), 'not an item');

    // Act
    const items = await skillItemsIn(root);

    // Assert
    should(items).deepEqual(['alpha', 'zeta']);
  });

  it('should read an absent store as holding none', async () => {
    // Arrange
    const root = await temporary();

    // Act
    const items = await skillItemsIn(path.join(root, 'nowhere'));

    // Assert
    should(items).deepEqual([]);
  });

  it('should rethrow a failure that is not an absent store', async () => {
    // Arrange
    const root = await temporary();
    const loop = path.join(root, 'loop');
    await symlink(loop, loop);

    // Act
    const items = skillItemsIn(loop);

    // Assert
    await should(items).be.rejected();
  });
});

interface Machine {
  readonly root: string;
  readonly userHome: string;
  readonly layout: FleetLayout;
  readonly catalog: SetupCatalogDeps;
  readonly secrets: Map<string, string>;
  deps: ReturnType<typeof fileFleetSetupDeps>;
}

const credentials: StoredCredentialMaterialReader & {
  material(kind: string, home: string): Promise<{ outcome: 'absent' }>;
} = {
  storedMaterial: async () => ({ outcome: 'absent' }),
  material: async () => ({ outcome: 'absent' }),
};

async function machine(options: { codexHome?: boolean } = {}): Promise<Machine> {
  const root = await temporary();
  const userHome = path.join(root, 'person');
  const fleetDirectory = path.join(root, 'fy', 'fleet');
  await mkdir(userHome, { recursive: true });
  await mkdir(fleetDirectory, { recursive: true });
  const layout: FleetLayout = {
    stateHome: path.join(root, 'fy'),
    userHome,
    fleetDirectory,
    binDirectory: path.join(fleetDirectory, 'bin'),
    homesDirectory: path.join(fleetDirectory, 'homes'),
    assetsDirectory: path.join(fleetDirectory, 'assets'),
    manifestPath: path.join(fleetDirectory, 'manifest.json'),
    defaultHomeDirectories: { claude: path.join(userHome, '.claude'), codex: path.join(userHome, '.codex') },
  };
  const catalog = {
    layout,
    locate: (name: string) => (name === 'claude' ? '/fake/bin/claude' : undefined),
    now: () => NOW,
    ...(options.codexHome === false ? {} : { hostCodexHome: path.join(userHome, '.codex') }),
  } as unknown as SetupCatalogDeps;
  const secrets = new Map<string, string>();
  const handle: Machine = {
    root,
    userHome,
    layout,
    catalog,
    secrets,
    deps: undefined as never,
  };
  handle.deps = fileFleetSetupDeps({
    catalog,
    credentials,
    tools: { plans: () => [], install: async () => [] },
    secrets: {
      list: async () => [...secrets.keys()].map(name => ({ name })),
      put: async (name, value) => {
        secrets.set(name, value);
      },
    },
  });
  return handle;
}

describe('the setup service collaborators over a temporary machine', () => {
  it('should scan the person’s own harness setup from the home it was given, and never another', async () => {
    // Arrange
    const { deps, userHome } = await machine();
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await writeFile(path.join(userHome, '.claude', 'CLAUDE.md'), '# my rules\n');

    // Act
    const scan = await deps.scan();

    // Assert
    should(scan.map(harness => harness.harness)).deepEqual(['claude', 'codex']);
    should(scan[0]).containDeep({ harness: 'claude', command: '/fake/bin/claude' });
    should(scan[0]?.instructions).containDeep({ kind: 'text' });
    should(scan[0]?.instructions.source).startWith(userHome);
  });

  it('should scan a named Claude and Codex home in place of the defaults', async () => {
    // Arrange
    const { catalog, root, userHome } = await machine();
    const claudeHome = path.join(root, 'elsewhere', 'claude');
    const codexHome = path.join(root, 'elsewhere', 'codex');
    await mkdir(claudeHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(claudeHome, 'CLAUDE.md'), '# elsewhere\n');
    await writeFile(path.join(codexHome, 'AGENTS.md'), '# elsewhere too\n');
    const deps = fileFleetSetupDeps({
      catalog,
      claudeConfigDir: claudeHome,
      codexHome,
      credentials,
      tools: { plans: () => [], install: async () => [] },
      secrets: { list: async () => [], put: async () => {} },
    });

    // Act
    const scan = await deps.scan();

    // Assert
    should(scan[0]?.instructions.source).startWith(claudeHome);
    should(scan[1]?.instructions.source).startWith(codexHome);
    should(scan[0]?.instructions.source.startsWith(userHome)).be.false();
  });

  it('should list secret names and store a secret through the store’s own management side', async () => {
    // Arrange
    const { deps, secrets } = await machine();
    secrets.set('OPENAI_API_KEY', 'placeholder');

    // Act
    await deps.secrets.put('NOTES_TOKEN', 'placeholder-two');
    const names = await deps.secrets.names();

    // Assert
    should(names).deepEqual(['OPENAI_API_KEY', 'NOTES_TOKEN']);
    should(secrets.get('NOTES_TOKEN')).equal('placeholder-two');
  });

  it('should read the skill items from the asset tree and the folders it is asked for', async () => {
    // Arrange
    const { deps, layout } = await machine();
    await mkdir(path.join(layout.assetsDirectory, 'skills', 'review'), { recursive: true });
    await mkdir(path.join(layout.assetsDirectory, 'skills', '.hidden'), { recursive: true });
    await writeFile(path.join(layout.assetsDirectory, 'skills', 'review', 'SKILL.md'), '# review');

    // Act
    const items = await deps.skillItems();
    const folder = await deps.readFolder(path.join(layout.assetsDirectory, 'skills', 'review'));

    // Assert
    should(items).deepEqual(['review']);
    should(folder.files).deepEqual([{ path: 'SKILL.md', content: '# review' }]);
  });

  it('should digest text as sha256 hex', async () => {
    // Arrange
    const { deps } = await machine();

    // Act
    const digest = deps.digest('ferretry');

    // Assert
    should(digest).match(/^[0-9a-f]{64}$/u);
    should(digest).equal(sha256('ferretry'));
  });
});
