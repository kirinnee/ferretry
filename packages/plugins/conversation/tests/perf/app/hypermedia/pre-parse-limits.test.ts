import { describe, expect, test } from 'bun:test';
import { exceedsPreParseLimits } from '../../../../app/hypermedia/limits.ts';

/**
 * The SPEED half of the pre-parse limits (r12 H11a): the check is one linear pass, so a message at the 300,000-byte cap is
 * checked in under 20 ms in bun, whatever its shape: long paragraphs, one long line, blank-line-separated brackets, runs of
 * marks. That it counts the RIGHT things, at each limit and one past it, is checked at a small size in unit
 * (`tests/unit/app/hypermedia/pre-parse-limits.test.tsx`). Synthetic filler only.
 */
const BUDGET_MS = 20;

const SHAPES: Readonly<Record<string, string>> = {
  'brackets, a paragraph each': '[a](b)\n\n'.repeat(37_000),
  'one long line of filler': 'x'.repeat(299_000),
  'one long paragraph of short lines': 'word\n'.repeat(59_000),
  'one mark per paragraph': '*\n\n'.repeat(99_000),
  'a space run in a short line, many times': `${' '.repeat(63)}x\n`.repeat(4_600),
};

describe('the pre-parse check of a near-cap message', () => {
  for (const [name, message] of Object.entries(SHAPES))
    test(`${name}: under ${BUDGET_MS} ms`, () => {
      expect(message.length).toBeLessThanOrEqual(300_000);
      expect(exceedsPreParseLimits(message)).toBe(false); // warm, and the shape is one that passes
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        exceedsPreParseLimits(message);
        best = Math.min(best, performance.now() - start);
      }
      expect(best).toBeLessThan(BUDGET_MS);
    });
});
