import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { boundedSpawn } from '../../../../daemon/adapters/tmux/bounded.ts';
import { forgetFerretIdentity } from '../../../../daemon/adapters/tmux/forget-ferret-identity.ts';
import { KernelTmuxProcess } from '../../../../daemon/adapters/tmux/kernel-tmux-process.ts';
import { hostSpawn, realAfter } from '../support/host-spawn.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';

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

  it('should stop asking after one wedged tmux client costs its bound, and say so once', async () => {
    // Arrange — a tmux program that never answers; each child is killed at the bound by the bounded spawn.
    const root = await mkdtemp(join(tmpdir(), 'ferretry-wedged-tmux-'));
    const wedged = join(root, 'tmux');
    await writeFile(wedged, '#!/bin/sh\nexec sleep 30\n');
    await chmod(wedged, 0o755);
    const tmux = new KernelTmuxProcess(boundedSpawn(hostSpawn, 300), join(root, 'tmux.sock'), wedged);
    let stalled = 0;

    try {
      // Act
      const cleared = await forgetFerretIdentity(tmux, {
        after: realAfter,
        timeoutMs: 100,
        stalled: () => {
          stalled += 1;
        },
      });

      // Assert
      should(cleared).deepEqual([]);
      should(stalled).equal(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should clear names a bounded, answering server confirmed without calling the stall hook', async () => {
    // Arrange
    const tmux = new RecordingTmux(async () => ({ code: 0, stdout: '', stderr: '' }));
    let stalled = 0;

    // Act
    const cleared = await forgetFerretIdentity(tmux, {
      after: realAfter,
      timeoutMs: 5000,
      stalled: () => {
        stalled += 1;
      },
    });

    // Assert
    should(cleared).have.length(3);
    should(stalled).equal(0);
  });
});
