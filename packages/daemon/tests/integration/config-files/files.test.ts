import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/protocol';
import should from 'should';
import { FileAcceptedConfigStore, FileConfigDirectory } from '../../../src/adapters/config-files/files.ts';
import { unrefFileEventTimers } from '../../../src/adapters/file-events/bun-file-event-source.ts';
import { platformFileEventSource } from '../../../src/adapters/file-events/platform.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { watchConfigFiles } from '../../../src/lib/config-files/watcher.ts';
import { FileEventHub } from '../../../src/lib/file-events/hub.ts';
import { createFoundationPaths } from '../../../src/lib/paths.ts';
import { resolveStateHome } from '../../../src/lib/state-home.ts';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly config: string;
  readonly state: string;
  readonly files: StateFileSystem;
  readonly directory: FileConfigDirectory;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fy-config-files-'));
  temporaryDirectories.push(root);
  const paths = createFoundationPaths(
    resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: join(root, 'user') }),
  );
  await mkdir(paths.config, { recursive: true });
  await mkdir(paths.state, { recursive: true });
  const files = new StateFileSystem(paths);
  return {
    root,
    config: paths.config,
    state: paths.state,
    files,
    directory: new FileConfigDirectory(paths.config, files),
  };
}

async function put(root: string, relative: string, text: string): Promise<void> {
  const target = join(root, relative);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, text);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('FileConfigDirectory', () => {
  it('should name every directory its walk reads, the root first, three levels deep at most', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'components/mcp/deeper/too-deep.yaml', 'name: no\n');
    await put(subject.config, 'logins/a.yaml', 'a: 1\n');
    await put(subject.config, '.schema/machine.yaml', 'not a config\n');

    // Act
    const directories = await subject.directory.directories();

    // Assert
    should(directories[0]).equal(subject.config);
    should(
      directories
        .slice(1)
        .map(directory => directory.slice(subject.config.length + 1))
        .toSorted(),
    ).deepEqual(['components', 'components/mcp', 'logins']);
  });

  it('should hear a file in a directory created after the watch began, by file events alone', async () => {
    // Arrange: events drive the watcher, and the backstop is far beyond the test.
    const subject = await fixture();
    const hub = new FileEventHub(platformFileEventSource(), unrefFileEventTimers, { settleMs: 10 });
    let loads = 0;
    const errors: unknown[] = [];
    const stop = watchConfigFiles({
      fingerprint: async () => await subject.directory.fingerprint(),
      onChange: async () => {
        loads += 1;
      },
      onError: error => errors.push(error),
      timers: {
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      events: {
        directories: async () => await subject.directory.directories(),
        subscribeDirectory: (path, listener) => hub.subscribeDirectory(path, listener),
      },
      debounceMs: 20,
    });
    try {
      await Bun.sleep(50);

      // Act: components/ and components/mcp/ do not exist when the watch begins.
      await mkdir(join(subject.config, 'components', 'mcp'), { recursive: true });
      await Bun.sleep(50);
      await writeFile(join(subject.config, 'components', 'mcp', 'github.yaml'), 'name: github\n');
      const deadline = Date.now() + 3_000;
      while (loads === 0 && Date.now() < deadline) await Bun.sleep(10);
      const afterFile = loads;
      await writeFile(join(subject.config, 'components', 'mcp', 'github.yaml'), 'name: github-2\n');
      while (loads === afterFile && Date.now() < deadline) await Bun.sleep(10);

      // Assert
      should(afterFile).be.aboveOrEqual(1);
      should(loads).be.above(afterFile);
      should(errors).deepEqual([]);
    } finally {
      stop();
      hub.close();
    }
  });

  it('should list yaml files at most three levels deep, skipping hidden entries and the schema directory', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'machine.yaml', 'version: 2\n');
    await put(subject.config, 'profiles/work.yml', 'name: work\n');
    await put(subject.config, 'components/mcp/github.yaml', 'name: github\n');
    await put(subject.config, 'components/mcp/deeper/too-deep.yaml', 'name: no\n');
    await put(subject.config, '.schema/machine.yaml', 'not a config\n');
    await put(subject.config, '.machine.yaml.swp', 'swap\n');
    await put(subject.config, 'profiles/.hidden.yaml', 'hidden\n');
    await put(subject.config, 'notes.txt', 'not yaml\n');

    // Act
    const actual = await subject.directory.list();

    // Assert
    should(actual.files.map(file => file.path).toSorted()).eql([
      'components/mcp/github.yaml',
      'machine.yaml',
      'profiles/work.yml',
    ]);
    should(actual.files.find(file => file.path === 'machine.yaml')?.text).equal('version: 2\n');
    should(actual.unreadable).eql([]);
  });

  it('should list nothing for a config directory that does not exist yet', async () => {
    // Arrange
    const subject = await fixture();
    await rm(subject.config, { recursive: true });

    // Act
    const actual = await subject.directory.list();

    // Assert
    should(actual).eql({ files: [], unreadable: [] });
  });

  it('should report a symlinked yaml as unreadable without reading through the link', async () => {
    // Arrange — the attack the adapter exists for: a link planted so GET /v1/config/file returns a secret.
    const subject = await fixture();
    const secret = join(subject.root, 'id_ed25519');
    await writeFile(secret, 'PRIVATE KEY\n');
    await mkdir(join(subject.config, 'logins'), { recursive: true });
    await symlink(secret, join(subject.config, 'logins', 'x.yaml'));
    await put(subject.config, 'machine.yaml', 'version: 2\n');

    // Act
    const actual = await subject.directory.list();

    // Assert
    should(actual.unreadable).eql(['logins/x.yaml']);
    should(actual.files.map(file => file.path)).eql(['machine.yaml']);
    should(JSON.stringify(actual)).not.match(/PRIVATE KEY/u);
  });

  it('should report a symlinked directory as unreadable and read nothing under it', async () => {
    // Arrange — `logins/` itself is the link, so no entry under it carries a link of its own.
    const subject = await fixture();
    const outside = join(subject.root, 'outside');
    await put(outside, 'stolen.yaml', 'PRIVATE KEY\n');
    await symlink(outside, join(subject.config, 'logins'));
    await put(subject.config, 'machine.yaml', 'version: 2\n');

    // Act
    const actual = await subject.directory.list();

    // Assert
    should(actual.unreadable).eql(['logins']);
    should(actual.files.map(file => file.path)).eql(['machine.yaml']);
    should(JSON.stringify(actual)).not.match(/PRIVATE KEY|stolen/u);
  });

  it('should report a FIFO as unreadable without opening it', async () => {
    // Arrange — opening a FIFO for reading would block the load forever.
    const subject = await fixture();
    const made = Bun.spawnSync(['mkfifo', join(subject.config, 'voice.yaml')]);
    if (made.exitCode !== 0) throw new Error('mkfifo is needed for this test');

    // Act
    const actual = await subject.directory.list();

    // Assert
    should(actual).eql({ files: [], unreadable: ['voice.yaml'] });
  });

  it('should fingerprint a tree holding links without throwing, and still see an edit', async () => {
    // Arrange
    const subject = await fixture();
    const outside = join(subject.root, 'outside');
    await put(outside, 'stolen.yaml', 'PRIVATE KEY\n');
    await symlink(join(outside, 'stolen.yaml'), join(subject.config, 'warden.yaml'));
    await symlink(outside, join(subject.config, 'logins'));
    await put(subject.config, 'machine.yaml', 'version: 2\n');
    const baseline = await subject.directory.fingerprint();

    // Act
    await writeFile(join(subject.config, 'machine.yaml'), 'version: 2\nagentPermissions: skip\n');
    const edited = await subject.directory.fingerprint();

    // Assert — the watcher keeps working while a planted link sits in the directory.
    should(baseline).match(/^logins:undefined/mu);
    should(baseline).match(/^warden\.yaml:undefined/mu);
    should(edited).not.equal(baseline);
  });

  it('should report a file larger than a config file may be as unreadable', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'voice.yaml', 'x'.repeat(CONFIG_FILE_MAX_BYTES + 1));
    await put(subject.config, 'learning.yaml', 'x'.repeat(CONFIG_FILE_MAX_BYTES));

    // Act
    const actual = await subject.directory.list();

    // Assert — exactly the limit is still read; one byte over is not.
    should(actual.unreadable).eql(['voice.yaml']);
    should(actual.files.map(file => file.path)).eql(['learning.yaml']);
  });

  it('should change its fingerprint when a file is edited and when a nested file appears', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'machine.yaml', 'version: 2\n');
    const baseline = await subject.directory.fingerprint();

    // Act
    const unchanged = await subject.directory.fingerprint();
    await writeFile(join(subject.config, 'machine.yaml'), 'version: 2\nagentPermissions: skip\n');
    const edited = await subject.directory.fingerprint();
    await put(subject.config, 'components/mcp/github.yaml', 'name: github\n');
    const added = await subject.directory.fingerprint();

    // Assert
    should(unchanged).equal(baseline);
    should(edited).not.equal(baseline);
    should(added).not.equal(edited);
    should(added).match(/components\/mcp\/github\.yaml:/u);
  });

  it('should change its fingerprint on a same-size edit through its modification time', async () => {
    // Arrange
    const subject = await fixture();
    const target = join(subject.config, 'machine.yaml');
    await put(subject.config, 'machine.yaml', 'aaaa\n');
    await utimes(target, new Date(1_000_000), new Date(1_000_000));
    const baseline = await subject.directory.fingerprint();

    // Act
    await writeFile(target, 'bbbb\n');
    await utimes(target, new Date(2_000_000), new Date(2_000_000));
    const actual = await subject.directory.fingerprint();

    // Assert
    should(actual).not.equal(baseline);
  });

  it('should read one file, or undefined when it does not exist', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'profiles/work.yaml', 'name: work\n');

    // Act
    const present = await subject.directory.read('profiles/work.yaml');
    const absent = await subject.directory.read('profiles/none.yaml');

    // Assert
    should(present).equal('name: work\n');
    should(absent).be.undefined();
  });

  it('should write a file atomically, owner-only, creating its directory', async () => {
    // Arrange
    const subject = await fixture();

    // Act
    await subject.directory.write('components/mcp/github.yaml', 'name: github\n');

    // Assert
    const target = join(subject.config, 'components', 'mcp', 'github.yaml');
    should(await readFile(target, 'utf8')).equal('name: github\n');
    should((await stat(target)).mode & 0o777).equal(0o600);
  });

  it('should remove a file, and a file already gone without an error', async () => {
    // Arrange
    const subject = await fixture();
    await put(subject.config, 'pack.yaml', 'enabled: true\n');

    // Act
    await subject.directory.remove('pack.yaml');
    await subject.directory.remove('pack.yaml');

    // Assert
    should(await subject.directory.read('pack.yaml')).be.undefined();
  });

  it('should rewrite only the schemas that changed', async () => {
    // Arrange
    const subject = await fixture();
    await subject.directory.writeSchemas(
      new Map([
        ['machine', '{"a":1}\n'],
        ['warden', '{"b":1}\n'],
      ]),
    );
    const machine = join(subject.config, '.schema', 'machine.json');
    const warden = join(subject.config, '.schema', 'warden.json');
    const machineBefore = await stat(machine);
    const wardenBefore = await stat(warden);

    // Act
    await subject.directory.writeSchemas(
      new Map([
        ['machine', '{"a":1}\n'],
        ['warden', '{"b":2}\n'],
      ]),
    );

    // Assert — the unchanged schema is the same file (an editor holding it open is not disturbed); the
    // changed one was replaced by an atomic rename, so it is a new inode.
    should((await stat(machine)).ino).equal(machineBefore.ino);
    should((await stat(warden)).ino).not.equal(wardenBefore.ino);
    should(await readFile(warden, 'utf8')).equal('{"b":2}\n');
    should(await readFile(machine, 'utf8')).equal('{"a":1}\n');
  });
});

