/**
 * The model catalog as Ferretry PUBLISHES it (docs/model-catalog.md § Live updates): every built-in
 * catalog in one JSON document, beside a tiny version document, served with the hosted app so a model
 * list can change without a release.
 *
 * - `catalog/version.json` — `{ "version": N }`. A daemon reads only this to decide; a version that
 *   differs from the one it holds is an update ("diff == update"), an equal one is no download.
 * - `catalog/models.json` — `{ "version": N, "catalogs": { "<id>": <catalog file>, … }, "prices": … }`.
 *   Listed, with its SHA-256, in the hosted app's signed release list, so a daemon trusts it only after
 *   checking that signature with the key compiled into it.
 *
 * PRICES TRAVEL BESIDE THE CATALOGS, NOT IN THEM (docs/model-catalog.md § Prices). A daemon older than
 * prices reads every model with a strict schema, so one `price` key would make it refuse the whole
 * catalog and fall back to its built-in one. `catalogs` therefore keeps exactly the shape those daemons
 * read, and `prices` — `{ "<catalog id>": { "claude"?: { "<model id>": <price> }, "codex"?: … } }` —
 * is a key they never look at. This build puts each price back on its model as it reads the document.
 *
 * `N` is the number of commits that changed `packages/fleet/models/` — it moves exactly when a catalog
 * does. Nothing here is a credential or a permission: labels, model ids and tiers.
 *
 * Pure.
 */
import { z } from 'zod';
import { modelCatalogFileValue, parseModelCatalog } from './catalog.ts';
import {
  type CatalogHalf,
  type CatalogPrice,
  CatalogPriceSchema,
  type ModelCatalog,
  type ModelCatalogFile,
} from './schema.ts';

/** Where the published catalog sits, relative to the hosted app's origin. */
export const PUBLISHED_MODEL_CATALOG_FILE = 'catalog/models.json';
/** Where its version sits, beside it. */
export const PUBLISHED_MODEL_CATALOG_VERSION_FILE = 'catalog/version.json';

const VersionSchema = z.number().int().nonnegative();

/** `catalog/version.json`. */
export const PublishedModelCatalogVersionSchema = z.object({ version: VersionSchema });

const CatalogIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

/** `catalog/models.json`, before each catalog and price in it is checked. */
export const PublishedModelCatalogDocumentSchema = z.object({
  version: VersionSchema,
  catalogs: z.record(CatalogIdSchema, z.unknown()),
  prices: z.record(CatalogIdSchema, z.unknown()).optional(),
});

const HALVES = ['claude', 'codex'] as const;
type Half = (typeof HALVES)[number];

/** One catalog's prices, by half and model id, as `prices` carries them. */
type CatalogPrices = Partial<Record<Half, Record<string, CatalogPrice>>>;

/** A catalog without its prices: the shape a daemon older than prices reads. */
function unpricedCatalogValue(catalog: ModelCatalog): ModelCatalogFile {
  const file = modelCatalogFileValue(catalog);
  const strip = (half: CatalogHalf | undefined) =>
    half === undefined ? {} : { models: half.models.map(({ price: _price, ...model }) => model) };
  return {
    ...file,
    ...(file.claude === undefined ? {} : { claude: { ...file.claude, ...strip(file.claude) } }),
    ...(file.codex === undefined ? {} : { codex: { ...file.codex, ...strip(file.codex) } }),
  };
}

/** A catalog's prices, by half and model id; `undefined` for a catalog that prices nothing. */
function catalogPrices(catalog: ModelCatalog): CatalogPrices | undefined {
  const prices: CatalogPrices = {};
  for (const half of HALVES) {
    const priced = (catalog[half]?.models ?? []).flatMap(model =>
      model.price === undefined ? [] : [[model.id, model.price] as const],
    );
    if (priced.length > 0) prices[half] = Object.fromEntries(priced);
  }
  return Object.keys(prices).length === 0 ? undefined : prices;
}

/** The documents CI writes for a set of catalogs at a version. */
export function publishedModelCatalogFiles(
  version: number,
  catalogs: Readonly<Record<string, ModelCatalog>>,
): Readonly<Record<string, string>> {
  const prices = Object.entries(catalogs).flatMap(([id, catalog]) => {
    const priced = catalogPrices(catalog);
    return priced === undefined ? [] : [[id, priced] as const];
  });
  const document = {
    version,
    catalogs: Object.fromEntries(Object.entries(catalogs).map(([id, catalog]) => [id, unpricedCatalogValue(catalog)])),
    prices: Object.fromEntries(prices),
  };
  return {
    [PUBLISHED_MODEL_CATALOG_FILE]: `${JSON.stringify(document)}\n`,
    [PUBLISHED_MODEL_CATALOG_VERSION_FILE]: `${JSON.stringify({ version })}\n`,
  };
}

/** A published document, read: its version, every catalog that checks, and why each other one does not. */
export interface PublishedModelCatalog {
  readonly version: number;
  readonly catalogs: Readonly<Record<string, ModelCatalog>>;
  readonly rejected: readonly { readonly id: string; readonly problem: string }[];
  /** Each price that did not check, left off its model — which stays in the catalog, unpriced. */
  readonly rejectedPrices: readonly { readonly id: string; readonly model: string; readonly problem: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Put a catalog's published prices back on its models. A price that does not check, or names a model
 * the catalog does not list, is left out and named — one bad price never takes its catalog with it.
 */
function withPrices(
  catalog: ModelCatalog,
  raw: unknown,
  rejected: { id: string; model: string; problem: string }[],
): ModelCatalog {
  if (raw === undefined) return catalog;
  const refuse = (model: string, problem: string) => rejected.push({ id: catalog.id, model, problem });
  if (!isRecord(raw)) {
    refuse('*', 'the prices are not a map of halves');
    return catalog;
  }
  const priced: { claude?: CatalogHalf; codex?: CatalogHalf } = {};
  for (const half of HALVES) {
    const models = raw[half];
    const listed = catalog[half];
    if (models === undefined) continue;
    if (!isRecord(models) || listed === undefined) {
      refuse(`${half}.*`, `there is no ${half} half to price`);
      continue;
    }
    const ids = new Set(listed.models.map(model => model.id));
    for (const id of Object.keys(models)) if (!ids.has(id)) refuse(id, `${half} lists no model ${id}`);
    priced[half] = {
      ...listed,
      models: listed.models.map(model => {
        if (!(model.id in models)) return model;
        const price = CatalogPriceSchema.safeParse(models[model.id]);
        if (price.success) return { ...model, price: price.data };
        refuse(model.id, price.error.issues.map(issue => issue.message).join('; '));
        return model;
      }),
    };
  }
  return { ...catalog, ...priced };
}

/**
 * Read a published document. `undefined` when it is not one at all; a catalog inside it that does not
 * check is left out and named in `rejected`, so one bad entry never takes the others with it.
 */
export function readPublishedModelCatalog(value: unknown): PublishedModelCatalog | undefined {
  const parsed = PublishedModelCatalogDocumentSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const catalogs: Record<string, ModelCatalog> = {};
  const rejected: { id: string; problem: string }[] = [];
  const rejectedPrices: { id: string; model: string; problem: string }[] = [];
  for (const [id, raw] of Object.entries(parsed.data.catalogs)) {
    const read = parseModelCatalog(id, raw, 'published');
    if (read.ok) catalogs[id] = withPrices(read.value, parsed.data.prices?.[id], rejectedPrices);
    else rejected.push({ id, problem: read.problem });
  }
  return { version: parsed.data.version, catalogs, rejected, rejectedPrices };
}
