import { describe, it } from 'bun:test';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { GitWorkingCopies } from '../../../src/adapters/board-github/git-working-copies.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

const repository = async (root: string): Promise<string> => {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '--quiet', '-b', 'main');
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'root');
  return repo;
};

describe('the git working copies', () => {
  it("should name the GitHub repository a folder's origin points at, and the branch it has checked out", async () => {
    await withTempRoot(async root => {
      const repo = await repository(root);
      await git(repo, 'remote', 'add', 'origin', 'git@github.com:kirinnee/ferretry.git');
      await git(repo, 'checkout', '--quiet', '-b', 'feat/board-u6');
      const copies = new GitWorkingCopies();
      should(await copies.repositoryOf(repo)).equal('kirinnee/ferretry');
      should(await copies.branchOf(repo)).equal('feat/board-u6');
    });
  });

  it('should name nothing for a remote on another host, a folder with no origin, or a detached head', async () => {
    await withTempRoot(async root => {
      const repo = await repository(root);
      const copies = new GitWorkingCopies();
      should(await copies.repositoryOf(repo)).be.null();
      await git(repo, 'remote', 'add', 'origin', 'https://gitlab.com/someone/thing.git');
      should(await copies.repositoryOf(repo)).be.null();
      await git(repo, 'checkout', '--quiet', '--detach');
      should(await copies.branchOf(repo)).be.null();
    });
  });

  it('should resolve an ssh host alias through ssh, once per alias, and accept only GitHub behind it', async () => {
    await withTempRoot(async root => {
      const repo = await repository(root);
      await git(repo, 'remote', 'add', 'origin', 'github-personal:kirinnee/ferretry.git');
      const calls = join(root, 'calls');
      const ssh = join(root, 'fake-ssh');
      await writeFile(
        ssh,
        `#!/bin/sh
echo "$*" >> '${calls}'
if [ "$2" = github-personal ]; then echo 'user git'; echo 'hostname github.com'; else echo 'hostname gitlab.com'; fi
`,
      );
      await chmod(ssh, 0o755);
      const copies = new GitWorkingCopies('git', ssh);
      should(await copies.repositoryOf(repo)).equal('kirinnee/ferretry');
      should(await copies.repositoryOf(repo)).equal('kirinnee/ferretry');
      should((await readFile(calls, 'utf8')).trim().split('\n')).deepEqual(['-G github-personal']);
      await git(repo, 'remote', 'set-url', 'origin', 'work-alias:someone/thing.git');
      should(await copies.repositoryOf(repo)).be.null();
      should(await new GitWorkingCopies('git', join(root, 'no-such-ssh')).repositoryOf(repo)).be.null();
    });
  });

  it('should name nothing outside a repository, or when git cannot run', async () => {
    await withTempRoot(async root => {
      should(await new GitWorkingCopies().branchOf(root)).be.null();
      should(await new GitWorkingCopies().repositoryOf(join(root, 'missing'))).be.null();
      should(await new GitWorkingCopies(join(root, 'no-such-git')).branchOf(root)).be.null();
    });
  });

  describe('kept answers', () => {
    /** A git that writes each question it is asked to `calls`, then answers it as the real one does. */
    const countingGit = async (root: string): Promise<{ binary: string; asked: () => Promise<readonly string[]> }> => {
      const real = Bun.which('git');
      if (real === null) throw new Error('git is not on PATH');
      const calls = join(root, 'git-calls');
      const binary = join(root, 'counting-git');
      await writeFile(binary, `#!/bin/sh\necho "$*" >> '${calls}'\nexec '${real}' "$@"\n`);
      await chmod(binary, 0o755);
      const asked = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(line => line !== '');
      return { binary, asked };
    };

    it('should ask git once while the checkout is unchanged, and again once its branch or remote changes', async () => {
      await withTempRoot(async root => {
        // Arrange
        const repo = await repository(root);
        await git(repo, 'remote', 'add', 'origin', 'git@github.com:kirinnee/ferretry.git');
        await git(repo, 'checkout', '--quiet', '-b', 'feat/one');
        const { binary, asked } = await countingGit(root);
        const copies = new GitWorkingCopies(binary);

        // Act
        const first = [await copies.repositoryOf(repo), await copies.branchOf(repo)];
        const again = [await copies.repositoryOf(repo), await copies.branchOf(repo)];
        const unchanged = (await asked()).length;
        await git(repo, 'checkout', '--quiet', '-b', 'feat/two');
        await git(repo, 'remote', 'set-url', 'origin', 'https://github.com/kirinnee/other.git');
        const changed = [await copies.repositoryOf(repo), await copies.branchOf(repo)];

        // Assert
        should(first).deepEqual(['kirinnee/ferretry', 'feat/one']);
        should(again).deepEqual(first);
        should(unchanged).equal(2);
        should(changed).deepEqual(['kirinnee/other', 'feat/two']);
        should((await asked()).length).equal(4);
      });
    });

    it("should follow a linked worktree's own branch and its repository's shared remote", async () => {
      await withTempRoot(async root => {
        // Arrange
        const repo = await repository(root);
        await git(repo, 'remote', 'add', 'origin', 'git@github.com:kirinnee/ferretry.git');
        const tree = join(root, 'tree');
        await git(repo, 'worktree', 'add', '--quiet', '-b', 'feat/tree', tree);
        const { binary, asked } = await countingGit(root);
        const copies = new GitWorkingCopies(binary);
        const nested = join(tree, 'nested');
        await mkdir(nested);

        // Act
        const before = [
          await copies.repositoryOf(nested),
          await copies.branchOf(nested),
          await copies.branchOf(nested),
        ];
        await git(repo, 'checkout', '--quiet', '-b', 'feat/main-moved');
        const mainMoved = await copies.branchOf(nested);
        const calls = (await asked()).length;
        await git(tree, 'checkout', '--quiet', '-b', 'feat/tree-moved');
        await git(repo, 'remote', 'set-url', 'origin', 'https://github.com/kirinnee/other.git');

        // Assert — the worktree's HEAD is its own; the remote lives in the shared config.
        should(before).deepEqual(['kirinnee/ferretry', 'feat/tree', 'feat/tree']);
        should(mainMoved).equal('feat/tree');
        should(calls).equal(2);
        should(await copies.branchOf(nested)).equal('feat/tree-moved');
        should(await copies.repositoryOf(nested)).equal('kirinnee/other');
      });
    });

    it('should let the oldest folder go once it keeps as many as it may', async () => {
      await withTempRoot(async root => {
        // Arrange — two folders kept at most; three asked about.
        const repo = await repository(root);
        const folders = ['a', 'b', 'c'].map(name => join(repo, name));
        for (const folder of folders) await mkdir(folder);
        const { binary, asked } = await countingGit(root);
        const copies = new GitWorkingCopies(binary, 'ssh', Date.now, 2);

        // Act
        for (const folder of folders) await copies.branchOf(folder);
        const filled = (await asked()).length;
        await copies.branchOf(folders[2] as string);
        await copies.branchOf(folders[0] as string);

        // Assert — the newest is still kept; the oldest was let go and is asked again.
        should(filled).equal(3);
        should((await asked()).length).equal(4);
      });
    });

    it('should ask again after ten minutes, and every time for a question git answered with nothing', async () => {
      await withTempRoot(async root => {
        // Arrange
        const repo = await repository(root);
        const { binary, asked } = await countingGit(root);
        let nowMs = 0;
        const copies = new GitWorkingCopies(binary, 'ssh', () => nowMs);

        // Act
        await copies.branchOf(repo);
        nowMs = 9 * 60_000;
        await copies.branchOf(repo);
        const young = (await asked()).length;
        nowMs = 10 * 60_000;
        await copies.branchOf(repo);
        const aged = (await asked()).length;
        await copies.repositoryOf(repo);
        await copies.repositoryOf(repo);

        // Assert — no origin is `null`, which is never kept.
        should(young).equal(1);
        should(aged).equal(2);
        should((await asked()).length).equal(4);
      });
    });

    describe('an answer never outlives a change git makes', () => {
      it("should follow an included config's remote across a branch switch and an edit to the included file", async () => {
        await withTempRoot(async root => {
          // Arrange
          const repo = await repository(root);
          const gitDirectory = join(repo, '.git');
          const remote = (name: string) => `[remote "origin"]\n\turl = git@github.com:owner/${name}.git\n`;
          await writeFile(join(gitDirectory, 'one.path'), remote('one'));
          await writeFile(join(gitDirectory, 'two.path'), remote('two'));
          await git(repo, 'config', 'includeIf.onbranch:feat/one.path', 'one.path');
          await git(repo, 'config', 'includeIf.onbranch:feat/two.path', 'two.path');
          await git(repo, 'checkout', '--quiet', '-b', 'feat/one');
          const copies = new GitWorkingCopies();

          // Act
          const one = await copies.repositoryOf(repo);
          await git(repo, 'checkout', '--quiet', '-b', 'feat/two');
          const two = await copies.repositoryOf(repo);
          await git(repo, 'config', 'include.path', 'remote.config');
          await git(
            repo,
            'config',
            '--file',
            join(gitDirectory, 'remote.config'),
            'remote.origin.url',
            'git@github.com:owner/third.git',
          );
          await git(repo, 'config', '--unset', 'includeIf.onbranch:feat/two.path');
          const third = await copies.repositoryOf(repo);
          await git(
            repo,
            'config',
            '--file',
            join(gitDirectory, 'remote.config'),
            'remote.origin.url',
            'git@github.com:owner/fourth.git',
          );
          const fourth = await copies.repositoryOf(repo);

          // Assert
          should([one, two, third, fourth]).deepEqual(['owner/one', 'owner/two', 'owner/third', 'owner/fourth']);
        });
      });

      it('should name the branch when a tag of the same name comes and goes', async () => {
        await withTempRoot(async root => {
          // Arrange
          const repo = await repository(root);
          await git(repo, 'checkout', '--quiet', '-b', 'renamed');
          await git(repo, 'tag', 'renamed');
          await git(repo, 'pack-refs', '--all');
          const copies = new GitWorkingCopies();

          // Act
          const withTag = await copies.branchOf(repo);
          await git(repo, 'tag', '-d', 'renamed');
          const withoutTag = await copies.branchOf(repo);

          // Assert
          should([withTag, withoutTag]).deepEqual(['renamed', 'renamed']);
        });
      });

      it("should not mistake an enclosing repository's head for a checkout whose .git is a symlink", async () => {
        await withTempRoot(async root => {
          // Arrange
          const outer = await repository(root);
          const store = join(root, 'inner-store');
          await mkdir(store);
          await git(store, 'init', '--quiet', '-b', 'main');
          await git(
            store,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            'commit',
            '--allow-empty',
            '--quiet',
            '-m',
            'root',
          );
          const inner = join(outer, 'inner');
          await mkdir(inner);
          await symlink(join(store, '.git'), join(inner, '.git'));
          await git(inner, 'checkout', '--quiet', '-b', 'inner/one');
          const copies = new GitWorkingCopies();

          // Act
          const one = await copies.branchOf(inner);
          await git(inner, 'checkout', '--quiet', '-b', 'inner/two');
          const two = await copies.branchOf(inner);

          // Assert
          should([one, two]).deepEqual(['inner/one', 'inner/two']);
        });
      });

      it('should name nothing for a folder that has been removed, whatever repository encloses it', async () => {
        await withTempRoot(async root => {
          // Arrange
          const repo = await repository(root);
          await git(repo, 'checkout', '--quiet', '-b', 'feat/one');
          const folder = join(repo, 'subdir');
          await mkdir(folder);
          const copies = new GitWorkingCopies();

          // Act
          const before = await copies.branchOf(folder);
          await rm(folder, { recursive: true });
          const after = await copies.branchOf(folder);

          // Assert
          should([before, after]).deepEqual(['feat/one', null]);
        });
      });
    });
  });
});
