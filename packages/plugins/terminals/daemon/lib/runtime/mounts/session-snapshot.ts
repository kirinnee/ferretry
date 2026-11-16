import { ApiError, type ApiResponse, type CallContext, queryValue, textResponse } from '@ferretry/kernel/contract';
import { type FerretDirectory, knownFerret, pathFerret } from './ferret-path.ts';

/** How much of a pane a capture returns: the visible frame, or the frame with its scrollback. */
export type SnapshotExtent = 'screen' | 'history';

/** What the route asks of the host: the ferret's pane text, scrubbed, or nothing when it has no live pane. */
export interface PaneSnapshotSource {
  capture(ferret: string, extent: SnapshotExtent): Promise<string | undefined>;
}

/**
 * `GET /v1/ferrets/:ferretId/snapshot` (today's `/v1/sessions/:sessionId/snapshot`, §1.4 word): the ferret's pane as
 * text, as of now. `live` is validated and accepted as today; this daemon writes no stored final frame, so both
 * answers are a live capture, and a pane that is gone is reported as gone — never an empty string, which a healthy
 * blank screen also is.
 */
export async function snapshotRoute(
  call: CallContext,
  ferrets: FerretDirectory,
  source: PaneSnapshotSource,
): Promise<ApiResponse> {
  const id = pathFerret(call);
  const live = queryValue(call.request, 'live');
  if (live !== undefined && live !== 'true' && live !== 'false')
    throw new ApiError(400, 'query parameter "live" must be true or false', 'invalid_query');
  const scope = queryValue(call.request, 'scope');
  if (scope !== undefined && scope !== 'screen' && scope !== 'history')
    throw new ApiError(400, 'query parameter "scope" must be screen or history', 'invalid_query');
  await knownFerret(ferrets, id);
  const text = await source.capture(id, scope ?? 'history');
  if (text === undefined)
    throw new ApiError(409, `ferret ${id} has no live pane, so there is no screen to read`, 'pane_dead');
  return textResponse(text);
}
