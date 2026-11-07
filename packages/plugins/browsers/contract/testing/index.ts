/** `@ferretry/plugin-browsers/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { type BrowserPageRef, type BrowsersApi, type BrowserStateView, BrowserStateViewSchema } from '../index.ts';

/** An in-memory `BrowsersApi`: a fixed lifecycle, pages keyed by ferret, and leftovers it records closing. */
export interface FakeBrowsers extends BrowsersApi {
  /** Every ferret whose leftovers were closed, in order. */
  readonly closed: FerretId[];
}

export function fakeBrowsers(
  pages: Readonly<Record<string, readonly BrowserPageRef[]>> = {},
  state: BrowserStateView = { state: 'stopped' },
  leftovers: Readonly<Record<string, number>> = {},
): FakeBrowsers {
  const view = BrowserStateViewSchema.parse(state);
  const closed: FerretId[] = [];
  return {
    closed,
    state: async () => view,
    pagesOf: async (ferret: FerretId) => [...(pages[ferret] ?? [])],
    closeLeftoverBrowsers: async (ferret: FerretId) => {
      closed.push(ferret);
      return leftovers[ferret] ?? 0;
    },
  };
}

/** What every `BrowsersApi` keeps. */
export function browsersConformance(name: string, make: () => BrowsersApi, ferret: FerretId): void {
  describe(`BrowsersApi conformance: ${name}`, () => {
    test('the lifecycle parses as the wire view', async () => {
      expect(BrowserStateViewSchema.safeParse(await make().state()).success).toBe(true);
    });
    test('closing leftovers answers how many closed, never a negative or a fraction', async () => {
      const closed = await make().closeLeftoverBrowsers(ferret);
      expect(Number.isSafeInteger(closed) && closed >= 0).toBe(true);
    });
    test('a page reference carries an id and a name, never a URL or a title', async () => {
      for (const page of await make().pagesOf(ferret)) {
        expect(Object.keys(page).every(key => ['id', 'name', 'incognito'].includes(key))).toBe(true);
      }
    });
  });
}
