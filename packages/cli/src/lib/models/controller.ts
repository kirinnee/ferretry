import {
  FleetRuntimeCatalogSchema,
  ModelCatalogRefreshResultSchema,
  ModelCatalogsViewSchema,
} from '@ferretry/protocol';
import type { IModelsGateway, IModelsOutput } from './ports.ts';
import { renderModelCatalogs, renderModelRefresh } from './render.ts';

/** Options `fy models list` accepts. */
export interface ModelsListOptions {
  /** Only the catalog this login's runtimes read. */
  readonly login?: string;
  readonly json?: boolean;
}

/**
 * Drives `fy models list` and `fy models refresh` (docs/model-catalog.md): the model catalogs the daemon
 * reads, and a check for a newer published one now. The daemon owns which catalog a login reads; this
 * only asks it.
 */
export class ModelsController {
  constructor(
    private readonly gateway: IModelsGateway,
    private readonly out: IModelsOutput,
  ) {}

  async list(options: ModelsListOptions): Promise<void> {
    const view = await this.gateway.request('/v1/models', ModelCatalogsViewSchema);
    let shown = view;
    if (options.login !== undefined) {
      const runtimes = await this.gateway.request('/v1/fleet/runtimes', FleetRuntimeCatalogSchema);
      const ids = new Set(
        runtimes.runtimes
          .filter(runtime => runtime.credential.id === options.login)
          .flatMap(runtime => (runtime.models === undefined ? [] : [runtime.models.catalog.id])),
      );
      if (!runtimes.runtimes.some(runtime => runtime.credential.id === options.login))
        throw new Error(`no runtime uses a login named ${options.login}`);
      if (ids.size === 0)
        throw new Error(`login ${options.login} reads no model catalog: it offers its profile's model set`);
      shown = { ...view, catalogs: view.catalogs.filter(catalog => ids.has(catalog.id)) };
    }
    this.out.success(options.json === true ? JSON.stringify(shown, null, 2) : renderModelCatalogs(shown));
  }

  async refresh(options: { readonly json?: boolean }): Promise<void> {
    const result = await this.gateway.request('/v1/models/refresh', ModelCatalogRefreshResultSchema, {
      method: 'POST',
    });
    this.out.success(options.json === true ? JSON.stringify(result, null, 2) : renderModelRefresh(result));
  }
}
