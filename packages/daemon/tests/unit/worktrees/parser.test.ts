import { describe, it } from 'bun:test';
import should from 'should';
import { parseWorktreeList, parseWorktreeStatus } from '../../../src/lib/worktrees/index.ts';

describe('worktree parsers', () => {
  it('should preserve whitespace in paths and parse porcelain flags and reasons', () => {
    // Arrange
    const input = [
      'worktree /repo with space',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo\nlinked',
      'HEAD def456',
      'detached',
      'locked maintenance window',
      'prunable stale metadata',
      '',
    ]
      .join('\0')
      .concat('\0');

    // Act
    const actual = parseWorktreeList(input);

    // Assert
    should(actual).deepEqual([
      {
        path: '/repo with space',
        head: 'abc123',
        branch: 'main',
        detached: false,
        bare: false,
        locked: undefined,
        prunable: undefined,
      },
      {
        path: '/repo\nlinked',
        head: 'def456',
        branch: undefined,
        detached: true,
        bare: false,
        locked: 'maintenance window',
        prunable: 'stale metadata',
      },
    ]);
  });

  it('should parse bare and reasonless worktree flags while ignoring malformed records', () => {
    // Arrange
    const input = ['bare', '', 'worktree /valid', 'bare', 'locked', 'prunable', ''].join('\0').concat('\0');

    // Act
    const actual = parseWorktreeList(input);

    // Assert
    should(actual).deepEqual([
      {
        path: '/valid',
        head: undefined,
        branch: undefined,
        detached: false,
        bare: true,
        locked: '',
        prunable: '',
      },
    ]);
  });

  it('should classify every independently unsafe porcelain-v2 status category', () => {
    // Arrange
    const input = [
      '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
      '1 .M S.M. 100644 100644 100644 aaa bbb changed-submodule',
      '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt',
      'old-name.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? untracked.txt',
      '! ignored.txt',
      'ignored malformed record',
    ]
      .join('\0')
      .concat('\0');

    // Act
    const actual = parseWorktreeStatus(input, true);

    // Assert
    should(actual).deepEqual({
      staged: true,
      unstaged: true,
      untracked: true,
      ignored: true,
      conflicted: true,
      dirtySubmodule: true,
      truncated: true,
    });
  });

  it('should report a clean complete status', () => {
    // Act
    const actual = parseWorktreeStatus('');

    // Assert
    should(actual).deepEqual({
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    });
  });
});
