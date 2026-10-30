import { describe, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { GitWorkingCopies } from '../../../src/adapters/board-github/git-working-copies.ts';
import { withTempRoot } from '../tasks/fixtures.ts';

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

  it('should name nothing outside a repository, or when git cannot run', async () => {
    await withTempRoot(async root => {
      should(await new GitWorkingCopies().branchOf(root)).be.null();
      should(await new GitWorkingCopies().repositoryOf(join(root, 'missing'))).be.null();
      should(await new GitWorkingCopies(join(root, 'no-such-git')).branchOf(root)).be.null();
    });
  });
});
