import {
  type ModelCatalogRefreshResult,
  ModelCatalogRefreshResultSchema,
  type ModelCatalogsView,
  ModelCatalogsViewSchema,
} from '@ferretry/protocol';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';

/**
 * The model catalogs this machine reads (docs/model-catalog.md): `GET` lists them with where each came
 * from and the published catalog's state; `POST …/refresh` checks for a newer published catalog now.
 *
 * GOVERNED AS `fleet.use`: a catalog is labels, model ids and tiers — what every runtime list already
 * shows — and a refresh is one unauthenticated read of the hosted app that spends nothing.
 */
export interface ModelsSubsystem {
  view(): Promise<ModelCatalogsView>;
  refresh(): Promise<ModelCatalogRefreshResult>;
}

const FLEET_USE = { capability: 'fleet', axis: 'use' } as const;

export function modelRoutes(subsystem: ModelsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/models',
      minimum: 'operator',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => jsonResponse(ModelCatalogsViewSchema.parse(await subsystem.view())),
    },
    {
      method: 'POST',
      path: '/v1/models/refresh',
      minimum: 'operator',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => jsonResponse(ModelCatalogRefreshResultSchema.parse(await subsystem.refresh())),
    },
  ];
}
