import {
  ApiError,
  type ApiResponse,
  type CallContext,
  headerValue,
  jsonResponse,
  queryValue,
  type Redaction,
  type RedactionScope,
  type RouteHandler,
  textResponse,
} from '@ferretry/kernel/contract';
import {
  bareMediaName,
  MAX_MEDIA_BYTES,
  MEDIA_CHUNK_BYTES,
  mediaAnswer,
  type MediaRange,
  mediaRangeAnswer,
  mediaTypeOf,
  parseMediaRange,
} from '../../../../contract/media-bytes.ts';
import { SESSION_FILE_INDEX_VERSION, type SessionFileIndexResponse } from '../../protocol/session-search.ts';
import {
  type ByteWindow,
  FsError,
  MAX_FILE_BYTES,
  type FsDiffView,
  type FsFileView,
  redactedDiff,
  redactedFileBase64,
  fileHoldsValue,
  redactedFile,
  type SessionFilesystem,
  type SessionReadFence,
} from '../../session/filesystem/index.ts';
import { FS_ERROR_STATUS } from '../../ferrets/folder-listing.ts';
import { type MediaVerdict, MediaScanCache } from './media-scan-cache.ts';

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

// The status table is shared with the in-process listing (`FerretsApi.listFolder`), so the two cannot drift. 501 rather
// than 403 for `unsupported`: it is a statement about the daemon, not about the caller's authority or the path.
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
// read-scoped: none — gates and git only; the diff text leaves through diffResponse(scope), never from here
async function diff(filesystem: SessionFilesystem, deps: FileBrowserDeps, context: RouteContext): Promise<ApiResponse> {
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
  // The vault opens HERE and only here: every refusal above was decided without it, and a vault that cannot open
  // serves no diff at all (it fails closed).
  return await deps.redaction.read(scope => diffResponse(view, scope, fence !== undefined));
}

/** The one place diff text leaves the daemon: masked through the read's scope. */
function diffResponse(view: FsDiffView, scope: RedactionScope, agent: boolean): ApiResponse {
  const { text: masked, covered } = redactedDiff(view.diff, scope);
  // The refusal rests on what the scope reported, never on whether the masked text differs from the original.
  if (agent && covered) throw holdsSecret(view.path);
  // An agent is also refused a file that holds a value, as fs/file does: a diff can show only part of a value, so the
  // two sides the service already read (HEAD and working) are asked too. A person's diff is masked, never refused.
  if (agent && sidesHoldValue(view, scope)) throw holdsSecret(view.path);
  return textResponse(masked);
}

function sidesHoldValue(view: FsDiffView, scope: RedactionScope): boolean {
  const { head, working } = view.sides ?? {};
  return (
    (head !== undefined && fileHoldsValue(head, scope)) || (working !== undefined && fileHoldsValue(working, scope))
  );
}

/**
 * An agent is never handed a file that holds a vault value, masked or not: a masked copy looks like ordinary content
 * and an agent could write it back over the real file. ONE sentence for any count of values; it names the path only.
 * `everyone` is for a route that refuses the file to a person too (`fs/media`: masking bytes would hand back something
 * that is not the file), where saying "an agent" would tell the person it was meant for someone else.
 */
function holdsSecret(path: string, everyone = false): ApiError {
  return new ApiError(
    403,
    `${path} holds a private value, so it is not served${everyone ? '' : ' to an agent'}.`,
    'holds_secret',
  );
}

/**
 * One file's bytes behind the same gates as a listing (today's file read). `scope=media` names the ferret's media
 * folder (F-0327), which lives in the daemon's own session state: the read is confined to that one folder by the same
 * descriptor walk, behind the same gates and the same grant, and a daemon that keeps none answers 404.
 * `rev=head` reads the committed bytes.
 */
