/**
 * The names a launch folder's Claude settings files put in their `env`.
 *
 * The claims: both project files are read and only the NAMES come back; a missing folder, a broken file
 * and a file with no `env` contribute nothing; and every file Claude Code reads for the folder is read — the
 * repository root's local file for a nested folder, the main checkout's for a linked worktree.
 */
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

  /** A main checkout and a linked worktree of it, wired the way `git worktree add` wires them. */
  const linkedWorktree = async (base: string): Promise<{ main: string; worktree: string; perWorktree: string }> => {
    const main = join(base, 'main');
    const worktree = join(base, 'worktree');
    const perWorktree = join(main, '.git/worktrees/feature');
    await mkdir(perWorktree, { recursive: true });
    await writeFile(join(perWorktree, 'commondir'), '../..\n');
    await writeFile(join(perWorktree, 'gitdir'), `${join(worktree, '.git')}\n`);
    await mkdir(join(worktree, 'src'), { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${perWorktree}\n`);
    return { main, worktree, perWorktree };
  };

  it('should read the main checkout’s local file for a linked worktree that proves itself both ways', async () => {
    // Arrange
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const { main, worktree } = await linkedWorktree(base);
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

  it('should read nothing outside the repository for a hostile .git file', async () => {
    // Arrange: a synthetic checkout whose .git points at a victim's per-worktree directory (no back-link to it), at
    // another with commondir ".", and at a directory that is not under .git/worktrees at all.
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const victim = join(base, 'victim');
    await localFile(victim, { VICTIM: 'x' });
    const victimWorktree = join(victim, '.git/worktrees/other');
    await mkdir(victimWorktree, { recursive: true });
    await writeFile(join(victimWorktree, 'commondir'), '../..\n');
    await writeFile(join(victimWorktree, 'gitdir'), `${join(base, 'somewhere-else/.git')}\n`);
    const noBackLink = join(base, 'outside-a');
    await mkdir(noBackLink);
    await writeFile(join(noBackLink, '.git'), `gitdir: ${victimWorktree}\n`);
    const selfCommon = join(base, 'outside-b');
    await mkdir(selfCommon);
    await mkdir(join(base, 'fake-gitdir'));
    await writeFile(join(base, 'fake-gitdir/commondir'), '.\n');
    await writeFile(join(selfCommon, '.git'), `gitdir: ${join(base, 'fake-gitdir')}\n`);
    await localFile(selfCommon, { OWN: 'x' });
    const outsideParent = join(base, 'outside-c');
    await mkdir(outsideParent);
    await writeFile(join(outsideParent, '.git'), `gitdir: ${victim}\n`);

    // Act
    const adapter = new FolderClaudeSettingsFiles('/nowhere');
    const forged = await Promise.all(
      [noBackLink, selfCommon, outsideParent].map(async path => await adapter.variables(path)),
    );

    // Assert: only the checkout's OWN files are ever read; the victim's local file never is.
    should(forged[0]).deepEqual([]);
    should(forged[1]).deepEqual([{ file: '.claude/settings.local.json', names: ['OWN'] }]);
    should(forged[2]).deepEqual([]);
  });

  it('should read nothing from a .git file that names an unrelated .git with commondir "."', async () => {
    // Arrange: the reviewer's repro — `gitdir: ../unrelated/.git`, whose commondir is ".".
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const repository = join(base, 'repo');
    const unrelated = join(base, 'unrelated');
    await mkdir(repository);
    await mkdir(join(unrelated, '.git'), { recursive: true });
    await localFile(unrelated, { ANTHROPIC_AUTH_TOKEN: '' });
    await writeFile(join(repository, '.git'), 'gitdir: ../unrelated/.git\n');
    await writeFile(join(unrelated, '.git/commondir'), '.\n');

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(repository);

    // Assert
    should(found).deepEqual([]);
  });

  it('should accept a worktree made by a real git, from a nested folder and through a symlink alias', async () => {
    // Arrange: git's own wiring is the one the proof has to accept.
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const main = join(base, 'main');
    await mkdir(main);
    const git = (cwd: string, ...args: string[]): void => {
      const run = Bun.spawnSync(['git', ...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: base,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
      should(run.exitCode).equal(0);
    };
    git(main, 'init', '-q');
    git(main, '-c', 'user.email=a@b.c', '-c', 'user.name=n', 'commit', '-q', '--allow-empty', '-m', 'x');
    const worktree = join(base, 'worktree');
    git(main, 'worktree', 'add', '-q', worktree);
    await mkdir(join(worktree, 'src'), { recursive: true });
    await localFile(main, { ANTHROPIC_AUTH_TOKEN: '' });
    const alias = join(base, 'alias');
    await symlink(join(worktree, 'src'), alias);

    // Act
    const adapter = new FolderClaudeSettingsFiles('/nowhere');
    const fromNested = await adapter.variables(join(worktree, 'src'));
    const fromAlias = await adapter.variables(alias);

    // Assert
    const expected = [{ file: join(main, '.claude/settings.local.json'), names: ['ANTHROPIC_AUTH_TOKEN'] }];
    should(fromNested).deepEqual(expected);
    should(fromAlias).deepEqual(expected);
  });

  it('should treat a worktree with no commondir or back-link as an ordinary checkout', async () => {
    // Arrange
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const { main, worktree, perWorktree } = await linkedWorktree(base);
    await localFile(main, { A: '1' });
    await rm(join(perWorktree, 'commondir'));

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(worktree);

    // Assert
    should(found).deepEqual([]);
  });

  it('should find the git root’s local file from a folder 70 levels deep', async () => {
    // Arrange
    const repository = await realpath(await tempDirectory('folder-claude-settings'));
    await mkdir(join(repository, '.git'));
    await localFile(repository, { ANTHROPIC_BASE_URL: '' });
    const deep = join(repository, ...Array.from({ length: 70 }, (_, level) => `d${level}`));
    await mkdir(deep, { recursive: true });

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(deep);

    // Assert
    should(found).deepEqual([{ file: join(repository, '.claude/settings.local.json'), names: ['ANTHROPIC_BASE_URL'] }]);
  });

  it('should find the git root’s local file from a symlink alias of a repository subdirectory', async () => {
    // Arrange: an alias outside the repository that points at a subdirectory inside it.
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const repository = join(base, 'repository');
    await mkdir(join(repository, '.git'), { recursive: true });
    await localFile(repository, { ANTHROPIC_BASE_URL: '' });
    await mkdir(join(repository, 'packages/child'), { recursive: true });
    const alias = join(base, 'alias');
    await symlink(join(repository, 'packages/child'), alias);

    // Act
    const found = await new FolderClaudeSettingsFiles('/nowhere').variables(alias);

    // Assert
    should(found).deepEqual([{ file: join(repository, '.claude/settings.local.json'), names: ['ANTHROPIC_BASE_URL'] }]);
  });

  it('should refuse, saying why, when a folder’s own .git cannot be looked at', async () => {
    // Arrange: a folder that can be resolved but not searched (skipped where the platform ignores modes).
    if (process.getuid?.() === 0) return;
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const folder = join(base, 'closed');
    await mkdir(folder);
    await chmod(folder, 0o000);

    // Act / Assert
    try {
      await should(new FolderClaudeSettingsFiles('/nowhere').variables(folder)).rejectedWith(/cannot be checked/u);
    } finally {
      await chmod(folder, 0o700);
    }
  });

  it('should refuse, saying why, when the walk to the repository root cannot complete', async () => {
    // Arrange: a folder whose parent cannot be searched (skipped where the platform ignores modes).
    if (process.getuid?.() === 0) return;
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const locked = join(base, 'locked');
    await mkdir(join(locked, 'inner'), { recursive: true });
    const folder = join(locked, 'inner');
    await chmod(locked, 0o000);

    // Act / Assert
    try {
      await should(new FolderClaudeSettingsFiles('/nowhere').variables(folder)).rejectedWith(/cannot be checked/u);
    } finally {
      await chmod(locked, 0o700);
    }
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
