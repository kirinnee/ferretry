import { describe, expect, test } from 'bun:test';
import { editConfigText, readConfigText } from '../../../app/lib/config-text.ts';

const read = (text: string) => {
  const result = readConfigText(text);
  if (!result.ok) throw new Error('expected the file to parse');
  return result.read;
};

describe('readConfigText', () => {
  test('reads the plain value, and an empty file is an empty mapping', () => {
    expect(read('a: 1\nb: [x, y]\n').value).toEqual({ a: 1, b: ['x', 'y'] });
    expect(read('').value).toEqual({});
  });

  test('YAML 1.2: off and no are strings, not booleans', () => {
    expect(read('a: off\nb: no\n').value).toEqual({ a: 'off', b: 'no' });
  });

  test('a file that does not parse answers its syntax errors, located to a line and column, first line only', () => {
    const result = readConfigText('a: 1\na: 2\nb: [\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.message).not.toContain('\n');
      expect(error.position?.line).toBeGreaterThanOrEqual(1);
      expect(error.position?.column).toBeGreaterThanOrEqual(1);
    }
    expect(result.errors[0]?.position).toEqual({ line: 2, column: 1 });
  });

  test('locates a key where a person looks for it, and a list item by its value', () => {
    const file = read('first: 1\nnested:\n  key: 2\nlist:\n  - one\n  - two\n');
    expect(file.locate(['first'])).toEqual({ line: 1, column: 1 });
    expect(file.locate(['nested', 'key'])).toEqual({ line: 3, column: 3 });
    expect(file.locate(['list', 1])).toEqual({ line: 6, column: 5 });
  });

  test('a missing key points at the deepest part of its path that is written', () => {
    const file = read('nested:\n  key: 2\n');
    expect(file.locate(['nested', 'missing'])).toEqual({ line: 1, column: 1 });
    expect(file.locate(['nested', 'missing', 'deeper'])).toEqual({ line: 1, column: 1 });
  });

  test('a path nothing in the file matches points at the top of the document', () => {
    expect(read('a: 1\n').locate(['nope'])).toEqual({ line: 1, column: 1 });
    expect(read('').locate(['nope'])).toEqual({ line: 1, column: 1 });
    expect(read('').locate([])).toEqual({ line: 1, column: 1 });
  });

  test('a key under a parent that is not a mapping has no key to point at, so its value is used', () => {
    expect(read('list: [a, b]\n').locate(['list', 0])).toEqual({ line: 1, column: 8 });
  });
});

describe('editConfigText', () => {
  test('changes only the keys that differ and keeps comments and order byte for byte', () => {
    const existing = '# the owner’s note\nb: 1 # keep me\na: 2\n';
    const edited = editConfigText(existing, { a: 3, b: 1 }, { a: 2, b: 1 }, undefined);
    expect(edited).toBe('# the owner’s note\nb: 1 # keep me\na: 3\n');
  });

  test('leaves a text alone when nothing differs', () => {
    const existing = 'a: 1 # same\n';
    expect(editConfigText(existing, { a: 1 }, { a: 1 }, undefined)).toBe(existing);
  });

  test('removes a key the target no longer has, and does not write a key whose default already matches', () => {
    expect(editConfigText('a: 1\nb: 2\n', { a: 1 }, { a: 1, b: 2 }, undefined)).toBe('a: 1\n');
    expect(editConfigText('a: 1\n', { a: 1, b: 5 }, { a: 1, b: 5 }, undefined)).toBe('a: 1\n');
  });

  test('skips a target key that is undefined', () => {
    expect(editConfigText('a: 1\n', { a: 1, b: undefined }, { a: 1 }, undefined)).toBe('a: 1\n');
  });

  test('edits a nested mapping key by key', () => {
    const existing = 'outer:\n  keep: 1 # stay\n  change: 2\n';
    const edited = editConfigText(
      existing,
      { outer: { keep: 1, change: 9 } },
      { outer: { keep: 1, change: 2 } },
      undefined,
    );
    expect(edited).toBe('outer:\n  keep: 1 # stay\n  change: 9\n');
  });

  test('edits a list item by item: an item in place, one added, and the tail cut', () => {
    expect(editConfigText('l:\n  - a # one\n  - b\n', { l: ['a', 'c'] }, { l: ['a', 'b'] }, undefined)).toBe(
      'l:\n  - a # one\n  - c\n',
    );
    expect(editConfigText('l:\n  - a\n', { l: ['a', 'b', 'c'] }, { l: ['a'] }, undefined)).toBe(
      'l:\n  - a\n  - b\n  - c\n',
    );
    expect(editConfigText('l:\n  - a\n  - b\n  - c\n', { l: ['a'] }, { l: ['a', 'b', 'c'] }, undefined)).toBe(
      'l:\n  - a\n',
    );
  });

  test('a list edited when the current meaning is not a list starts from nothing', () => {
    expect(editConfigText('l:\n  - a\n', { l: ['z'] }, {}, undefined)).toBe('l:\n  - z\n');
  });

  test('a mapping edited when the current meaning is not a mapping starts from nothing', () => {
    expect(editConfigText('m:\n  k: 1\n', { m: { k: 2 } }, { m: 'text' }, undefined)).toBe('m:\n  k: 2\n');
  });

  test('a value that changes shape is replaced whole', () => {
    expect(editConfigText('a: 1\n', { a: { x: 1 } }, { a: 1 }, undefined)).toBe('a:\n  x: 1\n');
    expect(editConfigText('a: [1]\n', { a: 'text' }, { a: [1] }, undefined)).toBe('a: text\n');
    expect(editConfigText('a:\n  x: 1\n', { a: [1, 2] }, { a: { x: 1 } }, undefined)).toBe('a:\n  - 1\n  - 2\n');
  });

  test('compares lists and mappings by structure, ignoring undefined members', () => {
    const existing = 'a:\n  - 1\n  - { x: 1 } # kept\n';
    expect(editConfigText(existing, { a: [1, { x: 1, y: undefined }] }, { a: [1, { x: 1 }] }, undefined)).toBe(
      existing,
    );
    expect(editConfigText('a: [1, 2]\n', { a: [1, 2, 3] }, { a: [1, 2] }, undefined)).toBe('a: [ 1, 2, 3 ]\n');
  });

  test('a new file is written from nothing, and a file that does not parse is replaced whole', () => {
    expect(editConfigText(undefined, { a: 1 }, {}, undefined)).toBe('a: 1\n');
    expect(editConfigText('a: [\n', { a: 1 }, {}, undefined)).toBe('a: 1\n');
  });

  test('a file whose top level is not a mapping becomes one', () => {
    expect(editConfigText('- a\n- b\n', { a: 1 }, {}, undefined)).toBe('a: 1\n');
  });

  test('adds the modeline when the file has none, and keeps one that is there', () => {
    const modeline = '# yaml-language-server: $schema=https://example.test/schema.json';
    expect(editConfigText('a: 1\n', { a: 2 }, { a: 1 }, modeline)).toBe(`${modeline}\n\na: 2\n`);
    const withIt = `${modeline}\na: 1\n`;
    expect(editConfigText(withIt, { a: 2 }, { a: 1 }, modeline)).toBe(`${modeline}\na: 2\n`);
  });

  test('puts the modeline above a header comment the file already starts with', () => {
    const modeline = '# yaml-language-server: $schema=s.json';
    const edited = editConfigText('# header\n\na: 1\n', { a: 2 }, { a: 1 }, modeline);
    expect(edited.startsWith(`${modeline}\n# header`)).toBe(true);
    expect(edited).toContain('a: 2');
  });
});
