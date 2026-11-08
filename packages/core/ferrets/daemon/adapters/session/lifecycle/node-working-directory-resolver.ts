import type { PathsPort } from '@ferretry/kernel/contract';
import type { WorkingDirectoryResolver } from '../../../lib/session/lifecycle/index.ts';

/**
 * Canonicalizes the directory an agent will run in, through `kernel.paths.checkDirectory`.
 *
 * A relative path is refused rather than resolved: resolving it would silently start the agent in
 * the *daemon's* working directory, which is never what the client asked for. A path that does not
 * exist is refused here, where the client still sees the error, instead of at launch. The kernel owns
 * the rules and the sentences; this adapter only turns its refusal into the error the lifecycle
 * already reports.
 */
export class NodeWorkingDirectoryResolver implements WorkingDirectoryResolver {
  constructor(private readonly paths: Pick<PathsPort, 'checkDirectory'>) {}

  async resolve(cwd: string): Promise<string> {
    const checked = await this.paths.checkDirectory(cwd);
    if (!checked.ok) throw new Error(checked.error.message);
    // Symlinks and platform aliases (/tmp vs /private/tmp) must agree with what the record stores.
    return checked.value.realPath;
  }
}
