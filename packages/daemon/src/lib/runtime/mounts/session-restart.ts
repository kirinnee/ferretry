import {
  FY_REQUEST_ID_HEADER,
  RestartRequestSchema,
  type RestartCancelResult,
  type RestartRequest,
  type RestartResult,
  type RestartStatus,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';

/**
 * Restarting the ferrets whose instructions are out of date: `POST`, `GET` and `DELETE /v1/restarts`
 * (docs/launch-settings.md).
 *
 * `POST` restarts what is idle and QUEUES what is busy — it never forces past the in-flight inventory, so it
 * is safe to press. `GET` lists the outdated ferrets and the waiting restarts. `DELETE` clears the queue.
 *
 * `operator` scope, as the migrate it drives is. The request id is OPTIONAL here, unlike the migrate's, because a
 * repeat of this POST is harmless: whatever it would restart is already current, and whatever waits is
 * already queued. When one is sent, a retried request is answered from memory rather than run again.
 *
 * `noStore` because every answer describes live sessions.
 */
export interface SessionRestartSubsystem {
  restart(request: RestartRequest, requestId?: string): Promise<RestartResult>;
  status(): Promise<RestartStatus>;
  cancel(): Promise<RestartCancelResult>;
  /** One pass over the waiting restarts. It serves no route: a timer calls it. */
  drain(): Promise<void>;
}

export function sessionRestartRoutes(subsystem: SessionRestartSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/restarts',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const request = await parseBody(context.request, RestartRequestSchema);
        const id = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim();
        return jsonResponse(await subsystem.restart(request, id === '' ? undefined : id));
      },
    },
    {
      method: 'GET',
      path: '/v1/restarts',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.status()),
    },
    {
      method: 'DELETE',
      path: '/v1/restarts',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.cancel()),
    },
  ];
}
