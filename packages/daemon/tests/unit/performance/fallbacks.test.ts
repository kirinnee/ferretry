import { describe, it } from 'bun:test';
import should from 'should';
import { polledDirectoryLimitations } from '../../../src/lib/performance/fallbacks.ts';

const roots = { home: '/home/me', stateHome: '/srv/fy' };

describe('polledDirectoryLimitations', () => {
  it('should say nothing when every directory is watched', () => {
    // Act
    const actual = polledDirectoryLimitations([], roots, 5_000);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should name one polled directory by its shape and its reason', () => {
    // Arrange
    const input = [{ directory: '/srv/fy/state/sessions/mvir1r5g-90731a4e', reason: 'watch-limit' }];
    const expected = [
      'The file-event hub could not watch 1 directory and polls it every 5 s instead: <fy-home>/state/sessions/<session> (watch-limit).',
    ];

    // Act
    const actual = polledDirectoryLimitations(input, roots, 5_000);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should name the first five and count the rest', () => {
    // Arrange
    const input = Array.from({ length: 7 }, (_, index) => ({
      directory: `/home/me/.claude/projects/-home-me-work-${String(index)}`,
      reason: 'unsupported',
    }));

    // Act
    const [actual] = polledDirectoryLimitations(input, roots, 2_000);

    // Assert
    should(actual).startWith('The file-event hub could not watch 7 directories and polls them every 2 s instead: ');
    should(actual?.match(/~\/\.claude\/projects\/<project> \(unsupported\)/gu)).have.length(5);
    should(actual).endWith(', and 2 more.');
    should(actual).not.containEql('work');
  });
});
