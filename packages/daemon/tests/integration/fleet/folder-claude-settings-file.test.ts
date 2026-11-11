/**
 * The names a launch folder's Claude settings files put in their `env`.
 *
 * The claims: both project files are read and only the NAMES come back; a missing folder, a broken file
 * and a file with no `env` contribute nothing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { FolderClaudeSettingsFiles } from '../../../src/adapters/fleet/folder-claude-settings-file.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

describe('FolderClaudeSettingsFiles', () => {
  it('should list the env names of both project files and drop every value', async () => {
    // Arrange
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, '.claude/settings.json'), JSON.stringify({ env: { A: 'x' }, other: 1 }));
    await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ env: { B: '', C: 'y' } }));

    // Act
    const found = await new FolderClaudeSettingsFiles().variables(directory);

    // Assert
    should(found).deepEqual([
      { file: '.claude/settings.json', names: ['A'] },
      { file: '.claude/settings.local.json', names: ['B', 'C'] },
    ]);
  });

  it('should answer nothing for a missing folder, a broken file, a non-object env or a file with no env', async () => {
    // Arrange
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, '.claude/settings.json'), '{ nope');
    await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ permissions: {} }));
    const arrayEnv = await tempDirectory('folder-claude-settings');
    await mkdir(join(arrayEnv, '.claude'));
    await writeFile(join(arrayEnv, '.claude/settings.json'), JSON.stringify({ env: ['A'] }));

    // Act / Assert
    const adapter = new FolderClaudeSettingsFiles();
    should(await adapter.variables(directory)).deepEqual([]);
    should(await adapter.variables(arrayEnv)).deepEqual([]);
    should(await adapter.variables(join(directory, 'absent'))).deepEqual([]);
  });
});
