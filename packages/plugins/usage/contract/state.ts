import { defineState } from '@ferretry/kernel/contract';
import { ProviderQuotaReadingSchema } from '@ferretry/plugin-logins/contract';
import { z } from 'zod';
import { AnalyticsPricingCatalogSchema, ConfiguredAnalyticsPricingSourcesSchema } from './analytics-pricing.ts';
import { InstantSchema } from './common.ts';
import { PausesFileSchema, PauseToldFileSchema } from './pause.ts';

/**
 * The files under `state/usage/` (§9.2). Every JSON document starts at format 1. A damaged file fails the plugin closed
 * (`store_damaged`), except the analytics index, which is a cache: dropped and rebuilt from the ferrets' own records.
 */

/** The pauses in force. A damaged file would read as "nothing paused" and spend past a cap, so it is never narrowed. */
export const PAUSES_STATE = defineState({
  name: 'pauses',
  path: 'pauses.json',
  store: 'json',
  format: 1,
  schema: PausesFileSchema,
});
export const PAUSE_TOLD_STATE = defineState({
  name: 'pause-told',
  path: 'pause-told.json',
  store: 'json',
  format: 1,
  schema: PauseToldFileSchema,
});

/** The owner's rate catalog and the sources it may sync from (today's `analyticsPricing` key of `config/daemon.json`). */
export const PricingFileSchema = z.strictObject({
  catalog: AnalyticsPricingCatalogSchema,
  sources: ConfiguredAnalyticsPricingSourcesSchema,
});
export type PricingFile = z.infer<typeof PricingFileSchema>;
export const PRICING_STATE = defineState({
  name: 'pricing',
  path: 'pricing.json',
  store: 'json',
  format: 1,
  schema: PricingFileSchema,
});

/** The last provider quota read for a login: shown at once on the next open, read again only when somebody watches. */
export const QuotaFileSchema = z.strictObject({ readAt: InstantSchema, reading: ProviderQuotaReadingSchema });
export type QuotaFile = z.infer<typeof QuotaFileSchema>;
export const QUOTAS_STATE = defineState({
  name: 'quotas',
  path: 'quotas/*.json',
  store: 'json',
  format: 1,
  schema: QuotaFileSchema,
});

/** The insights index: one row per finished ferret session. A cache, dropped and rebuilt on any mismatch. */
export const INSIGHTS_STATE = defineState({
  name: 'analytics',
  path: 'analytics.sqlite',
  store: 'sqlite-cache',
  format: 1,
});