// read-scoped: none — gates and file reads only; the bytes leave through fileResponse(scope), never from here
async function file(
  workingTree: SessionFilesystem,
  deps: FileBrowserDeps,
  context: RouteContext,
): Promise<ApiResponse> {
  fileQuery(context);
  const { id, cwd, fence } = await deps.reach(context);
  let filesystem = workingTree;
  if (queryValue(context.request, 'scope') === 'media') {
    if (deps.media === undefined) throw new ApiError(404, 'this daemon keeps no session media folder', 'not_found');
    filesystem = deps.media(id);
  }
  const target = requiredPath(context);
  const rev = queryValue(context.request, 'rev');
  const format = queryValue(context.request, 'format');
  let view: Awaited<ReturnType<SessionFilesystem['readFile']>>;
  try {
    view = await filesystem.readFile(cwd, target, {
      ...(rev === 'head' ? { rev: 'head' as const } : {}),
      ...(format === 'base64' ? { base64: true } : {}),
      ...(fence === undefined ? {} : { fence }),
    });
  } catch (error) {
    return refuse(error);
  }
  // A flag-only view (denied, ignored, too large, binary) carries no bytes: it is served without the vault.
  if (view.content === undefined && view.base64 === undefined) return jsonResponse(view);
  // The vault opens HERE and only here (after every gate); a vault that cannot open serves no bytes (fail closed).
  return await deps.redaction.read(scope => fileResponse(view, scope, fence !== undefined));
}

/** The one place file bytes leave the daemon: text masked through the read's scope, character for character. */
function fileResponse(view: FsFileView, scope: RedactionScope, agent: boolean): ApiResponse {
  const text = view.content === undefined ? undefined : redactedFile(view.content, scope);
  const bytes = view.base64 === undefined ? undefined : redactedFileBase64(view.base64, scope);
  const content = text?.text;
  const base64 = bytes?.base64;
  // The refusal rests on what the scope REPORTED, never on how the masked text compares to the original.
  const redacted = text?.covered === true || bytes?.covered === true;
  if (redacted && agent) throw holdsSecret(view.path);
  return jsonResponse({
    ...view,
    ...(content === undefined ? {} : { content }),
    ...(base64 === undefined ? {} : { base64 }),
    ...(redacted ? { redacted: true } : {}),
  });
}

/**
 * ONE FILE OF THE FERRET'S MEDIA FOLDER, AS RAW BYTES, IN PIECES (`docs/fy-render.md` rule 11, `docs/grants.md`).
 *
 * The read is `fs/file?scope=media`'s — the media folder's own pinned walk, the same gates, the same agent fence, the
 * same `filesystem` _use_ grant — with a cap of {@link MAX_MEDIA_BYTES} instead of one mebibyte and the bytes sent as
 * they are instead of base64 in JSON. What is stricter than the JSON read: the request names a BARE FILE NAME (`name`,
 * never a path), a name the type allowlist does not know is refused (`415`), and a file holding a vault value is
 * refused to everyone (`403 holds_secret`) because masking bytes would hand back something that is not the file.
 *
 * `Range` is RFC 9110 for one range: `206` with `Content-Range`, `416` with `Content-Range: bytes *\/size` for a start
 * past the end, an open or oversized range clamped to one piece. No `Range` at all is a `200` only for a file that fits
 * one piece; a larger one is `413 range_required`, never a body one session cannot carry.
 */
