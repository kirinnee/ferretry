import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { ferretOf } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type FerretId,
  queryValue,
  textResponse,
} from '@ferretry/kernel/contract';
import { type FerretDirectory, knownFerret, pathFerret } from './ferret-path.ts';

/** How much of a pane a capture returns: the visible frame, or the frame with its scrollback. */
export type SnapshotExtent = 'screen' | 'history';

/** What the route asks of the host: the ferret's pane text, scrubbed, or nothing when it has no live pane. */
export interface PaneSnapshotSource {
  capture(ferret: string, extent: SnapshotExtent): Promise<string | undefined>;
}

/** What the route asks of Ferrets: whether the ferret is held, and its stored last screen (masked again by Ferrets). */
export type SnapshotFerrets = FerretDirectory & Pick<FerretsApi, 'lastSnapshot'>;

/**
 * `GET /v1/ferrets/:ferretId/snapshot` (today's `/v1/sessions/:sessionId/snapshot`, §1.4 word): the ferret's pane as
 * text. `scope` is validated and applies to a live capture only.
 *
 * - `live=false` asks for the STORED last screen (the frame kept when the ferret stopped): `FerretsApi.lastSnapshot`,
 *   which masks it again with the Vault's values now and refuses a caller who may not touch the ferret.
 * - Otherwise the pane is captured live; a ferret with NO live pane answers its stored last screen the same way.
 *
 * Either way a screen that is not there is reported as not there (409, never an empty string, which a healthy blank
 * screen also is). The stored read fails closed: Ferrets answers nothing for a frame it cannot read or mask, so this
 * route can only ever answer a frame Ferrets masked on this very read.
 */
export async function snapshotRoute(
  call: CallContext,
  ferrets: SnapshotFerrets,
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
  const stored = async (): Promise<string | undefined> => await ferrets.lastSnapshot?.(id as FerretId, ferretOf(call));
  if (live === 'false') {
    const kept = await stored();
    if (kept === undefined)
      throw new ApiError(409, `ferret ${id} has no stored last screen to read`, 'stored_snapshot_unavailable');
    return textResponse(kept);
  }
  const text = await source.capture(id, scope ?? 'history');
  if (text !== undefined) return textResponse(text);
  const kept = await stored();
  if (kept === undefined)
    throw new ApiError(409, `ferret ${id} has no live pane, so there is no screen to read`, 'pane_dead');
  return textResponse(kept);
}
