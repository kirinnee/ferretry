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

const entry = (id: (typeof SEARCH_PROVIDER_IDS)[number]) => ({ provider: id, key: searchKeyReference(id) });

describe('search.yaml', () => {
  test('the daily cap defaults to 200 and that is the one value everything reads', () => {
    expect(SEARCH_DEFAULT_DAILY_CAP).toBe(200);
    expect(DEFAULT_SEARCH_CONFIG).toEqual({ providers: [], dailyCap: 200 });
    expect(SearchConfigSchema.parse({ providers: [entry('brave')] }).dailyCap).toBe(SEARCH_DEFAULT_DAILY_CAP);
  });

  test('has no default provider: every provider is available and none is listed until the owner lists it', () => {
    expect(DEFAULT_SEARCH_CONFIG.providers).toEqual([]);
    const all = SearchConfigSchema.safeParse({ providers: SEARCH_PROVIDER_IDS.map(entry) });
    expect(all.success).toBe(true);
  });

  test('takes an ordered list of providers, each with its own key reference, and nothing else', () => {
    const ok = SearchConfigSchema.safeParse({ providers: [entry('exa'), entry('serper')], dailyCap: 50 });
    expect(ok.success).toBe(true);
    expect(ok.data?.providers.map(item => item.provider)).toEqual(['exa', 'serper']);
    expect(searchKeyReference('exa')).toBe(['$', '{secret:EXA_API_KEY}'].join(''));
    // another provider's key, a missing key, a raw value, a repeat, the old single-provider shape and an unknown field are all refused
    const refused = (value: unknown) => SearchConfigSchema.safeParse(value).success;
    expect(refused({ providers: [{ provider: 'exa', key: searchKeyReference('brave') }] })).toBe(false);
    expect(refused({ providers: [{ provider: 'exa' }] })).toBe(false);
    expect(refused({ providers: [{ provider: 'exa', key: 'sk-live-123' }] })).toBe(false);
    expect(refused({ providers: [entry('exa'), entry('exa')] })).toBe(false);
    expect(refused({ provider: 'exa', key: searchKeyReference('exa') })).toBe(false);
    expect(refused({ providers: [{ ...entry('exa'), extra: 1 }] })).toBe(false);
  });

  test('the cap is a whole number from 1 to the ceiling', () => {
    for (const bad of [0, -1, 1.5, SEARCH_MAX_DAILY_CAP + 1])
      expect(SearchConfigSchema.safeParse({ dailyCap: bad }).success).toBe(false);
    expect(SearchConfigSchema.safeParse({ dailyCap: SEARCH_MAX_DAILY_CAP }).success).toBe(true);
  });

  test('raising the cap loosens; lowering it, keeping it and adding, removing or reordering providers do not', () => {
    const at = (dailyCap: number) => SearchConfigSchema.parse({ dailyCap });
    expect(searchLoosens(at(200), at(500))).toEqual(['the daily search limit goes up from 200 to 500']);
    expect(searchLoosens(undefined, at(500))).toHaveLength(1);
    expect(searchLoosens(at(500), undefined)).toEqual([]);
    expect(searchLoosens(at(500), at(100))).toEqual([]);
    expect(searchLoosens(at(200), at(200))).toEqual([]);
    const listed = (...ids: (typeof SEARCH_PROVIDER_IDS)[number][]) =>
      SearchConfigSchema.parse({ providers: ids.map(entry) });
    expect(searchLoosens(undefined, listed('serper'))).toEqual([]);
    expect(searchLoosens(listed('serper'), listed('serper', 'brave', 'exa'))).toEqual([]);
    expect(searchLoosens(listed('serper', 'brave'), listed('brave', 'serper'))).toEqual([]);
    expect(searchLoosens(listed('serper', 'brave'), listed('brave'))).toEqual([]);
  });
});
