import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RepositoryProbe } from '../../lib/board-projects/index.ts';

/** Asks git for the common directory a folder belongs to, so every worktree of one repository agrees. */
export class GitRepositoryProbe implements RepositoryProbe {
  async commonDirectory(cwd: string): Promise<string | null> {
    try {
      const process = Bun.spawn(['git', '-C', cwd, 'rev-parse', '--git-common-dir'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = (await new Response(process.stdout).text()).trim();
      if ((await process.exited) !== 0 || output === '') return null;
      return await realpath(resolve(cwd, output));
    } catch {
      return null;
    }
  }
}
