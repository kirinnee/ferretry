import { describe, it } from 'bun:test';
import should from 'should';
import { expandAssetPath, expandHomePath, expandPath, joinPath } from '../../src/lib/paths.ts';

const USER_HOME = '/home/tester';
const BASE = '/state/fleet/assets';

describe('expandPath', () => {
  it.each([
    ['a tilde prefix', '~/.claude-work', '/home/tester/.claude-work'],
    ['a $HOME prefix', '$HOME/.codex-work', '/home/tester/.codex-work'],
    ['a bare tilde', '~', '/home/tester'],
    ['a bare $HOME', '$HOME', '/home/tester'],
  ])('should expand %s against the supplied user home', (_label, value, expected) => {
    // Act
    const actual = expandPath(value, USER_HOME, BASE);

    // Assert
    should(actual).equal(expected);
  });

  it('should normalize an already-absolute path and leave it where it is', () => {
    // Act
    const actual = expandPath('/opt//fleet/./homes', USER_HOME, BASE);

    // Assert
    should(actual).equal('/opt/fleet/homes');
  });

  it('should resolve a relative path against the supplied base, not the process directory', () => {
    // Act
    const actual = expandPath('templates/settings.json', USER_HOME, BASE);

    // Assert
    should(actual).equal('/state/fleet/assets/templates/settings.json');
  });

  it.each([
    ['a name merely starting with a tilde', '~backup/x', '/state/fleet/assets/~backup/x'],
    ['a name merely starting with $HOME', '$HOMEWORK/x', '/state/fleet/assets/$HOMEWORK/x'],
  ])('should not treat %s as a home reference', (_label, value, expected) => {
    // Act
    const actual = expandPath(value, USER_HOME, BASE);

    // Assert
    should(actual).equal(expected);
  });
});

describe('expandHomePath', () => {
  it('should place a relative account home under the homes directory', () => {
    // Act
    const actual = expandHomePath('claude-work', USER_HOME, '/state/fleet/homes');

    // Assert
    should(actual).equal('/state/fleet/homes/claude-work');
  });
});

describe('expandAssetPath', () => {
  it('should place a relative asset reference under the assets directory', () => {
    // Act
    const actual = expandAssetPath('CLAUDE.md', USER_HOME, BASE);

    // Assert
    should(actual).equal('/state/fleet/assets/CLAUDE.md');
  });
});

describe('joinPath', () => {
  it.each([
    ['a directory without a trailing separator', '/state/bin', '/state/bin/fy-claude'],
    ['a directory with a trailing separator', '/state/bin/', '/state/bin/fy-claude'],
  ])('should join %s to exactly one separator', (_label, directory, expected) => {
    // Act
    const actual = joinPath(directory, 'fy-claude');

    // Assert
    should(actual).equal(expected);
  });
});
