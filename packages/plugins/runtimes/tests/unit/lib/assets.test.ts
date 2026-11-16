import { describe, it } from 'bun:test';
import should from 'should';
import {
  ASSET_FIELDS,
  HARNESS_ASSETS,
  HARNESS_OWNED_SKILL_ENTRIES,
  harnessAsset,
  isHarnessOwnedSkillEntry,
  isUsableSkillItemName,
} from '../../../daemon/lib/assets.ts';

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

  it.each(['claude', 'codex'] as const)('should link every %s asset except its generated settings', kind => {
    // Act
    const settings = harnessAsset(HARNESS_ASSETS, kind, 'settings');
    const linked = HARNESS_ASSETS[kind].filter(asset => asset.field !== 'settings');

    // Assert — a shared document has to BE the file in the home, or "shared" is only a description of
    // two files that started out equal. Settings is the one exception in both directions: a merge of
    // layers cannot be a link to any of them, and the harness rewrites the result at runtime.
    should(linked.length).be.above(0);
    should(linked.every(asset => asset.materialization === 'link')).be.true();
    should(settings?.materialization).equal('generated');
    should(settings?.format).be.oneOf(['json', 'toml']);
  });

  it('should give only the settings asset a format', () => {
    // Act
    const formatted = [...HARNESS_ASSETS.claude, ...HARNESS_ASSETS.codex].filter(asset => asset.format !== undefined);

    // Assert
    should(formatted.map(asset => asset.field)).deepEqual(['settings', 'settings']);
  });
});

describe('the asset fields a harness has no destination for', () => {
  it.each([
    ['claude', ['hooks', 'hooksDir']],
    ['codex', ['mcp']],
  ])('should find no asset for those %s accepts nowhere', (kind, expected) => {
    // Act
    const actual = ASSET_FIELDS.filter(
      field => harnessAsset(HARNESS_ASSETS, kind as 'claude' | 'codex', field) === undefined,
    );

    // Assert
    should([...actual]).deepEqual(expected);
  });
});

describe('harnessAsset', () => {
  it('should find a declared asset by field', () => {
    // Act
    const actual = harnessAsset(HARNESS_ASSETS, 'codex', 'memory');

    // Assert
    should(actual).deepEqual({ field: 'memory', dest: 'AGENTS.md', materialization: 'link' });
  });

  it('should return undefined for a field the harness does not accept', () => {
    // Act
    const actual = harnessAsset(HARNESS_ASSETS, 'claude', 'hooksDir');

    // Assert
    should(actual).be.undefined();
  });

  it('should read the supplied table rather than the built-in one', () => {
    // Arrange
    const table = { claude: [{ field: 'memory', dest: 'NOTES.md', materialization: 'copy' }], codex: [] } as const;

    // Act
    const actual = harnessAsset(table, 'claude', 'memory');

    // Assert
    should(actual?.dest).equal('NOTES.md');
  });
});

describe('isUsableSkillItemName', () => {
  it('should accept a single path component', () => {
    // Act / Assert
    should(isUsableSkillItemName('review')).be.true();
  });

  it.each(['', '.', '..', 'a/b'])('should refuse %s as a destination name', name => {
    // Act / Assert — each of these would compose a destination outside the item it names.
    should(isUsableSkillItemName(name)).be.false();
  });
});

describe('isHarnessOwnedSkillEntry', () => {
  it("should name Codex's bundled skills folder as Codex's own", () => {
    // Assert — Codex writes it on first start; sweeping it would delete Codex's own skills.
    HARNESS_OWNED_SKILL_ENTRIES.codex.should.deepEqual(['.system']);
    isHarnessOwnedSkillEntry('codex', '.system').should.be.true();
    isHarnessOwnedSkillEntry('codex', 'review').should.be.false();
  });

  it('should name nothing for Claude, which writes nothing into its skills folder', () => {
    // Assert
    isHarnessOwnedSkillEntry('claude', '.system').should.be.false();
  });
});
