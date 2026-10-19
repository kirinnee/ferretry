/**
 * The model catalogs a daemon reads (docs/model-catalog.md), as `fy models` and any other caller see
 * them: every catalog in effect with where it came from, and the state of the published catalog this
 * machine follows. Data only — labels, model ids and tiers — never a credential.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';

/** `GET`: the catalogs in effect. */
export const MODELS_PATH = '/v1/models';
/** `POST`: check for a newer published catalog now, whatever the last check was. */
export const MODELS_REFRESH_PATH = '/v1/models/refresh';

const NonEmpty = z.string().min(1);

export const ModelCatalogEntryViewSchema = z.strictObject({
  /** The value a CLI is handed (with a context suffix, when the catalog gives one). */
  id: NonEmpty,
  label: NonEmpty,
  tier: z.enum(['best', 'balanced', 'fast']),
  context: z.number().int().positive().optional(),
  efforts: z.array(NonEmpty).readonly(),
  default: z.boolean(),
});
export type ModelCatalogEntryView = z.infer<typeof ModelCatalogEntryViewSchema>;

export const ModelCatalogViewSchema = z.strictObject({
  id: NonEmpty,
  label: NonEmpty,
  /** Which copy is in effect: this machine's own file, the published catalog, or this build's. */
  origin: z.enum(['file', 'published', 'built-in']),
  verified: NonEmpty,
  customIds: z.boolean(),
  claude: z.array(ModelCatalogEntryViewSchema).readonly().optional(),
  codex: z.array(ModelCatalogEntryViewSchema).readonly().optional(),
});
export type ModelCatalogView = z.infer<typeof ModelCatalogViewSchema>;

/** What one check for a newer published catalog came to. */
export const ModelCatalogRefreshOutcomeSchema = z.enum([
  /** A different version was published, checked and is now in effect. */
  'updated',
  /** The published version is the one this machine already holds: nothing was downloaded. */
  'unchanged',
  /** The last check was recent; nothing was asked. */
  'not-due',
  /** The published catalog could not be reached; the one held stays in effect. */
  'unreachable',
  /** What was published did not check — signature, hash or shape; the one held stays in effect. */
  'refused',
  /** This daemon follows no published catalog (`FY_MODEL_CATALOG=off`). */
  'disabled',
]);
export type ModelCatalogRefreshOutcome = z.infer<typeof ModelCatalogRefreshOutcomeSchema>;

export const ModelCatalogRefreshResultSchema = z.strictObject({
  outcome: ModelCatalogRefreshOutcomeSchema,
  /** The published version in effect after the check, when there is one. */
  version: z.number().int().nonnegative().optional(),
  /** Why, in one sentence, for `unreachable` and `refused`. */
  reason: NonEmpty.optional(),
});
export type ModelCatalogRefreshResult = z.infer<typeof ModelCatalogRefreshResultSchema>;

export const ModelCatalogsViewSchema = z.strictObject({
  published: z.strictObject({
    /** The hosted app's origin the published catalog is read from. */
    origin: NonEmpty,
    enabled: z.boolean(),
    version: z.number().int().nonnegative().optional(),
    fetchedAt: InstantSchema.optional(),
    checkedAt: InstantSchema.optional(),
    last: ModelCatalogRefreshResultSchema.optional(),
  }),
  catalogs: z.array(ModelCatalogViewSchema).readonly(),
});
export type ModelCatalogsView = z.infer<typeof ModelCatalogsViewSchema>;
