import { describe, it } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { GitRepositoryProbe } from '../../../src/adapters/board-projects/git-repository-probe.ts';
import { withTempRoot } from '../tasks/fixtures.ts';

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
