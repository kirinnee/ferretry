import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type ModelListRefreshResult,
  ModelListRefreshRequestSchema,
  ModelListRefreshResultSchema,
} from '../../../contract/model-list.ts';
import { FleetCredentialRefusal } from '../credentials/credentials-service.ts';
import { parseBody } from './body.ts';

/**
 * One login's live model list (docs/model-catalog.md § Live model list): `POST …/model-list/refresh` reads it when it
 * is older than a day (a picker opening) or at once with `{ "force": true }` (the person's "Refresh list"), and answers
 * what it came to with the list's ids. It never moves a runtime's pinned default.
 *
 * GOVERNED AS `fleet.use` (in the manifest): the read spends nothing and returns ids only; the Vault records each use of
 * the key itself.
 */
export interface ModelListSubsystem {
  /** Throws {@link FleetCredentialRefusal} (`fleet_credential_unknown`) for a login this machine does not have. */
  refresh(loginId: string, options: { readonly force: boolean }): Promise<ModelListRefreshResult>;
}

export function modelListRoutes(subsystem: ModelListSubsystem) {
  return {
    'POST /v1/logins/:loginId/model-list/refresh': (async call => {
      const id = decodeParameter(call.params.get('loginId') ?? '') ?? '';
      if (id === '') throw new ApiError(400, 'the login id in the path is not usable', 'bad_request');
      const body = await parseBody(call.request, ModelListRefreshRequestSchema);
      try {
        return jsonResponse(
          ModelListRefreshResultSchema.parse(await subsystem.refresh(id, { force: body.force === true })),
        );
      } catch (error) {
        if (error instanceof FleetCredentialRefusal) {
          throw new ApiError(error.code === 'fleet_credential_unknown' ? 404 : 409, error.message, error.code);
        }
        throw error;
      }
    }) satisfies RouteHandler,
  };
}
