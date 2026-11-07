/** `@ferretry/plugin-browsers/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { type BrowserPageRef, type BrowsersApi, type BrowserStateView, BrowserStateViewSchema } from '../index.ts';

/** An in-memory `BrowsersApi`: a fixed lifecycle and pages keyed by ferret. */
export function fakeBrowsers(
  pages: Readonly<Record<string, readonly BrowserPageRef[]>> = {},
  state: BrowserStateView = { state: 'stopped' },
): BrowsersApi {
  const view = BrowserStateViewSchema.parse(state);
  return { state: async () => view, pagesOf: async (ferret: FerretId) => [...(pages[ferret] ?? [])] };
}

/** What every `BrowsersApi` keeps. */
export function browsersConformance(name: string, make: () => BrowsersApi, ferret: FerretId): void {
  describe(`BrowsersApi conformance: ${name}`, () => {
    test('the lifecycle parses as the wire view', async () => {
      expect(BrowserStateViewSchema.safeParse(await make().state()).success).toBe(true);
    });
    test('a page reference carries an id and a name, never a URL or a title', async () => {
      for (const page of await make().pagesOf(ferret)) {
        expect(Object.keys(page).every(key => ['id', 'name', 'incognito'].includes(key))).toBe(true);
      }
    });
  });
}
