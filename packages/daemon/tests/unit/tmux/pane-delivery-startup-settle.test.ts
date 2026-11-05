/**
 * Waiting out a harness's own startup after its first turn was delivered.
 *
 * The claims: a Codex still showing `Waiting for startup` is polled until the line clears; the wait is
 * bounded and a bound that passes is not a failure; a pane that dies meanwhile fails with the harness's own
 * reason; a pane that never parks (Claude, or a Codex that was not parked) is not waited on at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { PaneDeliveryError, TmuxPaneDelivery } from '../../../src/adapters/tmux/pane-delivery.ts';
import type { TmuxController } from '../../../src/lib/index.ts';

const FIXTURES = join(import.meta.dir, '../../fixtures/composer');
const fixture = (state: string): string => readFileSync(join(FIXTURES, `codex-0.166.0-${state}.txt`), 'utf8');
const PARKED = fixture('startup-queued-message');
const STARTED = fixture('started-idle');

interface PaneScript {
  readonly visible: string;
  readonly dead?: boolean;
  readonly history?: string;
  readonly exitCode?: number;
}

/** A pane that shows each scripted frame once, then the last one forever; every look is counted. */
function over(frames: readonly PaneScript[]): { readonly tmux: TmuxController; readonly looks: () => number } {
  let looked = 0;
  const tmux = {
    state: async () => {
      const frame = frames[Math.min(looked, frames.length - 1)] as PaneScript;
      looked += 1;
      return { alive: true, dead: false, promptReady: false, history: '', ...frame };
    },
    rows: async () => undefined,
  } as unknown as TmuxController;
  return { tmux, looks: () => looked };
}

function subject(
  tmux: TmuxController,
  options: { readonly pollMs: number; readonly startupSettleMs: number },
): { readonly delivery: TmuxPaneDelivery; readonly sleeps: number[] } {
  const sleeps: number[] = [];
  const delivery = new TmuxPaneDelivery(tmux, async ms => void sleeps.push(ms), options);
  return { delivery, sleeps };
}

describe('TmuxPaneDelivery.waitStartupSettled', () => {
  it('should not wait at all for a pane that is not parked', async () => {
    // Arrange
    const { tmux, looks } = over([{ visible: STARTED }]);
    const { delivery, sleeps } = subject(tmux, { pollMs: 250, startupSettleMs: 30_000 });

    // Act
    await delivery.waitStartupSettled('fy-s');

    // Assert
    should(looks()).equal(1);
    should(sleeps).deepEqual([]);
  });

  it('should poll every step while the park line is up and return as soon as it clears', async () => {
    // Arrange
    const { tmux, looks } = over([{ visible: PARKED }, { visible: PARKED }, { visible: STARTED }]);
    const { delivery, sleeps } = subject(tmux, { pollMs: 250, startupSettleMs: 30_000 });

    // Act
    await delivery.waitStartupSettled('fy-s');

    // Assert
    should(looks()).equal(3);
    should(sleeps).deepEqual([250, 250]);
  });

  it('should give up quietly once the bound passes, having looked once per step', async () => {
    // Arrange — parked forever.
    const { tmux, looks } = over([{ visible: PARKED }]);
    const { delivery, sleeps } = subject(tmux, { pollMs: 250, startupSettleMs: 1_000 });

    // Act
    await delivery.waitStartupSettled('fy-s');

    // Assert — a look at 0, 250, 500, 750 and 1000 ms, and a sleep between each.
    should(looks()).equal(5);
    should(sleeps).deepEqual([250, 250, 250, 250]);
  });

  it('should fail with the harness’s own reason when the pane dies while waiting', async () => {
    // Arrange
    const { tmux } = over([
      { visible: PARKED },
      {
        visible: 'Pane is dead',
        dead: true,
        exitCode: 1,
        history: 'Error: account/read failed during TUI bootstrap: workspace routing discovery timed out\n',
      },
    ]);
    const { delivery } = subject(tmux, { pollMs: 250, startupSettleMs: 30_000 });

    // Act
    const error = await delivery.waitStartupSettled('fy-s').then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Assert
    should(error).be.instanceOf(PaneDeliveryError);
    should((error as Error).message).equal(
      'the interactive harness exited (1): its last output was "Error: account/read failed during TUI bootstrap: workspace routing discovery timed out"; tmux session fy-s',
    );
  });
});
