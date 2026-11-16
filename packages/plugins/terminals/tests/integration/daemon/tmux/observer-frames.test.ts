/**
 * The pane half of the session observer's parity scenarios, against a real tmux pane (CI only).
 *
 * Moved from `packages/core/ferrets/tests/integration/daemon/session/observer/parity.test.ts`
 * ("should journal and record the same Claude turn: idle, working, permission, ended" and "…the same Codex turn and
 * its observed runtime"): what those scenarios ask of Terminals is that a real pane, redrawn with each harness's
 * frames, is READ as idle, working or waiting on a permission prompt. Whether the observer journals the same turn on
 * both paths from those readings is Ferrets' to test, with its own scripted pane there.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { TmuxController } from '../../../../daemon/lib/tmux/controller.ts';
import { paneShowsActiveWork, paneShowsPermissionPrompt } from '../../../../daemon/lib/tmux/pane.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

const CLAUDE_IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CLAUDE_PERMISSION = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently';
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The last non-blank rows of a frame or a capture, to tell whether the pane has drawn it. */
const lastRows = (text: string, count = 3): readonly string[] =>
  text
    .split('\n')
    .map(row => row.trimEnd())
    .filter(row => row !== '')
    .slice(-count);

/** A pane that redraws whatever the frame file holds, read through the real controller. */
async function framePane(initial: string) {
  const tmux = Bun.which('tmux');
  if (tmux === null) throw new Error('tmux is required for pane coverage');
  const root = await mkdtemp(join(tmpdir(), 'fy-observer-frames-'));
  const frameFile = join(root, 'frame.txt');
  await writeFile(frameFile, initial);
  const player = join(root, 'player.sh');
  await writeFile(
    player,
    [
      '#!/bin/sh',
      'last=""',
      'while :; do',
      `  now="$(cat '${frameFile}')"`,
      '  if [ "$now" != "$last" ]; then printf \'\\033[H\\033[2J%s\\n\\033[1A\' "$now"; last="$now"; fi',
      '  sleep 0.05',
      'done',
    ].join('\n'),
  );
  await chmod(player, 0o755);
  const socket = join(root, 'tmux.sock');
  const controller = new TmuxController(new BunTmuxProcess(tmux, socket));
  const session = 'fy-observer-frames';
  await controller.launch({ session, cwd: root, command: ['/bin/sh', player], width: 100, height: 40 });
  cleanups.push(async () => {
    await Bun.spawn([tmux, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
    await rm(root, { recursive: true, force: true });
  });
  /** Draws `text` and waits until the pane shows its last rows, then answers the pane's state. */
  const show = async (text: string) => {
    await writeFile(frameFile, text);
    const wanted = lastRows(text);
    await waitFor(async () => {
      const screen = await controller.visible(session);
      const shown = screen === undefined ? undefined : lastRows(screen);
      return shown?.length === wanted.length && shown.every((row, index) => row === wanted[index]);
    }, 'the pane to draw the frame');
    return await controller.state(session, { history: false });
  };
  return { show, controller, session };
}

describe('a real pane drawing Claude frames, read as a turn', () => {
  it('should read idle, working and a permission prompt from the frames the harness draws', async () => {
    // Arrange
    const { show } = await framePane(CLAUDE_IDLE);

    // Act
    const idle = await show(CLAUDE_IDLE);
    const working = await show(CLAUDE_WORKING);
    const permission = await show(CLAUDE_PERMISSION);

    // Assert
    should([idle.alive, idle.promptReady, paneShowsActiveWork(idle.visible)]).deepEqual([true, true, false]);
    should([working.promptReady, paneShowsActiveWork(working.visible)]).deepEqual([false, true]);
    should([paneShowsPermissionPrompt(permission.visible), paneShowsActiveWork(permission.visible)]).deepEqual([
      true,
      false,
    ]);
  });

  it('should answer the same activity stamp while nothing draws, and a stamp no older once it does', async () => {
    // Arrange
    const { show, controller, session } = await framePane(CLAUDE_IDLE);
    await show(CLAUDE_IDLE);

    // Act
    const before = await controller.activity(session);
    const after = await controller.activity(session);
    await show(CLAUDE_WORKING);
    const drawn = await controller.activity(session);

    // Assert
    should(after).deepEqual(before);
    should(drawn?.dead).be.false();
    should(drawn?.activityAt).be.aboveOrEqual(before?.activityAt ?? 0);
  });
});

describe('a real pane drawing Codex frames, read as a turn', () => {
  it('should read idle and working from the frames the harness draws', async () => {
    // Arrange
    const { show } = await framePane(CODEX_IDLE);

    // Act
    const idle = await show(CODEX_IDLE);
    const working = await show(CODEX_WORKING);

    // Assert
    should([idle.promptReady, paneShowsActiveWork(idle.visible)]).deepEqual([true, false]);
    should([working.promptReady, paneShowsActiveWork(working.visible)]).deepEqual([false, true]);
  });
});
