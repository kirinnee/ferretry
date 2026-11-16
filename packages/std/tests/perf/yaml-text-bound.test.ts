/**
 * `readConfigText` reads a file at the size limit in ONE pass, whatever its aliases do, and refuses a `%` directive
 * flood without parsing it. The answers are the unit tier's (`tests/unit/yaml-text.test.ts`), at a small size.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { editConfigText, readConfigText, setConfigKey } from '../../src/yaml-text.ts';
import { hostileReads, refusalOf } from '../unit/yaml-text-hostile.ts';

const MODELINE = '# yaml-language-server: $schema=../.schema/machine.json';

describe('readConfigText — a file at the size limit is read in ONE pass, whatever its aliases do', () => {
  /** A hard bound, far above what one linear pass takes; the quadratic paths this guards took seconds to minutes. */
  const BOUND_MS = 1500;
  /** How many times a read is timed before a slow one counts. */
  const ATTEMPTS = 3;
  /** Each read is cheap alone; up to four of them under a loaded run must still fit one test's own timeout. */
  const TEST_TIMEOUT_MS = 60_000;

  for (const { label, text, refused } of hostileReads(1)) {
    it(
      `should read ${label} in under ${BOUND_MS} ms`,
      () => {
        // Act: the BEST of a few reads. A bound on the clock measures the box as much as the code (2.2 s under a loaded
        // run, a few hundred ms alone): a quadratic path takes seconds in EVERY attempt, a busy moment spoils one.
        const actual = readConfigText(text);
        let took = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < ATTEMPTS && took >= BOUND_MS / 2; attempt += 1) {
          const started = performance.now();
          readConfigText(text);
          took = Math.min(took, performance.now() - started);
        }

        // Assert
        should(took).be.below(BOUND_MS);
        if (refused === undefined) should(actual.ok).be.true();
        else if (refused instanceof RegExp) should(refusalOf(actual)).match(refused);
        else should(refusalOf(actual)).containEql(refused);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

const FLOOD_FAST_MS = 250;
const FLOOD = '%\n'.repeat(131_072);

describe('the % directive guard — a flood is refused without parsing it', () => {
  it('should refuse a flood of bare % lines inside the bound', () => {
    // Act
    const started = performance.now();
    readConfigText(FLOOD);
    const elapsed = performance.now() - started;

    // Assert
    should(elapsed).be.below(FLOOD_FAST_MS);
  });

  it('should refuse to set a key in a flood inside the bound', () => {
    // Act
    const started = performance.now();
    try {
      setConfigKey(FLOOD, 'a', 1);
    } catch {
      // the refusal itself is the unit tier's claim
    }

    // Assert
    should(performance.now() - started).be.below(FLOOD_FAST_MS);
  });

  it('should replace a flood whole when an edit is made to it inside the bound', () => {
    // Act
    const started = performance.now();
    editConfigText(FLOOD, { a: 1 }, {}, MODELINE);

    // Assert
    should(performance.now() - started).be.below(FLOOD_FAST_MS);
  });
});
