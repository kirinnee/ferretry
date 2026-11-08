import {
  ApiError,
  type ApiResponse,
  type CallContext,
  jsonResponse,
  queryValue,
  type Redaction,
  type RedactionScope,
  type RouteHandler,
  textResponse,
} from '@ferretry/kernel/contract';
import { SESSION_FILE_INDEX_VERSION, type SessionFileIndexResponse } from '../../protocol/session-search.ts';
import {
  FsError,
  type FsErrorCode,
  MAX_FILE_BYTES,
  redactedDiffText,
  type SessionFilesystem,
  type SessionReadFence,
} from '../../session/filesystem/index.ts';

type RouteContext = CallContext;

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

/** Today's file query policy. Never silently read the working tree for a HEAD, media or base64 request. */
function fileQuery(context: RouteContext): void {
  const scope = queryValue(context.request, 'scope');
  if (scope !== undefined && scope !== 'media')
    throw new ApiError(400, 'query parameter "scope" must be "media"', 'invalid_scope');
  const rev = queryValue(context.request, 'rev');
  if (scope === 'media' && rev !== undefined)
    throw new ApiError(400, 'the media folder has no history, so "rev" does not apply', 'invalid_rev');
  requiredPath(context);
  if (rev !== undefined && rev !== 'head')
    throw new ApiError(400, 'query parameter "rev" must be "head"', 'invalid_rev');
  const format = queryValue(context.request, 'format');
  if (format !== undefined && format !== 'base64')
    throw new ApiError(400, 'query parameter "format" must be "base64"', 'invalid_format');
}

