/**
 * The names a launch folder's Claude settings files put in their `env`.
 *
 * The claims: both project files are read and only the NAMES come back; a broken file and a file with no `env`
 * contribute nothing; every file Claude Code reads for the folder is read — the repository root's local file for a
 * nested folder, the main checkout's for a linked worktree; and a layout that cannot be proved (a missing folder, a
 * symlinked `.git`, a `.git` file that fails its proof) REFUSES the launch rather than being guessed standalone.
 */
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskFolders } from '@ferretry/kernel/testing';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import should from 'should';
import { type FolderRoots, FolderClaudeSettingsFiles } from '../../daemon/adapters/folder-claude-settings-file.ts';

const created: string[] = [];

/** A temp directory (resolved, so a symlinked tmp does not confuse the layout proof) that the suite deletes on teardown. */
const tempDirectory = async (label: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `fy-${label}-`)));
  created.push(directory);
  return directory;
};

const cleanupTempDirectories = async (): Promise<void> => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
};

afterAll(cleanupTempDirectories);

/** The kernel's own `harness-home` root over the real disk: every read of the adapter goes through it. */
let folders: FolderRoots;
beforeAll(async () => {
  folders = await diskFolders(await tempDirectory('folder-roots'));
});

const adapterOf = (home = '/nowhere'): FolderClaudeSettingsFiles => new FolderClaudeSettingsFiles(folders, home);

