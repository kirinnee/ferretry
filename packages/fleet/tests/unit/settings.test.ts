import { describe, it } from 'bun:test';
import should from 'should';
import {
  deepMergeSettings,
  mergeSettingsLayers,
  parseSettings,
  SettingsParseError,
  serializeSettings,
  type SettingsObject,
} from '../../src/lib/settings.ts';

describe('deepMergeSettings', () => {
  it('should merge nested objects key by key rather than replacing the whole branch', () => {
    // Arrange
    const base = { permissions: { allow: ['a'], deny: ['x'] }, model: 'opus' };
    const overlay = { permissions: { deny: ['y'] } };

    // Act
    const actual = deepMergeSettings(base, overlay);

    // Assert
    should(actual).deepEqual({ permissions: { allow: ['a'], deny: ['y'] }, model: 'opus' });
  });

  it('should replace an array wholesale so an override can remove an entry', () => {
    // Arrange — concatenating would make "allow nothing" unexpressible.
    const base = { allow: ['Bash', 'Read'] };

    // Act
    const actual = deepMergeSettings(base, { allow: [] });

    // Assert
    should(actual).deepEqual({ allow: [] });
  });

  it.each([
    ['null over an object', { a: { b: 1 } }, { a: null }, { a: null }],
    ['an object over a scalar', { a: 1 }, { a: { b: 2 } }, { a: { b: 2 } }],
    ['a scalar over an object', { a: { b: 2 } }, { a: 1 }, { a: 1 }],
    ['undefined as a real value', { a: 1 }, { a: undefined }, { a: undefined }],
  ])('should let the overlay win for %s', (_label, base, overlay, expected) => {
    // Act
    const actual = deepMergeSettings(base as SettingsObject, overlay as SettingsObject);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should leave both inputs untouched', () => {
    // Arrange
    const base = { nested: { keep: 1 } };
    const overlay = { nested: { add: 2 } };

    // Act
    deepMergeSettings(base, overlay);

    // Assert
    should(base).deepEqual({ nested: { keep: 1 } });
    should(overlay).deepEqual({ nested: { add: 2 } });
  });
});

describe('mergeSettingsLayers', () => {
  it('should apply layers left to right so the last one wins', () => {
    // Act
    const actual = mergeSettingsLayers([{ model: 'a', keep: 1 }, { model: 'b' }, { model: 'c' }]);

    // Assert
    should(actual).deepEqual({ model: 'c', keep: 1 });
  });

  it('should produce an empty object for an empty stack', () => {
    // Act
    const actual = mergeSettingsLayers([]);

    // Assert
    should(actual).deepEqual({});
  });
});

describe('parseSettings', () => {
  it('should parse a JSON document', () => {
    // Act
    const actual = parseSettings('{"model":"opus","nested":{"a":1}}', 'json');

    // Assert
    should(actual).deepEqual({ model: 'opus', nested: { a: 1 } });
  });

  it('should parse a TOML document', () => {
    // Act
    const actual = parseSettings('model = "gpt"\n[profile]\neffort = "high"\n', 'toml');

    // Assert
    should(actual).deepEqual({ model: 'gpt', profile: { effort: 'high' } });
  });

  it.each([
    ['malformed JSON', '{not json', 'json'],
    ['malformed TOML', 'model = = "x"', 'toml'],
  ])('should reject %s', (_label, text, format) => {
    // Act
    const act = () => parseSettings(text, format as 'json' | 'toml');

    // Assert
    should(act).throw(SettingsParseError);
  });

  it.each([
    ['an array root', '[1, 2]'],
    ['a scalar root', '42'],
    ['a null root', 'null'],
  ])('should reject %s rather than silently dropping the layer', (_label, text) => {
    // Act
    const act = () => parseSettings(text, 'json');

    // Assert
    should(act).throw(/document root must be an object/);
  });
});

describe('serializeSettings', () => {
  it.each([
    ['json', '{\n  "model": "opus"\n}\n'],
    ['toml', 'model = "opus"\n'],
  ])('should serialize %s with exactly one trailing newline', (format, expected) => {
    // Act
    const actual = serializeSettings({ model: 'opus' }, format as 'json' | 'toml');

    // Assert
    should(actual).equal(expected);
  });

  it('should round-trip through parse for both formats', () => {
    // Arrange
    const settings = { model: 'opus', nested: { flag: true, count: 3 } };

    // Act
    const json = parseSettings(serializeSettings(settings, 'json'), 'json');
    const toml = parseSettings(serializeSettings(settings, 'toml'), 'toml');

    // Assert
    should(json).deepEqual(settings);
    should(toml).deepEqual(settings);
  });
});
