import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';

import { DEV_CHANNELS_ON_SCREEN } from '../../../../daemon/lib/tmux/startup.ts';
import { GUARD_REFUSED, guardedWriteArguments } from '../../../../daemon/lib/tmux/write-guard.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * `WriteGuard.onScreen` against a REAL tmux: the `#{C:...}` search runs in the write itself, so a key is enqueued only
 * while the dialog is on the pane's screen at that instant, and a redraw that took it away (same pane, same program,
 * same cursor row) makes the write answer refused and type nothing.
 */

const SESSION = 'fy-webterm-Hadi-0a1b2c3d-screen1';
const PANE = `${SESSION}:0.0`;
const MARK = String.raw`\342\235\257`;
const TITLE = String.raw`WARNING: Loading development channels\n\n`;
/** The dialog with the selection on row 1, then (after one Enter) redrawn in place with it on row 2. */
const DRAWN = String.raw`${TITLE} ${MARK} 1. I am using this for local development\n   2. Exit\n`;
const REDRAWN = String.raw`${TITLE}   1. I am using this for local development\n ${MARK} 2. Exit\n`;

async function fixture() {
  const executable = Bun.which('tmux');
  if (executable === null) throw new Error('tmux is required for write guard coverage');
  const home = await mkdtemp(join(tmpdir(), 'fy-screen-guard-'));
  const sink = join(home, 'typed.txt');
  const tmux = new BunTmuxProcess(executable, join(home, 'tmux.sock'));
  const script = `printf '${DRAWN}'; read line; printf '\\033[H\\033[2J'; printf '${REDRAWN}'; stty -echo; exec cat > '${sink}'`;
  const started = await tmux.execute([
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '80',
    '-y',
    '24',
    '-c',
    home,
    `sh -c "${script}"`,
  ]);
  if (started.code !== 0) throw new Error(`could not start the pane: ${started.stderr}`);
  const screen = async (): Promise<string> => (await tmux.execute(['capture-pane', '-p', '-t', PANE])).stdout;
  await waitFor(async () => (await screen()).includes('❯ 1. I am'), 'the dialog to be drawn');
  /** One write through the guard, built from the pane's facts as they are right now. */
  const press = async (key: string, onScreen: readonly string[]): Promise<string> => {
    const read = await tmux.execute([
      'display-message',
      '-p',
      '-t',
      PANE,
      '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{cursor_y}',
    ]);
    const [paneId = '', pid = '', command = '', cursorRow = ''] = read.stdout.trim().split('|');
    const args = guardedWriteArguments(
      paneId,
      { panePid: Number(pid), command, cursorRow: Number(cursorRow), onScreen },
      `send-keys -t ${paneId} ${key}`,
    );
    if (args === undefined) throw new Error('the guard refused to build');
    return (await tmux.execute(args)).stdout;
  };
  const typed = async (): Promise<string> => await readFile(sink, 'utf8').catch(() => '');
  const done = async () => {
    await tmux.execute(['kill-server']).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  };
  return { screen, press, typed, done };
}

describe('the write guard’s on-screen check against the real tmux', () => {
  it('should enqueue the key while the dialog is on screen, and nothing once a redraw took it away', async () => {
    const { screen, press, typed, done } = await fixture();
    try {
      should(await press('Enter', DEV_CHANNELS_ON_SCREEN)).not.containEql(GUARD_REFUSED);
      await waitFor(async () => (await screen()).includes('❯ 2. Exit'), 'the dialog to be redrawn with Exit selected');

      should(await press('-l X', DEV_CHANNELS_ON_SCREEN)).containEql(GUARD_REFUSED);
      // The honest write after it is the barrier: whatever the refused one had queued would be in front of it.
      should(await press('-l Y', [])).not.containEql(GUARD_REFUSED);
      should(await press('Enter', [])).not.containEql(GUARD_REFUSED);
      await waitFor(async () => (await typed()) !== '', 'the barrier to arrive');
      should(await typed()).equal('Y\n');
    } finally {
      await done();
    }
  });
});
