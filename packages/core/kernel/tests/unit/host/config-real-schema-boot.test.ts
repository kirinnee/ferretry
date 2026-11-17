/**
 * Boot with a hand-written file of a REAL declared kind, wrong for its own schema: boot never fails, puts nothing wrong
 * in effect, and its problems are listed at most {@link MAX_CONFIG_ISSUES} and one sentence counting the rest. The kinds
 * an agent may name are each booted with their sweep text, and the real `mcp/<name>.yaml` with review round 7's shapes -
 * here small; the same at the size cap, within a hard bound, is `tests/perf/host/config-real-schema-boot.test.ts`.
 * The other doors are `../host-config/real-schema-bound.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { declaredKinds, mcpReviewShapes, sweepTextOf } from '../host-config/real-schemas.ts';
import { bootsCapped, cleanup, UNTIMED } from './config-real-schema-world.ts';

/** Small enough that time is irrelevant. */
const SMALL_BYTES = 8192;

afterEach(cleanup);

describe('boot with a real kind written wrong', () => {
  // The kernel's own file is declared by the host itself; every other kind an agent may name is booted here.
  const kinds = declaredKinds().filter(kind => kind.agentMayName && kind.plugin !== 'kernel' && kind.plugin !== 'gate');

  test('the kinds an agent may name are all here', () => {
    expect(kinds.map(kind => kind.path)).toContain('mcp/sweep.yaml');
    expect(kinds.length).toBeGreaterThanOrEqual(15);
  });

  for (const kind of kinds) {
    const [label, text] = sweepTextOf(kind, SMALL_BYTES);
    test(`T-0032 ${kind.path} (${label}): boot never fails`, async () => {
      await bootsCapped(kind, text, UNTIMED);
    });
  }

  const mcp = declaredKinds().find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(SMALL_BYTES)) {
    test(`T-0032 mcp/<name>.yaml, ${label}: boot never fails`, async () => {
      if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
      await bootsCapped(mcp, text, UNTIMED);
    });
  }
});
