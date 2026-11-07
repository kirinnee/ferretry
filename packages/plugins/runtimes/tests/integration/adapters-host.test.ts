/**
 * The small file adapters over the seams in `daemon/adapters/ports.ts`, run against a temp directory this test made
 * (a stand-in for the kernel's host). Nothing here reads a real home.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  componentSourceFence,
  documentRevision,
  readConfigAccountDocument,
  readDeclaredAccountModel,
  runtimeFileMoves,
  sessionStatusOf,
} from '../../daemon/adapters/account-model-files.ts';
import { readFleetManifest } from '../../daemon/adapters/manifest-file.ts';
import {
  adapterHostFrom,
  type ConfigFilesPort,
  refusedHostFiles,
  refusedProvisionerKernel,
} from '../../daemon/adapters/ports.ts';
import { RuntimeIdsFile } from '../../daemon/adapters/runtime-ids-file.ts';
import { RuntimeSessionRecords } from '../../daemon/adapters/runtime-session-records.ts';
import { MAX_FOLDER_FILES, readTextFolder, skillItemsIn } from '../../daemon/adapters/setup-files.ts';
import { ABSENT_DOCUMENT_REVISION } from '../../daemon/lib/provisioning.ts';
import { nodeHostFiles } from './support/node-host.ts';

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fy-adapters-'));
  created.push(dir);
  return dir;
}

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('the refused seams', () => {
  it('should refuse a host file read with a sentence that names what is missing, never reading the disk', async () => {
    // Act
    const act = refusedHostFiles.readText('/anywhere');

    // Assert
    await should(act).be.rejectedWith(/the host's files is not available to the Runtimes plugin yet/u);
  });

  it('should refuse the provisioner helpers rather than falling back to node:fs', () => {
    // Act
    const act = () => refusedProvisionerKernel.applyLockFor('/anywhere/manifest.json');

    // Assert
    should(act).throw(/not available to the Runtimes plugin yet/u);
  });

  it('should take the time from the kernel clock', () => {
    // Arrange
    const host = adapterHostFrom({ clock: { nowMs: () => 1234 } as never });

    // Act / Assert
    should(host.now()).equal(1234);
  });
});

describe('the fleet manifest reader', () => {
  it('should answer nothing when no apply has published a manifest', async () => {
    // Arrange
    const root = await temp();

    // Act
    const found = await readFleetManifest(nodeHostFiles, path.join(root, 'manifest.json'));

    // Assert
    should(found).be.undefined();
  });

  it('should refuse text that is not JSON, naming the file', async () => {
    // Arrange
    const file = path.join(await temp(), 'manifest.json');
    await put(file, '{nope');

    // Act
    const act = readFleetManifest(nodeHostFiles, file);

    // Assert
    await should(act).be.rejectedWith(`the fleet manifest at ${file} is not valid JSON`);
  });

  it('should refuse JSON that is not a manifest', async () => {
    // Arrange
    const file = path.join(await temp(), 'manifest.json');
    await put(file, '{"version":1}');

    // Act
    const act = readFleetManifest(nodeHostFiles, file);

    // Assert
    await should(act).be.rejectedWith(`the fleet manifest at ${file} is not a fleet manifest`);
  });

  it('should read a manifest', async () => {
    // Arrange
    const file = path.join(await temp(), 'manifest.json');
    await put(file, JSON.stringify({ version: 1, generatedAt: '2026-11-07T00:00:00.000Z', accounts: [], runtimes: [] }));

    // Act
    const found = await readFleetManifest(nodeHostFiles, file);

    // Assert
    should(found?.accounts).deepEqual([]);
  });
});

describe('ids.json', () => {
  it('should answer nothing when the file is absent', async () => {
    // Arrange
    const file = path.join(await temp(), 'ids.json');

    // Act / Assert
    should(await new RuntimeIdsFile(nodeHostFiles, file).ids()).be.undefined();
  });

  it('should throw, naming the file, when it exists and cannot be read', async () => {
    // Arrange
    const file = path.join(await temp(), 'ids.json');
    await put(file, 'not json');

    // Act
    const act = new RuntimeIdsFile(nodeHostFiles, file).ids();

    // Assert
    await should(act).be.rejectedWith(new RegExp(`${file.replaceAll('.', '\\.')} could not be read`, 'u'));
  });

  it('should read an empty set of runtimes', async () => {
    // Arrange
    const file = path.join(await temp(), 'ids.json');
    await put(file, JSON.stringify({ version: 1, runtimes: {} }));

    // Act
    const ids = await new RuntimeIdsFile(nodeHostFiles, file).ids();

    // Assert
    should(ids).deepEqual({ version: 1, runtimes: {} });
  });
});

describe('runtime session records', () => {
  const storage = (configs: Record<string, unknown>, states: Record<string, unknown>) => {
    const written: Record<string, unknown> = { ...configs };
    return {
      written,
      listSessions: () => Object.keys(configs).map(id => ({ id })),
      readConfig: async (id: string) => written[id],
      readState: async (id: string) => {
        if (!(id in states)) throw new Error('unreadable');
        return states[id];
      },
      updateConfig: async (id: string, change: (current: unknown) => unknown) => {
        written[id] = change(written[id]);
      },
    };
  };

  it('should leave out a record that cannot be read, rather than failing the card that asked', async () => {
    // Arrange
    const records = new RuntimeSessionRecords(
      storage(
        {
          one: { agent: 'work', harness: 'claude', name: 'First', command: ['/bin/work'] },
          two: { agent: 'work', harness: 'claude' },
          three: { agent: 'work', harness: 'other' },
        },
        { one: { status: 'running' }, three: { status: 'running' } },
      ),
    );

    // Act
    const found = await records.sessionRecords();

    // Assert
    should(found).deepEqual([
      { id: 'one', name: 'First', harness: 'claude', agent: 'work', executable: '/bin/work', status: 'running' },
    ]);
  });

  it('should re-point only the records that name the old runtime', async () => {
    // Arrange
    const store = storage(
      { one: { agent: 'old', command: ['/old', '-x'] }, two: { agent: 'other' } },
      { one: { status: 'running' }, two: { status: 'running' } },
    );

    // Act
    const moved = await new RuntimeSessionRecords(store).renameSessions({
      from: 'old',
      to: 'new',
      fromWrapper: '/old',
      toWrapper: '/new',
    });

    // Assert
    should(moved).equal(1);
    should(store.written.one).deepEqual({ agent: 'new', command: ['/new', '-x'] });
    should(store.written.two).deepEqual({ agent: 'other' });
  });
});

describe('reading folders as text', () => {
  it('should read regular files relative to the folder, and skip links, version control and big files by name', async () => {
    // Arrange
    const root = await temp();
    await put(path.join(root, 'a.md'), 'alpha');
    await put(path.join(root, 'nested/b.md'), 'beta');
    await put(path.join(root, '.git/config'), 'ignored');
    await put(path.join(root, 'big.md'), 'x'.repeat(256 * 1024 + 1));
    await symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));

    // Act
    const reading = await readTextFolder(nodeHostFiles, root);

    // Assert
    should(reading.files).deepEqual([
      { path: 'a.md', content: 'alpha' },
      { path: 'nested/b.md', content: 'beta' },
    ]);
    should(reading.skipped).deepEqual([
      { path: 'big.md', reason: 'it is too large' },
      { path: 'link.md', reason: 'it is a link or a special file' },
    ]);
  });

  it('should read a folder that does not exist as empty', async () => {
    // Arrange
    const root = await temp();

    // Act
    const reading = await readTextFolder(nodeHostFiles, path.join(root, 'missing'));

    // Assert
    should(reading).deepEqual({ files: [], skipped: [] });
  });

  it('should take no more files than the limit and name the rest', async () => {
    // Arrange
    const root = await temp();
    for (let index = 0; index < MAX_FOLDER_FILES + 1; index += 1) await put(path.join(root, `f${String(index).padStart(4, '0')}`), 'x');

    // Act
    const reading = await readTextFolder(nodeHostFiles, root);

    // Assert
    should(reading.files.length).equal(MAX_FOLDER_FILES);
    should(reading.skipped).deepEqual([{ path: `f${String(MAX_FOLDER_FILES).padStart(4, '0')}`, reason: 'the folder has too many files' }]);
  });

  it('should list a skills store as its item folders, sorted, hidden ones left out', async () => {
    // Arrange
    const root = await temp();
    await put(path.join(root, 'zeta/SKILL.md'), 'z');
    await put(path.join(root, 'alpha/SKILL.md'), 'a');
    await put(path.join(root, '.hidden/SKILL.md'), 'h');
    await put(path.join(root, 'stray-file'), 's');

    // Act / Assert
    should(await skillItemsIn(nodeHostFiles, root)).deepEqual(['alpha', 'zeta']);
    should(await skillItemsIn(nodeHostFiles, path.join(root, 'none'))).deepEqual([]);
  });
});

describe('the account model files', () => {
  it('should give a document its sha256, or the absent sentinel', async () => {
    // Arrange
    const root = await temp();
    await put(path.join(root, 'doc'), 'hello');

    // Act / Assert
    should(await documentRevision(nodeHostFiles, path.join(root, 'doc'))).equal(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    should(await documentRevision(nodeHostFiles, path.join(root, 'none'))).equal(ABSENT_DOCUMENT_REVISION);
  });

  it('should fence the daemon directories and open the asset tree', () => {
    // Act
    const fence = componentSourceFence({ home: '/h', state: '/h/state', config: '/h/config', fleet: '/h/fleet' });

    // Assert
    should(fence).deepEqual({ homes: ['/h', '/h/state', '/h/config'], open: ['/h/fleet/assets'] });
  });

  it('should name a renamed runtime file new path to old path, under runtimes/', () => {
    // Act / Assert
    should([...runtimeFileMoves({ from: 'old', to: 'new' })]).deepEqual([['runtimes/new.yaml', 'runtimes/old.yaml']]);
    should(runtimeFileMoves(undefined).size).equal(0);
  });

  it('should read only a status a session state document can say', () => {
    // Act / Assert
    should(sessionStatusOf({ status: 'running' })).equal('running');
    should(sessionStatusOf({ status: 'bogus' })).be.undefined();
    should(sessionStatusOf(null)).be.undefined();
  });

  const fake = (fleetFiles: number): ConfigFilesPort<{ readonly marker: string }> => {
    const load = {
      evaluation: { fleetFiles, fleetRevision: 'rev-1', effective: { model: { marker: 'now' } } },
      files: {},
    };
    return {
      inEffect: async () => load,
      load: async () => load,
      editsFor: (_load, next, moved) => [
        { path: 'runtimes/new.yaml', content: `marker: ${next.marker}\n`, expect: `moved:${[...moved.values()].join(',')}` },
        { path: 'runtimes/gone.yaml', content: undefined, expect: 'etag-2' },
      ],
      mentionsRenamed: (_load, rename) => [{ path: 'warden.yaml', content: `to: ${rename.to}\n`, expect: 'etag-3' }],
      acknowledge: () => undefined,
      acknowledgeRemoval: () => undefined,
    };
  };

  it('should report a machine with no fleet files as none, and one with files as present', async () => {
    // Act
    const none = await readConfigAccountDocument(fake(0) as never, { configDirectory: '/h/config' });
    const present = await readConfigAccountDocument(fake(2) as never, { configDirectory: '/h/config' });

    // Assert
    should(none.format).equal('none');
    should(present.format).equal('present');
    should(present.revision).equal('rev-1');
    should(await readDeclaredAccountModel(fake(0) as never, { configDirectory: '/h/config' })).be.undefined();
  });

  it('should compose documents under the config directory, private, removing a file the model drops', async () => {
    // Arrange
    const reading = await readConfigAccountDocument(fake(1) as never, { configDirectory: '/h/config' });

    // Act
    const documents = reading.documents({ marker: 'next' } as never, { from: 'old', to: 'new' });

    // Assert
    should(documents).deepEqual([
      { path: '/h/config/runtimes/new.yaml', content: 'marker: next\n', mode: 0o600, expect: 'moved:runtimes/old.yaml' },
      { path: '/h/config/runtimes/gone.yaml', content: '', mode: 0o600, expect: 'etag-2', remove: true },
      { path: '/h/config/warden.yaml', content: 'to: new\n', mode: 0o600, expect: 'etag-3' },
    ]);
  });
});
