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

      it('should follow the repository git itself reaches through a symlinked folder, not the one enclosing the link', async () => {
        await withTempRoot(async root => {
          // Arrange — `outer` is a repository holding a link into a folder of ANOTHER repository.
          const outer = await repository(root);
          const other = join(root, 'another-repo');
          await mkdir(other);
          await git(other, 'init', '--quiet', '-b', 'main');
          await git(
            other,
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            'commit',
            '--allow-empty',
            '--quiet',
            '-m',
            'r',
          );
          await git(other, 'checkout', '--quiet', '-b', 'other/one');
          const target = join(other, 'subdir');
          await mkdir(target);
          const alias = join(outer, 'alias');
          await symlink(target, alias);
          const copies = new GitWorkingCopies();

          // Act
          const one = await copies.branchOf(alias);
          await git(other, 'checkout', '--quiet', '-b', 'other/two');
          const two = await copies.branchOf(alias);

          // Assert
          should([one, two]).deepEqual(['other/one', 'other/two']);
        });
      });

      it('should name the branch HEAD points at, not where a symbolic branch ref leads', async () => {
        await withTempRoot(async root => {
          // Arrange — HEAD -> refs/heads/feat/one -> refs/heads/target/one.
          const repo = await repository(root);
          await git(repo, 'branch', 'target/one');
          await git(repo, 'branch', 'target/two');
          await git(repo, 'symbolic-ref', 'refs/heads/feat/one', 'refs/heads/target/one');
          await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feat/one');
          const copies = new GitWorkingCopies();

          // Act — the middle ref moves; HEAD, the only file the answer is kept against, does not.
          const before = await copies.branchOf(repo);
          await git(repo, 'symbolic-ref', 'refs/heads/feat/one', 'refs/heads/target/two');
          const kept = await copies.branchOf(repo);
          const fresh = await new GitWorkingCopies().branchOf(repo);

          // Assert
          should([before, kept, fresh]).deepEqual(['feat/one', 'feat/one', 'feat/one']);
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

      describe('a repository whose refs are not plain files', () => {
        const reftable = async (root: string): Promise<string | undefined> => {
          const repo = join(root, 'repo');
          await mkdir(repo);
          try {
            await git(repo, 'init', '--quiet', '--ref-format=reftable', '-b', 'main');
          } catch {
            return undefined;
          }
          await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'r');
          return repo;
        };

        it('should follow a branch switch in a reftable repository, whose HEAD file never changes', async () => {
          await withTempRoot(async root => {
            // Arrange — skipped, loudly, where the installed git cannot make a reftable repository.
            const repo = await reftable(root);
            if (repo === undefined) {
              console.warn('skipped: the installed git cannot init --ref-format=reftable');
              return;
            }
            await git(repo, 'remote', 'add', 'origin', 'git@github.com:kirinnee/ferretry.git');
            await git(repo, 'checkout', '--quiet', '-b', 'feat/one');
            const { binary, asked } = await countingGit(root);
            const copies = new GitWorkingCopies(binary);

            // Act
            const one = await copies.branchOf(repo);
            await git(repo, 'checkout', '--quiet', '-b', 'feat/two');
            const two = await copies.branchOf(repo);
            const repositories = [await copies.repositoryOf(repo), await copies.repositoryOf(repo)];

            // Assert — the branch is asked every time; the remote is still kept.
            should(await readFile(join(repo, '.git', 'HEAD'), 'utf8')).containEql('.invalid');
            should([one, two]).deepEqual(['feat/one', 'feat/two']);
            should(repositories).deepEqual(['kirinnee/ferretry', 'kirinnee/ferretry']);
            should((await asked()).length).equal(3);
          });
        });

        it('should ask git every time for a HEAD placeholder or a ref storage it does not recognise', async () => {
          await withTempRoot(async root => {
            // Arrange — a files repository dressed as each, so the detection is covered whatever git is installed.
            const placeholder = await repository(root);
            await writeFile(join(placeholder, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
            const other = join(root, 'other');
            await mkdir(other);
            await git(other, 'init', '--quiet', '-b', 'main');
            await git(other, 'config', 'core.repositoryformatversion', '1');
            await git(other, 'config', 'extensions.refStorage', 'future');
            const { binary, asked } = await countingGit(root);
            const copies = new GitWorkingCopies(binary);

            // Act
            for (const folder of [placeholder, other]) {
              await copies.branchOf(folder);
              await copies.branchOf(folder);
            }

            // Assert
            should((await asked()).length).equal(4);
          });
        });

        it('should still keep a branch where the ref storage is spelled out as files', async () => {
          await withTempRoot(async root => {
            // Arrange
            const repo = await repository(root);
            await git(repo, 'config', 'core.repositoryformatversion', '1');
            await git(repo, 'config', 'extensions.refStorage', 'files');
            const { binary, asked } = await countingGit(root);
            const copies = new GitWorkingCopies(binary);

            // Act
            await copies.branchOf(repo);
            await copies.branchOf(repo);

            // Assert
            should((await asked()).length).equal(1);
          });
        });

        it('should follow the LAST ref storage git honours, not the first, once a branch is already kept', async () => {
          await withTempRoot(async root => {
            // Arrange — primed under `files`, then a later unknown storage appears with HEAD untouched.
            const repo = join(root, 'repo');
            await mkdir(repo);
            await git(repo, 'init', '--quiet', '-b', 'feat/one');
            await git(repo, 'config', 'core.repositoryformatversion', '1');
            await git(repo, 'config', 'extensions.refStorage', 'files');
            const copies = new GitWorkingCopies();
            const primed = await copies.branchOf(repo);
            await git(repo, 'config', '--add', 'extensions.refStorage', 'future');

            // Act
            const kept = await copies.branchOf(repo);
            const fresh = await new GitWorkingCopies().branchOf(repo);

            // Assert — git rejects the unknown storage, and so must the answer.
            should(primed).equal('feat/one');
            should(fresh).equal(null);
            should(kept).equal(fresh);
          });
        });

        it('should keep a branch for every spelling of files, and ask every time for any other occurrence', async () => {
          await withTempRoot(async root => {
            // Arrange — each config rewritten by hand: `files` spelled the ways git reads it, then ways it cannot be trusted.
            const spelled: readonly [string, boolean][] = [
              ['[extensions]\n\tREFSTORAGE = files # the default\n', true],
              ['[extensions] refStorage = files\n', true],
              ['[extensions]\n\trefStorage = Files\n', false],
              ['[extensions]\n\trefStorage = files\n\trefStorage = reftable\n', false],
              ['[extensions]\n\trefStorage\n', false],
              ['[include]\n\tpath = ../elsewhere\n[extensions]\n\trefStorage = files\n', false],
            ];
            const { binary, asked } = await countingGit(root);
            const counts: boolean[] = [];

            // Act
            for (const [index, [config, kept]] of spelled.entries()) {
              const repo = join(root, `repo-${String(index)}`);
              await mkdir(repo);
              await git(repo, 'init', '--quiet', '-b', 'main');
              await writeFile(join(repo, '.git', 'config'), `[core]\n\trepositoryformatversion = 1\n${config}`);
              const before = (await asked()).length;
              const copies = new GitWorkingCopies(binary);
              await copies.branchOf(repo);
              await copies.branchOf(repo);
              counts.push(((await asked()).length - before === 1) === kept);
            }

            // Assert
            should(counts).deepEqual(spelled.map(() => true));
          });
        });

        it('should look for a ref storage in the worktree config too', async () => {
          await withTempRoot(async root => {
            // Arrange
            const repo = await repository(root);
            await writeFile(join(repo, '.git', 'config.worktree'), '[extensions]\n\trefStorage = future\n');
            const { binary, asked } = await countingGit(root);
            const copies = new GitWorkingCopies(binary);

            // Act
            await copies.branchOf(repo);
            await copies.branchOf(repo);

            // Assert
            should((await asked()).length).equal(2);
          });
        });
      });
    });
  });
});
