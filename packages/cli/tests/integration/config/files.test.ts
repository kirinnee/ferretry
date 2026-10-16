import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_ACCEPTED_FILE, CONFIG_FILE_MAX_BYTES } from '@ferretry/protocol';
import should from 'should';
import { FileConfigFiles } from '../../../src/adapters/config/files.ts';

/** The real filesystem behind `fy config check`: the adapter that reads the directory without a daemon. */

const roots = new Set<string>();

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'fy-config-files-'));
  roots.add(root);
  const directory = join(root, 'config');
  const state = join(root, 'state');
  await mkdir(directory, { recursive: true });
  await mkdir(state, { recursive: true });
  return { root, directory, state, files: new FileConfigFiles(directory, state) };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('reading the config directory from disk', () => {
  it('should read every yaml file, nested down to components/<kind>/<name>.yaml, in path order', async () => {
    // Arrange
    const { directory, files } = await layout();
    await mkdir(join(directory, 'components', 'mcp'), { recursive: true });
    await mkdir(join(directory, 'logins'), { recursive: true });
    await writeFile(join(directory, 'machine.yaml'), 'agentPermissions: auto\n');
    await writeFile(join(directory, 'logins', 'claude-you.yaml'), 'harness: claude\n');
    await writeFile(join(directory, 'components', 'mcp', 'github.yaml'), 'command: gh\n');
    await writeFile(join(directory, 'old.yml'), 'a: 1\n');
    await writeFile(join(directory, 'notes.txt'), 'not config\n');

    // Act
    const found = await files.list();

    // Assert
    should(found.files).deepEqual([
      { path: 'components/mcp/github.yaml', text: 'command: gh\n' },
      { path: 'logins/claude-you.yaml', text: 'harness: claude\n' },
      { path: 'machine.yaml', text: 'agentPermissions: auto\n' },
      { path: 'old.yml', text: 'a: 1\n' },
    ]);
    should(found.unreadable).be.empty();
  });

  it('should not go deeper than components/<kind>/<name>.yaml', async () => {
    // Arrange
    const { directory, files } = await layout();
    await mkdir(join(directory, 'components', 'mcp', 'deeper'), { recursive: true });
    await writeFile(join(directory, 'components', 'mcp', 'ok.yaml'), 'a: 1\n');
    await writeFile(join(directory, 'components', 'mcp', 'deeper', 'too-deep.yaml'), 'a: 1\n');

    // Act
    const found = await files.list();

    // Assert
    should(found.files.map(file => file.path)).deepEqual(['components/mcp/ok.yaml']);
  });

  it('should skip a hidden file or directory: a swap file, or the schema directory', async () => {
    // Arrange
    const { directory, files } = await layout();
    await mkdir(join(directory, '.schema'), { recursive: true });
    await writeFile(join(directory, '.schema', 'machine.yaml'), 'a: 1\n');
    await writeFile(join(directory, '.machine.yaml.swp'), 'x');
    await writeFile(join(directory, '.hidden.yaml'), 'a: 1\n');
    await writeFile(join(directory, 'voice.yaml'), '');

    // Act
    const found = await files.list();

    // Assert
    should(found.files.map(file => file.path)).deepEqual(['voice.yaml']);
    should(found.unreadable).be.empty();
  });

  it('should name a link as unreadable and never follow it, even to a file that exists', async () => {
    // Arrange
    const { root, directory, files } = await layout();
    await writeFile(join(root, 'secret.yaml'), 'token: elsewhere\n');
    await symlink(join(root, 'secret.yaml'), join(directory, 'voice.yaml'));
    await symlink(join(root, 'nowhere.yaml'), join(directory, 'warden.yaml'));

    // Act
    const found = await files.list();

    // Assert
    should(found.files).be.empty();
    should(found.unreadable).deepEqual(['voice.yaml', 'warden.yaml']);
  });

  it('should not follow a linked directory either', async () => {
    // Arrange
    const { root, directory, files } = await layout();
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'x.yaml'), 'a: 1\n');
    await symlink(join(root, 'outside'), join(directory, 'logins'));

    // Act
    const found = await files.list();

    // Assert — `lstat` does not follow, so the link is named unreadable and nothing behind it is read.
    should(found.files).be.empty();
    should(found.unreadable).deepEqual(['logins']);
  });

  it('should name a link whatever it is called, even one a suffix test would have ignored', async () => {
    // Arrange
    const { root, directory, files } = await layout();
    await writeFile(join(root, 'target.txt'), 'x');
    await symlink(join(root, 'target.txt'), join(directory, 'notes.txt'));

    // Act
    const found = await files.list();

    // Assert
    should(found).deepEqual({ files: [], unreadable: ['notes.txt'] });
  });

  it('should name a file over the size limit as unreadable, and read one exactly at it', async () => {
    // Arrange
    const { directory, files } = await layout();
    await writeFile(join(directory, 'machine.yaml'), 'a'.repeat(CONFIG_FILE_MAX_BYTES + 1));
    await writeFile(join(directory, 'voice.yaml'), 'a'.repeat(CONFIG_FILE_MAX_BYTES));

    // Act
    const found = await files.list();

    // Assert
    should(found.unreadable).deepEqual(['machine.yaml']);
    should(found.files.map(file => file.path)).deepEqual(['voice.yaml']);
  });

  it('should answer nothing for a directory that does not exist yet', async () => {
    // Arrange
    const { root } = await layout();
    const absent = new FileConfigFiles(join(root, 'absent'), join(root, 'state'));

    // Act + Assert
    should(await absent.list()).deepEqual({ files: [], unreadable: [] });
  });

  it('should fail loudly on a directory it cannot read, rather than report an empty one', async () => {
    // Arrange — a plain file where the directory should be.
    const { root } = await layout();
    await writeFile(join(root, 'config-is-a-file'), 'x');
    const broken = new FileConfigFiles(join(root, 'config-is-a-file'), join(root, 'state'));

    // Act + Assert
    await should(broken.list()).rejected();
  });
});

describe('reading the daemon’s accepted record', () => {
  const record = { 'warden.yaml': { etag: 'abc', text: 'enabled: true\n' } };

  it('should read the record the daemon wrote', async () => {
    const { state, files } = await layout();
    await writeFile(join(state, CONFIG_ACCEPTED_FILE), JSON.stringify(record));
    should(await files.accepted()).deepEqual(record);
  });

  it('should answer empty when the daemon has not written one', async () => {
    const { files } = await layout();
    should(await files.accepted()).deepEqual({});
  });

  it('should answer empty for a record that is not JSON, or not the record’s shape', async () => {
    const { state, files } = await layout();
    await writeFile(join(state, CONFIG_ACCEPTED_FILE), '{ not json');
    should(await files.accepted()).deepEqual({});
    await writeFile(join(state, CONFIG_ACCEPTED_FILE), JSON.stringify({ 'warden.yaml': { etag: '' } }));
    should(await files.accepted()).deepEqual({});
  });

  it('should fail loudly when the record exists but cannot be read', async () => {
    // Arrange — a directory where the file should be.
    const { state, files } = await layout();
    await mkdir(join(state, CONFIG_ACCEPTED_FILE));

    // Act + Assert
    await should(files.accepted()).rejected();
  });
});