describe('FolderClaudeSettingsFiles', () => {
  it('should list the env names of both project files and drop every value', async () => {
    // Arrange
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, '.claude/settings.json'), JSON.stringify({ env: { A: 'x' }, other: 1 }));
    await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ env: { B: '', C: 'y' } }));

    // Act
    const found = await adapterOf().variables(directory);

    // Assert
    should(found).deepEqual([
      { file: '.claude/settings.json', names: ['A'] },
      { file: '.claude/settings.local.json', names: ['B', 'C'] },
    ]);
  });

  it('should answer nothing for a broken file, a non-object env or a file with no env', async () => {
    // Arrange
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, '.claude/settings.json'), '{ nope');
    await writeFile(join(directory, '.claude/settings.local.json'), JSON.stringify({ permissions: {} }));
    const arrayEnv = await tempDirectory('folder-claude-settings');
    await mkdir(join(arrayEnv, '.claude'));
    await writeFile(join(arrayEnv, '.claude/settings.json'), JSON.stringify({ env: ['A'] }));

    // Act / Assert
    const adapter = adapterOf();
    should(await adapter.variables(directory)).deepEqual([]);
    should(await adapter.variables(arrayEnv)).deepEqual([]);
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
    const found = await adapterOf('/nowhere').variables(nested);

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
    const adapter = adapterOf('/nowhere');
    const fromRoot = await adapter.variables(worktree);
    const fromNested = await adapter.variables(join(worktree, 'src'));

    // Assert
    const expected = [{ file: join(main, '.claude/settings.local.json'), names: ['ANTHROPIC_AUTH_TOKEN'] }];
    should(fromRoot).deepEqual(expected);
    should(fromNested).deepEqual(expected);
  });

  it('should refuse a hostile .git file, reading nothing outside the repository', async () => {
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
    const adapter = adapterOf('/nowhere');
    for (const folder of [noBackLink, selfCommon, outsideParent])
      await should(adapter.variables(folder)).rejectedWith(new RegExp(`${folder}.*cannot be checked`, 'u'));

    // Assert: each is refused, naming its folder, and the victim's local file is never read.
  });

  it('should refuse a .git file that names an unrelated .git with commondir "."', async () => {
    // Arrange: the reviewer's repro — `gitdir: ../unrelated/.git`, whose commondir is ".".
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const repository = join(base, 'repo');
    const unrelated = join(base, 'unrelated');
    await mkdir(repository);
    await mkdir(join(unrelated, '.git'), { recursive: true });
    await localFile(unrelated, { ANTHROPIC_AUTH_TOKEN: '' });
    await writeFile(join(repository, '.git'), 'gitdir: ../unrelated/.git\n');
    await writeFile(join(unrelated, '.git/commondir'), '.\n');

    // Act / Assert
    await should(adapterOf('/nowhere').variables(repository)).rejectedWith(/cannot be checked/u);
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
    const adapter = adapterOf('/nowhere');
    const fromNested = await adapter.variables(join(worktree, 'src'));
    const fromAlias = await adapter.variables(alias);

    // Assert
    const expected = [{ file: join(main, '.claude/settings.local.json'), names: ['ANTHROPIC_AUTH_TOKEN'] }];
    should(fromNested).deepEqual(expected);
    should(fromAlias).deepEqual(expected);
  });

  /** A real git repository with a linked worktree, and the local file that blanks the login in the main checkout. */
  const realWorktree = async (): Promise<{ base: string; main: string; worktree: string }> => {
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const main = join(base, 'main');
    const worktree = join(base, 'worktree');
    await mkdir(main);
    const git = (...args: string[]): void => {
      const run = Bun.spawnSync(['git', ...args], {
        cwd: main,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: base,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
      should(run.exitCode).equal(0);
    };
    git('init', '-q');
    git('-c', 'user.email=a@b.c', '-c', 'user.name=n', 'commit', '-q', '--allow-empty', '-m', 'x');
    git('worktree', 'add', '--detach', '-q', worktree);
    await mkdir(join(worktree, 'src'));
    await localFile(main, { ANTHROPIC_AUTH_TOKEN: '' });
    return { base, main, worktree };
  };

  it('should refuse a worktree whose .git marker is a symlink, which git still follows', async () => {
    // Arrange
    const { base, worktree } = await realWorktree();
    const moved = join(base, 'marker');
    await rename(join(worktree, '.git'), moved);
    await symlink(moved, join(worktree, '.git'));

    // Act / Assert
    await should(adapterOf('/nowhere').variables(join(worktree, 'src'))).rejectedWith(
      new RegExp(`${worktree}.*cannot be checked`, 'u'),
    );
  });

  it('should refuse a copy of a real worktree’s .git file that has no back-link, which git still follows', async () => {
    // Arrange
    const { base, worktree } = await realWorktree();
    const hostile = join(base, 'hostile');
    await mkdir(join(hostile, 'src'), { recursive: true });
    await writeFile(join(hostile, '.git'), await readFile(join(worktree, '.git'), 'utf8'));

    // Act / Assert
    await should(adapterOf('/nowhere').variables(join(hostile, 'src'))).rejectedWith(
      new RegExp(`${hostile}.*cannot be checked`, 'u'),
    );
  });

  it('should refuse a launch folder that is missing, which could be created inside the repository before the start', async () => {
    // Arrange
    const { main } = await realWorktree();
    const removed = join(main, 'removed');

    // Act / Assert
    await should(adapterOf('/nowhere').variables(removed)).rejectedWith(
      new RegExp(`${removed}.*cannot be resolved`, 'u'),
    );
  });

  it('should refuse a worktree with no commondir, rather than treat it as standing alone', async () => {
    // Arrange
    const base = await realpath(await tempDirectory('folder-claude-settings'));
    const { main, worktree, perWorktree } = await linkedWorktree(base);
    await localFile(main, { A: '1' });
    await rm(join(perWorktree, 'commondir'));

    // Act / Assert
    await should(adapterOf('/nowhere').variables(worktree)).rejectedWith(/cannot be checked/u);
  });

  it('should find the git root’s local file from a folder 70 levels deep', async () => {
    // Arrange
    const repository = await realpath(await tempDirectory('folder-claude-settings'));
    await mkdir(join(repository, '.git'));
    await localFile(repository, { ANTHROPIC_BASE_URL: '' });
    const deep = join(repository, ...Array.from({ length: 70 }, (_, level) => `d${level}`));
    await mkdir(deep, { recursive: true });

    // Act
    const found = await adapterOf('/nowhere').variables(deep);

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
    const found = await adapterOf('/nowhere').variables(alias);

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
      await should(adapterOf('/nowhere').variables(folder)).rejectedWith(/cannot be checked/u);
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
      await should(adapterOf('/nowhere').variables(folder)).rejectedWith(/cannot be checked/u);
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
    should(await adapterOf('/nowhere').variables(child)).deepEqual([]);
    should(await adapterOf(home).variables(insideHome)).deepEqual([]);
  });

  it('should refuse a settings file that is a symlink, which Claude Code follows and the kernel root never does', async () => {
    // Arrange: the project file is a link to a file that sets a variable.
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, 'elsewhere.json'), JSON.stringify({ env: { HIDDEN: 'x' } }));
    await symlink(join(directory, 'elsewhere.json'), join(directory, '.claude/settings.json'));

    // Act / Assert: reading nothing from it would leave the file that blanks the login unseen.
    await should(adapterOf().variables(directory)).rejectedWith(/settings\.json is a link.*cannot be checked/u);
  });

  it('should refuse a settings file that has a second hard link, which may be a file from anywhere', async () => {
    // Arrange
    const directory = await tempDirectory('folder-claude-settings');
    await mkdir(join(directory, '.claude'));
    await writeFile(join(directory, 'elsewhere.json'), JSON.stringify({ env: { HIDDEN: 'x' } }));
    await link(join(directory, 'elsewhere.json'), join(directory, '.claude/settings.json'));

    // Act / Assert
    await should(adapterOf().variables(directory)).rejectedWith(/second name.*cannot be checked/u);
  });
});
