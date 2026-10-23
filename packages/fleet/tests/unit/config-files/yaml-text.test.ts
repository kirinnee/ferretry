import { describe, it } from 'bun:test';
import should from 'should';
import { editConfigText, readConfigText, sameConfigValue } from '../../../src/lib/config-files/yaml-text.ts';

const MODELINE = '# yaml-language-server: $schema=../.schema/machine.json';

/** The value a text means, failing the test when the text does not parse. */
const meaningOf = (text: string): unknown => {
  const read = readConfigText(text);
  if (!read.ok) throw new Error(`expected the text to parse: ${JSON.stringify(read.errors)}`);
  return read.read.value;
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('readConfigText', () => {
  it('should read a document into its plain value', () => {
    // Arrange
    const input = 'a: 1\nb:\n  - x\n  - y\nc:\n  d: true\n';

    // Act
    const actual = meaningOf(input);

    // Assert
    should(actual).deepEqual({ a: 1, b: ['x', 'y'], c: { d: true } });
  });

  it('should read an empty file as an empty mapping', () => {
    // Act
    const actual = meaningOf('');

    // Assert
    should(actual).deepEqual({});
  });

  it('should read a file that is only comments as an empty mapping', () => {
    // Act
    const actual = meaningOf('# nothing here yet\n');

    // Assert
    should(actual).deepEqual({});
  });

  it('should read with YAML 1.2, so off and no stay strings', () => {
    // Act
    const actual = meaningOf('a: off\nb: no\nc: yes\nd: false\n');

    // Assert
    should(actual).deepEqual({ a: 'off', b: 'no', c: 'yes', d: false });
  });

  it('should answer a syntax error with its line and column and the first line of the message only', () => {
    // Arrange
    const input = 'a: 1\nb: [\n';

    // Act
    const actual = readConfigText(input);

    // Assert
    should(actual.ok).be.false();
    if (actual.ok) return;
    should(actual.errors.length).be.above(0);
    should(actual.errors[0]?.position).deepEqual({ line: 3, column: 1 });
    should(actual.errors[0]?.message).not.containEql('\n');
  });

  it('should refuse a duplicate key, pointing at the second one', () => {
    // Arrange
    const input = 'a: 1\na: 2\n';

    // Act
    const actual = readConfigText(input);

    // Assert
    should(actual).deepEqual({
      ok: false,
      errors: [{ message: 'Map keys must be unique', position: { line: 2, column: 1 } }],
    });
  });
});

describe('readConfigText — locate', () => {
  const read = (text: string) => {
    const actual = readConfigText(text);
    if (!actual.ok) throw new Error('expected the text to parse');
    return actual.read;
  };
  const TEXT = 'first: 1\na:\n  b: 1\n  c:\n    - x\n    - y\n';

  it('should place a map path at its KEY, not its value', () => {
    // Arrange
    const subject = read(TEXT);

    // Act
    const actual = subject.locate(['a', 'b']);

    // Assert
    should(actual).deepEqual({ line: 3, column: 3 });
  });

  it('should place a top-level key at its own line', () => {
    // Act
    const actual = read(TEXT).locate(['a']);

    // Assert
    should(actual).deepEqual({ line: 2, column: 1 });
  });

  it('should place a sequence index at the item, which has no key', () => {
    // Act
    const actual = read(TEXT).locate(['a', 'c', 1]);

    // Assert
    should(actual).deepEqual({ line: 6, column: 7 });
  });

  it('should place a path whose key is missing at its parent', () => {
    // Act
    const actual = read(TEXT).locate(['a', 'zz']);

    // Assert
    should(actual).deepEqual({ line: 2, column: 1 });
  });

  it('should place a path whose every part is missing at the start of the document', () => {
    // Act
    const actual = read(TEXT).locate(['q', 'r']);

    // Assert
    should(actual).deepEqual({ line: 1, column: 1 });
  });

  it('should place the empty path at the start of the document', () => {
    // Act
    const actual = read('x: 1\n').locate([]);

    // Assert
    should(actual).deepEqual({ line: 1, column: 1 });
  });

  it('should answer line 1 column 1 for an empty file', () => {
    // Act
    const actual = read('').locate(['anything']);

    // Assert
    should(actual).deepEqual({ line: 1, column: 1 });
  });

  it('should place an index of a document that is itself a sequence at the item', () => {
    // Act
    const actual = read('- a\n- b\n').locate([1]);

    // Assert
    should(actual).deepEqual({ line: 2, column: 3 });
  });

  it('should answer the scalar document for any path when the document is a bare scalar', () => {
    // Act
    const actual = read('hello\n').locate(['x']);

    // Assert
    should(actual).deepEqual({ line: 1, column: 1 });
  });
});

describe('sameConfigValue', () => {
  it.each<[string, unknown, unknown, boolean]>([
    ['equal scalars', 1, 1, true],
    ['different scalars', 1, 2, false],
    ['a number and its string', 1, '1', false],
    ['null and undefined', null, undefined, false],
    ['equal arrays', [1, 'a', [2]], [1, 'a', [2]], true],
    ['arrays of different length', [1, 2], [1], false],
    ['arrays of different items', [1, 2], [1, 3], false],
    ['an array and an object', [], {}, false],
    ['an object and null', {}, null, false],
    ['equal objects in a different key order', { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }, true],
    ['objects with a different value', { a: 1 }, { a: 2 }, false],
    ['objects with different keys', { a: 1 }, { b: 1 }, false],
    ['objects where one holds an extra key', { a: 1 }, { a: 1, b: 2 }, false],
    ['an object with an undefined key and one without it', { a: 1, b: undefined }, { a: 1 }, true],
    ['an undefined key against a defined one', { a: undefined }, { a: 1 }, false],
  ])('should judge %s', (_label, left, right, expected) => {
    // Act
    const actual = sameConfigValue(left, right);

    // Assert
    should(actual).equal(expected);
  });
});

describe('editConfigText — what survives an edit', () => {
  const TEXT = `# the owner's header
a: 1 # same line a
# own line before b
b:
  x: 1 # same line x
  y: 2
list:
  - one # c1
  - two # c2
  - three
`;
  const CURRENT = { a: 1, b: { x: 1, y: 2 }, list: ['one', 'two', 'three'] };

  it('should keep every comment, own-line and same-line, when one scalar changes', () => {
    // Arrange
    const input = { ...CURRENT, b: { x: 5, y: 2 } };

    // Act
    const actual = editConfigText(TEXT, input, CURRENT, MODELINE);

    // Assert
    should(actual).containEql("# the owner's header");
    should(actual).containEql('a: 1 # same line a');
    should(actual).containEql('# own line before b');
    should(actual).containEql('  x: 5 # same line x');
    should(actual).containEql('  - one # c1');
    should(actual).containEql('  - two # c2');
    should(meaningOf(actual)).deepEqual(input);
  });

  it('should keep the order of the keys the owner wrote', () => {
    // Arrange
    const input = { list: CURRENT.list, b: CURRENT.b, a: 9 };

    // Act
    const actual = editConfigText(TEXT, input, CURRENT, MODELINE);

    // Assert
    const order = ['\na: 9', '\nb:', '\nlist:'].map(part => actual.indexOf(part));
    should(order.every(index => index >= 0)).be.true();
    should(order).deepEqual([...order].sort((left, right) => left - right));
  });

  it('should rewrite only the key that changed, leaving the rest of the text byte for byte', () => {
    // Arrange
    const input = { ...CURRENT, a: 2 };

    // Act
    const actual = editConfigText(TEXT, input, CURRENT, MODELINE);

    // Assert
    const unchanged = TEXT.split('\n').filter(line => !line.startsWith('a:'));
    for (const line of unchanged) should(actual).containEql(line);
    should(actual).containEql('a: 2 # same line a');
  });

  it('should not write a key whose value is already what its default means', () => {
    // Arrange — `mode` is absent from the file because its default is already `auto`
    const existing = 'a: 1\n';
    const current = { a: 1, mode: 'auto' };
    const input = { a: 1, mode: 'auto' };

    // Act
    const actual = editConfigText(existing, input, current, MODELINE);

    // Assert
    should(actual).not.containEql('mode');
  });

  it('should write a key whose value differs from its default', () => {
    // Arrange
    const existing = 'a: 1\n';

    // Act
    const actual = editConfigText(existing, { a: 1, mode: 'skip' }, { a: 1, mode: 'auto' }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1, mode: 'skip' });
  });

  it('should delete a key the target no longer has, and keep its neighbours comments', () => {
    // Arrange
    const input = { a: 1, b: { x: 1 }, list: CURRENT.list };

    // Act
    const actual = editConfigText(TEXT, input, CURRENT, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual(input);
    should(actual).not.containEql('y: 2');
    should(actual).containEql('x: 1 # same line x');
  });

  it('should delete a whole top-level key', () => {
    // Arrange
    const input = { a: 1, list: CURRENT.list };

    // Act
    const actual = editConfigText(TEXT, input, CURRENT, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual(input);
  });

  it('should skip a target key whose value is undefined, and keep a key that is not a string', () => {
    // Arrange
    const existing = 'a: 1\n1: numeric key\n';

    // Act
    const actual = editConfigText(existing, { a: 1, b: undefined }, { a: 1 }, MODELINE);

    // Assert
    should(actual).containEql('numeric key');
    should(actual).not.containEql('b:');
  });

  it('should change nothing in the body when the target means what the file already means', () => {
    // Act
    const actual = editConfigText(TEXT, CURRENT, CURRENT, MODELINE);

    // Assert
    should(actual.split('\n').slice(2).join('\n')).equal(TEXT);
  });

  it('should write a number as the number, not a string', () => {
    // Act
    const actual = editConfigText('a: 1\n', { a: 42 }, { a: 1 }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 42 });
  });

  it('should write the string off back as a string that reads as one', () => {
    // Act
    const actual = editConfigText('a: 1\n', { a: 1, provider: 'off' }, { a: 1 }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1, provider: 'off' });
  });
});

