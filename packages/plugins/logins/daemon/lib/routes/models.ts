import { jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type LocalModels,
  LocalModelsSchema,
  type ModelCatalogRefreshResult,
  ModelCatalogRefreshResultSchema,
  type ModelCatalogsView,
  ModelCatalogsViewSchema,
} from '../../../contract/index.ts';

/**
 * The model catalogs this machine reads (docs/model-catalog.md): `GET` lists them with where each came from and the
 * published catalog's state; `POST …/refresh` checks for a newer published catalog now; `POST …/local/refresh` reads
 * the models Ollama has installed on this machine now.
 *
 * GOVERNED AS `fleet.use` (in the manifest): a catalog is labels, model ids and tiers — what every runtime list
 * already shows — and a refresh is one unauthenticated read that spends nothing.
 */
export interface ModelsSubsystem {
  view(): Promise<ModelCatalogsView>;
  refresh(): Promise<ModelCatalogRefreshResult>;
  /** Read the models installed on this machine now (Ollama). Never throws: a server that is down is an answer. */
  refreshLocal(): Promise<LocalModels>;
}

export function modelRoutes(subsystem: ModelsSubsystem) {
  return {
    'GET /v1/models': (async () =>
      jsonResponse(ModelCatalogsViewSchema.parse(await subsystem.view()))) satisfies RouteHandler,
    'POST /v1/models/refresh': (async () =>
      jsonResponse(ModelCatalogRefreshResultSchema.parse(await subsystem.refresh()))) satisfies RouteHandler,
    'POST /v1/models/local/refresh': (async () =>
      jsonResponse(LocalModelsSchema.parse(await subsystem.refreshLocal()))) satisfies RouteHandler,
  };
}
