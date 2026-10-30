import type { ProjectGitFactSource, ProjectGitFacts, RepositoryProbe } from '../../lib/board-projects/index.ts';
import { GitRepositoryProbe } from './git-repository-probe.ts';

const NO_REPOSITORY: ProjectGitFacts = { hasRepository: false, hasReleaseTags: false };

/** Asks git whether a folder is a repository and whether it has tagged a `v*` release. */
export class GitProjectFacts implements ProjectGitFactSource {
  constructor(
    private readonly gitBinary = 'git',
    private readonly repositories: RepositoryProbe = new GitRepositoryProbe(gitBinary),
  ) {}

  async inspect(path: string): Promise<ProjectGitFacts> {
    if ((await this.repositories.commonDirectory(path)) === null) return NO_REPOSITORY;
    return { hasRepository: true, hasReleaseTags: await this.hasReleaseTag(path) };
  }

  private async hasReleaseTag(path: string): Promise<boolean> {
    try {
      const process = Bun.spawn([this.gitBinary, '-C', path, 'tag', '--list', 'v*'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = (await new Response(process.stdout).text()).trim();
      return (await process.exited) === 0 && output !== '';
    } catch {
      return false;
    }
  }
}
