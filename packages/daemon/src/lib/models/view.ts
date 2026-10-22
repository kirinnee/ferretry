/**
 * `GET /v1/models` (docs/model-catalog.md): every catalog in effect, each model with its tier, context
 * window, efforts and whether it is the default, and the published catalog this machine follows.
 */
import { type CatalogHalf, catalogModelValue, type ModelCatalog } from '@ferretry/fleet';
import type { ModelCatalogEntryView, ModelCatalogRefreshResult, ModelCatalogsView } from '@ferretry/protocol';

const entries = (half: CatalogHalf): readonly ModelCatalogEntryView[] =>
  half.models.map(model => ({
    id: catalogModelValue(model),
    label: model.label,
    tier: model.tier,
    ...(model.context === undefined ? {} : { context: model.context }),
    efforts: [...model.efforts],
    default: model.default,
    ...(model.note === undefined ? {} : { note: model.note }),
    ...(model.price === undefined ? {} : { price: { input: model.price.input, output: model.price.output } }),
    ...(model.retires === undefined ? {} : { retires: model.retires }),
  }));

export interface PublishedCatalogState {
  readonly origin: string;
  readonly enabled: boolean;
  readonly version?: number;
  readonly fetchedAt?: string;
  readonly checkedAt?: string;
  readonly last?: ModelCatalogRefreshResult;
}

export function modelCatalogsView(
  catalogs: Readonly<Record<string, ModelCatalog>>,
  published: PublishedCatalogState,
): ModelCatalogsView {
  return {
    published,
    catalogs: Object.values(catalogs).map(catalog => ({
      id: catalog.id,
      label: catalog.label,
      origin: catalog.origin,
      verified: catalog.verified,
      customIds: catalog.customIds,
      ...(catalog.claude === undefined ? {} : { claude: entries(catalog.claude) }),
      ...(catalog.codex === undefined ? {} : { codex: entries(catalog.codex) }),
    })),
  };
}
