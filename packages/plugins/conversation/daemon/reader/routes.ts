import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
  textResponse,
} from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { namesTag } from './lib/http.ts';
import {
  type MessageBackwardRead,
  TranscriptReadError,
  type TranscriptReadFailure,
  type TranscriptReadService,
} from './lib/reads.ts';
import {
  TranscriptImageError,
  type TranscriptImageFailure,
  type TranscriptImages,
} from './lib/session/image-reader.ts';

type Call = Parameters<RouteHandler>[0];

/** Whether a ferret exists: asked before any evidence about it is gathered, so an unknown id is not an empty page. */
export type FerretExists = (ferret: string) => Promise<boolean>;

/** The HTTP status and code each refusal answers with (today's `REFUSALS`, minus the pane and journal ones). */
const REFUSALS: Readonly<Record<TranscriptReadFailure, { readonly status: number; readonly code: string }>> = {
  invalid_query: { status: 400, code: 'invalid_query' },
  no_transcript: { status: 409, code: 'no_transcript' },
  transcript_unreadable: { status: 409, code: 'transcript_unreadable' },
  turn_partition_unavailable: { status: 409, code: 'turn_partition_unavailable' },
  event_evidence_mismatch: { status: 500, code: 'event_evidence_mismatch' },
  // 409 rather than 400: the cursor was well formed and this daemon issued it; what changed is the conversation under it.
  message_cursor_stale: { status: 409, code: 'message_cursor_stale' },
  // R266 (kept half): the offsets were fine, and the transcript under them is another one.
  log_cursor_stale: { status: 409, code: 'log_cursor_stale' },
};

const IMAGE_REFUSALS: Readonly<Record<TranscriptImageFailure, number>> = {
  invalid_image_handle: 400,
  no_transcript: 409,
  transcript_unreadable: 409,
  image_not_found: 404,
  unsupported_image: 415,
};

/** One year, immutable: the handle names bytes of an append-only file, so the answer never changes (R267). */
const IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

const ferretId = (call: Call): string => {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
};

const refuse = (error: unknown): never => {
  if (error instanceof TranscriptReadError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
};

/**
 * A numeric query parameter. Present and not a number is a 400 rather than a silent fall back to the default:
 * `?limit=all` means the caller wanted something this route does not offer.
 */
const numberQuery = (call: Call, name: string): number | undefined => {
  const raw = queryValue(call.request, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ApiError(400, `query parameter "${name}" must be a number`, 'invalid_query');
  return value;
};

/** A strong validator over the body AS SERVED, after redaction (R265): never over the raw evidence. */
const entityTag = (body: string): string => `"${createHash('sha256').update(body).digest('base64url')}"`;

/** The answer, or a 304 when `If-None-Match` already names it. */
function conditional(response: ApiResponse, call: Call): ApiResponse {
  const etag = entityTag(response.body);
  const headers = new Map(response.headers);
  headers.set('etag', etag);
  const ifNoneMatch = call.request.headers.get('if-none-match');
  if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, etag)) {
    headers.delete('content-type');
    return { status: 304, headers, body: '' };
  }
  return { ...response, headers };
}

export interface ReaderRoutes {
  readonly reads: TranscriptReadService;
  readonly images: TranscriptImages;
  readonly exists: FerretExists;
}

/** The transcript reads. Each proves the ferret exists before it asks for evidence about it. */
export function readerRoutes({ reads, images, exists }: ReaderRoutes) {
  const known = (handle: (call: Call, id: string) => Promise<ApiResponse>): RouteHandler => {
    return async call => {
      const id = ferretId(call);
      if (!(await exists(id).catch(() => false))) throw new ApiError(404, `no ferret ${id}`, 'not-found');
      return await handle(call, id);
    };
  };

  return {
    /** R265: the tail as text, with a strong etag over the redacted text. `?turn` selects between explicit turn markers. */
    logs: known(async (call, id) => {
      try {
        const body = await reads.logs(id, numberQuery(call, 'limit'), numberQuery(call, 'turn'));
        return conditional(textResponse(body), call);
      } catch (error) {
        return refuse(error);
      }
    }),

    /** R266 (kept half): a page of the transcript, or the page `?before` a byte; a page of another file is `log_cursor_stale`. */
    logPage: known(async (call, id) => {
      const file = queryValue(call.request, 'file');
      const before = numberQuery(call, 'before');
      const from = numberQuery(call, 'from');
      const limit = numberQuery(call, 'limit');
      try {
        const page = await reads.logPage(id, {
          ...(before === undefined ? {} : { before }),
          ...(from === undefined ? {} : { from }),
          ...(limit === undefined ? {} : { limit }),
          ...(file === undefined || file === '' ? {} : { file }),
        });
        return conditional(jsonResponse(page), call);
      } catch (error) {
        return refuse(error);
      }
    }),

    logSearch: known(async (call, id) => {
      const who = queryValue(call.request, 'who');
      const tools = queryValue(call.request, 'tools');
      if (tools !== undefined && tools !== '0' && tools !== '1')
        throw new ApiError(400, 'query parameter "tools" must be 0 or 1', 'invalid_query');
      const limit = numberQuery(call, 'limit');
      try {
        return jsonResponse(
          await reads.logSearch(id, {
            q: queryValue(call.request, 'q') ?? '',
            tools: tools === '1',
            ...(who === undefined || who === '' ? {} : { who }),
            ...(limit === undefined ? {} : { limit }),
          }),
        );
      } catch (error) {
        return refuse(error);
      }
    }),

    /** G41: addressable rows. `?cursor` and `?through` are passed raw; the domain owns the refusal of a blank one. */
    messages: known(async (call, id) => {
      try {
        const tail = queryValue(call.request, 'tail') === '1';
        const through = queryValue(call.request, 'through');
        if (tail && through !== undefined)
          throw new TranscriptReadError('invalid_query', 'tail and through name two different ends; send one');
        const backward: MessageBackwardRead | undefined =
          tail || through !== undefined ? { ...(through === undefined ? {} : { through }) } : undefined;
        return jsonResponse(
          await reads.messages(id, queryValue(call.request, 'cursor'), numberQuery(call, 'limit'), backward),
        );
      } catch (error) {
        return refuse(error);
      }
    }),

    /** R267 / G162: one image, named by a handle the log carried; proved, never trusted; immutable. */
    transcriptImage: known(async (call, id) => {
      const handle = decodeParameter(call.params.get('handle') ?? '');
      try {
        const found = await images.lookup(id, handle ?? '');
        const headers = new Map([
          ['cache-control', IMAGE_CACHE_CONTROL],
          ['etag', found.etag],
        ]);
        const ifNoneMatch = call.request.headers.get('if-none-match');
        if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, found.etag)) return { status: 304, headers, body: '' };
        return jsonResponse(await found.download(), 200, Object.fromEntries(headers));
      } catch (error) {
        if (error instanceof TranscriptImageError)
          throw new ApiError(IMAGE_REFUSALS[error.failure], error.message, error.failure);
        throw error;
      }
    }),
  } as const;
}
