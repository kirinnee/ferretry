import { z } from 'zod';
import {
  AnalyticsPricingCatalogSchema,
  AnalyticsPricingProviderSchema,
  AnalyticsPricingRateApplicabilityRecordSchema,
  AnalyticsPricingRateSchema,
  AnalyticsPricingSourceUrlSchema,
  ConfiguredAnalyticsPricingSourcesSchema,
} from './analytics-pricing.ts';
import { InstantSchema, NonEmptyStringSchema } from './common.ts';

/**
 * What a person asks a daemon about its prices, and what it answers — one shape for both ends.
 *
 * EVERY WRITE NAMES THE CATALOG IT WAS COMPOSED AGAINST. Editing prices is exactly the situation
 * where two people, or one person in two tabs, read the same table and then write over each other:
 * the second save would silently discard the first with no error and no way to notice afterwards. So
 * a patch and an apply both carry the fingerprint of the catalog they were built from, and a daemon
 * that has moved on refuses instead of merging.
 *
 * LIFECYCLE IS NOT HERE. How long a preview stays applicable, where it is held and what sweeps it are
 * the daemon's business; this module fixes only the shapes the two ends have to agree on.
 */

/** An opaque digest of a catalog or source list, compared for equality and never parsed. */
export const AnalyticsPricingFingerprintSchema = NonEmptyStringSchema.max(128);

/** An opaque handle naming one previously computed preview. */
export const AnalyticsPricingPreviewIdSchema = NonEmptyStringSchema.max(128);

/** Everything the pricing surface renders: the catalog, the feeds it may sync from, and their identities. */
export const AnalyticsPricingViewSchema = z.strictObject({
  catalog: AnalyticsPricingCatalogSchema,
  catalogFingerprint: AnalyticsPricingFingerprintSchema,
  sources: ConfiguredAnalyticsPricingSourcesSchema,
  sourcesFingerprint: AnalyticsPricingFingerprintSchema,
  /**
   * Which slots this build applies when it has evidence, and which it stores priced but does not — so
   * an operator seeing a total also sees, in the same document, what it does not yet honour.
   */
  rateApplicability: AnalyticsPricingRateApplicabilityRecordSchema,
});
export type AnalyticsPricingView = z.infer<typeof AnalyticsPricingViewSchema>;

/**
 * A rate a PERSON is submitting, which is the only kind a manual patch may carry.
 *
 * A CALLER CANNOT AWARD ITSELF PROVENANCE. `provider_sync` means a daemon fetched these numbers
 * from a source its operator configured, and the whole point of recording that is to tell a price
 * somebody typed from a price a provider published. A patch is the typed path, so a submitted
 * `provider_sync` source would be a client asserting the one claim it is not in a position to make
 * — along with a `sourceUrl` that passes every bound in the contract and names a feed nobody chose.
 *
 * The consequence for the editing journey is deliberate: changing a synced row's numbers converts
 * that row to manual provenance, because after the edit the numbers ARE a person's, not the feed's.
 * That conversion belongs to the surface doing the editing; refusing the forgery belongs here,
 * where both ends read it, rather than in one daemon route a second caller could sidestep.
 */
export const ManualAnalyticsPricingRateSchema = AnalyticsPricingRateSchema.refine(
  rate => rate.source.kind === 'manual',
  { path: ['source', 'kind'], error: 'a submitted rate is manual; a daemon alone records a sync' },
);
export type ManualAnalyticsPricingRate = z.infer<typeof ManualAnalyticsPricingRateSchema>;

/**
 * One deliberate edit, spelled out rather than implied by a diff of the whole table.
 *
 * A structured operation says what the person meant. Submitting a replacement catalog would make
 * "I removed this row" and "my copy never had it" the same request, and a stale tab would delete
 * rows nobody chose to delete.
 */
export const AnalyticsPricingPatchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('upsert'), rate: ManualAnalyticsPricingRateSchema }),
  z.strictObject({ op: z.literal('remove'), pricingKey: NonEmptyStringSchema.max(128) }),
]);
export type AnalyticsPricingPatchOperation = z.infer<typeof AnalyticsPricingPatchOperationSchema>;

export const AnalyticsPricingPatchSchema = z
  .strictObject({
    expectedCatalogFingerprint: AnalyticsPricingFingerprintSchema,
    operations: z.array(AnalyticsPricingPatchOperationSchema).min(1).max(512).readonly(),
  })
  .superRefine((patch, context) => {
    const touched = new Set<string>();
    for (const [index, operation] of patch.operations.entries()) {
      const pricingKey = operation.op === 'upsert' ? operation.rate.pricingKey : operation.pricingKey;
      if (touched.has(pricingKey)) {
        context.addIssue({
          code: 'custom',
          path: ['operations', index],
          message: `${JSON.stringify(pricingKey)} is edited twice in one patch`,
        });
      }
      touched.add(pricingKey);
    }
  });
