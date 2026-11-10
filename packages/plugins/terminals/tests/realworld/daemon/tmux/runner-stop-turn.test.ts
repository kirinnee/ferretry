// Realworld: asserts how often a guarded keystroke beats a moving cursor on a real tmux; the outcome depends on how
// fast this machine's tmux answers against how often the pane redraws, not only on the code.
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunnerHandle, runnerDeliveryFailure } from '@ferretry/core-ferrets/contract';
import { testActRunner, TestMintedIds } from '@ferretry/kernel/testing';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess, hostSpawn } from '../../../integration/daemon/support/host-spawn.ts';
import { waitFor } from '../../../integration/daemon/support/wait-for.ts';

/**
 * R1's open question for harness-refusals (before Conversation's interrupt gate opens): `TmuxRunner.stopTurn` presses
 * the stop key through the guarded write, whose server-side guard compares the pane's `cursor_y` with the row read just
 * before. A pane that is WORKING — the exact pane a stop is pressed at — may move its cursor in that window, so the
 * guard could refuse the press (answered `not_ready`/`exited`, nothing pressed) far more often than today's unguarded
 * `sendKey(session, 'Escape')` ever failed.
 *
 * Each case presses at a real working pane ATTEMPTS times and holds two things: every answer is a press or the closed
 * nothing-pressed refusal (never an unclassified rejection), and at least MIN_PRESSES of them pressed. A failure of the
 * second is the measurement R1 asked for: the guard makes Stop unreliable on such a pane, and the gate must not open
 * until the lead rules on it (for example a re-read and ONE more guarded attempt after a refusal, which still presses
 * at most once).
 *
 * The pane runs one `bun` process that never forks, so its foreground program stays the same for the whole test (a
 * shell loop that runs `sleep` would flip `pane_current_command` and read as a replaced pane, which is not the
 * question).
 */
const TMUX = Bun.which('tmux');
const ATTEMPTS = 20;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real tmux server with one ferret pane running `program` (a `bun -e` script), and a runner bound to it. */
async function workingPane(rows: number, program: string): Promise<{ runner: TmuxRunner; handle: RunnerHandle }> {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-stop-'));
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  const created = await tmux.execute([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-s',
    'fy-stop-turn',
    '-x',
    '100',
    '-y',
    String(rows),
    `'${process.execPath}' -e '${program}'`,
  ]);
  const handle = created.stdout.trim() as RunnerHandle;
  should(handle).match(/^%\d+$/u);
  await waitFor(
    async () => (await tmux.execute(['capture-pane', '-p', '-t', handle])).stdout.includes('esc to interrupt'),
    'the pane to show a turn at work',
  );
  const runner = new TmuxRunner({
    tmux,
    spawn: hostSpawn,
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    delivery: {
      act: testActRunner({
        holds: () => ({ decide: () => 'allow' }),
        actor: () => 'ferret',
        minted: new TestMintedIds(),
        record: () => {},
      }),
      sleep: async ms => await Bun.sleep(ms),
    },
  });
  return { runner, handle };
}

/** Presses ATTEMPTS times at a working pane; answers how many pressed, after holding every answer to the contract. */
async function pressesAt(runner: TmuxRunner, handle: RunnerHandle): Promise<number> {
  let pressed = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await runner.stopTurn(handle, { key: 'Escape', whenIdle: false }).then(
      outcome => ({ outcome }),
      (error: unknown) => ({ failure: runnerDeliveryFailure(error) }),
    );
    if ('outcome' in answer) {
      // A working pane is pressed under shouldPressStopKey even when the key is not harmless at an idle prompt.
      should(answer.outcome.pressed).equal(true);
      pressed += 1;
    } else should(answer.failure).deepEqual({ kind: 'not_ready', why: 'exited' });
  }
  return pressed;
}

describe('harness-refusals: stopTurn at a real working pane, through the guarded write', () => {
  it.skipIf(TMUX === null)(
    'harness-refusals a pane whose output is still filling it (the cursor row climbs every 10 ms) is still pressed',
    async () => {
      // A tall pane early in a turn: every new line moves the cursor down one row until the screen is full.
      const { runner, handle } = await workingPane(
        1_000,
        'let i = 0; setInterval(() => process.stdout.write("step " + ++i + " - esc to interrupt\\n"), 10);',
      );

      should(await pressesAt(runner, handle)).be.aboveOrEqual(15);
    },
    60_000,
  );

  it.skipIf(TMUX === null)(
    'harness-refusals a full pane redrawing its status line in place every 10 ms is pressed every time',
    async () => {
      // The steady state of a long turn: the screen is full and the status line is rewritten on the same row.
      const { runner, handle } = await workingPane(
        12,
        'for (let n = 0; n < 30; n++) process.stdout.write("earlier output " + n + "\\n"); let i = 0; setInterval(() => process.stdout.write("\\r\\u001b[2KWorking (" + ++i + "s - esc to interrupt)"), 10);',
      );

      should(await pressesAt(runner, handle)).be.aboveOrEqual(18);
    },
    60_000,
  );
});
