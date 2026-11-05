import { describe, it } from 'bun:test';
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

      describe('a repository that is not the plain shape the files vouch for', () => {
        /** The environment a daemon would hand git when none of it steers git. */
        const plain = (): Record<string, string | undefined> =>
          Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

        it("should follow a linked worktree whose .git is a symlink to the worktree's directory in the main repository", async () => {
          await withTempRoot(async root => {
            // Arrange — git follows the link, then `commondir` (`../..`) from the directory it reached.
            const repo = await repository(root);
            await git(repo, 'remote', 'add', 'origin', 'git@github.com:owner/one.git');
            const tree = join(root, 'tree');
            await git(repo, 'worktree', 'add', '--quiet', '-b', 'feat/tree', tree);
            await rm(join(tree, '.git'));
            await symlink(join(repo, '.git', 'worktrees', 'tree'), join(tree, '.git'));
            const copies = new GitWorkingCopies();

            // Act
            const primed = await copies.repositoryOf(tree);
            await git(repo, 'remote', 'set-url', 'origin', 'git@github.com:owner/two.git');
            const kept = await copies.repositoryOf(tree);
            const fresh = await new GitWorkingCopies().repositoryOf(tree);

            // Assert
            should([primed, kept, fresh]).deepEqual(['owner/one', 'owner/two', 'owner/two']);
          });
        });

        it('should ignore a nested .git that git itself ignores for lacking objects and refs', async () => {
          await withTempRoot(async root => {
            // Arrange — `sub/.git` holds only a HEAD: git walks on past it to the outer repository.
            const outer = await repository(root);
            await git(outer, 'checkout', '--quiet', '-b', 'feat/outer');
            const sub = join(outer, 'sub');
            await mkdir(join(sub, '.git'), { recursive: true });
            await writeFile(join(sub, '.git', 'HEAD'), 'ref: refs/heads/phantom\n');
            const copies = new GitWorkingCopies();

            // Act
            const primed = await copies.branchOf(sub);
            await git(outer, 'checkout', '--quiet', '-b', 'feat/outer-two');
            const kept = await copies.branchOf(sub);
            const fresh = await new GitWorkingCopies().branchOf(sub);

            // Assert
            should([primed, kept, fresh]).deepEqual(['feat/outer', 'feat/outer-two', 'feat/outer-two']);
          });
        });

        it("should follow a bare repository's own head, not that of the repository enclosing it", async () => {
          await withTempRoot(async root => {
            // Arrange — `git -C nested.git` uses the bare repository it stands in.
            const outer = await repository(root);
            const nested = join(outer, 'nested.git');
            await mkdir(nested);
            await git(nested, 'init', '--bare', '--quiet', '-b', 'main');
            const copies = new GitWorkingCopies();

            // Act
            const primed = await copies.branchOf(nested);
            await git(nested, 'symbolic-ref', 'HEAD', 'refs/heads/other');
            const kept = await copies.branchOf(nested);
            const fresh = await new GitWorkingCopies().branchOf(nested);

            // Assert
            should([primed, kept, fresh]).deepEqual(['main', 'other', 'other']);
          });
        });

        it('should follow a repository an inherited GIT_DIR points at, and keep answers where nothing steers git', async () => {
          await withTempRoot(async root => {
            // Arrange — the folder's own `.git` is not what git reads once `GIT_DIR` is set.
            const folder = await repository(root);
            const elsewhere = join(root, 'elsewhere');
            await mkdir(elsewhere);
            await git(elsewhere, 'init', '--quiet', '-b', 'main');
            await git(
              elsewhere,
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
            await git(elsewhere, 'checkout', '--quiet', '-b', 'feat/there-one');
            const steered = new GitWorkingCopies('git', 'ssh', Date.now, 512, {
              ...plain(),
              GIT_DIR: join(elsewhere, '.git'),
            });
            const { binary, asked } = await countingGit(root);
            const ceiling = new GitWorkingCopies(binary, 'ssh', Date.now, 512, {
              ...plain(),
              GIT_CEILING_DIRECTORIES: root,
            });
            const harmless = new GitWorkingCopies(binary, 'ssh', Date.now, 512, {
              ...plain(),
              GIT_TERMINAL_PROMPT: '0',
            });

            // Act
            const primed = await steered.branchOf(folder);
            await git(elsewhere, 'checkout', '--quiet', '-b', 'feat/there-two');
            const kept = await steered.branchOf(folder);
            await ceiling.branchOf(folder);
            await ceiling.branchOf(folder);
            const ceilingCalls = (await asked()).length;
            await harmless.branchOf(folder);
            await harmless.branchOf(folder);

            // Assert
            should([primed, kept]).deepEqual(['feat/there-one', 'feat/there-two']);
            should(ceilingCalls).equal(2);
            should((await asked()).length - ceilingCalls).equal(1);
          });
        });

        it('should follow a legacy remotes/ or branches/ file, which git reads as an origin and the config does not', async () => {
          await withTempRoot(async root => {
            // Arrange
            const kinds = [
              ['remotes', (name: string) => `URL: git@github.com:owner/${name}.git\n`],
              ['branches', (name: string) => `git@github.com:owner/${name}.git\n`],
            ] as const;
            const outcomes: (readonly [string | null, string | null, string | null])[] = [];

            // Act
            for (const [directory, contents] of kinds) {
              const repo = join(root, directory);
              await mkdir(repo);
              await git(repo, 'init', '--quiet', '-b', 'main');
              await mkdir(join(repo, '.git', directory));
              await writeFile(join(repo, '.git', directory, 'origin'), contents('legacy-one'));
              const copies = new GitWorkingCopies();
              const primed = await copies.repositoryOf(repo);
              await writeFile(join(repo, '.git', directory, 'origin'), contents('legacy-two'));
              outcomes.push([primed, await copies.repositoryOf(repo), await new GitWorkingCopies().repositoryOf(repo)]);
            }

            // Assert
            should(outcomes).deepEqual([
              ['owner/legacy-one', 'owner/legacy-two', 'owner/legacy-two'],
              ['owner/legacy-one', 'owner/legacy-two', 'owner/legacy-two'],
            ]);
          });
        });
      });

      describe('a repository git validates and locates in ways a type check cannot see', () => {
        const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'r'];
        /** A repository at `path`, on `branch`, with a commit and an `origin` named after `name`. */
        const initAt = async (path: string, branch: string, name: string): Promise<string> => {
          await mkdir(path, { recursive: true });
          await git(path, 'init', '--quiet', '-b', branch);
          await git(path, ...COMMIT);
          await git(path, 'remote', 'add', 'origin', `git@github.com:owner/${name}.git`);
          return path;
        };
        /**
         * The real repository at `<root>/base/repo`, a decoy at `<root>/repo`, and `<root>/bridge`, a symlink to
         * `<root>/base/deeper`: `<root>/bridge/../repo` is the real one (the link is followed, THEN `..`), and the
         * same text normalised without the filesystem is the decoy.
         */
        const bridged = async (root: string): Promise<string> => {
          const real = await initAt(join(root, 'base', 'repo'), 'main', 'one');
          await mkdir(join(root, 'base', 'deeper'));
          await symlink(join(root, 'base', 'deeper'), join(root, 'bridge'));
          await initAt(join(root, 'repo'), 'decoy', 'decoy');
          return real;
        };
        /** What a primed adapter says after `change`, and what a fresh one says. */
        const primedThenChanged = async (
          ask: (copies: GitWorkingCopies) => Promise<string | null>,
          change: () => Promise<void>,
        ): Promise<readonly [string | null, string | null, string | null]> => {
          const copies = new GitWorkingCopies();
          const primed = await ask(copies);
          await change();
          return [primed, await ask(copies), await ask(new GitWorkingCopies())];
        };
        const branch = async (copies: GitWorkingCopies, path: string) => await copies.branchOf(path);

        it('should use the enclosing repository when a nested .git has a HEAD git does not accept', async () => {
          await withTempRoot(async root => {
            // Arrange — git ignores `inner/.git` for a HEAD that is no ref and no object id, and uses `outer`.
            const outer = await repository(root);
            await git(outer, 'checkout', '--quiet', '-b', 'feat/one');
            const inner = join(outer, 'inner');
            await mkdir(inner);
            await git(inner, 'init', '--quiet', '-b', 'main');
            await writeFile(join(inner, '.git', 'HEAD'), 'not a ref\n');

            // Act
            const outcome = await primedThenChanged(
              async copies => await branch(copies, inner),
              async () => await git(outer, 'checkout', '--quiet', '-b', 'feat/two'),
            );

            // Assert
            should(outcome).deepEqual(['feat/one', 'feat/two', 'feat/two']);
          });
        });

        it('should use the enclosing repository when a nested .git has an objects directory git cannot enter', async () => {
          await withTempRoot(async root => {
            // Arrange — an ordinary user cannot enter a mode-000 `objects/`, so git ignores `inner/.git` for it.
            const outer = await repository(root);
            await git(outer, 'checkout', '--quiet', '-b', 'feat/one');
            const inner = join(outer, 'inner');
            await mkdir(inner);
            await git(inner, 'init', '--quiet', '-b', 'main');
            const objects = join(inner, '.git', 'objects');
            await chmod(objects, 0o000);

            try {
              // Act
              const [primed, kept, fresh] = await primedThenChanged(
                async copies => await branch(copies, inner),
                async () => await git(outer, 'checkout', '--quiet', '-b', 'feat/two'),
              );

              // Assert — root enters it anyway, and then git and the adapter both take `inner` for the repository.
              should(kept).equal(fresh);
              if (process.getuid?.() !== 0) should([primed, kept]).deepEqual(['feat/one', 'feat/two']);
            } finally {
              await chmod(objects, 0o755);
            }
          });
        });

        it("should follow a worktree's commondir through a symlink before its .. and not past the link's name", async () => {
          await withTempRoot(async root => {
            // Arrange
            const real = await bridged(root);
            const tree = join(root, 'tree');
            await git(real, 'worktree', 'add', '--quiet', '-b', 'feat/tree', tree);
            await writeFile(join(real, '.git', 'worktrees', 'tree', 'commondir'), `${root}/bridge/../repo/.git\n`);

            // Act
            const outcome = await primedThenChanged(
              async copies => await copies.repositoryOf(tree),
              async () => await git(real, 'remote', 'set-url', 'origin', 'git@github.com:owner/two.git'),
            );

            // Assert
            should(outcome).deepEqual(['owner/one', 'owner/two', 'owner/two']);
          });
        });

        it("should follow a .git file's gitdir through a symlink before its .. and not past the link's name", async () => {
          await withTempRoot(async root => {
            // Arrange
            const real = await bridged(root);
            const tree = join(root, 'tree');
            await mkdir(tree);
            await writeFile(join(tree, '.git'), `gitdir: ${root}/bridge/../repo/.git\n`);

            // Act
            const outcome = await primedThenChanged(
              async copies => await branch(copies, tree),
              async () => await git(real, 'symbolic-ref', 'HEAD', 'refs/heads/feat/two'),
            );

            // Assert
            should(outcome).deepEqual(['main', 'feat/two', 'feat/two']);
          });
        });

        for (const [spelling, store] of [
          ['a trailing space, which belongs to the path', (root: string) => `${root}/store `],
          ['a newline inside the path', (root: string) => `${root}/store\nsecond`],
        ] as const)
          it(`should take a separate git dir whose path has ${spelling} exactly as git does`, async () => {
            await withTempRoot(async root => {
              // Arrange — the decoy `<root>/store` is what trimming, or reading the first line, would name.
              const tree = join(root, 'tree');
              await git(root, 'init', '--quiet', '--separate-git-dir', store(root), '-b', 'actual/one', tree);
              await git(root, 'init', '--quiet', '--bare', '-b', 'decoy', join(root, 'store'));

              // Act
              const outcome = await primedThenChanged(
                async copies => await branch(copies, tree),
                async () => await git(tree, 'symbolic-ref', 'HEAD', 'refs/heads/actual/two'),
              );

              // Assert
              should(outcome).deepEqual(['actual/one', 'actual/two', 'actual/two']);
            });
          });

        it('should keep the answer for a .git file that ends in a CRLF, which git strips', async () => {
          await withTempRoot(async root => {
            // Arrange
            const real = await initAt(join(root, 'real'), 'main', 'one');
            const tree = join(root, 'tree');
            await mkdir(tree);
            await writeFile(join(tree, '.git'), `gitdir: ${real}/.git\r\n`);
            const { binary, asked } = await countingGit(root);
            const copies = new GitWorkingCopies(binary);

            // Act
            const first = await copies.branchOf(tree);
            await copies.branchOf(tree);
            const unchanged = (await asked()).length;
            await git(real, 'symbolic-ref', 'HEAD', 'refs/heads/feat/two');
            const changed = await copies.branchOf(tree);

            // Assert
            should([first, unchanged, changed]).deepEqual(['main', 1, 'feat/two']);
          });
        });

        describe('a shape this cannot vouch for exactly', () => {
          /** Each builds a folder git can (or cannot) answer for; the adapter must ask git every time. */
          const cases: readonly (readonly [string, (root: string) => Promise<string | undefined>])[] = [
            [
              'a legacy symlink for HEAD',
              async root => {
                const repo = await repository(root);
                await rm(join(repo, '.git', 'HEAD'));
                await symlink('refs/heads/main', join(repo, '.git', 'HEAD'));
                return repo;
              },
            ],
            [
              'a .git file whose path is not valid UTF-8',
              async root => {
                const store = await initAt(join(root, 'store'), 'main', 'one');
                const bytes = Buffer.concat([Buffer.from(`${store}-`), Buffer.from([0xff])]);
                try {
                  await rename(store, bytes);
                } catch {
                  return undefined; // a filesystem that refuses a name that is not UTF-8 cannot hold the case
                }
                const tree = join(root, 'tree');
                await mkdir(tree);
                await writeFile(
                  join(tree, '.git'),
                  Buffer.concat([Buffer.from('gitdir: '), bytes, Buffer.from('/.git\n')]),
                );
                return tree;
              },
            ],
            [
              'a commondir with nothing in it',
              async root => {
                const real = await initAt(join(root, 'real'), 'main', 'one');
                const tree = join(root, 'tree');
                await git(real, 'worktree', 'add', '--quiet', '-b', 'feat/tree', tree);
                await writeFile(join(real, '.git', 'worktrees', 'tree', 'commondir'), '');
                return tree;
              },
            ],
            [
              'a commondir that leads nowhere',
              async root => {
                const real = await initAt(join(root, 'real'), 'main', 'one');
                const tree = join(root, 'tree');
                await git(real, 'worktree', 'add', '--quiet', '-b', 'feat/tree', tree);
                await writeFile(join(real, '.git', 'worktrees', 'tree', 'commondir'), `${root}/missing\n`);
                return tree;
              },
            ],
            [
              'a .git file with no path after gitdir:',
              async root => {
                const tree = join(root, 'tree');
                await mkdir(tree);
                await writeFile(join(tree, '.git'), 'gitdir: \n');
                return tree;
              },
            ],
            [
              'a .git file that does not start with gitdir:',
              async root => {
                const tree = join(root, 'tree');
                await mkdir(tree);
                await writeFile(join(tree, '.git'), `${root}/missing\n`);
                return tree;
              },
            ],
            [
              'an objects that is not a directory',
              async root => {
                const repo = await repository(root);
                await rm(join(repo, '.git', 'objects'), { recursive: true });
                await writeFile(join(repo, '.git', 'objects'), '');
                return repo;
              },
            ],
          ];

          for (const [name, build] of cases)
            it(`should ask git every time for ${name}`, async () => {
              await withTempRoot(async root => {
                // Arrange
                const folder = await build(root);
                if (folder === undefined) return;
                const { binary, asked } = await countingGit(root);
                const copies = new GitWorkingCopies(binary);

                // Act
                const answers = [await copies.branchOf(folder), await copies.branchOf(folder)];

                // Assert
                should((await asked()).length).equal(2);
                should(answers[1]).equal(answers[0]);
              });
            });
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

      describe('a config git cannot read', () => {
        /** Primes both answers, breaks the shared config with `break`, and returns what the next two answers do. */
        const afterBreaking = async (
          root: string,
          breakConfig: (config: string) => Promise<void>,
          restore: (config: string) => Promise<void>,
        ): Promise<void> => {
          // Arrange
          const repo = await repository(root);
          await git(repo, 'remote', 'add', 'origin', 'git@github.com:owner/five.git');
          await git(repo, 'checkout', '--quiet', '-b', 'feat/sub');
          const { binary, asked } = await countingGit(root);
          const copies = new GitWorkingCopies(binary);
          const config = join(repo, '.git', 'config');
          const primed = [await copies.repositoryOf(repo), await copies.branchOf(repo)];
          should(primed).deepEqual(['owner/five', 'feat/sub']);
          const asksWhilePrimed = (await asked()).length;

          // Act
          await breakConfig(config);
          try {
            const broken = [await copies.repositoryOf(repo), await copies.branchOf(repo)];
            const asksWhileBroken = (await asked()).length;
            const fresh = [
              await new GitWorkingCopies(binary).repositoryOf(repo),
              await new GitWorkingCopies(binary).branchOf(repo),
            ];

            // Assert — a config that cannot be read is no reason to serve what it said before: git is asked.
            should(asksWhileBroken - asksWhilePrimed).equal(2);
            should(broken).deepEqual(fresh);
          } finally {
            await restore(config);
          }
          should([await copies.repositoryOf(repo), await copies.branchOf(repo)]).deepEqual(primed);
        };

        it('should ask git, not serve a kept answer, while the config has no read permission', async () => {
          await withTempRoot(async root => {
            let mode = 0o644;
            await afterBreaking(
              root,
              async config => {
                mode = (await stat(config)).mode & 0o777;
                await chmod(config, 0o000);
              },
              async config => await chmod(config, mode),
            );
          });
        });

        it('should ask git, not serve a kept answer, when the config is a directory', async () => {
          await withTempRoot(async root => {
            const moved = join(root, 'config-moved');
            await afterBreaking(
              root,
              async config => {
                await rename(config, moved);
                await mkdir(config);
              },
              async config => {
                await rm(config, { recursive: true, force: true });
                await rename(moved, config);
              },
            );
          });
        });
      });
    });
  });
});
