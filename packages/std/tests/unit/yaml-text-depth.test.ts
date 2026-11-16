import { describe, it } from 'bun:test';
import should from 'should';
import {
  editConfigText,
  MAX_NESTING_DEPTH,
  readConfigText,
  readConfigTextToEdit,
  setConfigKey,
} from '../../src/yaml-text.ts';

const TOO_DEEP = 'the file is too deeply nested or too large to read';

/** Text nested `depth` collections deep, each shape written the way a person could write it. */
const SHAPES: readonly (readonly [label: string, make: (depth: number) => string, far: number])[] = [
  ['flow lists', depth => `${'['.repeat(depth)}${']'.repeat(depth)}\n`, 20],
  ['flow mappings', depth => `${'{a: '.repeat(depth)}1${'}'.repeat(depth)}\n`, 20],
  ['block lists on one line', depth => `${'- '.repeat(depth)}x\n`, 20],
  [
    'block mappings',
    depth =>
      `${Array.from({ length: depth }, (_, level) => `${' '.repeat(level)}k:\n`).join('')}${' '.repeat(depth)}x\n`,
    2,
  ],
  [
    'block mappings and lists alternating',
    depth =>
      `${Array.from({ length: depth }, (_, level) => (level % 2 === 0 ? `${' '.repeat(level)}k:\n` : `${' '.repeat(level)}- \n`)).join('')}${' '.repeat(depth)}x\n`,
    2,
  ],
];

describe('the nesting bound', () => {
  it('should be far above any real configuration and far below any stack', () => {
    should(MAX_NESTING_DEPTH).be.within(64, 1024);
  });

  for (const [label, make, far] of SHAPES) {
    it(`should accept ${label} nested ${String(MAX_NESTING_DEPTH)} deep`, () => {
      // Act
      const actual = readConfigText(make(MAX_NESTING_DEPTH));

      // Assert
      should(actual.ok).be.true();
    });

    it(`should refuse ${label} nested ${String(MAX_NESTING_DEPTH + 1)} deep, in the fixed sentence, at a place`, () => {
      // Act
      const actual = readConfigText(make(MAX_NESTING_DEPTH + 1));

      // Assert
      if (actual.ok) throw new Error('expected a refusal');
      should(actual.errors).have.length(1);
      should(actual.errors[0]?.message).equal(TOO_DEEP);
      should(actual.errors[0]?.position?.line).be.aboveOrEqual(1);
      should(actual.errors[0]?.position?.column).be.aboveOrEqual(1);
    });

    it(`should refuse ${label} nested far past the bound without a stack overflow, the same every time`, () => {
      // Act
      const first = readConfigText(make(MAX_NESTING_DEPTH * far));
      const second = readConfigText(make(MAX_NESTING_DEPTH * far));

      // Assert
      should(first).deepEqual(second);
      should(first.ok ? undefined : first.errors[0]?.message).equal(TOO_DEEP);
    });
  }

  it('should point at the collection that crosses the bound', () => {
    // Arrange: one collection per line, the crossing one the last.
    const text = `${Array.from({ length: MAX_NESTING_DEPTH + 1 }, (_, level) => `${' '.repeat(level)}k:\n`).join('')}`;

    // Act
    const actual = readConfigText(text);

    // Assert
    should(actual.ok ? undefined : actual.errors[0]?.position?.line).equal(MAX_NESTING_DEPTH + 1);
  });

  it('should not count brackets in a quoted scalar, a comment or a block scalar as nesting', () => {
    // Arrange
    const brackets = '['.repeat(MAX_NESTING_DEPTH * 2);
    const text = `a: "${brackets}"\nb: '${brackets}'\nc: x ${brackets}\n# ${brackets}\nd: |\n  ${brackets}\ne: 1\n`;

    // Act
    const actual = readConfigText(text);

    // Assert
    should(actual.ok).be.true();
  });

  it('should refuse the same text, without parsing it, to edit and to set a key in', () => {
    // Arrange
    const text = SHAPES[0]?.[1](MAX_NESTING_DEPTH + 1) ?? '';

    // Act
    const edited = readConfigTextToEdit(text);
    const replaced = editConfigText(text, { a: 1 }, {}, undefined);

    // Assert
    should(edited.base).be.undefined();
    should(edited.read.ok).be.false();
    should(replaced).equal('a: 1\n');
    should(() => setConfigKey(text, 'a', 1)).throw(`the file does not parse: ${TOO_DEEP}`);
  });
});
