/** `@ferretry/plugin-browsers/contract/testing` (§7.8): the contract's fake and the conformance suite. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  type BrowserPageRef,
  type BrowsersApi,
  type BrowserStateView,
  BrowserStateViewSchema,
  LeftAloneWhySchema,
  type LeftoverBrowsersClosed,
} from '../index.ts';

/** An in-memory `BrowsersApi`: a fixed lifecycle, pages keyed by ferret, and leftovers it records closing. */
export interface FakeBrowsers extends BrowsersApi {
  /** Every ferret whose leftovers were closed, in order. */
  readonly closed: FerretId[];
}

export function fakeBrowsers(
  pages: Readonly<Record<string, readonly BrowserPageRef[]>> = {},
  state: BrowserStateView = { state: 'stopped' },
  leftovers: Readonly<Record<string, LeftoverBrowsersClosed>> = {},
): FakeBrowsers {
  const view = BrowserStateViewSchema.parse(state);
  const closed: FerretId[] = [];
  return {
    closed,
    state: async () => view,
    pagesOf: async (ferret: FerretId) => [...(pages[ferret] ?? [])],
    closeLeftoverBrowsers: async (ferret: FerretId) => {
      closed.push(ferret);
      return leftovers[ferret] ?? { closed: 0, leftAlone: [] };
    },
  };
}

/** What every `BrowsersApi` keeps. */
export function browsersConformance(name: string, make: () => BrowsersApi, ferret: FerretId): void {
  describe(`BrowsersApi conformance: ${name}`, () => {
    test('the lifecycle parses as the wire view', async () => {
      expect(BrowserStateViewSchema.safeParse(await make().state()).success).toBe(true);
    });
    test('closing leftovers answers how many closed, and each pid left alone with a closed reason only', async () => {
      const answer = await make().closeLeftoverBrowsers(ferret);
      expect(Object.keys(answer).sort()).toEqual(['closed', 'leftAlone']);
      expect(Number.isSafeInteger(answer.closed) && answer.closed >= 0).toBe(true);
      for (const left of answer.leftAlone) {
        expect(Object.keys(left).sort()).toEqual(['pid', 'why']);
        expect(Number.isSafeInteger(left.pid)).toBe(true);
        expect(LeftAloneWhySchema.safeParse(left.why).success).toBe(true);
      }
    });
    test('a page reference carries an id and a name, never a URL or a title', async () => {
      for (const page of await make().pagesOf(ferret)) {
        expect(Object.keys(page).every(key => ['id', 'name', 'incognito'].includes(key))).toBe(true);
      }
    });
  });
}
