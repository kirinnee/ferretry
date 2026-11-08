import { err, ok, type Result } from '@ferretry/std';
import { isAbsolute } from 'node:path';
import type { CheckedDirectory, DirectoryRefusal } from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';

/**
 * `kernel.paths.checkDirectory` (today's session working-directory resolver, rule for rule): the path is trimmed; a
 * relative one is refused rather than resolved, because resolving it would silently start an agent in the DAEMON's
 * folder, which is never what the client asked for; one that does not exist, or is not a directory, is refused here
 * where the client still sees the error instead of at launch; the answer is the real path, so links and platform
 * aliases (`/tmp` and `/private/tmp`) agree with what a record stores. Read-only: it creates nothing.
 */
export async function checkDirectory(
  fs: Pick<HostFs, 'realpath' | 'identity'>,
  absolutePath: string,
): Promise<Result<CheckedDirectory, DirectoryRefusal>> {
  const requested = absolutePath.trim();
  if (!isAbsolute(requested))
    return err({
      reason: 'not_absolute',
      message: `session working directory must be absolute: ${JSON.stringify(absolutePath)}`,
    });
  const real = await fs.realpath(requested).catch(() => undefined);
  const found = real === undefined ? undefined : await fs.identity(real).catch(() => undefined);
  if (real === undefined || found?.kind !== 'directory')
    return err({ reason: 'not_a_directory', message: `session working directory is not a directory: ${requested}` });
  return ok({ realPath: real });
}
