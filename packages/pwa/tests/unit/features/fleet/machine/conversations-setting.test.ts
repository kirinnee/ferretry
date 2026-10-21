import { describe, expect, it } from 'bun:test';
import {
  KEEP_IN_SYNC_EXPLANATION,
  readKeepInSync,
  withKeepInSync,
} from '../../../../../src/features/fleet/machine/conversations-setting.ts';

describe('Keep in sync as machine.yaml holds it', () => {
  it('is on unless the file says it is off', () => {
    // Arrange
    const inputs = [
      '',
      'conversations:\n  listComputer: true\n',
      'defaultRuntime: x\n',
      'conversations:\n  listComputer: false\n',
    ];

    // Act
    const actual = inputs.map(readKeepInSync);

    // Assert
    expect(actual).toEqual([true, true, true, false]);
  });

  it('is unknown when the file does not parse', () => {
    // Arrange
    const input = 'conversations: [unclosed\n';

    // Act
    const actual = readKeepInSync(input);

    // Assert
    expect(actual).toBeNull();
  });

  it('writes off as a key, keeping the owner’s comments and other keys', () => {
    // Arrange
    const input = '# my machine\ndefaultRuntime: claude-default # mine\n';

    // Act
    const actual = withKeepInSync(input, false);

    // Assert
    expect(actual).toContain('# my machine');
    expect(actual).toContain('defaultRuntime: claude-default # mine');
    expect(readKeepInSync(actual ?? '')).toBe(false);
  });

  it('turns it back on by rewriting the key that is there, and leaves a file that never said it alone', () => {
    // Arrange
    const off = 'conversations:\n  listComputer: false\n';
    const silent = 'defaultRuntime: claude-default\n';

    // Act
    const on = withKeepInSync(off, true);
    const untouched = withKeepInSync(silent, true);

    // Assert
    expect(readKeepInSync(on ?? '')).toBe(true);
    expect(untouched).toBe(silent);
  });

  it('writes into a file with no mapping at all, and refuses one that does not parse', () => {
    // Arrange
    const empty = '';
    const broken = 'conversations: [unclosed\n';

    // Act
    const written = withKeepInSync(empty, false);
    const refused = withKeepInSync(broken, false);

    // Assert
    expect(readKeepInSync(written ?? '')).toBe(false);
    expect(refused).toBeNull();
  });

  it('keeps the sentence the owner reads', () => {
    // Arrange
    const subject = KEEP_IN_SYNC_EXPLANATION;

    // Act
    const actual = subject;

    // Assert
    expect(actual).toBe(
      'Show conversations from this computer’s own Claude Code and Codex in Continue. Read-only; nothing is imported until you continue one.',
    );
  });
});
