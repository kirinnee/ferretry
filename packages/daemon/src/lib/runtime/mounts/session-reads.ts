import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { conditional, jsonResponse, namesTag, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { OperatorReadError, type OperatorReadFailure, type OperatorReadService } from '../../session/reads/index.ts';
import {
  TranscriptImageError,
  type TranscriptImageFailure,
  type TranscriptImages,
} from '../../session/transcript/image-reader.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/**
 * The operator READ surface: a session's durable event history, its live screen, its transcript, and
 * that transcript as addressable rows.
 *
 * WHY IT EXISTS. The protocol client has carried `snapshot`, `logs`, `events` and `history` since the
 * migration began and the daemon mounted none of them, so every one of them answered `unknown_route`.
 * A client method with no route is the shape this migration has now produced several times: it looks
 * like a capability in every type signature and is not one. These routes are what make those client
 * methods real, and `history` needs no route of its own — it is `events` paged, in the client, over
 * that route's exact cursor.
 *
 * `messages` is the newest of them and the one with a second job. The other three answer a question;
 * this one hands back rows a caller may ACT on, so each row carries the durable coordinate a fork is
 * cut at plus opaque evidence that the raw message there is unchanged. Its cursor is likewise minted
 * and checked by the daemon: a client that built one from the point of the last row it saw would be
 * addressing a page this daemon never authenticated.
 *
 * WHY A 404 FROM THE SESSION READ COMES FIRST. Every route here asks the session directory whether the
 * session exists before it asks the subsystem for evidence about it. Without that, an unknown id and a
 * known id with no history would both answer an empty page, and "that session does not exist" would be
 * indistinguishable from "that session has done nothing" — which is the same failure the refusals
 * inside the subsystem exist to prevent, one layer up.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. The live feed is a WebSocket, not another HTTP read. It is
 * mounted separately at `/v1/events` through the socket dispatcher and receives durable appends from
 * the same opened daemon storage. Keeping that transport out of these routes prevents a long-lived
 * stream from being mistaken for another page of replay history.
 */

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<OperatorReadFailure, { readonly status: number; readonly code: string }>> = {
  invalid_query: { status: 400, code: 'invalid_query' },
  // 409 rather than 404: the session is real and the daemon knows it, and what is absent is the
  // terminal — a client that retries the same id later may well get a screen.
  no_terminal: { status: 409, code: 'no_terminal' },
  pane_dead: { status: 409, code: 'pane_dead' },
  stored_snapshot_unavailable: { status: 409, code: 'stored_snapshot_unavailable' },
  stored_snapshot_unreadable: { status: 409, code: 'stored_snapshot_unreadable' },
  no_transcript: { status: 409, code: 'no_transcript' },
  transcript_unreadable: { status: 409, code: 'transcript_unreadable' },
  turn_partition_unavailable: { status: 409, code: 'turn_partition_unavailable' },
  event_evidence_mismatch: { status: 500, code: 'event_evidence_mismatch' },
  // 409 rather than 400: the cursor was well formed and this daemon issued it, and what changed is the
  // conversation under it. A client acts by re-reading from the start of the page it still holds,
  // which is a different remedy from correcting a malformed query — that one stays a 400.
  message_cursor_stale: { status: 409, code: 'message_cursor_stale' },
};

/** The path parameter, decoded. A parameter that regains a separator never reaches the subsystem. */
function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** Restates a domain refusal in the HTTP vocabulary, preserving the code so a client need not match prose. */
function refuse(error: unknown): never {
  if (error instanceof OperatorReadError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/** Proves the session exists before any evidence about it is gathered. */
async function requireSession(sessions: SessionDirectorySubsystem, id: string): Promise<void> {
  const session = await sessions.get(id).catch(() => undefined);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
}

/**
 * A numeric query parameter.
 *
 * A value that is present and not a number is a 400 rather than a silent fall back to the default:
 * `?limit=all` means the caller wanted something this route does not offer, and answering the default
 * page would serve a bound they never asked for.
 */
function numberQuery(context: RouteContext, name: string): number | undefined {
  const raw = queryValue(context.request, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ApiError(400, `query parameter "${name}" must be a number`, 'invalid_query');
  return value;
}

async function events(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  await requireSession(sessions, id);
  try {
    return jsonResponse(await reads.events(id, numberQuery(context, 'after') ?? 0, numberQuery(context, 'limit')));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The live screen.
 *
 * `?live=false` selects the final frame captured at terminalization; the omitted and `true` forms
 * retain the live-pane default. A missing artifact remains a refusal instead of a blank screen,
 * because absence is not evidence that the final screen was blank.
 *
 * `?scope=screen` narrows a LIVE capture to the visible frame; omitted or `history` is the whole
 * scrollback, which is what every reader before the scope existed received. A stored final frame is
 * already one frame, so the scope does not touch it.
 */
async function snapshot(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const live = queryValue(context.request, 'live');
  if (live !== undefined && live !== 'true' && live !== 'false')
    throw new ApiError(400, 'query parameter "live" must be true or false', 'invalid_query');
  const scope = queryValue(context.request, 'scope');
  if (scope !== undefined && scope !== 'screen' && scope !== 'history')
    throw new ApiError(400, 'query parameter "scope" must be screen or history', 'invalid_query');
  await requireSession(sessions, id);
  try {
    return textResponse(await reads.snapshot(id, live !== 'false', scope ?? 'history'));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The session's own transcript tail, as text.
 *
 * `?turn` selects only transcript events between explicit normalized `turn/started` markers. A
 * transcript with no such marker cannot prove a partition, so it is refused rather than guessed from
 * timestamps or handed the whole tail.
 *
 * CONDITIONAL, because the chat page polls it every few seconds and a quiet session's tail is the same
 * answer each time — up to hundreds of kilobytes on a metered relay, for nothing. The tag is taken over
 * the scrubbed text the service returns, never over the transcript itself (see `entityTag`). So a
 * `304` still costs one vault open: the tag cannot be known without the scrub, and a tag over the raw
 * text would tell a client that something a mask hides had changed.
 */
async function logs(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  await requireSession(sessions, id);
  try {
    const body = await reads.logs(id, numberQuery(context, 'limit'), numberQuery(context, 'turn'));
    return conditional(textResponse(body), context.request.headers.get('if-none-match'));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * One page of the session's addressable conversation.
 *
 * `?cursor` is passed through RAW and unnormalized, which is the one place this mount deliberately
 * differs from {@link numberQuery}. An empty value is not treated as absent here: `?cursor=` means the
 * caller believed it held a continuation token, and serving the first page for it would silently
 * restart a walk they thought they were resuming. The domain owns that refusal, so the mount is not a
 * second place a token's bytes could be trimmed, decoded or re-spelled on the way in.
 *
 * `?limit` is the ordinary numeric form, and its default and ceiling belong to the domain rather than
 * to this route — a page size decided in two places is a page size that can disagree with the client's
 * own stated ceiling.
 */
async function messages(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  await requireSession(sessions, id);
  try {
    return jsonResponse(await reads.messages(id, queryValue(context.request, 'cursor'), numberQuery(context, 'limit')));
  } catch (error) {
    return refuse(error);
  }
}

/** The HTTP status and code each refusal of the image read answers with; the code is the reader's own. */
const IMAGE_REFUSALS: Readonly<Record<TranscriptImageFailure, number>> = {
  invalid_image_handle: 400,
  // 409 as for `logs`: the session is real and what is absent is its transcript, which may appear.
  no_transcript: 409,
  transcript_unreadable: 409,
  image_not_found: 404,
  unsupported_image: 415,
};

/** One year, immutable: the handle names bytes of an append-only file, so the answer never changes. */
const IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * One image of the session's transcript, named by a handle the log carried as a marker.
 *
 * THE HANDLE IS PROVED, NEVER TRUSTED (see `TranscriptImageReader`, behind the `TranscriptImages` port). It reads the same transcript at
 * the same minimum as `logs`, so it widens nothing: whoever may read the text may read the picture.
 *
 * CACHEABLE, unlike `logs`: a handle names bytes of an append-only file, so `private` and `immutable`
 * hold and the browser keeps what it painted. A rewritten file is not served stale — the reader proves
 * the handle again under the file's new fingerprint. The tag is the session, the handle and the size, so
 * a `304` still costs a `stat` and a memory lookup, never a read of the image.
 */
async function transcriptImage(
  images: TranscriptImages,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  await requireSession(sessions, id);
  const handle = decodeParameter(context.params.get('handle') ?? '');
  try {
    const found = await images.lookup(id, handle ?? '');
    const headers = { 'cache-control': IMAGE_CACHE_CONTROL, etag: found.etag };
    const ifNoneMatch = context.request.headers.get('if-none-match');
    if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, found.etag))
      return textResponse('', 304, 'application/json', headers);
    return jsonResponse(await found.download(), 200, headers);
  } catch (error) {
    if (error instanceof TranscriptImageError)
      throw new ApiError(IMAGE_REFUSALS[error.failure], error.message, error.failure);
    throw error;
  }
}

/**
 * The `operator` minimum on all five: a pane capture is the agent's whole screen, a transcript is
 * everything it has said, an addressable page is that transcript row by row, and the journal carries
 * the session's configuration in its lifecycle events. None of it is warden-readable until a unit
 * decides deliberately that it should be.
 *
 * `noStore` on the first four for the reason the session view is: these are live state, and a cached answer
 * shows a session that has already moved on. It matters most for the snapshot, whose entire value is
 * that it is the screen as of now — and for `messages`, whose rows carry evidence that is only true of
 * the conversation as it read at the moment it was served.
 *
 * The transcript image route is the exception to `noStore`: a handle names a record that is only ever
 * appended after, so its answer is immutable and caches for a year. Every pattern is under
 * `/v1/sessions/:sessionId` and ends in a literal no other route uses, so none can shadow or be shadowed
 * by the surfaces already mounted.
 */
export function sessionReadRoutes(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  images: TranscriptImages,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/events',
      minimum: 'operator',
      noStore: true,
      handle: async context => await events(reads, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/snapshot',
      minimum: 'operator',
      noStore: true,
      handle: async context => await snapshot(reads, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/logs',
      minimum: 'operator',
      noStore: true,
      handle: async context => await logs(reads, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/messages',
      minimum: 'operator',
      noStore: true,
      handle: async context => await messages(reads, sessions, context),
    },
    // The same minimum and no capability as `logs`, and no `noStore`: see {@link transcriptImage}.
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/transcript-images/:handle',
      minimum: 'operator',
      handle: async context => await transcriptImage(images, sessions, context),
    },
  ];
}
