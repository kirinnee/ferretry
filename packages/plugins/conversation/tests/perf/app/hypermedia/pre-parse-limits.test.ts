import { describe, expect, test } from 'bun:test';
import { exceedsPreParseLimits } from '../../../../app/hypermedia/limits.ts';

/**
 * The SPEED half of the pre-parse limits (r12 H11a): the check is one linear pass, so a message at the 300,000-byte cap is
 * checked in under 20 ms in bun, whatever its shape (each of the shapes below passes the limits, so the whole message is
 * read). That it counts the RIGHT things, at each limit and one past it, is checked at a small size in unit
 * (`tests/unit/app/hypermedia/pre-parse-limits.test.tsx`). Synthetic filler only.
 */
const BUDGET_MS = 20;

const SHAPES: Readonly<Record<string, string>> = {
  'short paragraphs, then one long one of filler': `${'[a](b)\n\n'.repeat(2_000)}${'word '.repeat(50_000)}`,
  'one long line of filler': 'x'.repeat(299_000),
  'one long paragraph of short lines': 'word\n'.repeat(59_000),
  'short paragraphs, then filler': `${'*\n\n'.repeat(3_000)}${'~\n\n'.repeat(3_000)}${'word\n'.repeat(50_000)}`,
  'paragraphs of filler of the same size, a few each': Array.from(
    { length: 20 },
    () => `${'[a](b) '.repeat(5)}${'word '.repeat(1_990)}`,
  ).join('\n\n'),
  'a short line of filler, many times': `${' '.repeat(63)}x\n`.repeat(4_600),
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