describe('editConfigText — sequences are edited item by item', () => {
  const TEXT = 'list:\n  - one # c1\n  - two # c2\n  - three # c3\n';
  const CURRENT = { list: ['one', 'two', 'three'] };

  it('should append an item without touching the others comments', () => {
    // Act
    const actual = editConfigText(TEXT, { list: ['one', 'two', 'three', 'four'] }, CURRENT, MODELINE);

    // Assert
    should(actual).containEql('- one # c1');
    should(actual).containEql('- two # c2');
    should(actual).containEql('- three # c3');
    should(meaningOf(actual)).deepEqual({ list: ['one', 'two', 'three', 'four'] });
  });

  it('should shrink a sequence, keeping the first items comments', () => {
    // Act
    const actual = editConfigText(TEXT, { list: ['one'] }, CURRENT, MODELINE);

    // Assert
    should(actual).containEql('- one # c1');
    should(actual).not.containEql('two');
    should(meaningOf(actual)).deepEqual({ list: ['one'] });
  });

  it('should replace one item in place, keeping every other items comment and its own', () => {
    // Act
    const actual = editConfigText(TEXT, { list: ['one', 'TWO', 'three'] }, CURRENT, MODELINE);

    // Assert
    should(actual).containEql('- one # c1');
    should(actual).containEql('- TWO # c2');
    should(actual).containEql('- three # c3');
  });

  it('should edit inside an item that is itself a mapping', () => {
    // Arrange
    const existing = 'servers:\n  - name: a # first\n    port: 1\n  - name: b # second\n    port: 2\n';
    const current = {
      servers: [
        { name: 'a', port: 1 },
        { name: 'b', port: 2 },
      ],
    };
    const input = {
      servers: [
        { name: 'a', port: 1 },
        { name: 'b', port: 3 },
      ],
    };

    // Act
    const actual = editConfigText(existing, input, current, MODELINE);

    // Assert
    should(actual).containEql('name: a # first');
    should(actual).containEql('name: b # second');
    should(meaningOf(actual)).deepEqual(input);
  });

  it('should compare against an empty list when the default is not a list', () => {
    // Arrange
    const existing = 'list:\n  - one\n';

    // Act
    const actual = editConfigText(existing, { list: ['one', 'two'] }, {}, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ list: ['one', 'two'] });
  });

  it('should write a sequence in whole where the file has a scalar', () => {
    // Act
    const actual = editConfigText('n: 1\n', { n: [1, 2] }, { n: 1 }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ n: [1, 2] });
  });
});

