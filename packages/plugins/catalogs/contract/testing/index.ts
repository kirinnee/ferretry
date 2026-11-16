/** `@ferretry/plugin-catalogs/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import { type CatalogInstallSummary, CatalogInstallSummarySchema, type CatalogsApi } from '../index.ts';

/** An in-memory `CatalogsApi` over a fixed set of installs. */
export function fakeCatalogs(installs: readonly CatalogInstallSummary[] = []): CatalogsApi {
  const all = installs.map(install => CatalogInstallSummarySchema.parse(install));
  return { installs: async () => [...all] };
}

/** What every `CatalogsApi` keeps. */
export function catalogsConformance(name: string, make: () => CatalogsApi): void {
  describe(`CatalogsApi conformance: ${name}`, () => {
    test('every install is pinned by digest and parses as the wire view', async () => {
      for (const install of await make().installs())
        expect(CatalogInstallSummarySchema.safeParse(install).success).toBe(true);
    });
  });
}
