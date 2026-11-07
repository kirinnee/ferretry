import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { WorkingDirectoryResolver } from '../../../lib/session/lifecycle/index.ts';

/**
 * Canonicalizes the directory an agent will run in.
 *
 * A relative path is refused rather than resolved: resolving it would silently start the agent in
 * the *daemon's* working directory, which is never what the client asked for. A path that does not
 * exist is refused here, where the client still sees the error, instead of at launch.
 */
export class NodeWorkingDirectoryResolver implements WorkingDirectoryResolver {
  async resolve(cwd: string): Promise<string> {
    const requested = cwd.trim();
    if (!isAbsolute(requested)) throw new Error(`session working directory must be absolute: ${JSON.stringify(cwd)}`);
    const information = await stat(requested).catch(() => undefined);
    if (information?.isDirectory() !== true)
      throw new Error(`session working directory is not a directory: ${requested}`);
    // Symlinks and platform aliases (/tmp vs /private/tmp) must agree with what the record stores.
    return await realpath(requested);
  }
}
