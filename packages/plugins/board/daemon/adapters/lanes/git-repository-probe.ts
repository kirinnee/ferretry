import type { SpawnPort } from '@ferretry/kernel/contract';
import { seconds } from '@ferretry/std';
import { posix } from 'node:path';
import type { RepositoryLocation, RepositoryLocator } from '../../lib/lanes/project-adoption.ts';
import type { RepositoryProbe } from '../../lib/lanes/ferret-projects.ts';

const GIT = 'git';
const GIT_TIMEOUT = seconds(10);

/**
 * Asks git for the common directory a folder belongs to, so every worktree of one repository agrees. Git is asked
 * for ABSOLUTE, canonical paths (`--path-format=absolute`), so the answer needs no file-system call of ours.
 */
export class GitRepositoryProbe implements RepositoryProbe, RepositoryLocator {
  constructor(private readonly spawn: Pick<SpawnPort, 'run'>) {}

  async commonDirectory(folder: string): Promise<string | null> {
    const lines = await this.revParse(folder, ['--git-common-dir']);
    const [output] = lines ?? [];
    return output === undefined || !posix.isAbsolute(output) ? null : output;
  }

  /**
   * The repository `folder` is in, named by its main working tree: the folder holding the common `.git`, so a
   * linked worktree names the checkout it was made from. A repository whose common directory is not a `.git`
   * folder (a bare one, or `--separate-git-dir`) is named by the working tree `folder` is in.
   */
  async locate(folder: string): Promise<RepositoryLocation | null> {
    const lines = await this.revParse(folder, ['--git-common-dir', '--show-toplevel']);
    const [common, toplevel] = lines ?? [];
    if (common === undefined || toplevel === undefined) return null;
    if (!posix.isAbsolute(common) || !posix.isAbsolute(toplevel)) return null;
    const root = posix.basename(common) === '.git' ? posix.dirname(common) : toplevel;
    return { commonDirectory: common, root };
  }

  /** `git rev-parse`'s answer, one line per question, or `null` when git could not answer. Never rejects. */
  private async revParse(folder: string, questions: readonly string[]): Promise<readonly string[] | null> {
    try {
      const result = await this.spawn.run(GIT, ['-C', folder, 'rev-parse', '--path-format=absolute', ...questions], {
        timeout: GIT_TIMEOUT,
      });
      const output = result.stdout.trim();
      if (result.exitCode !== 0 || output === '') return null;
      return output.split('\n').map(line => line.trim());
    } catch {
      return null;
    }
  }
}
