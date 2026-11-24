import { z } from 'zod';

/**
 * The six search providers, as data and in the order a person reads them (cheapest per search first).
 *
 * Each entry names the ONE secret it spends and the ONE host that secret may reach. The host list is the whole
 * `permissions.network` of this plugin and the secret list is its `permissions.secrets`, so adding a provider is a
 * reviewed edit here, never a URL somebody typed into a configuration file. How a request is built and a reply read
 * lives in `daemon/lib/providers.ts`; what a person reads before pasting a key lives here, because the app shows it.
 */
export const SEARCH_PROVIDER_IDS = ['serper', 'firecrawl', 'brave', 'perplexity', 'exa', 'tavily'] as const;
export const SearchProviderSchema = z.enum(SEARCH_PROVIDER_IDS);
export type SearchProviderId = z.infer<typeof SearchProviderSchema>;

export interface SearchProviderInfo {
  readonly id: SearchProviderId;
  readonly label: string;
  /** The Vault secret this provider's key lives under. */
  readonly secretName: string;
  /** The one host that key may reach. */
  readonly host: string;
  /** Where a person makes a key: shown as text AND a link, because a link alone can be blocked. */
  readonly keyUrl: string;
  /** What one thousand searches cost, from the vendor's own pricing page (checked 2026-11-24; prices drift, so look again when you add a key). */
  readonly priceNote: string;
}

export const SEARCH_PROVIDERS: Readonly<Record<SearchProviderId, SearchProviderInfo>> = Object.freeze({
  serper: {
    id: 'serper',
    label: 'Serper',
    secretName: 'SERPER_API_KEY',
    host: 'google.serper.dev',
    keyUrl: 'https://serper.dev',
    priceNote: 'About $1 per 1,000 searches.',
  },
  firecrawl: {
    id: 'firecrawl',
    label: 'Firecrawl',
    secretName: 'FIRECRAWL_API_KEY',
    host: 'api.firecrawl.dev',
    keyUrl: 'https://www.firecrawl.dev/app/api-keys',
    priceNote: 'About $0.75 to $7.60 per 1,000 searches of ten results, by plan (2 credits per ten results).',
  },
  brave: {
    id: 'brave',
    label: 'Brave Search',
    secretName: 'BRAVE_API_KEY',
    host: 'api.search.brave.com',
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    priceNote: 'About $5 per 1,000 searches.',
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    secretName: 'PERPLEXITY_API_KEY',
    host: 'api.perplexity.ai',
    keyUrl: 'https://console.perplexity.ai/project/keys',
    priceNote: 'About $5 per 1,000 searches.',
  },
  exa: {
    id: 'exa',
    label: 'Exa',
    secretName: 'EXA_API_KEY',
    host: 'api.exa.ai',
    keyUrl: 'https://dashboard.exa.ai/api-keys',
    priceNote: 'About $7 per 1,000 searches; results are titles and links only.',
  },
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    secretName: 'TAVILY_API_KEY',
    host: 'api.tavily.com',
    keyUrl: 'https://app.tavily.com',
    priceNote: 'About $8 per 1,000 searches.',
  },
});

/** `${secret:NAME}`: the line `search.yaml` carries so the kernel may place this provider's key on a request. */
export const searchKeyReference = (provider: SearchProviderId): string =>
  `\${secret:${SEARCH_PROVIDERS[provider].secretName}}`;
