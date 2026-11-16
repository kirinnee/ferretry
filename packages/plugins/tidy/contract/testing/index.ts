/** `@ferretry/plugin-tidy/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import { type TidyApi, type TidyTotals, TidyTotalsSchema } from '../index.ts';

/** A `TidyApi` answering fixed totals. */
export function fakeTidy(totals: Partial<TidyTotals> = {}): TidyApi {
  const fixed = TidyTotalsSchema.parse({ enabled: true, reclaimedFerrets: 0, reclaimedBytes: 0, ...totals });
  return { totals: async () => fixed };
}

/** What every `TidyApi` keeps. */
export function tidyConformance(name: string, make: () => TidyApi): void {
  describe(`TidyApi conformance: ${name}`, () => {
    test('the totals parse, and a ferret count is never zero while bytes were reclaimed', async () => {
      const totals = await make().totals();
      expect(TidyTotalsSchema.safeParse(totals).success).toBe(true);
      if (totals.reclaimedBytes > 0) expect(totals.reclaimedFerrets).toBeGreaterThan(0);
    });
  });
}
