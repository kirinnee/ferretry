import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { ExecutableProbe } from '../which.ts';

/**
 * The disk's answer for `kernel.paths.which` (today's harness `runnable`: `access(X_OK)` and a regular file, links
 * followed): the file is only looked at, never opened, never run. A directory fails even with its execute bit set.
 */
export const nodeExecutableProbe: ExecutableProbe = async absolutePath => {
  const found = await stat(absolutePath).catch(() => undefined);
  if (found?.isFile() !== true) return false;
  return await access(absolutePath, constants.X_OK).then(
    () => true,
    () => false,
  );
};
