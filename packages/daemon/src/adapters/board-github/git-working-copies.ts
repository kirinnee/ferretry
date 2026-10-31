import { githubRepositoryOf, parseGitRemote, type WorkingCopies } from '../../lib/board-github/index.ts';

/**
 * Asks git about a folder: the GitHub repository its `origin` names, and the branch it has checked out.
 *
 * An SSH `origin` may name a host alias (`github-personal:kirinnee/ferretry.git`); ssh itself says where the
 * alias goes (`ssh -G <alias>` prints the `hostname` it resolves to, reading the user's ssh config, and
 * connects to nothing). Each alias is asked once per adapter.
 */
export class GitWorkingCopies implements WorkingCopies {
  private readonly hosts = new Map<string, Promise<string | null>>();

  constructor(
    private readonly gitBinary = 'git',
    private readonly sshBinary = 'ssh',
  ) {}

  async repositoryOf(path: string): Promise<string | null> {
    const url = await this.git(path, ['remote', 'get-url', 'origin']);
    const remote = url === null ? null : parseGitRemote(url);
    if (remote === null) return null;
    const direct = githubRepositoryOf(remote, null);
    if (direct !== null || !remote.ssh) return direct;
    return githubRepositoryOf(remote, (await this.hostOf(remote.host)) ?? remote.host);
  }

  async branchOf(path: string): Promise<string | null> {
    return await this.git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  /** The host an ssh alias resolves to, or `null` when ssh could not say. */
  private async hostOf(alias: string): Promise<string | null> {
    const known = this.hosts.get(alias);
    if (known !== undefined) return await known;
    const asked = this.run([this.sshBinary, '-G', alias]).then(output => {
      const line = output?.split('\n').find(entry => entry.toLowerCase().startsWith('hostname '));
      return line === undefined ? null : line.slice('hostname '.length).trim();
    });
    this.hosts.set(alias, asked);
    return await asked;
  }

  /** git's one line of output, or `null` when it failed, printed nothing, or could not run. */
  private async git(path: string, args: readonly string[]): Promise<string | null> {
    return await this.run([this.gitBinary, '-C', path, ...args]);
  }

  /** A command's output, trimmed, or `null` when it failed, printed nothing, or could not run. */
  private async run(command: readonly string[]): Promise<string | null> {
    try {
      const child = Bun.spawn([...command], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const output = (await new Response(child.stdout).text()).trim();
      return (await child.exited) === 0 && output !== '' ? output : null;
    } catch {
      return null;
    }
  }
}
