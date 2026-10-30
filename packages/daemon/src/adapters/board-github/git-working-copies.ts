import { githubRepositoryOfRemote, type WorkingCopies } from '../../lib/board-github/index.ts';

/** Asks git about a folder: the GitHub repository its `origin` names, and the branch it has checked out. */
export class GitWorkingCopies implements WorkingCopies {
  constructor(private readonly gitBinary = 'git') {}

  async repositoryOf(path: string): Promise<string | null> {
    const url = await this.git(path, ['remote', 'get-url', 'origin']);
    return url === null ? null : githubRepositoryOfRemote(url);
  }

  async branchOf(path: string): Promise<string | null> {
    return await this.git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  /** git's one line of output, or `null` when it failed, printed nothing, or could not run. */
  private async git(path: string, args: readonly string[]): Promise<string | null> {
    try {
      const child = Bun.spawn([this.gitBinary, '-C', path, ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const output = (await new Response(child.stdout).text()).trim();
      return (await child.exited) === 0 && output !== '' ? output : null;
    } catch {
      return null;
    }
  }
}