// read-scoped: none — gates and file reads only; the bytes leave through mediaAnswer, after the secrets verdict below
async function media(
  _workingTree: SessionFilesystem,
  deps: FileBrowserDeps,
  context: RouteContext,
  scans: MediaScanCache,
): Promise<ApiResponse> {
  const { id, cwd, fence } = await deps.reach(context);
  const name = bareMediaName(queryValue(context.request, 'name'));
  if (name === undefined) throw new ApiError(400, 'query parameter "name" must be one bare file name', 'invalid_path');
  const type = mediaTypeOf(name);
  if (type === undefined) throw new ApiError(415, `${name} is not a file type this route serves`, 'unsupported_type');
  if (deps.media === undefined) throw new ApiError(404, 'this daemon keeps no session media folder', 'not_found');
  const rangeHeader = headerValue(context.request, 'range');
  // What the span chooser decided, for the answer built after the read: the range asked, the file's size, and whether
  // this request owes the whole-file scan (nobody has a verdict yet) and so reads every byte.
  let asked: { readonly range: MediaRange; readonly size: number } | undefined;
  let owed: ((verdict: MediaVerdict | undefined) => void) | undefined;
  let held = false;
  let view: Awaited<ReturnType<SessionFilesystem['readFile']>>;
  try {
    view = await deps.media(id).readFile(cwd, name, {
      raw: true,
      maxBytes: MAX_MEDIA_BYTES,
      // Asked once every gate has passed and before a byte is read, with the identity of the very file about to be read.
      span: async file => {
        const range = parseMediaRange(rangeHeader, file.size);
        asked = { range, size: file.size };
        // The vault opens HERE for the first time (after every gate); one that cannot open serves no bytes (fail closed).
        const fingerprint = await deps.redaction.read(scope => scope.fingerprint?.());
        // A redactor that cannot say what it masks cannot say a verdict still holds: read and scan every time.
        if (fingerprint === undefined) return undefined;
        const key = MediaScanCache.keyOf(file);
        for (;;) {
          const claim = scans.claim(key, fingerprint);
          if (claim.kind === 'verdict') {
            if (claim.secret) throw holdsSecret(name, true);
            held = true;
            return windowOf(range, file.size, name);
          }
          if (claim.kind === 'wait') {
            await claim.until;
            continue;
          }
          owed = claim.settle;
          return undefined;
        }
      },
      ...(fence === undefined ? {} : { fence }),
    });
  } catch (error) {
    owed?.(undefined);
    return refuse(error);
  }
  try {
    if (view.denied === true || view.ignored === true)
      throw new ApiError(
        403,
        `${name} is not served by the repository secrets policy`,
        view.denied === true ? 'denied' : 'ignored',
        undefined,
        view.rule === undefined ? undefined : { rule: view.rule },
      );
    if (view.tooLarge === true)
      throw new ApiError(413, `${name} is over the ${MAX_MEDIA_BYTES}-byte limit this route serves`, 'too_large');
    const bytes = view.bytes;
    if (bytes === undefined) throw new ApiError(404, `no file ${name}`, 'not_found');
    if (held && asked !== undefined) {
      // A verdict was already held: these are the range's bytes alone, and they answer as the whole file would have.
      assertPiece(asked, bytes);
      return mediaRangeAnswer(asked.range, asked.size, bytes, type, name);
    }
    // Every byte of the file is here and no verdict covers it: scan it ONCE, keep what was found, then answer.
    return await deps.redaction.read(scope => {
      const secret = fileHoldsValue(bytes, scope);
      const fingerprint = scope.fingerprint?.();
      owed?.(fingerprint === undefined ? undefined : { secret, fingerprint });
      owed = undefined;
      if (secret) throw holdsSecret(name, true);
      return mediaAnswer(bytes, type, rangeHeader, name);
    });
  } finally {
    // A request that leaves without a verdict (a refusal, a throw) hands the scan back so a waiter takes it over.
    owed?.(undefined);
  }
}

/** The span of the file a range needs, and `undefined` when it needs all of it (a small file asked for whole). */
function windowOf(range: MediaRange, size: number, name: string): ByteWindow | undefined {
  if (range.kind === 'part') return { start: range.start, length: range.end - range.start + 1 };
  if (range.kind === 'unsatisfiable') return { start: 0, length: 0 };
  if (size > MEDIA_CHUNK_BYTES)
    throw new ApiError(413, `${name} is read in ranges of at most ${MEDIA_CHUNK_BYTES} bytes`, 'range_required');
  return undefined;
}

/** The piece read is the length the range named: a file cut short under the read is refused, never served short. */
function assertPiece(asked: { readonly range: MediaRange; readonly size: number }, bytes: Uint8Array): void {
  const { range, size } = asked;
  const expected = range.kind === 'part' ? range.end - range.start + 1 : range.kind === 'unsatisfiable' ? 0 : size;
  if (bytes.byteLength !== expected)
    throw new ApiError(409, 'the file changed while it was being read, so ask again', 'changed');
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
   * The service over the ONE ferret's media folder (`scope=media`, F-0327): a function of the ferret alone, so the caller
   * chooses `scope=media`, never a directory. Absent: `scope=media` answers 404.
   */
  readonly media?: ((ferret: string) => SessionFilesystem) | undefined;
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
  'GET /v1/ferrets/:ferretId/fs/media',
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
  // One verdict memory for this mount: a media file is scanned for vault values once, not once per piece it is served in.
  const scans = new MediaScanCache();
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
    'GET /v1/ferrets/:ferretId/fs/media': bound((filesystem, bounded, context) =>
      media(filesystem, bounded, context, scans),
    ),
    'GET /v1/ferrets/:ferretId/fs/index': bound(index),
    'GET /v1/ferrets/:ferretId/fs/changes': bound(changes),
    'GET /v1/ferrets/:ferretId/fs/diff': bound(diff),
    'GET /v1/ferrets/:ferretId/fs': bound(list),
  };
}
