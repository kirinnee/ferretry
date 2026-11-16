/**
 * The SPEED half of `../../unit/host/config-real-schema-boot.test.ts`: boot with a hand-written file of a REAL declared
 * kind at the size cap, wrong for its own schema, answers within one hard bound. The kinds an agent may name are each
 * booted with their sweep text, and the real `mcp/<name>.yaml` with review round 7's shapes. The answers (the cap on
 * the issues) are checked on the way, and are unit's at a small size.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { declaredKinds, mcpReviewShapes, sweepTextOf } from '../../unit/host-config/real-schemas.ts';
import { bootsCapped, cleanup, type Timed } from '../../unit/host/config-real-schema-world.ts';

/** A hard bound, far above one linear read: the shapes this guards took 4–16 s at this size. */
const BOUND_MS = 1500;

afterEach(cleanup);

const timed: Timed = async act => {
  const started = performance.now();
  const value = await act();
  return { ms: performance.now() - started, value };
};

describe('boot with a real kind written wrong at the size cap', () => {
  const kinds = declaredKinds().filter(kind => kind.agentMayName && kind.plugin !== 'kernel' && kind.plugin !== 'gate');

  for (const kind of kinds) {
    const [label, text] = sweepTextOf(kind, CONFIG_FILE_MAX_BYTES);
    test(`T-0032 ${kind.path} (${label}): boot answers in under ${BOUND_MS} ms`, async () => {
      expect(await bootsCapped(kind, text, timed)).toBeLessThan(BOUND_MS);
    });
  }

  const mcp = declaredKinds().find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(CONFIG_FILE_MAX_BYTES)) {
    test(`T-0032 mcp/<name>.yaml, ${label}: boot answers in under ${BOUND_MS} ms`, async () => {
      if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
      expect(await bootsCapped(mcp, text, timed)).toBeLessThan(BOUND_MS);
    });
  }
});
