import { join, relative } from 'node:path';
import { SESSION_FILE_INDEX_VERSION, type SessionFileIndexResponse } from '@ferretry/protocol';
import { agentSessionOf, isAgentCaller } from '../../api/agent-caller.ts';
import { ApiError } from '../../api/error.ts';
import { resolvedStateHomes, type StateHomeReach } from '../../api/state-homes.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  FsError,
  type FsErrorCode,
  withinFolder,
  MAX_FILE_BYTES,
  type SessionFilesystem,
  type SessionReadFence,
} from '../../session/filesystem/index.ts';
import { isAncestorOf, sessionSubFerretDirectory } from '../../sub-ferret/index.ts';
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
 * AN AGENT READS ONLY ITS OWN TREE, AND NEVER THE STATE HOME. A ferret (its session credential, or the admin
 * token naming its session) may read its own session and the sub-ferrets it started — a lead reviews its
 * sub-ferret's work — and no other: the owner's sessions, a sibling's, the Warden's. Whatever session it reads,
 * nothing inside the daemon's state home is read for it, so a session started in `~` or in the home itself
 * hands it no token. A person (a paired device, the owner at the machine) is unchanged, so the owner's viewer
 * still opens any session's files (docs/agent-tools.md § "Reading a session's files").
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

/** The code an agent asking for a session that is not its own, or its sub-ferret's, is refused with. */
const NOT_OWN_SESSION_CODE = 'not_own_session';

/**
 * The fence a read for this caller sits behind, or `undefined` for a person. An agent is refused here when
 * `id` is neither its own session nor one it started, and when the state home cannot be resolved.
 *
 * `media`: the session's media folder, the fence's one opening — it lives in the daemon's own session state,
 * and it is where the agent puts what it made to show. Mapped onto each home's real path by the home's own
 * prefix, never by resolving the folder itself, so a media folder swapped for a link into the home is not
 * opened by the resolution of that link.
 */
async function agentFence(
  context: RouteContext,
  sessions: SessionDirectorySubsystem,
  stateHomes: StateHomeReach | undefined,
  id: string,
  media?: string,
): Promise<SessionReadFence | undefined> {
  if (!isAgentCaller(context)) return undefined;
  const own = agentSessionOf(context);
  if (own === undefined)
    throw new ApiError(
      403,
      'an agent reads only its own session’s files, and this request names no session of its own',
      NOT_OWN_SESSION_CODE,
    );
  if (own !== id && !(await isAncestorOf(sessionSubFerretDirectory(sessions), own, id)))
    throw new ApiError(
      403,
      `an agent reads only its own session’s files and its sub-ferrets’, and ${id} is neither`,
      NOT_OWN_SESSION_CODE,
    );
  const homes = await resolvedStateHomes(stateHomes);
  const opening =
    media === undefined
      ? []
      : [
          media,
          ...homes.homes.flatMap(home =>
            withinFolder(home.named, media) ? [join(home.real, relative(home.named, media))] : [],
          ),
        ];
  return { homes, opening };
}

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
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const fence = await agentFence(context, sessions, stateHomes, id);
  const cwd = await sessionCwd(sessions, id);
  try {
    return jsonResponse(
      await filesystem.list(cwd, queryValue(context.request, 'path'), fence === undefined ? {} : { fence }),
    );
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Names the session's MEDIA folder — where its agent puts files it made to show the person — or
 * `undefined` on a daemon that keeps none. A function of the session id alone: the caller chooses
 * `scope=media`, never a directory.
 */
export type SessionMediaRoot = (sessionId: string) => string;

/**
 * Which tree a file read is confined to: the session's working tree, or with `scope=media` its media
 * folder. The media folder lives in the daemon's own session state, so no repository's ignore rules
 * decide whether a generated chart can be shown — the denylist still applies, the filesystem grant still
 * governs the route, and the read is still descriptor-confined to that one folder.
 */
async function fileRoot(
  sessions: SessionDirectorySubsystem,
  mediaRoot: SessionMediaRoot | undefined,
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<{ readonly root: string; readonly fence: SessionReadFence | undefined }> {
  const id = sessionId(context);
  const scope = queryValue(context.request, 'scope');
  if (scope === undefined) {
    const fence = await agentFence(context, sessions, stateHomes, id);
    return { root: await sessionCwd(sessions, id), fence };
  }
  if (scope !== 'media') throw new ApiError(400, 'query parameter "scope" must be "media"', 'invalid_scope');
  if (queryValue(context.request, 'rev') !== undefined)
    throw new ApiError(400, 'the media folder has no history, so "rev" does not apply', 'invalid_rev');
  if (mediaRoot === undefined) throw new ApiError(404, 'this daemon keeps no session media folder', 'not_found');
  const media = mediaRoot(id);
  const fence = await agentFence(context, sessions, stateHomes, id, media);
  await sessionCwd(sessions, id);
  return { root: media, fence };
}

async function file(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  mediaRoot: SessionMediaRoot | undefined,
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const { root: cwd, fence } = await fileRoot(sessions, mediaRoot, stateHomes, context);
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
        ...(fence === undefined ? {} : { fence }),
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
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const fence = await agentFence(context, sessions, stateHomes, id);
  const cwd = await sessionCwd(sessions, id);
  try {
    // Bounds are the domain's own; the only thing a route contributes is the caller's cancellation,
    // because the transport is the only layer that knows the caller stopped waiting.
    const view = await filesystem.index(cwd, {
      signal: context.request.signal,
      ...(fence === undefined ? {} : { fence }),
    });
    const response: SessionFileIndexResponse = { v: SESSION_FILE_INDEX_VERSION, sessionId: id, ...view };
    return jsonResponse(response);
  } catch (error) {
    return refuse(error);
  }
}

async function changes(
  filesystem: SessionFilesystem,
  sessions: SessionDirectorySubsystem,
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const fence = await agentFence(context, sessions, stateHomes, id);
  const cwd = await sessionCwd(sessions, id);
  try {
    return jsonResponse(await filesystem.changes(cwd, fence === undefined ? {} : { fence }));
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
  stateHomes: StateHomeReach | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const fence = await agentFence(context, sessions, stateHomes, id);
  const cwd = await sessionCwd(sessions, id);
  const target = requiredPath(context);
  let view: Awaited<ReturnType<SessionFilesystem['diff']>>;
  try {
    view = await filesystem.diff(cwd, target, fence === undefined ? {} : { fence });
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
  mediaRoot?: SessionMediaRoot,
  /** The daemon's own directories, which no read for an agent reaches. Absent: an agent reads nothing here. */
  stateHomes?: StateHomeReach,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/file',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await file(filesystem, sessions, mediaRoot, stateHomes, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/index',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await index(filesystem, sessions, stateHomes, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/changes',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await changes(filesystem, sessions, stateHomes, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs/diff',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await diff(filesystem, sessions, stateHomes, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/fs',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await list(filesystem, sessions, stateHomes, context),
    },
  ];
}
