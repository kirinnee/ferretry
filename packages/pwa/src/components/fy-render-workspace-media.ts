/**
 * Reads one workspace file for a `fy-render` media block, AS THE READER.
 *
 * This is the far side of `FyRenderWorkspaceReader`, assembled where the
 * session's connection already lives (`reference-surface.tsx`) so the block
 * itself never holds one. It takes the same route and the same proof an `@file`
 * click takes: the authored `@path` is made session-relative exactly as
 * `codeReferenceRelativePath` makes it for a reference — session-relative,
 * `./`-relative, or absolute INSIDE the session's folder — and the bytes come
 * from the session filesystem route's bounded preview read, through the carrier
 * router's fetch. The daemon's grant check decides it (`docs/grants.md`,
 * `filesystem` _use_); nothing here widens or bypasses that.
 *
 * Every outcome is one of a closed set the renderer turns into a card. A 403 is
 * `denied` — this reader's grants refuse it. A file the daemon declines to serve
 * (a secret, a gitignored file, a link out of the folder) is `not-served`,
 * because "you may not" and "nobody may" are different sentences.
 */
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { FyRenderWorkspaceRead } from '../lib/fy-render.ts';
import { type DaemonFetch, DaemonResponseError } from '../lib/runtime-models.ts';
import { codeReferenceRelativePath, fsApi, isAbort } from './files-api.ts';
import { bytesFromBase64 } from './rich-file-preview.tsx';

export const readWorkspaceMedia = async (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  cwd: string | undefined,
  fetcher: DaemonFetch,
  signal: AbortSignal,
): Promise<FyRenderWorkspaceRead> => {
  const relative = codeReferenceRelativePath(path, cwd);
  if (relative === null) return { ok: false, reason: 'missing' };
  let file: Awaited<ReturnType<typeof fsApi.preview>>;
  try {
    file = await fsApi.preview(connection, scope, relative, signal, fetcher);
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof DaemonResponseError && error.status === 403) return { ok: false, reason: 'denied' };
    if (error instanceof DaemonResponseError && error.status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  }
  if (file.denied === true || file.ignored === true || file.reason !== undefined)
    return { ok: false, reason: 'not-served' };
  if (file.tooLarge === true) return { ok: false, reason: 'too-large' };
  if (file.base64 === undefined) return { ok: false, reason: 'unavailable' };
  try {
    return { bytes: bytesFromBase64(file.base64), ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
};
