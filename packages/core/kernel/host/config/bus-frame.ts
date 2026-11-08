/**
 * Who hears a `kernel.config-changed` frame on `GET /v1/bus`: exactly a caller `GET /v1/config/file` would let READ the
 * file the frame names. The bus route asks only for an authenticated caller who may discover the publisher (the
 * kernel, which every caller may), but the frame carries a file's state and its disk etag, which only that read
 * answers. So the frame is asked about as that read is, at the same two steps:
 *
 * 1. Gate admits the caller for the route's own descriptor (its minimum, its fleet `use`, the unlock, the grants);
 * 2. Gate's per-file judge (`judgeConfigAccess`, act `read`) admits it for THAT file — `warden.yaml` asks `warden`.
 *
 * With no Gate bound, a judge missing, a decision undetermined or anything that throws, the frame is not shown: a
 * live feed fails closed. A payload that is not the event's own shape shows nothing either.
 */
import type { Admission } from '../../contract/bound.ts';
import { ConfigChanged } from '../../contract/kernel.ts';
import type { ApiRequest } from '../../contract/http.ts';
import type { ScopedRoute } from '../../contract/route.ts';

export function configFrameShown(
  admission: Admission | undefined,
  request: ApiRequest,
  payload: unknown,
  /** The kernel manifest's own `GET /v1/config/file` declaration. */
  fileRead: ScopedRoute,
): boolean {
  if (admission === undefined) return false;
  const frame = ConfigChanged.schema.safeParse(payload);
  if (!frame.success) return false;
  try {
    const decision = admission.admit({ table: 'route', descriptor: fileRead, request, params: new Map() });
    if (decision?.outcome !== 'admitted') return false;
    const verdict = admission.judgeConfigAccess?.({
      plugin: frame.data.plugin,
      path: frame.data.path,
      act: 'read',
      actor: decision.actor,
      standing: decision.standing,
    });
    return verdict?.allowed === true;
  } catch {
    return false;
  }
}
