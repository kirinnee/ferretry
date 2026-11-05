import { RENDER_MAX_BODY_BYTES, RenderIdSchema, RenderSaveRequestSchema } from '@ferretry/protocol';
import { agentSessionOf } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, arrivedOnHost, decodeParameter } from '../../api/http.ts';
import { jsonResponse, namesTag, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { RenderError, type RenderErrorCode, type RenderService } from '../../renders/index.ts';

/**
 * The saved pictures' HTTP surface (docs/renders.md): one write and two reads.
 *
 * THE READS ARE `operator` WITH NO CAPABILITY, like the transcript image route: a picture is content a ferret
 * put into a conversation, a card or an agenda, all of which a device that may read them already reads, so a
 * second gate would only be a second copy of the first. A test pins this choice
 * (`tests/unit/runtime/mounts/renders.test.ts`), so making renders governed is a reviewed decision. The
 * warden and anonymous callers never reach them.
 *
 * THE WRITE IS NARROWER THAN ITS CREDENTIAL. `operator` also admits every paired device, a browser on the host
 * and a session carried over the relay, and none of those writes pictures in this release: nothing in the app
 * saves one, so there is no remote write to govern. Only a ferret's own session credential and the host's admin
 * token over a loopback peer (`arrivedOnHost`, decided from the carrier — a relayed hop is never loopback)
 * may save. The check runs before the body is read, so a refused caller learns nothing about its payload.
 *
 * NOTHING HERE SERVES A PICTURE AS A DOCUMENT. Both reads answer `application/json` with
 * `X-Content-Type-Options: nosniff`, whatever the request's `Accept` says, so a stored `html` picture opened
 * in a browser tab is JSON text and cannot run on the daemon's origin. The only way it runs is the opaque
 * sandbox frame the app puts it in. That is the feature's security invariant.
 */

const ERROR_STATUS: Readonly<Record<RenderErrorCode, number>> = {
  invalid: 422,
  supersedes_not_found: 404,
  quota_exceeded: 507,
  not_found: 404,
  damaged: 500,
  id_space_exhausted: 500,
};

/** One year, immutable: a render's payload is its id, so the answer never changes. */
const PAYLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Set on every answer, errors included: the body is data, never a document. */
const SAFE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

function reraise(error: unknown): never {
  if (error instanceof RenderError) throw new ApiError(ERROR_STATUS[error.code], error.message, `render_${error.code}`);
  throw error;
}

function renderId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('id') ?? '');
  const parsed = RenderIdSchema.safeParse(decoded);
  if (!parsed.success) throw new ApiError(400, 'the picture id in the path is not usable', 'invalid_render_id');
  return parsed.data;
}

/** Whether the caller may save: a ferret's own session credential, or the host's admin token at the machine. */
function mayWrite(context: RouteContext): boolean {
  const tokenClass = context.credential?.tokenClass;
  if (tokenClass === 'session') return true;
  return arrivedOnHost(context.request, tokenClass === 'admin');
}

async function save(renders: RenderService, context: RouteContext): Promise<ApiResponse> {
  if (!mayWrite(context))
    throw new ApiError(403, 'only a ferret or the owner at the machine saves a picture', 'render_save_host_only');
  const request = await parseBody(context.request, RenderSaveRequestSchema, { maxBytes: RENDER_MAX_BODY_BYTES });
  try {
    const saved = await renders.save(request, agentSessionOf(context));
    return jsonResponse(saved, saved.created ? 201 : 200, SAFE_HEADERS);
  } catch (error) {
    return reraise(error);
  }
}

async function meta(renders: RenderService, context: RouteContext): Promise<ApiResponse> {
  try {
    return jsonResponse(await renders.meta(renderId(context)), 200, SAFE_HEADERS);
  } catch (error) {
    return reraise(error);
  }
}

async function body(renders: RenderService, context: RouteContext): Promise<ApiResponse> {
  const id = renderId(context);
  try {
    const found = await renders.body(id);
    const headers = { ...SAFE_HEADERS, 'cache-control': PAYLOAD_CACHE_CONTROL, etag: `"${found.meta.sha256}"` };
    const ifNoneMatch = context.request.headers.get('if-none-match');
    if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, headers.etag))
      return textResponse('', 304, 'application/json', headers);
    return jsonResponse(found, 200, headers);
  } catch (error) {
    return reraise(error);
  }
}

/**
 * `GET …/meta` is `noStore`: its answer names the newest render that replaced this one, which changes.
 * `GET …/:id` is the immutable one. The patterns share a prefix and differ in a literal, so neither can
 * shadow the other.
 */
export function renderRoutes(renders: RenderService): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/renders',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await save(renders, context),
    },
    {
      method: 'GET',
      path: '/v1/renders/:id/meta',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await meta(renders, context),
    },
    {
      method: 'GET',
      path: '/v1/renders/:id',
      minimum: 'operator',
      caller: 'any',
      handle: async context => await body(renders, context),
    },
  ];
}
