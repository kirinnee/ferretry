import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SEARCH_CONFIG,
  SEARCH_DEFAULT_DAILY_CAP,
  SEARCH_MAX_DAILY_CAP,
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDERS,
  SearchConfigSchema,
  searchKeyReference,
  searchLoosens,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

describe('the provider table', () => {
  test('holds the six providers the owner named, each with its own secret and its own host', () => {
    expect([...SEARCH_PROVIDER_IDS].sort()).toEqual(['brave', 'exa', 'firecrawl', 'perplexity', 'serper', 'tavily']);
    const secrets = SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].secretName);
    const hosts = SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].host);
    expect(new Set(secrets).size).toBe(6);
    expect(new Set(hosts).size).toBe(6);
    for (const id of SEARCH_PROVIDER_IDS) expect(SEARCH_PROVIDERS[id].id).toBe(id);
  });

  test('is the whole of the manifest’s network and secret permissions, so a key can only reach its own host', () => {
    expect(manifest.permissions?.secrets).toEqual(SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].secretName));
    expect(manifest.permissions?.network).toEqual(SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].host));
  });

  test('lists the cheapest provider first', () => {
    expect(SEARCH_PROVIDER_IDS[0]).toBe('serper');
  });
});

describe('search.yaml', () => {
  test('the daily cap defaults to 200 and that is the one value everything reads', () => {
    expect(SEARCH_DEFAULT_DAILY_CAP).toBe(200);
    expect(DEFAULT_SEARCH_CONFIG).toEqual({ dailyCap: 200 });
    expect(SearchConfigSchema.parse({ provider: 'brave' }).dailyCap).toBe(SEARCH_DEFAULT_DAILY_CAP);
  });

  test('takes a provider with its own key reference and nothing else', () => {
    const ok = SearchConfigSchema.safeParse({ provider: 'exa', key: searchKeyReference('exa'), dailyCap: 50 });
    expect(ok.success).toBe(true);
    expect(searchKeyReference('exa')).toBe(['$', '{secret:EXA_API_KEY}'].join(''));
    // another provider's key, a key with no provider, a raw value and an unknown field are all refused
    expect(SearchConfigSchema.safeParse({ provider: 'exa', key: searchKeyReference('brave') }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ key: searchKeyReference('exa') }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ provider: 'exa', key: 'sk-live-123' }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ provider: 'exa', extra: 1 }).success).toBe(false);
  });

  test('the cap is a whole number from 1 to the ceiling', () => {
    for (const bad of [0, -1, 1.5, SEARCH_MAX_DAILY_CAP + 1])
      expect(SearchConfigSchema.safeParse({ dailyCap: bad }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ dailyCap: SEARCH_MAX_DAILY_CAP }).success).toBe(true);
  });

  test('raising the cap loosens; lowering it, keeping it and choosing a provider do not', () => {
    const at = (dailyCap: number) => SearchConfigSchema.parse({ dailyCap });
    expect(searchLoosens(at(200), at(500))).toEqual(['the daily search limit goes up from 200 to 500']);
    expect(searchLoosens(undefined, at(500))).toHaveLength(1);
    expect(searchLoosens(at(500), undefined)).toEqual([]);
    expect(searchLoosens(at(500), at(100))).toEqual([]);
    expect(searchLoosens(at(200), at(200))).toEqual([]);
    expect(searchLoosens(undefined, SearchConfigSchema.parse({ provider: 'serper' }))).toEqual([]);
  });
});
