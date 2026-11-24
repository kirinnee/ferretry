import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type ModelListRefreshResult,
  ModelListRefreshRequestSchema,
  ModelListRefreshResultSchema,
} from '../../../contract/model-list.ts';
import { FleetCredentialRefusal } from '../credentials/credentials-service.ts';
import { parseBody } from './body.ts';

/**
 * One login's live model list (docs/model-catalog.md § Live model list), two doors on one service:
 *
 * - `POST …/model-list/refresh` (a picker opening) reads the list only when it is a day old or more.
 * - `POST …/model-list/force` (the person's "Refresh list") reads it at once.
 *
 * Each answers what it came to with the list's ids, and neither moves a runtime's pinned default. Both are held to the
 * service's attempt cooldowns, so no caller reaches the provider more often than a minute (a quarter hour after a failed
 * plain read), however often it asks.
 *
 * GOVERNED IN THE MANIFEST: the plain door is `fleet.use` (it can only ever refresh a stale list), the forced one is
 * `fleet.configure` like the keyed Test, because it is the one a caller can aim at the provider on demand. Each read of a
 * key is recorded by the read itself (`secrets.used`, docs/audit.md), not by these routes.
 */
export interface ModelListSubsystem {
  /** Throws {@link FleetCredentialRefusal} (`fleet_credential_unknown`) for a login this machine does not have. */
  refresh(loginId: string, options: { readonly force: boolean }): Promise<ModelListRefreshResult>;
}

export function modelListRoutes(subsystem: ModelListSubsystem) {
  const door =
    (force: boolean): RouteHandler =>
    async call => {
      const id = decodeParameter(call.params.get('loginId') ?? '') ?? '';
      if (id === '') throw new ApiError(400, 'the login id in the path is not usable', 'bad_request');
      await parseBody(call.request, ModelListRefreshRequestSchema);
      try {
        return jsonResponse(ModelListRefreshResultSchema.parse(await subsystem.refresh(id, { force })));
      } catch (error) {
        if (error instanceof FleetCredentialRefusal) {
          throw new ApiError(error.code === 'fleet_credential_unknown' ? 404 : 409, error.message, error.code);
        }
        throw error;
      }
    };
  return {
    'POST /v1/logins/:loginId/model-list/refresh': door(false) satisfies RouteHandler,
    'POST /v1/logins/:loginId/model-list/force': door(true) satisfies RouteHandler,
  };
}
