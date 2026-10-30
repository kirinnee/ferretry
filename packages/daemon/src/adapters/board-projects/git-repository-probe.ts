import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { RepositoryLocation, RepositoryLocator, RepositoryProbe } from '../../lib/board-projects/index.ts';

/** Asks git for the common directory a folder belongs to, so every worktree of one repository agrees. */
export class GitRepositoryProbe implements RepositoryProbe, RepositoryLocator {
  constructor(private readonly gitBinary = 'git') {}

  async commonDirectory(cwd: string): Promise<string | null> {
    const lines = await this.revParse(cwd, ['--git-common-dir']);
    const [output] = lines ?? [];
    if (output === undefined) return null;
    return await realpath(resolve(cwd, output)).catch(() => null);
  }

  /**
   * The repository `cwd` is in, named by its main working tree: the folder holding the common `.git`, so a
   * linked worktree names the checkout it was made from. A repository whose common directory is not a `.git`
   * folder (a bare one, or `--separate-git-dir`) is named by the working tree `cwd` is in.
   */
  async locate(cwd: string): Promise<RepositoryLocation | null> {
    const lines = await this.revParse(cwd, ['--git-common-dir', '--show-toplevel']);
    const [common, toplevel] = lines ?? [];
    if (common === undefined || toplevel === undefined) return null;
    try {
      const commonDirectory = await realpath(resolve(cwd, common));
      const root = basename(commonDirectory) === '.git' ? dirname(commonDirectory) : await realpath(toplevel);
      return { commonDirectory, root };
    } catch {
      return null;
    }
  }

  /** `git rev-parse`'s answer, one line per question, or `null` when git could not answer. Never rejects. */
  private async revParse(cwd: string, questions: readonly string[]): Promise<readonly string[] | null> {
    try {
      const process = Bun.spawn([this.gitBinary, '-C', cwd, 'rev-parse', ...questions], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = (await new Response(process.stdout).text()).trim();
      if ((await process.exited) !== 0 || output === '') return null;
      return output.split('\n').map(line => line.trim());
    } catch {
      return null;
    }
  }
}
