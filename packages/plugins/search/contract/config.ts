import { defineConfig } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { SearchProviderSchema, searchKeyReference } from './providers.ts';

/**
 * How many searches a machine makes in one day, as the shipped default. THE ONE VALUE: the schema, the ledger, the
 * settings screen and the tool's refusal sentence all read it from here. It is its own cap, outside the creative-tools
 * spend cap (owner decision O5): 200 searches is about $0.20 to $1.60 a day at the prices in `providers.ts`.
 */
export const SEARCH_DEFAULT_DAILY_CAP = 200;
/** The most the file may ask for; a bigger number is a typo or a runaway, not a plan. */
export const SEARCH_MAX_DAILY_CAP = 10_000;

/**
 * `config/search.yaml` (§9.2):
 *
 * ```yaml
 * provider: serper                 # absent: web search is off
 * key: ${secret:SERPER_API_KEY}    # the owner's line; without it nothing is ever sent
 * dailyCap: 200                    # searches a day, this machine
 * ```
 *
 * The key line is the kernel's door (docs/secrets.md › A plugin's own key): a ferret's write that adds it is held for
 * the owner, so an agent can never switch paid search on. No value is ever written here.
 */
export const SearchConfigSchema = z
  .strictObject({
    provider: SearchProviderSchema.optional(),
    key: z.string().optional(),
    dailyCap: z.number().int().min(1).max(SEARCH_MAX_DAILY_CAP).default(SEARCH_DEFAULT_DAILY_CAP),
  })
  .check(ctx => {
    const { provider, key } = ctx.value;
    if (key === undefined) return;
    if (provider === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: '"key" names a provider’s key, so "provider" must say which provider',
        input: key,
        path: ['key'],
      });
    } else if (key !== searchKeyReference(provider)) {
      ctx.issues.push({
        code: 'custom',
        message: `"key" is only ever ${searchKeyReference(provider)} for provider: ${provider}`,
        input: key,
        path: ['key'],
      });
    }
  });
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

/** What a machine with no `search.yaml` behaves as: off, with the default cap. */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = SearchConfigSchema.parse({});

/**
 * Raising the daily cap loosens what the machine may spend, so it waits for the owner (docs/config-files.md rule 2);
 * lowering it never does. Deleting the file is an edit to the defaults and is judged the same way. Naming a key is a
 * loosening of its own, judged by the kernel as an added `${secret:NAME}` reference.
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
