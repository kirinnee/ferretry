import { ApiError, decodeParameter, type RouteHandler } from '@ferretry/kernel/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';

/**
 * A route that names a ferret in its path takes the id OR the callsign (`fy send joslin …`, as `fy stop joslin` does):
 * Ferrets owns the one rule that says which ferret a name is (`FerretsApi.resolve`), and this puts it in front of a handler,
 * so every conversation route reads an id and none of them re-decides what a name means.
 *
 *   - a reference that resolves is handed on as the ferret's id;
 *   - a name two ferrets hold on one footing is refused (409 `ambiguous_name`) with the candidates, never guessed between;
 *   - a reference that matches nothing goes on as it was, so the handler's own "no such ferret" answers it.
 */
export const addressedByCallsign =
  (ferrets: Pick<FerretsApi, 'resolve'>, handler: RouteHandler): RouteHandler =>
  async call => {
    const raw = call.params.get('ferretId');
    const reference = raw === undefined ? undefined : decodeParameter(raw);
    if (reference === undefined || reference === '') return await handler(call);
    const address = await ferrets.resolve(reference);
    if (address.kind === 'ambiguous') throw new ApiError(409, address.message, 'ambiguous_name');
    if (address.kind === 'unknown' || address.id === reference) return await handler(call);
    return await handler({ ...call, params: new Map(call.params).set('ferretId', address.id) });
  };
