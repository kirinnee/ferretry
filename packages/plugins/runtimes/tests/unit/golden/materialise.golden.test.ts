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
import { type GoldenHarness, type McpName, PERMISSIONS, planOf, STORES } from './support/world.ts';

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

  // One transport at a time: the all-together plans above cannot say which transport a harness renders how.
  const TRANSPORTS: readonly (readonly [McpName, string])[] = [
    ['files', 'stdio'],
    ['docs', 'http'],
    ['feed', 'sse'],
    ['notes', 'oauth'],
  ];
  for (const harness of HARNESSES) {
    for (const [server, transport] of TRANSPORTS) {
      for (const permissions of ['auto-accepted', 'auto-refused'] as const) {
        // Claude alone can refuse auto (`acceptsAutoPermissionMode`); Codex's refused plan is the same bytes as its accepted one, so it is pinned once.
        if (permissions === 'auto-refused' && harness === 'codex') continue;
        it(`should plan ${harness} with only the ${transport} MCP server under ${permissions} exactly as the base does`, () => {
          expectGolden(
            `plan/${harness}-host-only-${transport}-${permissions}`,
            planOf(harness, 'host', permissions, { mcp: [server] }),
          );
        });
      }
    }
  }

  // A profile with no default model under every Agent permission and every store (a Codex provider names its own model).
  for (const harness of HARNESSES) {
    for (const store of STORES[harness]) {
      for (const permissions of ['skip', 'auto-refused'] as const) {
        if (permissions === 'auto-refused' && harness === 'codex') continue;
        it(`should plan ${harness} on ${store} with no default model under ${permissions} exactly as the base does`, () => {
          expectGolden(
            `plan/${harness}-${store}-no-model-${permissions}`,
            planOf(harness, store, permissions, { defaultModel: false }),
          );
        });
      }
    }
  }

  // A declared MCP server no layer names, and the person's own settings (a Claude statusLine to chain onto).
  for (const harness of HARNESSES) {
    for (const permissions of ['auto-accepted', 'skip'] as const) {
      it(`should plan ${harness} with an inactive MCP server and the person's own settings under ${permissions} exactly as the base does`, () => {
        expectGolden(
          `plan/${harness}-host-inactive-mcp-own-settings-${permissions}`,
          planOf(harness, 'host', permissions, { inactiveMcp: true, settings: true }),
        );
      });
    }
    it(`should plan ${harness} on the built-in profile exactly as the base does`, () => {
      expectGolden(`plan/${harness}-host-builtin-profile`, planOf(harness, 'host', 'auto-accepted', { builtin: true }));
    });
  }

  it('should render one value to one text', () => {
    const value = planOf('claude', 'host', 'skip');
    if (render(value) !== render(planOf('claude', 'host', 'skip'))) throw new Error('the plan is not reproducible');
  });
});
