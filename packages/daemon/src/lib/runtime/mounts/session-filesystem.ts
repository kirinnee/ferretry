import { SESSION_FILE_INDEX_VERSION, type SessionFileIndexResponse } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { FsError, type FsErrorCode, MAX_FILE_BYTES, type SessionFilesystem } from '../../session/filesystem/index.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/**
 * The session working-tree READ surface: a listing, one file, the change list, and one path's diff.
 *
 * WHY EVERY ROUTE IS `noStore`. These responses carry working-tree bytes, and a browser's private HTTP
 * cache is a place those bytes must never land — a later viewer of the same browser profile would be
 * served a file the session no longer contains, or one the gates would refuse today. It is also why a
 * `denied` or `ignored` view is still a 200 for `file` (the badge is the answer a viewer renders) but a
 * 403 for `diff` (whose body is bytes, with nowhere to put a badge).
 *
 * WHY THE cwd COMES FROM THE SESSION DOCUMENT AND NOT FROM THE REQUEST. A caller may name a session; it
 * may never name a directory. The root is the one the session was started in, read from the document the
 * daemon owns, so no request can point this surface at a tree the human never opened. And the session id
 * itself is percent-decoded and refused if it regains a separator, so it cannot become a path either.
 *
 * WHAT IS DELIBERATELY NOT SERVED. There is no write surface — no upload, no rename, no delete — and no
 * `?force` override for either secrets gate. The gitignore gate over-blocks build output, and that is the
 * right direction to be wrong in: gitignore is the one machine-readable place a human has already
 * declared "this must not leave the machine".
 */

/** Every refusal, as the status a client can act on. */
const FS_ERROR_STATUS: Readonly<Record<FsErrorCode, number>> = {
  invalid_path: 400,
  not_found: 404,
  not_a_directory: 400,
  not_a_file: 400,
  escapes_root: 403,
  denied: 403,
  ignored: 403,
  // 501 rather than 403: the surface is not implemented on this machine, which is a statement about the
  // daemon rather than about the caller's authority or the path they asked for.
  unsupported: 501,
};

/** The path parameter, decoded. A parameter that regains a separator never reaches the pinner. */
function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** The session's own working directory. A session the daemon does not hold is a 404, not an empty tree. */
async function sessionCwd(sessions: SessionDirectorySubsystem, id: string): Promise<string> {
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return session.config.cwd;
}

/** Restates a domain refusal in the HTTP vocabulary, preserving the code so a client need not match prose. */
function refuse(error: unknown): never {
  if (error instanceof FsError) throw new ApiError(FS_ERROR_STATUS[error.code], error.message, error.code);
  throw error;
}

/** The `path` query parameter, which the file and diff routes require and the listing treats as the root. */
function requiredPath(context: RouteContext): string {
  const target = queryValue(context.request, 'path');
  if (target === undefined || target === '')
    throw new ApiError(400, 'query parameter "path" is required', 'invalid_path');
  return target;
}

async function list(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const cwd = await sessionCwd(sessions, sessionId(context));
  try {
    return jsonResponse(await filesystem.list(cwd, queryValue(context.request, 'path')));
  } catch (error) {
    return refuse(error);
  }
}

async function file(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const cwd = await sessionCwd(sessions, sessionId(context));
  const target = requiredPath(context);
  // `rev` is an enumeration of exactly one member, so anything else is a client mistake rather than a
  // silent fall back to the working tree — which would serve different bytes than the caller asked for.
  const rev = queryValue(context.request, 'rev');
  if (rev !== undefined && rev !== 'head')
    throw new ApiError(400, 'query parameter "rev" must be "head"', 'invalid_rev');
  const format = queryValue(context.request, 'format');
  if (format !== undefined && format !== 'base64')
    throw new ApiError(400, 'query parameter "format" must be "base64"', 'invalid_format');
  try {
    return jsonResponse(
      await filesystem.readFile(cwd, target, {
        ...(rev === 'head' ? { rev: 'head' as const } : {}),
        ...(format === 'base64' ? { base64: true } : {}),
      }),
    );
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Every searchable file under the session root, with a total record of what was left out.
 *
 * This is the one route in the family that answers about the WHOLE tree, and it is the reason a client
 * no longer walks the tree itself: a browser doing that met a 403 on the first listing of any Git
 * checkout — `.git` is refused by name — and had no way to tell a closed subtree from a failed read.
 * Here a refusal is a counted row and the response still arrives 200, which is what makes "nothing
 * matched" and "I could not look" different answers.
 *
 * Still `noStore`: a list of every filename under a session is not bytes, but it is a map of somebody's
 * working tree, and a shared browser profile is no place to leave one.
 */
async function index(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const cwd = await sessionCwd(sessions, id);
  try {
    // Bounds are the domain's own; the only thing a route contributes is the caller's cancellation,
    // because the transport is the only layer that knows the caller stopped waiting.
    const view = await filesystem.index(cwd, { signal: context.request.signal });
    const response: SessionFileIndexResponse = { v: SESSION_FILE_INDEX_VERSION, sessionId: id, ...view };
    return jsonResponse(response);
  } catch (error) {
    return refuse(error);
  }
}

async function changes(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const cwd = await sessionCwd(sessions, sessionId(context));
  try {
    return jsonResponse(await filesystem.changes(cwd));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * One path's unified diff, as text.
 *
 * A refused diff is a 403 rather than a badge: the body of this route is diff bytes and has nowhere to
 * carry a flag. A TRUNCATED diff is a 413 for a stronger reason — a partial diff is actively misleading in
 * a review surface, because the missing tail renders as content that was never removed.
 */
async function diff(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const cwd = await sessionCwd(sessions, sessionId(context));
  const target = requiredPath(context);
  let view: Awaited<ReturnType<SessionFilesystem['diff']>>;
  try {
    view = await filesystem.diff(cwd, target);
  } catch (error) {
    return refuse(error);
  }
  if (view.denied || view.ignored) {
    throw new ApiError(403, 'diff is not served by the repository secrets policy', view.denied ? 'denied' : 'ignored');
  }
  if (view.truncated) {
    throw new ApiError(413, `diff exceeds the ${MAX_FILE_BYTES}-byte response limit`, 'too_large');
  }
  return textResponse(view.diff);
}

/**
 * `admin` scope on all four: a warden supervises sessions and has no business reading the human's source
 * tree, and this surface is an arbitrary-file-read primitive wearing a viewer costume.
 *
 * The three deeper paths are registered before the one-segment `fs` so neither can shadow the other — the
 * router matches in registration order, and `fs/file` would otherwise be unreachable behind a pattern that
 * ends at `fs`.
 */
export function sessionFilesystemRoutes(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/file',
      minimum: 'operator',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await file(filesystem, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/index',
      minimum: 'operator',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await index(filesystem, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/changes',
      minimum: 'operator',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await changes(filesystem, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/diff',
      minimum: 'operator',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await diff(filesystem, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs',
      minimum: 'operator',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await list(filesystem, sessions, context),
    },
  ];
}
