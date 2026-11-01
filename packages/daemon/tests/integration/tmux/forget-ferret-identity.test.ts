import { describe, it } from 'bun:test';
import should from 'should';
import { forgetFerretIdentity } from '../../../src/adapters/tmux/forget-ferret-identity.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

/**
 * A daemon started inside a ferret's pane, or a tmux server an earlier such daemon started, must hand no child
 * that ferret's credential (docs/agent-tools.md § "A child never inherits it").
 */
class RecordingTmux implements TmuxCommandPort {
  readonly commands: string[][] = [];
  constructor(private readonly answer: (command: readonly string[]) => Promise<TmuxCommandResult>) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.commands.push([...arguments_]);
    return await this.answer(arguments_);
  }
}

describe("a daemon's tmux server's global environment", () => {
  it('should unset each one from the tmux server’s global environment', async () => {
    // Arrange
    const tmux = new RecordingTmux(async () => ({ code: 0, stdout: '', stderr: '' }));

    // Act
    const cleared = await forgetFerretIdentity(tmux);

    // Assert
    should(tmux.commands).deepEqual([
      ['set-environment', '-g', '-u', 'FY_SESSION_TOKEN'],
      ['set-environment', '-g', '-u', 'FY_SESSION_BOARD_CAPABILITY'],
      ['set-environment', '-g', '-u', 'FY_SESSION_ID'],
    ]);
    should(cleared).deepEqual(['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY', 'FY_SESSION_ID']);
  });

  it('should never fail a boot when no server is running or tmux cannot be run', async () => {
    // Arrange
    const none = new RecordingTmux(async () => ({ code: 1, stdout: '', stderr: 'no server running' }));
    const broken = new RecordingTmux(async () => {
      throw new Error('tmux is not installed');
    });

    // Act / Assert
    should(await forgetFerretIdentity(none)).deepEqual([]);
    should(await forgetFerretIdentity(broken)).deepEqual([]);
  });
});
