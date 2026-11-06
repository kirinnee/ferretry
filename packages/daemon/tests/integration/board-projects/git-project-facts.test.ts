import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { GitProjectFacts } from '../../../src/adapters/board-projects/git-project-facts.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

describe('GitProjectFacts', () => {
  it('should say no repository for a plain folder', async () => {
    await withTempRoot(async root => {
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: false, hasReleaseTags: false });
    });
  });

  it('should find a repository without release tags, then with one', async () => {
    await withTempRoot(async root => {
      await git(root, 'init', '--quiet');
      await git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '--quiet', '-m', 'root');
      await git(root, 'tag', 'nightly');
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: true, hasReleaseTags: false });
      await git(root, 'tag', 'v1.0.0');
      should(await new GitProjectFacts().inspect(root)).eql({ hasRepository: true, hasReleaseTags: true });
    });
  });

  it('should say no release tags when git cannot be started for the tag listing', async () => {
    await withTempRoot(async root => {
      const probe = { commonDirectory: async () => '/somewhere/.git' };
      should(await new GitProjectFacts(join(root, 'no-such-git'), probe).inspect(root)).eql({
        hasRepository: true,
        hasReleaseTags: false,
      });
    });
  });
});
