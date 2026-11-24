import { defineState } from '@ferretry/kernel/contract';
import { InstantSchema, NonNegativeFiniteSchema } from '@ferretry/std';
import { z } from 'zod';
import { providersAreDistinct } from './config.ts';
import { SEARCH_PROVIDER_IDS, SearchProviderSchema } from './providers.ts';

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

/** One provider in the list, with what its last Test proved. */
export const SearchProviderViewSchema = z.strictObject({
  provider: SearchProviderSchema,
  lastTest: SearchTestResultSchema.optional(),
});
export type SearchProviderView = z.infer<typeof SearchProviderViewSchema>;

/** `GET /v1/web-search`: what Settings › Web search draws. Names, numbers and sentences; never a key. */
export const SearchViewSchema = z.strictObject({
  /** The providers `search.yaml` names, in the order a search tries them; empty while web search is off. A provider is listed only with its key named. */
  providers: z.array(SearchProviderViewSchema),
  dailyCap: z.number().int().positive(),
  /** Searches counted today, over every provider (a Test counts too, and so does each fall-through). */
  usedToday: z.number().int().nonnegative(),
  /** What an edit waiting for the owner would change; empty when none waits. */
  held: z.array(z.string()),
});
export type SearchView = z.infer<typeof SearchViewSchema>;

/** `PUT /v1/web-search/setup`: the whole ordered provider list (each naming its key) and/or the daily cap. */
export const SearchSetupRequestSchema = z.strictObject({
  providers: z
    .array(SearchProviderSchema)
    .max(SEARCH_PROVIDER_IDS.length)
    .refine(providersAreDistinct, 'each provider may be listed once')
    .optional(),
  dailyCap: z.number().int().min(1).optional(),
});
export type SearchSetupRequest = z.infer<typeof SearchSetupRequestSchema>;

/** `POST /v1/web-search/test`: which listed provider to try, on its own, with no fall-through. */
export const SearchTestRequestSchema = z.strictObject({ provider: SearchProviderSchema });
export type SearchTestRequest = z.infer<typeof SearchTestRequestSchema>;

/** What a setup came to: `applied`, or `held` with the sentences of what now waits for the owner. */
export const SearchSetupResultSchema = z.strictObject({
  outcome: z.enum(['applied', 'held']),
  held: z.array(z.string()),
});
export type SearchSetupResult = z.infer<typeof SearchSetupResultSchema>;

/**
 * `state/search/ledger.json`: the day, how many searches went out that day (one count over every provider), and each provider's last Test. Counted BEFORE a search
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
    tests: z.array(SearchTestResultSchema),
  }),
});
