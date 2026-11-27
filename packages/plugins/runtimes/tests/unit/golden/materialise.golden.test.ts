/**
 * E-276 0a: the whole plan `materialiseFleet` produces — every operation (path, mode, content), the manifest, the ids, the
 * shared-history requests — for each harness × credential store × Agent permissions, and for a profile whose model set names
 * no default. Captured on the base; every later E-276 PR leaves these byte-identical (see `support/golden.ts`).
 *
 * "ask" is not a machine value: it is the interactive part every wrapper here carries (the wrapper without its auto block),
 * so it is pinned inside each plan.
 */
import { describe, it } from 'bun:test';
import { expectGolden, render } from './support/golden.ts';
import { type GoldenHarness, PERMISSIONS, planOf, STORES } from './support/world.ts';

const HARNESSES: readonly GoldenHarness[] = ['claude', 'codex'];

describe('materialiseFleet goldens', () => {
  for (const harness of HARNESSES) {
    for (const store of STORES[harness]) {
      for (const permissions of PERMISSIONS) {
        it(`should plan ${harness} on ${store} with ${permissions} exactly as the base does`, () => {
          const first = planOf(harness, store, permissions);
          expectGolden(`plan/${harness}-${store}-${permissions}`, first);
          // Deterministic by construction: a second plan from the same inputs renders the same bytes.
          expectGolden(`plan/${harness}-${store}-${permissions}`, planOf(harness, store, permissions));
          expectGolden(`plan/${harness}-${store}-${permissions}`, JSON.parse(JSON.stringify(first)));
        });
      }
      it(`should plan ${harness} on ${store} whose profile names no model exactly as the base does`, () => {
        expectGolden(
          `plan/${harness}-${store}-no-model`,
          planOf(harness, store, 'auto-accepted', { defaultModel: false }),
        );
      });
    }
  }

  for (const harness of HARNESSES) {
    for (const store of ['host', 'environment'] as const) {
      it(`should plan ${harness} on ${store} reading the model catalogs exactly as the base does`, () => {
        expectGolden(`plan/${harness}-${store}-catalogs`, planOf(harness, store, 'auto-accepted', { catalogs: true }));
      });
    }
  }

  it('should render one value to one text', () => {
    const value = planOf('claude', 'host', 'skip');
    if (render(value) !== render(planOf('claude', 'host', 'skip'))) throw new Error('the plan is not reproducible');
  });
});
