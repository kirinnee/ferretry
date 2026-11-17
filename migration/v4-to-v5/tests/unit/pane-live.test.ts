// The real probe never throws and never reaches a tmux it was not pointed at: with no v4 socket it says "not live".
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxPaneLive } from '../../src/v4/pane-live.ts';

test('FX2 a v4 home with no tmux socket, or a file in its place, is not live', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fy-pane-'));
  try {
    const pane = { paneId: '%1', tmuxSession: 'fy-f1' };
    expect(await tmuxPaneLive(pane, home)).toBe(false);
    await writeFile(join(home, 'tmux.sock'), 'not a socket');
    expect(await tmuxPaneLive(pane, home)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
