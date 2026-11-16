/**
 * `ferrets.file-open`, PROVIDED (`contract/app-hooks.ts`): another half's `@file` link asks the Files panel of one
 * ferret on this daemon to show a path.
 *
 * It only REQUESTS (`requestFileOpen`): nothing is read here, and the panel reads the file through the daemon's file
 * routes, where the `filesystem` grant and the agent fence decide. A path that is absolute, climbs (`..`), carries a
 * backslash or a control character, or names no ferret is refused before any request.
 */
import { codeReferenceRelativePath, type FerretsFileOpen } from '../../../contract/index.ts';
import type { FerretsClient } from '../../lib/client.ts';
import { requestFileOpen } from './open-request.ts';

export const createFileOpen = (client: FerretsClient): FerretsFileOpen => ({
  open: (ferretId, path) => {
    // No `cwd`: an absolute path names nothing here, and a `..`, a backslash or a control character is not openable.
    const relative = ferretId === '' ? null : codeReferenceRelativePath(path);
    if (relative === null) return false;
    requestFileOpen({ client, ferretId }, relative);
    return true;
  },
});
