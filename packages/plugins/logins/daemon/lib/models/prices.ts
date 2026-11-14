/**
 * What `LoginsApi.modelPrices` answers (docs/model-catalog.md § Prices): every catalog in effect, each half's models that
 * state a list price with the WHOLE of it, and Claude Code's tier pins as bare model ids. Pure; public catalog data only.
 */
import type { ModelPriceCatalog } from '../../../contract/index.ts';
import { type CatalogHalf, type ModelCatalog, slotModelId } from '../catalog/schema.ts';

const TIER_NAMES = ['opus', 'sonnet', 'haiku'] as const;

const half = (source: CatalogHalf | undefined): ModelPriceCatalog['claude'] => {
  if (source === undefined) return undefined;
  const tiers = Object.fromEntries(
    TIER_NAMES.flatMap(name => {
      const pinned = source.tiers?.[name];
      return pinned === undefined ? [] : [[name, slotModelId(pinned)]];
    }),
  );
  return {
    models: source.models.flatMap(model => (model.price === undefined ? [] : [{ id: model.id, price: model.price }])),
    ...(Object.keys(tiers).length === 0 ? {} : { tiers }),
  };
};

export function modelPriceCatalogs(catalogs: Readonly<Record<string, ModelCatalog>>): readonly ModelPriceCatalog[] {
  return Object.values(catalogs).map(catalog => {
    const claude = half(catalog.claude);
    const codex = half(catalog.codex);
    return { id: catalog.id, ...(claude === undefined ? {} : { claude }), ...(codex === undefined ? {} : { codex }) };
  });
}
