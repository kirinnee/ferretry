import type { SpawnPort } from '@ferretry/kernel/contract';
import { seconds } from '@ferretry/std';
import type { RepositoryProbe } from '../../lib/lanes/ferret-projects.ts';
import type { ProjectGitFactSource } from '../../lib/lanes/ports.ts';
import type { ProjectGitFacts } from '../../lib/lanes/template-inference.ts';
import { GitRepositoryProbe } from './git-repository-probe.ts';

const NO_REPOSITORY: ProjectGitFacts = { hasRepository: false, hasReleaseTags: false };

/** Asks git whether a folder is a repository and whether it has tagged a `v*` release. */
export class GitProjectFacts implements ProjectGitFactSource {
  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly repositories: RepositoryProbe = new GitRepositoryProbe(spawn),
  ) {}

  async inspect(path: string): Promise<ProjectGitFacts> {
    if ((await this.repositories.commonDirectory(path)) === null) return NO_REPOSITORY;
    return { hasRepository: true, hasReleaseTags: await this.hasReleaseTag(path) };
  }

  private async hasReleaseTag(path: string): Promise<boolean> {
    try {
      const result = await this.spawn.run('git', ['-C', path, 'tag', '--list', 'v*'], { timeout: seconds(10) });
      return result.exitCode === 0 && result.stdout.trim() !== '';
    } catch {
      return false;
    }
  }
}
