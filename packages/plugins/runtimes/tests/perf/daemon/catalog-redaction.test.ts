/**
 * S25: every shape rule of the catalogue's component-text net is linear: a long run of any shape costs the same per
 * character as a short one. What the net withholds is tests/unit/daemon/catalog-redaction.test.ts; this file holds only
 * the time. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { interleavedBest } from '@ferretry/std/testing/linear-time';
import { s25Shapes } from '../../support/s25-shapes.ts';
import { shownFor } from '../../unit/daemon/redact-support.ts';

describe('S25 the catalogue redaction is linear', () => {
  // Per-test limit (testing standard): each shape's test runs (1 warm-up + 9 interleaved rounds of a small and a
  // large run), 100 KB at the largest, through `shownFor`, which is the component-text path; the text net runs W's
  // flag rule once per line. Measured alone, one file, wall clock: 5.0 3.24 s, fix 2 4.0 s, fix 3 4.5-5.5 s (5.26 s
  // and 5.50 s failed bun's 5 s default), fix 4 4.76 s, 4.80 s, 4.80 s (+ one 5.13 s fail on the first run), then
  // 6.9 s with nine interleaved rounds (all 7 shapes in one test). The ratio and ceiling below are unchanged and are
  // the linearity proof; each shape's timeout is a margin for a loaded runner, not a speed claim.
  // One test per shape (the timeout is the shape's local time with at least four times the headroom: 'a=' repeated
  // 2.2 s, the others 0.1-1.7 s). The warm-up, the sizes, the nine rounds and both assertions are the same for each.
  for (const [label, shape, timeoutMs] of s25Shapes) {
    it(
      `S25 every shape rule is linear: a long run of any shape costs the same per character as a short one: ${label}`,
      () => {
        // Arrange: the shapes that made the old rules quadratic (name characters with no separator, repeated token heads,
        // a separator with nothing after it, a long block, a long expansion).
        // The FASTEST of nine interleaved rounds, in wall-clock ms (a small run is about 1 ms, which is the CPU clock's own
        // tick, so the wall clock is the only one that can read it): a collection or a lost moment on a shared runner lands
        // in one round, and because the small and the large run alternate it lands on both sides, while a rule that is not
        // linear is slow in every round.
        shownFor(shape(3_000));
        const smallText = shape(10_000);
        const largeText = shape(100_000);

        // Act
        const { small, large } = interleavedBest(
          () => shownFor(largeText),
          () => shownFor(smallText),
          { floorMs: 1 },
        );

        // Assert: ten times the text is nowhere near a hundred times the time (quadratic), and an absolute ceiling.
        should(large).be.below(small * 40);
        should(large).be.below(3_000);
      },
      timeoutMs,
    );
  }
});
