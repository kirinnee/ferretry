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
 * Every outcome is one of a closed set the renderer turns into a file row. A 403
 * is `denied` — this reader's grants refuse it. A file the daemon declines to
 * serve is `not-served` WITH THE RULE that refused it (the ignore file, line and
 * pattern; a Git failure; the denied name; a link out of the folder), because
 * "not served — gitignored, a secret, or outside the folder" left an agent's own
 * freshly written image with no way to find out which.
 *
 * `media` reads the session's MEDIA folder (`FY_MEDIA_DIR`) through the same
 * route with `scope=media`: the daemon names the folder, this never does.
 */
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { FyRenderWorkspaceRead, FyRenderWorkspaceScope } from '../lib/fy-render.ts';
import { type DaemonFetch, DaemonResponseError } from '../lib/runtime-models.ts';
import { codeReferenceRelativePath, fsApi, isAbort } from './files-api.ts';
import { bytesFromBase64 } from './rich-file-preview.tsx';

/** The daemon's own words for a 403 that is about the path rather than about this reader. */
const PATH_REFUSALS: Readonly<Record<string, string>> = {
  denied: 'the protected-secrets list refuses this name',
  escapes_root: 'it resolves outside the session folder (a link pointing out of it)',
  ignored: 'Git ignores it',
};

export const readWorkspaceMedia = async (
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  cwd: string | undefined,
  fetcher: DaemonFetch,
  signal: AbortSignal,
  folder: FyRenderWorkspaceScope = 'workspace',
): Promise<FyRenderWorkspaceRead> => {
  // A media-folder path is already relative to that folder; a workspace one is made session-relative
  // exactly as an `@file` reference is.
  const relative = folder === 'media' ? path : codeReferenceRelativePath(path, cwd);
  if (relative === null) return { ok: false, reason: 'missing' };
  let file: Awaited<ReturnType<typeof fsApi.preview>>;
  try {
    file =
      folder === 'media'
        ? await fsApi.mediaPreview(connection, scope, relative, signal, fetcher)
        : await fsApi.preview(connection, scope, relative, signal, fetcher);
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof DaemonResponseError && error.status === 403) {
      // A path refusal names its rule; anything else at 403 is this reader's grants.
      const rule = error.code === undefined ? undefined : PATH_REFUSALS[error.code];
      return rule === undefined ? { ok: false, reason: 'denied' } : { ok: false, reason: 'not-served', rule };
    }
    if (error instanceof DaemonResponseError && error.status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  }
  if (file.denied === true || file.ignored === true || file.reason !== undefined)
    return { ok: false, reason: 'not-served', ...(file.rule === undefined ? {} : { rule: file.rule }) };
  if (file.tooLarge === true) return { ok: false, reason: 'too-large' };
  if (file.base64 === undefined) return { ok: false, reason: 'unavailable' };
  try {
    return { bytes: bytesFromBase64(file.base64), ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
};
