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
import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import type { FyRenderWorkspaceRead, FyRenderWorkspaceScope } from './fy-render.ts';
import { codeReferenceRelativePath } from './workspace-path.ts';

/**
 * The one file read, as the filesystem route answers it (`GET /v1/ferrets/:ferretId/fs/file?format=base64`).
 * GAP(ferrets): the wire is Ferrets'; these are the only fields read, and an unknown one is ignored.
 */
const FsFileSchema = z.looseObject({
  base64: z.string().optional(),
  denied: z.boolean().optional(),
  ignored: z.boolean().optional(),
  reason: z.string().optional(),
  /** Set when the daemon masked private values in the bytes: they are NOT the file. */
  redacted: z.boolean().optional(),
  rule: z.string().optional(),
  tooLarge: z.boolean().optional(),
});

/** Decoded into an ordinary ArrayBuffer: a renderer must never smuggle a shared buffer to Blob. */
const bytesFromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

/** The daemon's own words for a 403 that is about the path rather than about this reader. */
const PATH_REFUSALS: Readonly<Record<string, string>> = {
  denied: 'the protected-secrets list refuses this name',
  escapes_root: 'it resolves outside the session folder (a link pointing out of it)',
  ignored: 'Git ignores it',
};

/** The same sentence the files feature shows for a masked file. */
const MASKED_RULE = 'private values masked — this is not the file';

export const readWorkspaceMedia = async (
  client: PluginClient,
  ferretId: string,
  path: string,
  cwd: string | undefined,
  signal: AbortSignal,
  folder: FyRenderWorkspaceScope = 'workspace',
): Promise<FyRenderWorkspaceRead> => {
  // A media-folder path is already relative to that folder; a workspace one is made session-relative
  // exactly as an `@file` reference is.
  const relative = folder === 'media' ? path : codeReferenceRelativePath(path, cwd);
  if (relative === null) return { ok: false, reason: 'missing' };
  let file: z.infer<typeof FsFileSchema>;
  try {
    signal.throwIfAborted();
    const answer = await client.call('GET /v1/ferrets/:ferretId/fs/file', {
      params: { ferretId },
      query:
        folder === 'media'
          ? { path: relative, format: 'base64', scope: 'media' }
          : { path: relative, format: 'base64' },
    });
    signal.throwIfAborted();
    const parsed = FsFileSchema.safeParse(answer);
    if (!parsed.success) return { ok: false, reason: 'unavailable' };
    file = parsed.data;
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error instanceof DaemonCallError && error.status === 403) {
      // A path refusal names its rule; anything else at 403 is this reader's grants.
      const rule = PATH_REFUSALS[error.code];
      return rule === undefined ? { ok: false, reason: 'denied' } : { ok: false, reason: 'not-served', rule };
    }
    if (error instanceof DaemonCallError && error.status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  }
  if (file.denied === true || file.ignored === true || file.reason !== undefined)
    return { ok: false, reason: 'not-served', ...(file.rule === undefined ? {} : { rule: file.rule }) };
  // Masked bytes are not the file: never show them as it, and never offer them to open or download (a PDF row would).
  if (file.redacted === true) return { ok: false, reason: 'not-served', rule: MASKED_RULE };
  if (file.tooLarge === true) return { ok: false, reason: 'too-large' };
  if (file.base64 === undefined) return { ok: false, reason: 'unavailable' };
  try {
    return { bytes: bytesFromBase64(file.base64), ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
};
