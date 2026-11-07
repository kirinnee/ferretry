import { FY_REQUEST_ID_HEADER } from '../../protocol/headers.ts';
import {
  RestartRequestSchema,
  type RestartCancelResult,
  type RestartRequest,
  type RestartResult,
  type RestartStatus,
} from '../../../../contract/index.ts';
import { type CallContext, headerValue, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { parseBody } from '../../http/body.ts';
import { ferretOf } from '@ferretry/core-gate/contract';

/**
 * Restarting the ferrets whose instructions are out of date: `POST`, `GET` and `DELETE /v1/restarts`
 * (docs/launch-settings.md).
 *
 * `POST` restarts what is idle and QUEUES what is busy — it never forces past the in-flight inventory, so it
 * is safe to press. `GET` lists the outdated ferrets and the waiting restarts. `DELETE` clears the queue.
 *
 * `operator` scope, as the move it drives is. The request id is OPTIONAL here, unlike the move's, because a
 * repeat of this POST is harmless: whatever it would restart is already current, and whatever waits is
 * already queued. When one is sent, a retried request is answered from memory rather than run again.
 *
 * `noStore` because every answer describes live sessions.
 */
export interface SessionRestartSubsystem {
  restart(request: RestartRequest, requestId?: string, requestedBy?: string): Promise<RestartResult>;
  status(): Promise<RestartStatus>;
  cancel(): Promise<RestartCancelResult>;
  /** One pass over the waiting restarts. It serves no route: a timer calls it. */
  drain(): Promise<void>;
}

/**
 * Who a request came from, in the words the journal keeps: a calling ferret's session, else the owner (today's
 * `moverOf`, which ferrets-c's move mount also keeps; here read from Gate's standing instead of the actor string).
 */
function requestedBy(call: CallContext): string {
  // A ferret's own token, or the admin token naming a ferret (G12), is that ferret's request.
  const ferret = ferretOf(call);
  return ferret === undefined ? 'owner' : `session:${ferret}`;
}

/** `POST`, `GET` and `DELETE /v1/restarts` (R-0323, R-0128, R-0023; paths unchanged), keyed for the manifest. */
export function sessionRestartRoutes(subsystem: SessionRestartSubsystem): {
  readonly 'POST /v1/restarts': RouteHandler;
  readonly 'GET /v1/restarts': RouteHandler;
  readonly 'DELETE /v1/restarts': RouteHandler;
} {
  return {
    'POST /v1/restarts': async context => {
      const request = await parseBody(context.request, RestartRequestSchema);
      const id = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim();
      return jsonResponse(await subsystem.restart(request, id === '' ? undefined : id, requestedBy(context)));
    },
    'GET /v1/restarts': async () => jsonResponse(await subsystem.status()),
    'DELETE /v1/restarts': async () => jsonResponse(await subsystem.cancel()),
  };
}
