/**
 * `readConfigText` reads a file at the size limit in ONE pass, whatever its aliases do, and refuses a `%` directive
 * flood without parsing it. The answers are checked here at the original size, and the unit tier's (`tests/unit/yaml-text.test.ts`) at a small one.
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
const FLOOD_LINES = 131_072;
const DIRECTIVE_SENTENCE = 'a % directive line is not one YAML knows';
const DIRECTIVE_CAP = 64;

/** The value a text means, failing the test when the text does not parse. */
const meaningOf = (text: string): unknown => {
  const read = readConfigText(text);
  if (!read.ok) throw new Error(`expected the text to parse: ${JSON.stringify(read.errors)}`);
  return read.read.value;
};

describe('the % directive guard — a flood is refused without parsing it', () => {
  it('should refuse a flood of bare % lines in one fixed sentence at the first line past the cap, inside the bound', () => {
    // Arrange
    const flood = '%\n'.repeat(FLOOD_LINES);

    // Act
    const started = performance.now();
    const actual = readConfigText(flood);
    const elapsed = performance.now() - started;

    // Assert
    should(actual.ok).be.false();
    if (actual.ok) return;
    should(actual.errors).deepEqual([
      { message: DIRECTIVE_SENTENCE, position: { line: DIRECTIVE_CAP + 1, column: 1 } },
    ]);
    should(elapsed).be.below(FLOOD_FAST_MS);
  });

  it('should refuse to set a key in a flood, in the same fixed sentence, inside the bound', () => {
    // Act
    const started = performance.now();
    const act = () => setConfigKey('%\n'.repeat(FLOOD_LINES), 'a', 1);

    // Assert
    should(act).throw(`the file does not parse: ${DIRECTIVE_SENTENCE}`);
    should(performance.now() - started).be.below(FLOOD_FAST_MS);
  });

  it('should replace a flood whole when an edit is made to it, inside the bound', () => {
    // Act
    const started = performance.now();
    const actual = editConfigText('%\n'.repeat(FLOOD_LINES), { a: 1 }, {}, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1 });
    should(actual).not.containEql('%\n');
    should(performance.now() - started).be.below(FLOOD_FAST_MS);
  });
});
