import { describe, it } from 'bun:test';
import should from 'should';
import { ASSET_FIELDS, assetsOf, harnessAsset, isUsableSkillItemName } from '../../../daemon/lib/assets.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const KINDS = ['claude', 'codex'] as const;
const kitOf = (kind: (typeof KINDS)[number]) => REAL_KITS.get(kind);

describe('the assets of a harness', () => {
  it.each(KINDS)('should give %s harness assets distinct destinations', kind => {
    // Act
    const destinations = assetsOf(kitOf(kind)).map(asset => asset.dest);

    // Assert — two fields landing on the same file would make the later one silently win.
    should(new Set(destinations).size).equal(destinations.length);
  });

  it.each(KINDS)('should declare only known asset fields for %s', kind => {
    // Act
    const fields = assetsOf(kitOf(kind)).map(asset => asset.field);

    // Assert
    should(fields.every(field => ASSET_FIELDS.includes(field))).be.true();
  });

  it.each(KINDS)('should link every %s asset except its generated settings', kind => {
    // Act
    const settings = harnessAsset(kitOf(kind), 'settings');
    const linked = assetsOf(kitOf(kind)).filter(asset => asset.field !== 'settings');

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
    const formatted = KINDS.flatMap(kind => assetsOf(kitOf(kind))).filter(asset => asset.format !== undefined);

    // Assert
    should(formatted.map(asset => asset.field)).deepEqual(['settings', 'settings']);
  });

  it('should derive the settings, instructions and skills destinations from what the plugin already says, so a kit that gives none of its own assets still lands them', () => {
    // Arrange
    const kit = { ...kitOf('claude'), assets: undefined };

    // Act
    const actual = assetsOf(kit).map(asset => [asset.field, asset.dest]);

    // Assert
    should(actual).deepEqual([
      ['settings', 'settings.json'],
      ['memory', 'CLAUDE.md'],
      ['skills', 'skills'],
    ]);
  });

  it('should give a harness no destination when its plugin gave none', () => {
    // Act / Assert
    should(harnessAsset(undefined, 'skills')?.dest).equal('skills');
    should(harnessAsset(undefined, 'settings')).be.undefined();
  });
});

describe('the asset fields a harness has no destination for', () => {
  it.each([
    ['claude', ['hooks', 'hooksDir']],
    ['codex', ['mcp']],
  ] as const)('should find no asset for those %s accepts nowhere', (kind, expected) => {
    // Act
    const actual = ASSET_FIELDS.filter(field => harnessAsset(kitOf(kind), field) === undefined);

    // Assert
    should([...actual]).deepEqual(expected);
  });
});

describe('harnessAsset', () => {
  it('should find a declared asset by field', () => {
    // Act
    const actual = harnessAsset(kitOf('codex'), 'memory');

    // Assert
    should(actual).deepEqual({ field: 'memory', dest: 'AGENTS.md', materialization: 'link' });
  });

  it('should return undefined for a field the harness does not accept', () => {
    // Act
    const actual = harnessAsset(kitOf('claude'), 'hooksDir');

    // Assert
    should(actual).be.undefined();
  });

  it('should read the kit it is given', () => {
    // Arrange
    const kit = { assets: [{ field: 'hooks', dest: 'NOTES.json', materialization: 'copy' }] } as const;

    // Act
    const actual = harnessAsset(kit, 'hooks');

    // Assert
    should(actual?.dest).equal('NOTES.json');
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
