import { describe, it } from 'bun:test';
import should from 'should';
import { BunDetachedLauncher } from '../../../src/adapters/system/detached-launcher.ts';

describe('BunDetachedLauncher', () => {
  it('should start a program without waiting for it or reading its output', async () => {
    // Arrange
    const launcher = new BunDetachedLauncher();

    // Act / Assert
    await should(launcher.launch({ command: 'true', args: ['https://example.com/'] })).be.fulfilled();
  });

  it('should reject when the program does not exist', async () => {
    // Arrange
    const launcher = new BunDetachedLauncher();

    // Act / Assert
    await should(launcher.launch({ command: 'fy-no-such-opener', args: [] })).be.rejected();
  });

  it('should pass shell metacharacters through as one literal argument', async () => {
    // Arrange
    const launcher = new BunDetachedLauncher();

    // Act / Assert — a shell would run the substitution and fail on the stray quote; an argv does not.
    await should(
      launcher.launch({ command: 'true', args: ["https://example.com/?a=$(touch /nonexistent/x)&b=';"] }),
    ).be.fulfilled();
  });
});
