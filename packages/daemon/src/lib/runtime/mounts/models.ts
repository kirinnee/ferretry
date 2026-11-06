import {
  type ModelCatalogRefreshResult,
  ModelCatalogRefreshResultSchema,
  type LocalModels,
  LocalModelsSchema,
  type ModelCatalogsView,
  ModelCatalogsViewSchema,
} from '@ferretry/protocol';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import type { ModuleContribution } from '../modules.ts';

/**
 * The model catalogs this machine reads (docs/model-catalog.md): `GET` lists them with where each came
 * from and the published catalog's state; `POST …/refresh` checks for a newer published catalog now;
 * `POST …/local/refresh` reads the models Ollama has installed on this machine now.
 *
 * GOVERNED AS `fleet.use`: a catalog is labels, model ids and tiers — what every runtime list already
 * shows — and a refresh is one unauthenticated read that spends nothing: of the hosted app, or of a
 * server on this machine. Installed model names are what `ollama list` prints.
 */
export interface ModelsSubsystem {
  view(): Promise<ModelCatalogsView>;
  refresh(): Promise<ModelCatalogRefreshResult>;
  /** Read the models installed on this machine now (Ollama). Never throws: a server that is down is an answer. */
  refreshLocal(): Promise<LocalModels>;
}

const FLEET_USE = { capability: 'fleet', axis: 'use' } as const;

export function modelRoutes(subsystem: ModelsSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/models',
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => jsonResponse(ModelCatalogsViewSchema.parse(await subsystem.view())),
    },
    {
      method: 'POST',
      path: '/v1/models/refresh',
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => jsonResponse(ModelCatalogRefreshResultSchema.parse(await subsystem.refresh())),
    },
    {
      method: 'POST',
      path: '/v1/models/local/refresh',
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      handle: async () => jsonResponse(LocalModelsSchema.parse(await subsystem.refreshLocal())),
    },
  ];
}

/**
 * What the models module adds to the daemon: the three catalog routes. They have no audit rule (a refresh is a
 * read that spends nothing, and the contract fragment says why) and claim no protocol feature.
 *
 * Every path is a fixed literal under `/v1/models`, which no other subsystem uses, so no table can shadow or be
 * shadowed by anything around it.
 */
export function modelsContribution(subsystem: ModelsSubsystem): ModuleContribution {
  return { routes: modelRoutes(subsystem) };
}
