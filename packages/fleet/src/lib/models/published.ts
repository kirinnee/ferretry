/**
 * The model catalog as Ferretry PUBLISHES it (docs/model-catalog.md § Live updates): every built-in
 * catalog in one JSON document, beside a tiny version document, served with the hosted app so a model
 * list can change without a release.
 *
 * - `catalog/version.json` — `{ "version": N }`. A daemon reads only this to decide; a version that
 *   differs from the one it holds is an update ("diff == update"), an equal one is no download.
 * - `catalog/models.json` — `{ "version": N, "catalogs": { "<id>": <catalog file>, … } }`. Listed, with
 *   its SHA-256, in the hosted app's signed release list, so a daemon trusts it only after checking that
 *   signature with the key compiled into it.
 *
 * `N` is the number of commits that changed `packages/fleet/models/` — it moves exactly when a catalog
 * does. Nothing here is a credential or a permission: labels, model ids and tiers.
 *
 * Pure.
 */
import { z } from 'zod';
import { modelCatalogFileValue, parseModelCatalog } from './catalog.ts';
import type { ModelCatalog } from './schema.ts';

/** Where the published catalog sits, relative to the hosted app's origin. */
export const PUBLISHED_MODEL_CATALOG_FILE = 'catalog/models.json';
/** Where its version sits, beside it. */
export const PUBLISHED_MODEL_CATALOG_VERSION_FILE = 'catalog/version.json';

const VersionSchema = z.number().int().nonnegative();

/** `catalog/version.json`. */
export const PublishedModelCatalogVersionSchema = z.object({ version: VersionSchema });

/** `catalog/models.json`, before each catalog in it is checked. */
export const PublishedModelCatalogDocumentSchema = z.object({
  version: VersionSchema,
  catalogs: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u), z.unknown()),
});

/** The documents CI writes for a set of catalogs at a version. */
export function publishedModelCatalogFiles(
  version: number,
  catalogs: Readonly<Record<string, ModelCatalog>>,
): Readonly<Record<string, string>> {
  const document = {
    version,
    catalogs: Object.fromEntries(Object.entries(catalogs).map(([id, catalog]) => [id, modelCatalogFileValue(catalog)])),
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
  for (const [id, raw] of Object.entries(parsed.data.catalogs)) {
    const read = parseModelCatalog(id, raw, 'published');
    if (read.ok) catalogs[id] = read.value;
    else rejected.push({ id, problem: read.problem });
  }
  return { version: parsed.data.version, catalogs, rejected };
}
