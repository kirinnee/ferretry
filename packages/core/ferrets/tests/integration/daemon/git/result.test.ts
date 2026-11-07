import { describe, it } from 'bun:test';
import should from 'should';
import {
  GitCommandError,
  decodeGitOutput,
  requireGitExit,
  stripFinalLineFeed,
} from '../../../src/adapters/git/index.ts';
import type { GitExecution } from '../../../src/lib/worktrees/ports.ts';

const execution = (overrides: Partial<GitExecution> = {}): GitExecution => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(''),
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  ...overrides,
});

describe('Git result inspection', () => {
  it('should return the execution unchanged when the exit code is accepted', () => {
    // Arrange
    const input = execution({ exitCode: 1 });

    // Act
    const actual = requireGitExit('git show-ref', input, [0, 1]);

    // Assert
    should(actual).equal(input);
  });

  it('should raise the stderr detail when the exit code is rejected', () => {
    // Arrange
    const input = execution({ exitCode: 128, stderr: 'fatal: bad revision\n' });

    // Act
    let actual: unknown;
    try {
      requireGitExit('git worktree add', input);
    } catch (error) {
      actual = error;
    }

    // Assert
    should(actual).be.instanceof(GitCommandError);
    should((actual as GitCommandError).message).equal('git worktree add failed: fatal: bad revision');
    should((actual as GitCommandError).action).equal('git worktree add');
    should((actual as GitCommandError).name).equal('GitCommandError');
    should((actual as GitCommandError).execution).equal(input);
  });

  it('should fall back to the exit code when Git said nothing on stderr', () => {
    // Act + Assert
    should(() => requireGitExit('git status', execution({ exitCode: 9 }))).throw('git status failed: exit 9');
  });

  it('should flag truncated stderr so a caller never trusts a clipped diagnostic', () => {
    // Act + Assert
    should(() => requireGitExit('git log', execution({ exitCode: 2, stderr: 'boom', stderrTruncated: true }))).throw(
      'git log failed: boom (stderr truncated)',
    );
  });

  it('should report a timeout as a timeout even when the exit code looks accepted', () => {
    // Act + Assert
    should(() => requireGitExit('git fetch', execution({ exitCode: 0, timedOut: true }))).throw('git fetch timed out');
    should(() => requireGitExit('git fetch', execution({ exitCode: 0, timedOut: true, stderrTruncated: true }))).throw(
      'git fetch timed out (stderr truncated)',
    );
  });

  it('should decode Git stdout as UTF-8 and strip only the final line feed', () => {
    // Arrange
    const input = execution({ stdout: new TextEncoder().encode('réf/heads/main\n') });

    // Act
    const decoded = decodeGitOutput(input);

    // Assert
    should(decoded).equal('réf/heads/main\n');
    should(stripFinalLineFeed(decoded)).equal('réf/heads/main');
    should(stripFinalLineFeed('a\n\n')).equal('a\n');
    should(stripFinalLineFeed('no-newline')).equal('no-newline');
  });
});
