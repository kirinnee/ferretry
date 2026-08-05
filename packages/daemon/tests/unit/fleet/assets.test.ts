import { describe, it } from 'bun:test';
import should from 'should';
import {
  FleetAssetRefusal,
  isEditableText,
  MAX_ASSET_EDIT_COUNT,
  MAX_ASSET_FILE_BYTES,
  measureAssetEdit,
  parseAssetEdits,
  parseAssetPath,
} from '../../../src/lib/fleet/assets.ts';

const refusalOf = (act: () => unknown): string => {
  try {
    act();
  } catch (error) {
    should(error).be.instanceof(FleetAssetRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('parseAssetPath', () => {
  it('should accept a nested relative path and return it canonically', () => {
    // Act
    const actual = parseAssetPath('skills/review/SKILL.md');

    // Assert
    should(actual).equal('skills/review/SKILL.md');
  });

  it.each([
    ['', /is empty/u],
    ['/etc/passwd', /must be relative/u],
    ['C:/windows', /must be relative/u],
    ['skills\\review', /must use "\/" separators/u],
    ['../../.ssh/authorized_keys', /path traversal/u],
    ['skills/./SKILL.md', /path traversal/u],
    ['skills//SKILL.md', /empty path segment/u],
    ['skills/ review.md', /whitespace/u],
    ['a/b/c/d/e/f/g/h/i.md', /deeper than/u],
  ])('should refuse %p', (candidate, expected) => {
    // Act
    const actual = refusalOf(() => parseAssetPath(candidate));

    // Assert
    should(actual).match(expected);
  });

  it.each([['skills/\tSKILL.md'], ['skills/\nSKILL.md'], ['skills/\rSKILL.md'], ['skills/\u0000SKILL.md']])(
    'should refuse the control character in %j even though a file may contain it',
    candidate => {
      // Act
      const actual = refusalOf(() => parseAssetPath(candidate));

      // Assert — a path that prints as one thing and opens another is the whole problem.
      should(actual).match(/control characters/u);
    },
  );

  it('should refuse a path longer than the limit', () => {
    // Act
    const actual = refusalOf(() => parseAssetPath(`${'a'.repeat(400)}.md`));

    // Assert
    should(actual).match(/longer than/u);
  });
});

describe('isEditableText', () => {
  it('should accept the whitespace a text file legitimately contains', () => {
    // Act + Assert
    should(isEditableText('line one\n\tindented\r\n')).be.true();
  });

  it.each([['\u0000'], ['\u0007'], ['\u007f']])('should reject %j', content => {
    // Act + Assert
    should(isEditableText(`text${content}`)).be.false();
  });
});

describe('measureAssetEdit', () => {
  it('should count bytes rather than characters', () => {
    // Act
    const actual = measureAssetEdit({ path: 'CLAUDE.md', content: '€' });

    // Assert
    should(actual).equal(3);
  });

  it('should refuse a file over the per-file limit', () => {
    // Act
    const actual = refusalOf(() => measureAssetEdit({ path: 'big.md', content: 'a'.repeat(MAX_ASSET_FILE_BYTES + 1) }));

    // Assert
    should(actual).match(/over the .* limit for a single file/u);
  });

  it('should refuse content that is not editable text', () => {
    // Act
    const actual = refusalOf(() => measureAssetEdit({ path: 'binary.md', content: 'a\u0000b' }));

    // Assert
    should(actual).match(/not editable text/u);
  });
});

describe('parseAssetEdits', () => {
  it('should canonicalise every path and keep the content', () => {
    // Act
    const actual = parseAssetEdits([{ path: 'CLAUDE.md', content: 'hello\n' }]);

    // Assert
    should(actual).deepEqual([{ path: 'CLAUDE.md', content: 'hello\n' }]);
  });

  it('should refuse more edits than one proposal may carry', () => {
    // Arrange
    const edits = Array.from({ length: MAX_ASSET_EDIT_COUNT + 1 }, (_, index) => ({
      path: `skills/skill-${index}.md`,
      content: 'x',
    }));

    // Act
    const actual = refusalOf(() => parseAssetEdits(edits));

    // Assert
    should(actual).match(/at most .* asset edits/u);
  });

  it('should refuse the same file edited twice in one proposal', () => {
    // Act
    const actual = refusalOf(() =>
      parseAssetEdits([
        { path: 'CLAUDE.md', content: 'one' },
        { path: 'CLAUDE.md', content: 'two' },
      ]),
    );

    // Assert
    should(actual).match(/edited more than once/u);
  });

  it('should refuse a set within every per-file limit that is too large together', () => {
    // Arrange — bounded as a set as well as per file, or thirty-two near-limit files still land.
    const edits = Array.from({ length: 8 }, (_, index) => ({
      path: `skills/skill-${index}.md`,
      content: 'a'.repeat(MAX_ASSET_FILE_BYTES),
    }));

    // Act
    const actual = refusalOf(() => parseAssetEdits(edits));

    // Assert
    should(actual).match(/limit for one proposal/u);
  });
});
