import { defineConfig } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { SEARCH_PROVIDER_IDS, SearchProviderSchema, searchKeyReference } from './providers.ts';

/**
 * How many searches a machine makes in one day, as the shipped default. THE ONE VALUE: the schema, the ledger, the
 * settings screen and the tool's refusal sentence all read it from here. It is its own cap, outside the creative-tools
 * spend cap (owner decision O5): 200 searches is about $0.20 to $1.60 a day at the prices in `providers.ts`. It is ONE
 * cap over every provider: a search that falls through to the next provider counts as a call at each.
 */
export const SEARCH_DEFAULT_DAILY_CAP = 200;
/** The most the file may ask for; a bigger number is a typo or a runaway, not a plan. */
export const SEARCH_MAX_DAILY_CAP = 10_000;

/** One provider the machine may search with, and the line that names its key. */
export const SearchProviderEntrySchema = z
  .strictObject({
    provider: SearchProviderSchema,
    key: z.string(),
  })
  .check(ctx => {
    const { provider, key } = ctx.value;
    if (key !== searchKeyReference(provider))
      ctx.issues.push({
        code: 'custom',
        message: `"key" is only ever ${searchKeyReference(provider)} for provider: ${provider}`,
        input: key,
        path: ['key'],
      });
  });
export type SearchProviderEntry = z.infer<typeof SearchProviderEntrySchema>;

/** A list of providers names each at most once: the order is the order they are tried, and a repeat would only be a second try. */
export const providersAreDistinct = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

/**
 * `config/search.yaml` (§9.2):
 *
 * ```yaml
 * providers:                          # tried in this order; empty or absent: web search is off
 *   - provider: serper
 *     key: ${secret:SERPER_API_KEY}   # the owner's line; without it nothing is ever sent to that provider
 *   - provider: brave
 *     key: ${secret:BRAVE_API_KEY}
 * dailyCap: 200                       # searches a day over ALL the providers, this machine
 * ```
 *
 * A search goes to the first provider and falls through to the next on a failure (never on a valid empty answer).
 * Each key line is the kernel's door (docs/secrets.md › A plugin's own key): a ferret's write that adds one is held
 * for the owner, so an agent can never switch paid search on. No value is ever written here.
 */
export const SearchConfigSchema = z
  .strictObject({
    providers: z.array(SearchProviderEntrySchema).max(SEARCH_PROVIDER_IDS.length).default([]),
    dailyCap: z.number().int().min(1).max(SEARCH_MAX_DAILY_CAP).default(SEARCH_DEFAULT_DAILY_CAP),
  })
  .check(ctx => {
    const ids = ctx.value.providers.map(entry => entry.provider);
    if (!providersAreDistinct(ids))
      ctx.issues.push({
        code: 'custom',
        message: 'each provider may be listed once; the list is the order they are tried in',
        input: ids,
        path: ['providers'],
      });
  });
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

/** What a machine with no `search.yaml` behaves as: off, with the default cap. */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = SearchConfigSchema.parse({});

/**
 * Raising the daily cap loosens what the machine may spend, so it waits for the owner (docs/config-files.md rule 2);
 * lowering it never does. Deleting the file is an edit to the defaults and is judged the same way.
 *
 * ADDING A PROVIDER, REMOVING ONE OR REORDERING THE LIST LOOSENS NOTHING HERE: the spend is still bounded by the one
 * cap above, whichever provider answers. Naming a provider's key is a loosening of its own, and it is judged exactly as
 * it was with one provider: by the kernel, as an added `${secret:NAME}` reference, so it is held for a caller who is
 * not the owner and in effect for the owner (docs/secrets.md). Removing a reference and moving one loosen nothing.
 */
export function searchLoosens(before: SearchConfig | undefined, after: SearchConfig | undefined): readonly string[] {
  const was = (before ?? DEFAULT_SEARCH_CONFIG).dailyCap;
  const now = (after ?? DEFAULT_SEARCH_CONFIG).dailyCap;
  return now > was ? [`the daily search limit goes up from ${String(was)} to ${String(now)}`] : [];
}

export const SEARCH_CONFIG = defineConfig({
  file: 'search.yaml',
  schema: SearchConfigSchema,
  axis: 'configure',
  loosens: searchLoosens,
});
