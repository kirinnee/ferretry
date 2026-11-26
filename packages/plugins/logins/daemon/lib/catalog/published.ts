/**
 * The model catalog as Ferretry PUBLISHES it (docs/model-catalog.md § Live updates): every built-in
 * catalog in one JSON document, beside a tiny version document, served with the hosted app so a model
 * list can change without a release.
 *
 * - `catalog/version.json` — `{ "version": N, "digest": "<SHA-256 base64url>" }`. A daemon reads only this
 *   to decide; matching version and digest need no download. The digest includes discovery snapshot changes.
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
 * HALVES ADDED LATER RIDE BESIDE THE CATALOGS TOO (U5). A catalog's `gemini`, `copilot` and `opencode` halves are
 * keys a daemon older than them would refuse, so `catalogs` holds only what those daemons read — the `claude` and
 * `codex` halves of the catalogs that have one, byte for byte as before — and `catalogsV2` holds, WHOLE, every
 * catalog that has a newer half. A daemon that knows them reads `catalogsV2[id]` in place of `catalogs[id]`, and
 * falls back to `catalogs[id]` when the V2 entry does not check. `suggestions` (./suggestions.ts) is a trimmed
 * models.dev snapshot, a key no older daemon looks at.
 *
 * `N` is the number of commits that changed `packages/fleet/models/` — it moves exactly when a catalog
 * does. Nothing here is a credential or a permission: labels, model ids and tiers.
 *
 * Pure.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { modelCatalogFileValue, parseModelCatalog } from './catalog.ts';
import {
  type CatalogHalf,
  type CatalogPrice,
  CatalogPriceSchema,
  BASE_HALF_KEYS,
  type ModelCatalog,
  type ModelCatalogFile,
  NEW_HALF_KEYS,
} from './schema.ts';
import { type DroppedSuggestion, readSuggestions, type Suggestions } from './suggestions.ts';

/** Where the published catalog sits, relative to the hosted app's origin. */
export const PUBLISHED_MODEL_CATALOG_FILE = 'catalog/models.json';
/** Where its version sits, beside it. */
export const PUBLISHED_MODEL_CATALOG_VERSION_FILE = 'catalog/version.json';

const VersionSchema = z.number().int().nonnegative();

/** `catalog/version.json`. */
export const PublishedModelCatalogVersionSchema = z.object({
  version: VersionSchema,
  digest: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
});

const CatalogIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

/** `catalog/models.json`, before each catalog and price in it is checked. */
const PublishedModelCatalogDocumentSchema = z.object({
  version: VersionSchema,
  catalogs: z.record(CatalogIdSchema, z.unknown()),
  prices: z.record(CatalogIdSchema, z.unknown()).optional(),
  catalogsV2: z.record(CatalogIdSchema, z.unknown()).optional(),
  suggestions: z.unknown().optional(),
});

const HALVES = BASE_HALF_KEYS;
type Half = (typeof HALVES)[number];

/** One catalog's prices, by half and model id, as `prices` carries them. */
type CatalogPrices = Partial<Record<Half, Record<string, CatalogPrice>>>;

/** The shape a daemon older than the newer halves reads: no newer half. `undefined` for a catalog with no base half. */
function baseCatalogValue(catalog: ModelCatalog): ModelCatalogFile | undefined {
  const file = unpricedCatalogValue(catalog);
  if (file.claude === undefined && file.codex === undefined) return undefined;
  const base: Record<string, unknown> = { ...file };
  for (const key of NEW_HALF_KEYS) delete base[key];
  return base as ModelCatalogFile;
}

const hasNewHalf = (catalog: ModelCatalog): boolean => NEW_HALF_KEYS.some(key => catalog[key] !== undefined);

/** A catalog without its base halves' prices (they ride in `prices`); a newer half keeps its own. */
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
  suggestions?: Suggestions,
): Readonly<Record<string, string>> {
  const prices = Object.entries(catalogs).flatMap(([id, catalog]) => {
    const priced = catalogPrices(catalog);
    return priced === undefined ? [] : [[id, priced] as const];
  });
  const document = {
    version,
    catalogs: Object.fromEntries(
      Object.entries(catalogs).flatMap(([id, catalog]) => {
        const base = baseCatalogValue(catalog);
        return base === undefined ? [] : [[id, base] as const];
      }),
    ),
    prices: Object.fromEntries(prices),
    catalogsV2: Object.fromEntries(
      Object.entries(catalogs).flatMap(([id, catalog]) =>
        hasNewHalf(catalog) ? [[id, unpricedCatalogValue(catalog)] as const] : [],
      ),
    ),
    ...(suggestions === undefined ? {} : { suggestions }),
  };
  const text = `${JSON.stringify(document)}\n`;
  const digest = createHash('sha256').update(text).digest('base64url');
  return {
    [PUBLISHED_MODEL_CATALOG_FILE]: text,
    [PUBLISHED_MODEL_CATALOG_VERSION_FILE]: `${JSON.stringify({ version, digest })}\n`,
  };
}

/** A published document, read: its version, every catalog that checks, and why each other one does not. */
export interface PublishedModelCatalog {
  readonly version: number;
  readonly catalogs: Readonly<Record<string, ModelCatalog>>;
  readonly rejected: readonly { readonly id: string; readonly problem: string }[];
  /** The trimmed models.dev snapshot, when the document carries one that checks (./suggestions.ts). */
  readonly suggestions?: Suggestions;
  /** Each suggestion provider or row that did not check, left out. */
  readonly droppedSuggestions: readonly DroppedSuggestion[];
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
  const ids = [...new Set([...Object.keys(parsed.data.catalogs), ...Object.keys(parsed.data.catalogsV2 ?? {})])];
  for (const id of ids) {
    // A catalog with a newer half is read from its whole V2 entry; when that does not check, from the base one.
    const whole = parsed.data.catalogsV2?.[id];
    const fromWhole = whole === undefined ? undefined : parseModelCatalog(id, whole, 'published');
    if (fromWhole?.ok === true) {
      catalogs[id] = withPrices(fromWhole.value, parsed.data.prices?.[id], rejectedPrices);
      continue;
    }
    const base = parsed.data.catalogs[id];
    if (base === undefined) {
      rejected.push({ id, problem: fromWhole?.ok === false ? fromWhole.problem : 'not a catalog' });
      continue;
    }
    const read = parseModelCatalog(id, base, 'published');
    if (read.ok) catalogs[id] = withPrices(read.value, parsed.data.prices?.[id], rejectedPrices);
    else rejected.push({ id, problem: read.problem });
  }
  const { suggestions, dropped } = readSuggestions(parsed.data.suggestions);
  return {
    version: parsed.data.version,
    catalogs,
    rejected,
    rejectedPrices,
    droppedSuggestions: dropped,
    ...(suggestions === undefined ? {} : { suggestions }),
  };
}
