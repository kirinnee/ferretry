import { defineState } from '@ferretry/kernel/contract';
import { InstantSchema, NonNegativeFiniteSchema } from '@ferretry/std';
import { z } from 'zod';
import { SearchProviderSchema } from './providers.ts';

/** The most results one search may ask for, and the default. */
export const SEARCH_MAX_RESULTS = 10;
export const SEARCH_DEFAULT_RESULTS = 5;

/** What a ferret passes `web_search`. */
export const WebSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(400),
  count: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional(),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

/** One result, whichever provider found it. `snippet` is the provider's own words, cut short. */
export const SearchHitSchema = z.strictObject({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * What one Test proved, as a closed vocabulary so a screen can say the next step: `not_set` means pick a provider and
 * paste a key, `rejected` means the key is wrong, everything else is the provider's side (or the network).
 * `vault_damaged` is never reported as `not_set`: a person told "no key" over a store that is merely unreadable pastes
 * a second one on top.
 */
export const SearchTestCodeSchema = z.enum([
  'ok',
  'not_set',
  'rejected',
  'rate_limited',
  'timeout',
  'unreachable',
  'provider_error',
  'malformed',
  'vault_damaged',
]);
export type SearchTestCode = z.infer<typeof SearchTestCodeSchema>;

export const SearchTestResultSchema = z.strictObject({
  provider: SearchProviderSchema,
  ok: z.boolean(),
  code: SearchTestCodeSchema,
  /** One fixed sentence per code. Never a provider body: that could echo anything. */
  message: z.string().min(1).max(400),
  latencyMs: NonNegativeFiniteSchema.optional(),
  at: InstantSchema,
});
export type SearchTestResult = z.infer<typeof SearchTestResultSchema>;

/** `GET /v1/web-search`: what Settings › Web search draws. Names, numbers and sentences; never a key. */
export const SearchViewSchema = z.strictObject({
  /** The provider `search.yaml` names; absent while web search is off. */
  provider: SearchProviderSchema.optional(),
  /** Whether `search.yaml` names that provider's key. Without it nothing is ever sent. */
  keyNamed: z.boolean(),
  dailyCap: z.number().int().positive(),
  /** Searches counted today (a Test counts too). */
  usedToday: z.number().int().nonnegative(),
  /** What an edit waiting for the owner would change; empty when none waits. */
  held: z.array(z.string()),
  lastTest: SearchTestResultSchema.optional(),
});
export type SearchView = z.infer<typeof SearchViewSchema>;

/** `PUT /v1/web-search/setup`: the provider (naming its key) and/or the daily cap. */
export const SearchSetupRequestSchema = z.strictObject({
  provider: SearchProviderSchema.optional(),
  dailyCap: z.number().int().min(1).optional(),
});
export type SearchSetupRequest = z.infer<typeof SearchSetupRequestSchema>;

/** What a setup came to: `applied`, or `held` with the sentences of what now waits for the owner. */
export const SearchSetupResultSchema = z.strictObject({
  outcome: z.enum(['applied', 'held']),
  held: z.array(z.string()),
});
export type SearchSetupResult = z.infer<typeof SearchSetupResultSchema>;

/**
 * `state/search/ledger.json`: the day, how many searches went out that day, and the last Test. Counted BEFORE a search
 * is sent, so a crash between the count and the answer never gives a free call. A damaged file stops search for the
 * subsystem (the default policy) rather than reading as zero: a ledger that forgets would forget the cap.
 */
export const SEARCH_LEDGER_STATE = defineState({
  name: 'ledger',
  path: 'ledger.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({
    day: z.string(),
    calls: z.number().int().nonnegative(),
    lastTest: SearchTestResultSchema.optional(),
  }),
});