async function list(filesystem: SessionFilesystem, deps: FileBrowserDeps, context: RouteContext): Promise<ApiResponse> {
  const { cwd, fence } = await deps.reach(context);
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
async function index(
  filesystem: SessionFilesystem,
  deps: FileBrowserDeps,
  context: RouteContext,
): Promise<ApiResponse> {
  const { id, cwd, fence } = await deps.reach(context);
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
  deps: FileBrowserDeps,
  context: RouteContext,
): Promise<ApiResponse> {
  const { cwd, fence } = await deps.reach(context);
  try {
    return jsonResponse(await filesystem.changes(cwd, fence === undefined ? {} : { fence }));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * One path's unified diff, as text, with every vault secret masked.
 *
 * The service's diff bytes are the real ones (they stay unchanged so nothing consuming a diff is corrupted); this
 * route is the OUTBOUND projection, and it masks them through the read's `scope` as the last step before they leave.
 * The secrets-policy refusal below runs first and is untouched: redaction adds to the gate, it does not replace it.
 *
 * A refused diff is a 403 rather than a badge: the body of this route is diff bytes and has nowhere to
 * carry a flag. A TRUNCATED diff is a 413 for a stronger reason — a partial diff is actively misleading in
 * a review surface, because the missing tail renders as content that was never removed.
 */
async function diff(
  filesystem: SessionFilesystem,
  deps: FileBrowserDeps,
  context: RouteContext,
  scope: RedactionScope,
): Promise<ApiResponse> {
  const { cwd, fence } = await deps.reach(context);
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
  return textResponse(redactedDiffText(view.diff, scope));
}

/**
 * One file's bytes behind the same gates as a listing (today's file read). `scope=media` names the ferret's media
 * folder, which this daemon keeps in its own state and does not serve through the working-tree walk: it answers
 * 404, as today's daemon did when it kept no media folder. `rev=head` reads the committed bytes.
 */
async function file(filesystem: SessionFilesystem, deps: FileBrowserDeps, context: RouteContext): Promise<ApiResponse> {
  fileQuery(context);
  if (queryValue(context.request, 'scope') === 'media')
    throw new ApiError(404, 'this daemon keeps no session media folder', 'not_found');
  const { cwd, fence } = await deps.reach(context);
  const target = requiredPath(context);
  const rev = queryValue(context.request, 'rev');
  const format = queryValue(context.request, 'format');
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
 * `admin` scope on all four: a warden supervises sessions and has no business reading the human's source
 * tree, and this surface is an arbitrary-file-read primitive wearing a viewer costume.
 *
 * The three deeper paths are registered before the one-segment `fs` so neither can shadow the other — the
 * router matches in registration order, and `fs/file` would otherwise be unreachable behind a pattern that
 * ends at `fs`.
 */
/** What the file-browser routes need from Ferrets' build. */
export interface FileBrowserDeps {
  /**
   * The service, over the kernel's pinned root walk (today's session root pinners) and Git through the kernel's
   * spawn: one for every ferret, or one made for the ferret a request names (its pinner is that ferret's `work`
   * root). Absent: every route answers 503.
   */
  readonly filesystem: SessionFilesystem | ((ferret: string) => SessionFilesystem) | undefined;
  /**
   * The ferret the path names, its working folder, and the fence an agent's read sits behind (S47: its own ferret and
   * its helpers only, never the state home); `fence` is `undefined` for a person. Refusals are today's.
   */
  reach(
    context: RouteContext,
  ): Promise<{ readonly id: string; readonly cwd: string; readonly fence?: SessionReadFence }>;
  /**
   * The vault's read-scoped redaction. The diff route opens ONE read and masks the diff text through it before it
   * leaves; a vault that cannot open fails the read, so nothing unmasked is served (S19).
   */
  readonly redaction: Pick<Redaction, 'read'>;
}

/** The four route keys, as `manifest.ts` declares them (today's `/v1/sessions/:sessionId/fs…`, renamed). */
const FILE_BROWSER_ROUTE_KEYS = [
  'GET /v1/ferrets/:ferretId/fs/file',
  'GET /v1/ferrets/:ferretId/fs/index',
  'GET /v1/ferrets/:ferretId/fs/changes',
  'GET /v1/ferrets/:ferretId/fs/diff',
  'GET /v1/ferrets/:ferretId/fs',
] as const;
export type FileBrowserRouteKey = (typeof FILE_BROWSER_ROUTE_KEYS)[number];

/** The spine's skeleton answer (D10), until the kernel's root walk is bound. */
function notBuilt(): never {
  throw new ApiError(
    503,
    'The ferret file browser is not built yet in this version of Ferretry.',
    'plugin_unavailable',
  );
}

/**
 * The working-tree read surface. Every byte read needs today's descriptor pinner, single-link metadata,
 * gitignore policy and agent home fence. RootHandle.stat/readText cannot prove these checks.
 */
export function sessionFilesystemRoutes(deps: FileBrowserDeps): { readonly [K in FileBrowserRouteKey]: RouteHandler } {
  const bound =
    (handler: (filesystem: SessionFilesystem, deps: FileBrowserDeps, context: RouteContext) => Promise<ApiResponse>) =>
    async (context: RouteContext): Promise<ApiResponse> => {
      // Who may ask is decided first (S47), so an agent is refused another ferret's folder even before it is built.
      const reached = await deps.reach(context);
      const filesystem = typeof deps.filesystem === 'function' ? deps.filesystem(reached.id) : deps.filesystem;
      if (filesystem === undefined) return notBuilt();
      // The handler is told what the check found, not asked to check again.
      return await handler(filesystem, { ...deps, reach: async () => reached }, context);
    };
  return {
    'GET /v1/ferrets/:ferretId/fs/file': bound(file),
    'GET /v1/ferrets/:ferretId/fs/index': bound(index),
    'GET /v1/ferrets/:ferretId/fs/changes': bound(changes),
    'GET /v1/ferrets/:ferretId/fs/diff': bound((filesystem, routeDeps, context) =>
      routeDeps.redaction.read(scope => diff(filesystem, routeDeps, context, scope)),
    ),
    'GET /v1/ferrets/:ferretId/fs': bound(list),
  };
}
