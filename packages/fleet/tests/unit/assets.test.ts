import { describe, it } from 'bun:test';
import should from 'should';
import { ASSET_FIELDS, HARNESS_ASSETS, harnessAsset, unsupportedAssetFields } from '../../src/lib/assets.ts';

describe('HARNESS_ASSETS', () => {
  it.each(['claude', 'codex'] as const)('should give %s harness assets distinct destinations', kind => {
    // Act
    const destinations = HARNESS_ASSETS[kind].map(asset => asset.dest);

    // Assert — two fields landing on the same file would make the later one silently win.
    should(new Set(destinations).size).equal(destinations.length);
  });

  it.each(['claude', 'codex'] as const)('should declare only known asset fields for %s', kind => {
    // Act
    const fields = HARNESS_ASSETS[kind].map(asset => asset.field);

    // Assert
    should(fields.every(field => ASSET_FIELDS.includes(field))).be.true();
  });

  it.each(['claude', 'codex'] as const)('should make the %s settings asset a copy with a format', kind => {
    // Act
    const settings = harnessAsset(HARNESS_ASSETS, kind, 'settings');

    // Assert — the harness rewrites this file at runtime, so a symlink into a template would break.
    should(settings?.mode).equal('copy');
    should(settings?.format).be.oneOf(['json', 'toml']);
  });

  it('should give only the settings asset a format', () => {
    // Act
    const formatted = [...HARNESS_ASSETS.claude, ...HARNESS_ASSETS.codex].filter(asset => asset.format !== undefined);

    // Assert
    should(formatted.map(asset => asset.field)).deepEqual(['settings', 'settings']);
  });
});

describe('unsupportedAssetFields', () => {
  it.each([
    ['claude', ['hooks', 'hooksDir']],
    ['codex', ['mcp']],
  ])('should report the fields %s has no destination for', (kind, expected) => {
    // Act
    const actual = unsupportedAssetFields(HARNESS_ASSETS, kind as 'claude' | 'codex');

    // Assert
    should([...actual]).deepEqual(expected);
  });

  it.each(['claude', 'codex'] as const)('should partition every asset field for %s', kind => {
    // Act
    const supported = HARNESS_ASSETS[kind].map(asset => asset.field);
    const unsupported = unsupportedAssetFields(HARNESS_ASSETS, kind);

    // Assert
    should([...supported, ...unsupported].toSorted()).deepEqual([...ASSET_FIELDS].toSorted());
  });
});

describe('harnessAsset', () => {
  it('should find a declared asset by field', () => {
    // Act
    const actual = harnessAsset(HARNESS_ASSETS, 'codex', 'memory');

    // Assert
    should(actual).deepEqual({ field: 'memory', dest: 'AGENTS.md', mode: 'link' });
  });

  it('should return undefined for a field the harness does not accept', () => {
    // Act
    const actual = harnessAsset(HARNESS_ASSETS, 'claude', 'hooksDir');

    // Assert
    should(actual).be.undefined();
  });

  it('should read the supplied table rather than the built-in one', () => {
    // Arrange
    const table = { claude: [{ field: 'memory', dest: 'NOTES.md', mode: 'copy' }], codex: [] } as const;

    // Act
    const actual = harnessAsset(table, 'claude', 'memory');

    // Assert
    should(actual?.dest).equal('NOTES.md');
  });
});
