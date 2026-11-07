import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { ApiError, type CallContext, decodeParameter, type FerretId } from '@ferretry/kernel/contract';

/** Whether a ferret is held: the one question these routes ask Ferrets before acting (today's `sessions.get`). */
export type FerretDirectory = Pick<FerretsApi, 'get'>;

/** The ferret named in the path (`:ferretId`), decoded; a traversal or a separator is refused. */
export function pathFerret(call: CallContext): string {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** 404 for a ferret this daemon does not hold. */
export async function knownFerret(ferrets: FerretDirectory, id: string): Promise<void> {
  if ((await ferrets.get(id as FerretId)) === undefined) throw new ApiError(404, `no ferret ${id}`, 'not-found');
}
