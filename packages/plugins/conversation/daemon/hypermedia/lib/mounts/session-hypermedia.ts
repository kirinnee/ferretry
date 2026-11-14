import { ApiError, decodeParameter, jsonResponse, parseBody } from '../../../seams/api.ts';
import type { ApiResponse, MountRoute, RouteContext } from '../../../seams/api.ts';
import { type HypermediaResult, HypermediaRequestSchema, type HypermediaState } from '../../../../contract/index.ts';
import { type HypermediaOutcome, SessionHypermediaError } from '../service.ts';

/**
 * Reading and switching whether one ferret is told to use hypermedia: `GET` and `PATCH /v1/ferrets/:ferretId/hypermedia`
 * (docs/hypermedia.md). The read is the ferret's switch as it stands (the owner's, else its mode's default). The answer is whether a restart is needed for it to take effect, and that said in words.
 *
 * `operator` scope and no capability, like rename: it is a write to a ferret's own configuration, it grants nothing,
 * and it changes only what the ferret is told at its next launch.
 */
export interface SessionHypermediaSubsystem {
  read(ferret: string): Promise<boolean>;
  set(ferret: string, enabled: boolean): Promise<HypermediaOutcome>;
}

function refuse(error: unknown): never {
  if (error instanceof SessionHypermediaError) throw new ApiError(404, error.message, 'not-found');
  throw error;
}

function ferretOf(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function read(subsystem: SessionHypermediaSubsystem, context: RouteContext): Promise<ApiResponse> {
  const enabled = await subsystem.read(ferretOf(context)).catch(refuse);
  return jsonResponse({ enabled } satisfies HypermediaState);
}

async function set(subsystem: SessionHypermediaSubsystem, context: RouteContext): Promise<ApiResponse> {
  const ferret = ferretOf(context);
  const request = await parseBody(context.request, HypermediaRequestSchema);
  const outcome = await subsystem.set(ferret, request.enabled).catch(refuse);
  return jsonResponse({ ...outcome } satisfies HypermediaResult);
}

/** `noStore` (the manifest's descriptor) because the answer is the switch this call changed. */
export function sessionHypermediaRoutes(subsystem: SessionHypermediaSubsystem): readonly MountRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/ferrets/:ferretId/hypermedia',
      handle: async context => await read(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/ferrets/:ferretId/hypermedia',
      handle: async context => await set(subsystem, context),
    },
  ];
}
