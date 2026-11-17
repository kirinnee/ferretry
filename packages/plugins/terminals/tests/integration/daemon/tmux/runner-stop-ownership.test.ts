/**
 * `TmuxRunner.stop` / `signal` with a stale pane id. A pane id is not an identity: the private tmux server hands `%0`
 * out again after it restarts, so a handle a record kept (a converted v4 ferret's, one from before a restart) can name
 * ANOTHER ferret's pane. A stop through it used to end that ferret's session; with the ferret named it ends only its own.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const STALE_OWNER = 'mw7bp88g-50e00159' as FerretId;
const LIVE_OWNER = 'mw7bp99h-61f11260' as FerretId;
/** The pane `%5` is now the second ferret's, and alive. */
const PANE = '%5' as RunnerHandle;

function runner() {
  const calls: (readonly string[])[] = [];
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        if (args[0] === 'display-message') {
          return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1700000000\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    spawn: {
      run: async () => {
        throw new Error('stop must not spawn');
      },
      runBytes: () => Promise.reject(new Error('stop must not spawn')),
      start: () => {
        throw new Error('stop must not spawn');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => '2026-11-08T10:00:00.000Z' as never,
    now: () => '2026-11-08T10:00:00.000Z' as never,
  });
  const writes = () => calls.filter(args => args[0] === 'kill-session' || args[0] === 'send-keys');
  return { subject, writes };
}

describe('TmuxRunner stop and signal through a stale pane id', () => {
  test('a stop that names a ferret kills nothing when the pane behind the handle is another ferret', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test('a polite stop does not press Ctrl-C at another ferret either', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'polite', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test('a signal that names a ferret does nothing to another ferret', async () => {
    const { subject, writes } = runner();

    await subject.signal(PANE, 'terminate', STALE_OWNER);
    await subject.signal(PANE, 'interrupt', STALE_OWNER);

    expect(writes()).toEqual([]);
  });

  test("a stop that names the pane's own ferret still ends it", async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now', LIVE_OWNER);

    expect(writes().map(args => args[0])).toEqual(['kill-session']);
  });

  test('a stop that names no ferret trusts the handle, as a launch cleaning up its own pane does', async () => {
    const { subject, writes } = runner();

    await subject.stop(PANE, 'now');

    expect(writes().map(args => args[0])).toEqual(['kill-session']);
  });
});
