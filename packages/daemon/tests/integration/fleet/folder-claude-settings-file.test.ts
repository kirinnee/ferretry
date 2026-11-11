/**
 * The names a launch folder's Claude settings files put in their `env`.
 *
 * The claims: both project files are read and only the NAMES come back; a missing folder, a broken file
 * and a file with no `env` contribute nothing; and every file Claude Code reads for the folder is read — the
 * repository root's local file for a nested folder, the main checkout's for a linked worktree.
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
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

  const localFile = async (directory: string, env: Record<string, string>): Promise<void> => {
    await mkdir(join(directory, '.claude'), { recursive: true });
    await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ env }));
  };

  it('should read the repository root’s local file for a folder nested inside it', async () => {
    // Arrange
    const repository = await realpath(await tempDirectory('folder-claude-settings'));
    await mkdir(join(repository, '.git'));
    await localFile(repository, { ANTHROPIC_BASE_URL: '' });
    const nested = join(repository, 'packages/child');
    await mkdir(nested, { recursive: true });
    await localFile(nested, { OWN: 'x' });

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(nested);

    // Assert: the folder's own file by a relative name, the root's by its path; names only.
    should(found).deepEqual([
      { file: '.claude/settings.local.json', names: ['OWN'] },
      { file: join(repository, '.claude/settings.local.json'), names: ['ANTHROPIC_BASE_URL'] },
    ]);
  });

  it('should read the main checkout’s local file for a linked worktree', async () => {
    // Arrange: a main checkout, and a worktree whose .git file points at its per-worktree directory.
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const main = join(base, 'main');
    const worktree = join(base, 'worktree');
    const perWorktree = join(main, '.git/worktrees/feature');
    await mkdir(perWorktree, { recursive: true });
    await writeFile(join(perWorktree, 'commondir'), '../..\n');
    await mkdir(join(worktree, 'src'), { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${perWorktree}\n`);
    await localFile(main, { ANTHROPIC_AUTH_TOKEN: 'synthetic' });

    // Act: from the worktree's root and from a folder inside it.
    const adapter = new FolderClaudeSettingsFiles('/nowhere');
    const fromRoot = await adapter.variables(worktree);
    const fromNested = await adapter.variables(join(worktree, 'src'));

    // Assert
    const expected = [{ file: join(main, '.claude/settings.local.json'), names: ['ANTHROPIC_AUTH_TOKEN'] }];
    should(fromRoot).deepEqual(expected);
    should(fromNested).deepEqual(expected);
  });

  it('should find the main checkout of a worktree with no commondir file by its gitdir', async () => {
    // Arrange
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const main = join(base, 'main');
    const worktree = join(base, 'worktree');
    await mkdir(join(main, '.git/worktrees/feature'), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git/worktrees/feature')}\n`);
    await localFile(main, { A: '1' });

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(worktree);

    // Assert
    should(found.map(entry => entry.names)).deepEqual([['A']]);
  });

  it('should not read a file Claude Code does not: outside a repository, or when the root is the home directory', async () => {
    // Arrange: a parent with a local file but no repository; and a repository whose root is the home directory.
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    await localFile(base, { PARENT: 'x' });
    const child = join(base, 'child');
    await mkdir(child);
    const home = join(base, 'home');
    await mkdir(join(home, '.git'), { recursive: true });
    await localFile(home, { HOMEFILE: 'x' });
    const insideHome = join(home, 'work');
    await mkdir(insideHome);

    // Act / Assert
    should(await new FolderClaudeSettingsFiles('/nowhere').variables(child)).deepEqual([]);
    should(await new FolderClaudeSettingsFiles(home).variables(insideHome)).deepEqual([]);
  });
});