export type AnalyticsPricingPatch = z.infer<typeof AnalyticsPricingPatchSchema>;

/**
 * Ask what a configured feed would change, by naming the feed — never by supplying an address.
 *
 * The daemon fetches only from a source its operator configured, so this request carries an `id` and
 * nothing that could redirect it.
 */
export const AnalyticsPricingSyncPreviewRequestSchema = z.strictObject({
  sourceId: NonEmptyStringSchema.max(64),
  expectedCatalogFingerprint: AnalyticsPricingFingerprintSchema,
});
export type AnalyticsPricingSyncPreviewRequest = z.infer<typeof AnalyticsPricingSyncPreviewRequestSchema>;

/**
 * One row of the answer, with both sides of the change present.
 *
 * `before` and `after` are shown rather than summarised because the person approving a sync is being
 * asked whether a number should change, and a row that only reports the new value cannot be checked.
 */
export const AnalyticsPricingSyncChangeSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('added'),
      pricingKey: NonEmptyStringSchema.max(128),
      after: AnalyticsPricingRateSchema,
    }),
    z.strictObject({
      kind: z.literal('updated'),
      pricingKey: NonEmptyStringSchema.max(128),
      before: AnalyticsPricingRateSchema,
      after: AnalyticsPricingRateSchema,
    }),
    z.strictObject({
      kind: z.literal('unchanged'),
      pricingKey: NonEmptyStringSchema.max(128),
      before: AnalyticsPricingRateSchema,
    }),
  ])
  .superRefine((change, context) => {
    if (change.kind === 'updated' && change.before.pricingKey !== change.after.pricingKey) {
      context.addIssue({
        code: 'custom',
        path: ['after', 'pricingKey'],
        message: 'an updated change describes one pricing key on both sides',
      });
    }
  });
export type AnalyticsPricingSyncChange = z.infer<typeof AnalyticsPricingSyncChangeSchema>;

/**
 * What a sync would do, and the two identities an apply has to quote back.
 *
 * `baseCatalogFingerprint` pins what it was computed against and `resultCatalogFingerprint` pins what
 * it would produce, so applying a preview is an exact request: a daemon whose catalog moved, or whose
 * feed now answers differently, refuses rather than applying something the person never saw.
 *
 * A sync NEVER removes a row. A feed that has stopped listing a model is evidence about the feed, not
 * an instruction to delete a price historical sessions were costed with; withdrawing a rate stays a
 * deliberate manual operation.
 */
export const AnalyticsPricingSyncPreviewSchema = z.strictObject({
  previewId: AnalyticsPricingPreviewIdSchema,
  sourceId: NonEmptyStringSchema.max(64),
  provider: AnalyticsPricingProviderSchema,
  sourceUrl: AnalyticsPricingSourceUrlSchema,
  /** Stamped by the daemon that made the request, never read from the feed. */
  fetchedAt: InstantSchema,
  baseCatalogFingerprint: AnalyticsPricingFingerprintSchema,
  resultCatalogFingerprint: AnalyticsPricingFingerprintSchema,
  changes: z.array(AnalyticsPricingSyncChangeSchema).max(512).readonly(),
});
export type AnalyticsPricingSyncPreview = z.infer<typeof AnalyticsPricingSyncPreviewSchema>;

/**
 * Apply exactly the rows that were reviewed, out of exactly the preview that was shown.
 *
 * THE SELECTION IS CARRIED, NOT INFERRED. Nothing is selected for a person by default, and a request
 * that named only the preview would apply every row in it — including the ones somebody looked at and
 * chose to leave alone. So the keys are listed, and a daemon applies their changes and nothing else.
 * The list being empty is refused rather than treated as "all", because "apply nothing" is a button
 * nobody presses and a payload that lost its selection is the likelier explanation.
 *
 * The schema bounds the list and refuses a repeat; whether each key is one the named preview actually
 * offered is a question only the daemon holding that preview can answer, and it answers it there.
 */
export const AnalyticsPricingSyncApplySchema = z
  .strictObject({
    previewId: AnalyticsPricingPreviewIdSchema,
    expectedCatalogFingerprint: AnalyticsPricingFingerprintSchema,
    expectedResultFingerprint: AnalyticsPricingFingerprintSchema,
    selectedPricingKeys: z.array(NonEmptyStringSchema.max(128)).min(1).max(512).readonly(),
  })
  .superRefine((apply, context) => {
    const selected = new Set<string>();
    for (const [index, pricingKey] of apply.selectedPricingKeys.entries()) {
      if (selected.has(pricingKey)) {
        context.addIssue({
          code: 'custom',
          path: ['selectedPricingKeys', index],
          message: `${JSON.stringify(pricingKey)} is selected twice`,
        });
      }
      selected.add(pricingKey);
    }
  });
export type AnalyticsPricingSyncApply = z.infer<typeof AnalyticsPricingSyncApplySchema>;
