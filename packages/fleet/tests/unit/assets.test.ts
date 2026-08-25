import { describe, it } from 'bun:test';
import should from 'should';
import {
  ASSET_FIELDS,
  HARNESS_ASSETS,
  harnessAsset,
  isUsableSkillItemName,
  resolveAssetMaterialization,
  skillItemName,
  unsupportedAssetFields,
} from '../../src/lib/assets.ts';

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

describe('resolveAssetMaterialization', () => {
  it.each([
    ['./CLAUDE.md', 'link'],
    ['CLAUDE.md', 'link'],
    ['memory/terse.md', 'link'],
  ])('should link %s, because it lives in the asset tree this fleet owns', (reference, expected) => {
    // Act
    const actual = resolveAssetMaterialization(HARNESS_ASSETS, 'claude', 'memory', reference);

    // Assert — the whole point: the home's file IS the shared document, so an edit reaches every
    // account referencing it with no apply in between.
    should(actual).equal(expected);
  });

  it.each(['/etc/instructions.md', '~/dotfiles/CLAUDE.md', '$HOME/CLAUDE.md', '../outside/CLAUDE.md'])(
    'should downgrade %s to a copy, because a link inside a home may only resolve into the asset tree',
    reference => {
      // Act
      const actual = resolveAssetMaterialization(HARNESS_ASSETS, 'claude', 'memory', reference);

      // Assert — the state home refuses to traverse a link out of itself, and the narrow exemption
      // admits only a target inside the fleet's own directories. So this one is copied, and says so.
      should(actual).equal('copy');
    },
  );

  it('should call settings generated whatever the reference is', () => {
    // Act
    const inTree = resolveAssetMaterialization(
      HARNESS_ASSETS,
      'claude',
      'settings',
      './templates/claude/settings.json',
    );
    const outside = resolveAssetMaterialization(HARNESS_ASSETS, 'claude', 'settings', '~/settings.json');

    // Assert — a stack is merged in memory and written as one file, so there is no source it could be
    // the same file as. Being in the asset tree changes nothing about that.
    should(inTree).equal('generated');
    should(outside).equal('generated');
  });

  it('should say nothing at all for a field this harness has no destination for', () => {
    // Act
    const actual = resolveAssetMaterialization(HARNESS_ASSETS, 'claude', 'hooksDir', './hooks');

    // Assert — undefined rather than a mechanism, because nothing is materialized. Naming one would
    // describe a write that never happens, and this is exactly the set `linkable` leaves out.
    should(actual).be.undefined();
  });

  it('should read the supplied table rather than the built-in one', () => {
    // Arrange — a table that asks for a copy of a document sitting in the asset tree.
    const table = { claude: [{ field: 'memory', dest: 'NOTES.md', materialization: 'copy' }], codex: [] } as const;

    // Act
    const actual = resolveAssetMaterialization(table, 'claude', 'memory', './CLAUDE.md');

    // Assert — the reference only ever downgrades a `link`; it never promotes a declared copy.
    should(actual).equal('copy');
  });
});

describe('skillItemName', () => {
  it.each([
    ['skills/review', 'review'],
    ['./skills/review', 'review'],
    ['skills/review/', 'review'],
    ['skills/a/../b/deploy', 'deploy'],
    ['review', 'review'],
  ])('should read %s as the item %s', (reference, expected) => {
    // Act
    const actual = skillItemName(reference);

    // Assert — two spellings of one document must claim one destination, not two.
    should(actual).equal(expected);
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