describe('editConfigText — a value changes shape', () => {
  it('should replace a scalar with a mapping', () => {
    // Act
    const actual = editConfigText('a: scalar\n', { a: { k: 1 } }, { a: 'scalar' }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: { k: 1 } });
  });

  it('should replace a mapping with a scalar', () => {
    // Act
    const actual = editConfigText('a:\n  k: 1\n', { a: 5 }, { a: { k: 1 } }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 5 });
  });

  it('should replace a sequence with a scalar', () => {
    // Act
    const actual = editConfigText('q:\n  - 1\n', { q: 'x' }, { q: [1] }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ q: 'x' });
  });

  it('should add a nested mapping and a list that the file did not have', () => {
    // Act
    const actual = editConfigText('a: 1\n', { a: 1, nested: { k: 1 }, arr: [1] }, { a: 1 }, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1, nested: { k: 1 }, arr: [1] });
  });

  it('should edit into a mapping the default knows nothing about', () => {
    // Act
    const actual = editConfigText('b:\n  x: 1 # keep\n', { b: { x: 2 } }, {}, MODELINE);

    // Assert
    should(actual).containEql('x: 2 # keep');
  });
});

describe('editConfigText — the file itself', () => {
  it('should write a new file, modeline first', () => {
    // Act
    const actual = editConfigText(undefined, { a: 1 }, {}, MODELINE);

    // Assert
    should(actual.startsWith(`${MODELINE}\n`)).be.true();
    should(meaningOf(actual)).deepEqual({ a: 1 });
  });

  it('should write an empty mapping for an existing empty file', () => {
    // Act
    const actual = editConfigText('', { a: 1 }, {}, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1 });
  });

  it('should replace an existing text that does not parse, whole', () => {
    // Arrange
    const existing = '# my notes\na: [unclosed\nb: 2\n';

    // Act
    const actual = editConfigText(existing, { a: 1 }, {}, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1 });
    should(actual).not.containEql('unclosed');
    should(actual).not.containEql('my notes');
  });

  it('should replace an existing text that is not a mapping', () => {
    // Act
    const actual = editConfigText('- x\n- y\n', { a: 1 }, {}, MODELINE);

    // Assert
    should(meaningOf(actual)).deepEqual({ a: 1 });
  });

  it('should add the modeline once, above the owners own comment', () => {
    // Arrange
    const existing = '# my notes\na: 1\n';

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
    should(actual.indexOf(MODELINE)).be.below(actual.indexOf('# my notes'));
  });

  it('should not add the modeline again when the file already has one', () => {
    // Arrange
    const existing = `${MODELINE}\n\na: 1\n`;

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
  });

  it('should not add the modeline again when it sits directly above the first key', () => {
    // Arrange
    const existing = `${MODELINE}\na: 1\n`;

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
    should(meaningOf(actual)).deepEqual({ a: 2 });
  });

  it('should keep the modeline when the edit removes the first key it sat above', () => {
    // Arrange
    const existing = `${MODELINE}\na: 1\nb: 2\n`;

    // Act
    const actual = editConfigText(existing, { b: 2, c: 3 }, { a: 1, b: 2 }, MODELINE);

    // Assert
    should(actual.startsWith(MODELINE)).be.true();
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
    should(meaningOf(actual)).deepEqual({ b: 2, c: 3 });
  });

  it('should find a modeline below a comment or two, within the first lines of the file', () => {
    // Arrange
    const existing = `# owner note\n# another\n${MODELINE}\na: 1\n`;

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
    should(actual).containEql('# owner note');
  });

  it('should keep a modeline of the owner’s own, directly above the first key, without adding ours', () => {
    // Arrange
    const existing = '# yaml-language-server: $schema=https://example.com/mine.json\na: 1\n';

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(occurrences(actual, 'yaml-language-server:')).equal(1);
    should(actual).containEql('https://example.com/mine.json');
  });

  it('should add the modeline once however many times the file is edited', () => {
    // Act
    const first = editConfigText(undefined, { a: 1 }, {}, MODELINE);
    const second = editConfigText(first, { a: 2 }, { a: 1 }, MODELINE);
    const third = editConfigText(second, { a: 3 }, { a: 2 }, MODELINE);

    // Assert
    should(occurrences(third, 'yaml-language-server:')).equal(1);
    should(meaningOf(third)).deepEqual({ a: 3 });
  });

  it('should keep a modeline the owner pointed somewhere else', () => {
    // Arrange
    const existing = '# yaml-language-server: $schema=./mine.json\n\na: 1\n';

    // Act
    const actual = editConfigText(existing, { a: 2 }, { a: 1 }, MODELINE);

    // Assert
    should(actual).containEql('$schema=./mine.json');
    should(actual).not.containEql('machine.json');
  });

  it('should end the text with one newline', () => {
    // Act
    const actual = editConfigText(undefined, { a: 1 }, {}, MODELINE);

    // Assert
    should(actual.endsWith('\n')).be.true();
    should(actual.endsWith('\n\n')).be.false();
  });

  it('should not fold a long value across lines', () => {
    // Arrange
    const long = 'word '.repeat(60).trim();

    // Act
    const actual = editConfigText(undefined, { a: long }, {}, MODELINE);

    // Assert
    should(actual).containEql(long);
  });
});
