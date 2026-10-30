import { describe, it } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { GitRepositoryProbe } from '../../../src/adapters/board-projects/git-repository-probe.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

describe('the git repository probe', () => {
  it('should answer null outside a repository', async () => {
    await withTempRoot(async root => {
      should(await new GitRepositoryProbe().commonDirectory(root)).equal(null);
    });
  });

  it('should answer null when git cannot be started', async () => {
    await withTempRoot(async root => {
      should(await new GitRepositoryProbe(join(root, 'no-such-git')).commonDirectory(root)).equal(null);
    });
  });

  it('should answer null for a folder that does not exist', async () => {
    await withTempRoot(async root => {
      should(await new GitRepositoryProbe().commonDirectory(join(root, 'missing'))).equal(null);
    });
  });

  it('should give a repository and its worktree the same common directory', async () => {
    await withTempRoot(async root => {
      const repo = join(root, 'repo');
      await mkdir(repo);
      await git(repo, 'init', '--quiet');
      await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'root');
      const worktree = join(root, 'tree');
      await git(repo, 'worktree', 'add', '--quiet', '-b', 'side', worktree);
      const probe = new GitRepositoryProbe();
      const expected = join(await realpath(repo), '.git');
      should(await probe.commonDirectory(repo)).equal(expected);
      should(await probe.commonDirectory(worktree)).equal(expected);
    });
  });
});

describe('locating a repository', () => {
  it('should name the main checkout for the repository and for a linked worktree of it', async () => {
    await withTempRoot(async root => {
      const repo = join(root, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await git(repo, 'init', '--quiet');
      await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'root');
      const worktree = join(root, 'tree');
      await git(repo, 'worktree', 'add', '--quiet', '-b', 'side', worktree);
      const probe = new GitRepositoryProbe();
      const main = await realpath(repo);
      const expected = { commonDirectory: join(main, '.git'), root: main };
      should(await probe.locate(join(repo, 'src'))).eql(expected);
      should(await probe.locate(worktree)).eql(expected);
    });
  });

  it('should name the working tree of a repository whose git folder lives elsewhere', async () => {
    await withTempRoot(async root => {
      const tree = join(root, 'tree');
      await mkdir(tree);
      await git(tree, 'init', '--quiet', '--separate-git-dir', join(root, 'store.git'));
      should(await new GitRepositoryProbe().locate(tree)).eql({
        commonDirectory: await realpath(join(root, 'store.git')),
        root: await realpath(tree),
      });
    });
  });

  it('should answer null when git names a folder that is not there', async () => {
    await withTempRoot(async root => {
      // A git that answers, but with a common directory and work tree that do not exist on disk.
      const fakeGit = join(root, 'git');
      await writeFile(fakeGit, `#!/bin/sh\necho ${root}/gone/.git\necho ${root}/gone\n`, { mode: 0o755 });
      const probe = new GitRepositoryProbe(fakeGit);
      should(await probe.locate(root)).equal(null);
      should(await probe.commonDirectory(root)).equal(null);
    });
  });

  it('should answer null outside a repository, for a missing folder, and when git cannot be started', async () => {
    await withTempRoot(async root => {
      should(await new GitRepositoryProbe().locate(root)).equal(null);
      should(await new GitRepositoryProbe().locate(join(root, 'missing'))).equal(null);
      should(await new GitRepositoryProbe(join(root, 'no-such-git')).locate(root)).equal(null);
    });
  });
});
