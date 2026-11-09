/**
 * A ferret's own pane through tmux, run for real over a real child process: the `tmux` on the child's PATH is a stand-in
 * shell script in a temp folder that records the arguments it was started with, so nothing here touches a real tmux
 * server. What is checked is the command the pane adapter builds and what it makes of the answer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '@ferretry/kernel/host';
import { PaneDirectory, TmuxPane } from '../../daemon/adapters/tmux-pane.ts';

const STAND_IN = `#!/bin/sh
printf '%s\\n' "$@" > "$STAND_IN_LOG"
if [ -n "$STAND_IN_STDERR" ]; then printf '%s\\n' "$STAND_IN_STDERR" >&2; fi
if [ -n "$STAND_IN_EXIT" ]; then exit "$STAND_IN_EXIT"; fi
if [ "$1" = "capture-pane" ]; then printf 'the pane as drawn\\n'; fi
`;

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'fy-tmux-pane-'));
  await writeFile(join(folder, 'tmux'), STAND_IN);
  await chmod(join(folder, 'tmux'), 0o755);
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const paneWith = (extra: Record<string, string> = {}): { pane: TmuxPane; directory: PaneDirectory } => {
  const directory = new PaneDirectory();
  directory.remember('ferret-one', '%12');
  const spawn = bunSpawn({
    PATH: `${folder}:/usr/bin:/bin`,
    STAND_IN_LOG: join(folder, 'args.txt'),
    ...extra,
  });
  return { pane: new TmuxPane(spawn, directory), directory };
};

const argsSeen = async (): Promise<readonly string[]> =>
  (await readFile(join(folder, 'args.txt'), 'utf8')).replace(/\n$/u, '').split('\n');

describe('PaneDirectory', () => {
  it('names the pane a ferret was last handed, and refuses with a sentence for a ferret it never saw', () => {
    const directory = new PaneDirectory();

    expect(() => directory.require('ferret-two')).toThrow(
      'this daemon does not know which pane ferret ferret-two is in, so nothing was read or sent',
    );

    directory.remember('ferret-two', '%3');
    expect(directory.require('ferret-two')).toBe('%3');

    directory.remember('ferret-two', '%4');
    expect(directory.require('ferret-two')).toBe('%4');

    directory.forget('ferret-two');
    expect(() => directory.require('ferret-two')).toThrow('ferret ferret-two');
  });
});

describe('TmuxPane', () => {
  it('reads the pane by its exact id and returns what tmux printed', async () => {
    const { pane } = paneWith();

    expect(await pane.capture('ferret-one')).toBe('the pane as drawn\n');
    expect(await argsSeen()).toEqual(['capture-pane', '-p', '-t', '%12']);
  });

  it('says what tmux complained about when the pane cannot be read', async () => {
    const { pane } = paneWith({ STAND_IN_EXIT: '1', STAND_IN_STDERR: "can't find pane: %12" });

    await expect(pane.capture('ferret-one')).rejects.toThrow(
      "ferret ferret-one's pane could not be read: can't find pane: %12",
    );
  });

  it('names the exit code when tmux fails without a word', async () => {
    const { pane } = paneWith({ STAND_IN_EXIT: '3' });

    await expect(pane.capture('ferret-one')).rejects.toThrow(
      "ferret ferret-one's pane could not be read: tmux exited 3",
    );
  });

  it('refuses to read a pane it was never told about, without starting tmux', async () => {
    const { pane } = paneWith();

    await expect(pane.capture('ferret-unknown')).rejects.toThrow('does not know which pane ferret ferret-unknown');
    await expect(readFile(join(folder, 'args.txt'), 'utf8')).rejects.toThrow();
  });

  it('types the bytes literally into the pane by its exact id and reports how many it sent', async () => {
    const { pane } = paneWith();
    const bytes = new TextEncoder().encode('1\n');

    expect(await pane.write('ferret-one', bytes)).toBe(2);
    expect(await argsSeen()).toEqual(['send-keys', '-t', '%12', '-l', '--', '1', '']);
  });

  it('says what tmux complained about when the pane cannot be typed into', async () => {
    const { pane } = paneWith({ STAND_IN_EXIT: '1', STAND_IN_STDERR: 'no server running' });

    await expect(pane.write('ferret-one', new TextEncoder().encode('y'))).rejects.toThrow(
      "ferret ferret-one's pane could not be typed into: no server running",
    );
  });

  it('names the exit code when tmux fails to type without a word', async () => {
    const { pane } = paneWith({ STAND_IN_EXIT: '2' });

    await expect(pane.write('ferret-one', new TextEncoder().encode('y'))).rejects.toThrow(
      "ferret ferret-one's pane could not be typed into: tmux exited 2",
    );
  });

  it('refuses to type into a pane it was never told about', async () => {
    const { pane, directory } = paneWith();
    directory.forget('ferret-one');

    await expect(pane.write('ferret-one', new TextEncoder().encode('y'))).rejects.toThrow(
      'does not know which pane ferret ferret-one',
    );
  });
});
