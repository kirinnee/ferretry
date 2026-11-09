/**
 * The TOML Ferretry writes into every Codex home (`config.toml`) from settings items. A key that is not a bare word
 * must be quoted and escaped, or a key such as `x]\n[y` would open a table of its own. Each case writes a document,
 * parses it back with a real TOML parser and expects the same keys, so a key that leaked into the syntax fails.
 */
import { describe, expect, test } from 'bun:test';
import { tomlDocument, tomlTables } from '../../daemon/lib/toml.ts';

const parse = (text: string): unknown => Bun.TOML.parse(text);

/** Keys that are not bare words: a dot, a quote, a space, a newline, `=` and brackets. */
const AWKWARD = ['a.b', 'say "hi"', 'two words', 'line\nbreak', 'k=v', 'x]\n[y', '[table]', 'back\\slash', 'tab\there'];

describe('the TOML Codex settings are written as', () => {
  test('O6 a nested key with a dot, quote, space, newline, equals or bracket stays one quoted table header', () => {
    for (const awkward of AWKWARD) {
      const document = { outer: { [awkward]: { leaf: 'value' } } };

      const text = tomlDocument(document);

      expect(parse(text)).toEqual(document);
    }
  });

  test('O6b a scalar key with a dot, quote, space, newline, equals or bracket stays one quoted key', () => {
    for (const awkward of AWKWARD) {
      const document = { [awkward]: 'top', table: { [awkward]: 1 } };

      const text = tomlDocument(document);

      expect(parse(text)).toEqual(document);
    }
  });

  test('BG-031 OM1 a string value with a C0 control character or DEL is escaped, so the file still parses', () => {
    // The written text is checked directly: no raw control character may reach the file.
    expect(tomlDocument({ note: 'a\u0001b' })).toBe('note = "a\\u0001b"');
    expect(tomlDocument({ note: 'a\u001bb' })).toBe('note = "a\\u001bb"');
    expect(tomlDocument({ note: 'a\u007fb' })).toBe('note = "a\\u007fb"');
    expect(tomlDocument({ 'k\u0001': 'v' })).toBe('"k\\u0001" = "v"');
  });

  test('a key that tries to open a table is quoted, so it opens none', () => {
    const text = tomlDocument({ 'x]\n[y': 'z' });

    expect(Object.keys(parse(text) as object)).toEqual(['x]\n[y']);
  });

  test('a bare key stays bare', () => {
    expect(tomlDocument({ approval_policy: 'never', 'a-b': { c_d: true } })).toBe(
      'approval_policy = "never"\n\n[a-b]\nc_d = true',
    );
  });

  test('an inline table inside an array quotes its keys too', () => {
    const document = { list: [{ 'a.b': 1, 'c d': 2 }] };

    expect(parse(tomlDocument(document))).toEqual(document);
  });

  test('tomlTables quotes the entry name and every field name', () => {
    const text = tomlTables('mcp_servers', { 'my.server': { 'a b': 'x', 'c=d': 'y' } });

    expect(parse(text)).toEqual({ mcp_servers: { 'my.server': { 'a b': 'x', 'c=d': 'y' } } });
  });
});

describe('the values that need care', () => {
  test('a carriage return and any other control character are escaped, so no value can end its line', () => {
    const document = { text: 'a\rb\u0001c\u007fd' };

    const text = tomlDocument(document);

    expect(text).toBe('text = "a\\rb\\u0001c\\u007fd"');
    expect(parse(text)).toEqual(document);
  });

  test('an empty record inside an array is an empty inline table', () => {
    expect(parse(tomlDocument({ list: [{}] }))).toEqual({ list: [{}] });
  });

  test('a value with no TOML spelling inside an array is an empty string, never a broken document', () => {
    expect(parse(tomlDocument({ list: [undefined, 'x'] }))).toEqual({ list: ['', 'x'] });
  });
});
