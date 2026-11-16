/**
 * The SPEED half of `../../unit/host-config/real-schema-bound.test.ts`. Every configuration file kind this build
 * declares, checked against its OWN schema at the size cap: each answers within one hard bound at every door a text
 * comes in by - `config_validate`, `config_write` and `config_read` for a file an agent may name, the owner's write and
 * read otherwise, and a reload of it hand-written. The answers themselves (the cap on the issues) are unit's.
 */
import { describe, expect, test } from 'bun:test';
import { MAX_CONFIG_ISSUES } from '../../../host/config/check.ts';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { mcpReviewShapes, sweepTextOf } from '../../unit/host-config/real-schemas.ts';
import { everyDoor, KINDS, type Measure } from '../../unit/host-config/real-schema-doors.ts';

/** A hard bound per call, far above one linear pass: the shapes this guards took 4–16 s at this size. */
const BOUND_MS = 1500;
/**
 * What one test may take on the wall clock. A door is bounded by CPU (`BOUND_MS`), but a test samples six doors, and a slow
 * first sample is sampled again from fresh worlds, so on a loaded runner a test that is within every bound can pass bun's
 * 5 s default. This bounds a hang, not a regression; the regression is the CPU bound.
 */
const TEST_TIMEOUT_MS = 60_000;

/**
 * The CPU the main thread spent on `act`, in ms (everything here is in memory, so all of it is on the main thread). A
 * bound on the clock measures the box as much as the code, and a call is hundreds of ms, far above the CPU clock's tick.
 */
async function timed<T>(act: () => Promise<T> | T): Promise<{ readonly ms: number; readonly value: T }> {
  if (typeof process.threadCpuUsage !== 'function') throw new Error('process.threadCpuUsage is not available');
  const before = process.threadCpuUsage();
  const value = await act();
  const spent = process.threadCpuUsage(before);
  return { ms: (spent.user + spent.system) / 1_000, value };
}

const measure: Measure = {
  timed,
  resample: ms => ms >= BOUND_MS,
  within: ms => expect(ms).toBeLessThan(BOUND_MS),
  // The CPU clock must read something, or every bound above passes on 0.
  done: spent => expect(Math.max(...spent)).toBeGreaterThan(0),
};

describe('every declared kind, its own schema, wrong values at the size cap: every door within the bound', () => {
  for (const kind of KINDS) {
    const [label, text] = sweepTextOf(kind, CONFIG_FILE_MAX_BYTES);
    test(
      `T-0032 T-0033 T-0034 ${kind.path} (${label}): reload, read, validate and write each under ${BOUND_MS} ms`,
      async () => {
        await everyDoor(kind, text, measure);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe('review round 7: the real mcp/<name>.yaml at the size cap', () => {
  const mcp = KINDS.find(kind => kind.path === 'mcp/sweep.yaml');
  for (const [label, text] of mcpReviewShapes(CONFIG_FILE_MAX_BYTES)) {
    test(
      `T-0032 T-0033 T-0034 ${label}: every door under ${BOUND_MS} ms, at most ${MAX_CONFIG_ISSUES} problems listed`,
      async () => {
        if (mcp === undefined) throw new Error('mcp/<name>.yaml is not declared');
        await everyDoor(mcp, text, measure);
      },
      TEST_TIMEOUT_MS,
    );
  }
});