describe('FileAcceptedConfigStore', () => {
  it('should read back exactly what it wrote', async () => {
    // Arrange
    const subject = await fixture();
    const store = new FileAcceptedConfigStore(join(subject.state, 'config-accepted.json'), subject.files);
    const accepted = { 'warden.yaml': { etag: 'abc', text: 'enabled: true\n' } };

    // Act
    await store.write(accepted);
    const actual = await store.read();

    // Assert
    should(actual).eql(accepted);
    should((await stat(join(subject.state, 'config-accepted.json'))).mode & 0o777).equal(0o600);
  });

  it('should read a missing record as empty', async () => {
    // Arrange
    const subject = await fixture();
    const store = new FileAcceptedConfigStore(join(subject.state, 'config-accepted.json'), subject.files);

    // Act
    const actual = await store.read();

    // Assert
    should(actual).eql({});
  });

  it('should read a record that is not JSON as empty', async () => {
    // Arrange
    const subject = await fixture();
    const path = join(subject.state, 'config-accepted.json');
    await writeFile(path, '{ not json');
    const store = new FileAcceptedConfigStore(path, subject.files);

    // Act
    const actual = await store.read();

    // Assert — empty is the safe direction: every loosening is held until confirmed again.
    should(actual).eql({});
  });

  it('should read a record of the wrong shape as empty', async () => {
    // Arrange
    const subject = await fixture();
    const path = join(subject.state, 'config-accepted.json');
    await writeFile(path, JSON.stringify({ 'warden.yaml': { etag: '', text: 1 } }));
    const store = new FileAcceptedConfigStore(path, subject.files);

    // Act
    const actual = await store.read();

    // Assert
    should(actual).eql({});
  });
});
