/**
 * What `LoginsApi.modelSources` answers (docs/model-catalog.md): the catalogs in effect whole, the slice of each preset
 * that names the catalog a login reads and the variables that are the person's own, and what the last read of a local
 * server found. Pure; public catalog data only: a preset's variables are named here, never valued.
 */
import { type ModelCatalogSourcesView, ModelCatalogSourcesSchema } from '../../../contract/index.ts';
import type { ModelCatalogSources } from '../catalog/catalog.ts';

export function modelCatalogSourcesView(sources: ModelCatalogSources): ModelCatalogSourcesView {
  return ModelCatalogSourcesSchema.parse({
    catalogs: sources.catalogs,
    presets: sources.presets.map(preset => ({
      id: preset.id,
      ...(preset.catalog === undefined ? {} : { catalog: preset.catalog }),
      variables: {
        ...(preset.halves.claude === undefined ? {} : { claude: Object.keys(preset.halves.claude.env) }),
        ...(preset.halves.codex === undefined ? {} : { codex: Object.keys(preset.halves.codex.env) }),
      },
    })),
    ...(sources.local === undefined ? {} : { local: sources.local }),
  });
}
