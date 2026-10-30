import { describe, it } from 'bun:test';
import should from 'should';
import { TmuxReleaseReader } from '../../../src/adapters/tmux/tmux-release-reader.ts';
import type { TmuxCommandPort } from '../../../src/lib/tmux/contracts.ts';

const server = (
  answer: () => Promise<{ code: number; stdout: string; stderr: string }>,
): TmuxCommandPort & {
  readonly asked: (readonly string[])[];
} => {
  const asked: (readonly string[])[] = [];
  return {
    asked,
    execute: async arguments_ => {
      asked.push(arguments_);
      return await answer();
    },
  };
};

describe('TmuxReleaseReader', () => {
  it("should ask this daemon's own server for the release it runs", async () => {
    // Arrange
    const port = server(async () => ({ code: 0, stdout: '3.6a\n', stderr: '' }));

    // Act
    const actual = await new TmuxReleaseReader('/nonexistent/tmux', port).read();

    // Assert — an executable that cannot be run is an absent answer, never a guess.
    should(actual).deepEqual({ server: '3.6a' });
    should(port.asked).deepEqual([['display-message', '-p', '#{version}']]);
  });

  it('should read no server when none is running, and never start one to ask', async () => {
    // Arrange
    const port = server(async () => ({ code: 1, stdout: '', stderr: 'no server running on /x/tmux.sock\n' }));

    // Act / Assert
    should(await new TmuxReleaseReader('/nonexistent/tmux', port).read()).deepEqual({});
  });

  it('should give up on a server that does not answer in time', async () => {
    // Arrange
    const port = server(async () => await new Promise(() => undefined));

    // Act / Assert
    should(await new TmuxReleaseReader('/nonexistent/tmux', port, 20).read()).deepEqual({});
  });
});
