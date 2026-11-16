import {
  ApiError,
  type ApiResponse,
  arrivedOnHost,
  decodeParameter,
  errorResponse,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ferretOf } from '@ferretry/core-gate/contract';
import { RenderIdSchema, RenderSaveRequestSchema } from '../../contract/index.ts';
import { namesTag, parseBody } from '../reader/lib/http.ts';
import { RENDER_MAX_BODY_BYTES } from './lib/constants.ts';
import { RenderError, type RenderErrorCode } from './lib/types.ts';
import type { RenderService } from './lib/service.ts';

/**
 * The saved pictures' HTTP surface (docs/renders.md): one write and two reads.
 *
 * THE READS ARE `operator` WITH NO CAPABILITY, like the transcript image route: a picture is content a ferret put into
 * a conversation, a card or an ask, all of which a device that may read them already reads, so a second gate would only
 * be a second copy of the first. The manifest pins this choice, so making renders governed is a reviewed decision.
 *
 * THE WRITE IS NARROWER THAN ITS CREDENTIAL. Only a ferret's own credential and the host's admin token over a local
 * arrival (`arrivedOnHost`, decided from the carrier: a relayed hop is never local) may save. The check runs before the
 * body is read, so a refused caller learns nothing about its payload.
 *
 * THE WRITE IS BOUNDED IN MEMORY. The route reserves a slot (`admit`) right after the caller check and BEFORE the body
 * is read, so `RENDER_MAX_PENDING_SAVES` simultaneous uploads is a hard ceiling and the next is refused with 429
 * `render_busy` without its body being read. The slot is released in a `finally` on every path.
 *
 * NOTHING HERE SERVES A PICTURE AS A DOCUMENT. Both reads answer `application/json` with `X-Content-Type-Options:
 * nosniff`, whatever the request's `Accept` says, so a stored `html` picture opened in a browser tab is JSON text and
 * cannot run on the daemon's origin. The only way it runs is the opaque sandbox frame the app puts it in. EVERY answer a
 * handler here produces carries the header, refusals included (`safely` renders a thrown refusal itself).
 */

const ERROR_STATUS: Readonly<Record<RenderErrorCode, number>> = {
  invalid: 422,
  supersedes_not_found: 404,
  quota_exceeded: 507,
  not_found: 404,
  damaged: 500,
  id_space_exhausted: 500,
  busy: 429,
};

/** One year, immutable: a render's payload is its id, so the answer never changes. */
const PAYLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Set on every answer, errors included: the body is data, never a document. */
const SAFE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

const withSafeHeaders = (response: ApiResponse): ApiResponse => ({
  ...response,
  headers: new Map([...response.headers, ...Object.entries(SAFE_HEADERS)]),
});

/**
 * Wraps a handler so that every answer it produces carries {@link SAFE_HEADERS}. A refusal it raises (a `RenderError`, or
 * an `ApiError` from the id, the caller check or the body) is rendered here with the header added. Anything else is a
 * defect (a repository that rejects): it is answered as a fixed 500 `internal_error` that never repeats the error's text.
 */
function safely(handle: RouteHandler): RouteHandler {
  return async call => {
    try {
      return withSafeHeaders(await handle(call));
    } catch (error) {
      if (error instanceof RenderError)
        return withSafeHeaders(errorResponse(ERROR_STATUS[error.code], error.message, `render_${error.code}`));
      if (error instanceof ApiError)
        return withSafeHeaders(errorResponse(error.status, error.message, error.code, error.extra ?? {}));
      return withSafeHeaders(errorResponse(500, 'internal error', 'internal_error'));
    }
  };
}

const renderId = (call: Parameters<RouteHandler>[0]): string => {
  const decoded = decodeParameter(call.params.get('id') ?? '');
  const parsed = RenderIdSchema.safeParse(decoded);
  if (!parsed.success) throw new ApiError(400, 'the picture id in the path is not usable', 'invalid_render_id');
  return parsed.data;
};

/** Whether the caller may save: a ferret's own credential, or the host's admin token at the machine. */
const mayWrite = (call: Parameters<RouteHandler>[0]): boolean =>
  call.credential?.tokenClass === 'ferret' || arrivedOnHost(call.request, call.credential?.tokenClass === 'admin');

export function saveRoute(renders: RenderService): RouteHandler {
  return safely(async call => {
    if (!mayWrite(call))
      throw new ApiError(403, 'only a ferret or the owner at the machine saves a picture', 'render_save_host_only');
    const slot = renders.admit();
    try {
      const request = await parseBody(call.request, RenderSaveRequestSchema, RENDER_MAX_BODY_BYTES);
      const saved = await renders.save(request, ferretOf(call), slot);
      return jsonResponse(saved, saved.created ? 201 : 200, SAFE_HEADERS);
    } finally {
      slot.release();
    }
  });
}

/** `GET …/meta` is `noStore` (the manifest says so): its answer names the newest render that replaced this one. */
export function metaRoute(renders: RenderService): RouteHandler {
  return safely(async call => jsonResponse(await renders.meta(renderId(call)), 200, SAFE_HEADERS));
}

export function bodyRoute(renders: RenderService): RouteHandler {
  return safely(async call => {
    const found = await renders.body(renderId(call));
    const etag = `"${found.meta.sha256}"`;
    const headers = { ...SAFE_HEADERS, 'cache-control': PAYLOAD_CACHE_CONTROL, etag };
    const ifNoneMatch = call.request.headers.get('if-none-match');
    if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, etag))
      return { status: 304, headers: new Map(Object.entries(headers)), body: '' };
    return jsonResponse(found, 200, headers);
  });
}
