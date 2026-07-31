import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_TERMINAL_SIZE,
  TerminalPolicyError,
  idleDeadline,
  isTerminalIdle,
  nextTerminalTitle,
  normalizeTerminalSize,
  normalizeTerminalTitle,
} from '../../../src/lib/terminal/index.ts';

describe('terminal policy', () => {
  it('should clamp finite dimensions to protocol bounds and retain valid integers', () => {
    // Act
    const bounded = normalizeTerminalSize(1.6, 400.1);
    const valid = normalizeTerminalSize(DEFAULT_TERMINAL_SIZE.cols, DEFAULT_TERMINAL_SIZE.rows);

    // Assert
    should(bounded).deepEqual({ cols: 20, rows: 120 });
    should(valid).deepEqual(DEFAULT_TERMINAL_SIZE);
  });

  it('should reject non-finite dimensions', () => {
    // Act + Assert
    should(() => normalizeTerminalSize(Number.NaN, 30)).throw(TerminalPolicyError);
    should(() => normalizeTerminalSize(100, Number.POSITIVE_INFINITY)).throw(TerminalPolicyError);
  });

  it('should trim valid terminal titles and reject unsafe or invalid titles', () => {
    // Act
    const actual = normalizeTerminalTitle('  deploy shell  ');

    // Assert
    should(actual).equal('deploy shell');
    for (const value of ['', '  ', 'x'.repeat(65), 'line\nbreak', 3]) {
      should(() => normalizeTerminalTitle(value)).throw(TerminalPolicyError);
    }
  });

  it('should select the first unused generated title and use a bounded fallback', () => {
    // Act + Assert
    should(nextTerminalTitle(['Terminal 1', 'custom', 'Terminal 3'], 3)).equal('Terminal 2');
    should(nextTerminalTitle(['Terminal 1', 'Terminal 2', 'Terminal 3', 'Terminal 4'], 3)).equal('Terminal');
  });

  it('should expose an idle deadline only when nobody is viewing the terminal', () => {
    // Act + Assert
    should(idleDeadline(1_000, 0, 500)).equal(1_500);
    should(idleDeadline(1_000, 2, 500)).equal(undefined);
    should(isTerminalIdle(1_000, 0, 1_500, 500)).be.true();
    should(isTerminalIdle(1_000, 0, 1_499, 500)).be.false();
    should(isTerminalIdle(1_000, 1, 9_999, 500)).be.false();
  });

  it('should reject impossible idle inputs instead of silently reaping a terminal', () => {
    // Act + Assert
    should(() => idleDeadline(0, -1, 100)).throw(TerminalPolicyError);
    should(() => idleDeadline(0, 0, 0)).throw(TerminalPolicyError);
  });
});
