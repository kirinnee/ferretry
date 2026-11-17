/**
 * `TmuxRunner.stop`: an error is not proof. A stop that cannot tell whether its session is there, or whose interrupt or
 * kill tmux refused, is THROWN, so FerretsService never settles a possibly live ferret `stopped`. Only an ANSWER that the
 * session is not there (`can't find session`, `no current target`, no server) is a stop already made.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretId, RunnerHandle } from '@ferretry/core-ferrets/contract';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';

const STALE_OWNER = 'mw7bp88g-50e00159' as FerretId;
const LIVE_OWNER = 'mw7bp99h-61f11260' as FerretId;
const PANE = '%5' as RunnerHandle;

interface Reply {
  readonly code: number;
  readonly stderr: string;
}

type Script = Partial<Record<'has-session' | 'send-keys' | 'kill-session', Reply | 'throw'>>;

/** The pane `%5` is `LIVE_OWNER`'s and alive; every command answers OK unless the script says otherwise. */
function runner(script: Script) {
  const calls: (readonly string[])[] = [];
  const subject = new TmuxRunner({
    tmux: {
      execute: async args => {
        calls.push(args);
        if (args[0] === 'display-message') return { code: 0, stdout: `%5|4242|0|fy-${LIVE_OWNER}|1\n`, stderr: '' };
        if (args[0] === 'list-panes') return { code: 0, stdout: '0\n', stderr: '' };
        const scripted = script[args[0] as keyof Script];
        if (scripted === 'throw') throw new Error('spawn failed');
        return { code: scripted?.code ?? 0, stdout: '', stderr: scripted?.stderr ?? '' };
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

describe('TmuxRunner.stop by name (a handle that is another ferret’s)', () => {
  test('a has-session that THROWS or fails any other way is thrown, and nothing is pressed or killed', async () => {
    for (const has of [
      'throw',
      { code: 1, stderr: 'server exited unexpectedly' },
      { code: 1, stderr: 'error connecting to /s (Permission denied)' },
      { code: 1, stderr: '' },
    ] as const) {
      for (const how of ['polite', 'now'] as const) {
        const { subject, writes } = runner({ 'has-session': has });
        await expect(subject.stop(PANE, how, STALE_OWNER)).rejects.toThrow(
          /so it was not stopped; it may still be running/u,
        );
        expect(writes()).toEqual([]);
      }
    }
  });

  test('a has-session that ANSWERS the session is not there is the stop already made', async () => {
    for (const stderr of [
      "can't find session: fy-x",
      'no current target',
      'no server running on /fixture/tmux.sock',
      'error connecting to /s (No such file or directory)',
    ]) {
      for (const how of ['polite', 'now'] as const) {
        const { subject, writes } = runner({ 'has-session': { code: 1, stderr } });
        await subject.stop(PANE, how, STALE_OWNER);
        expect(writes()).toEqual([]);
      }
    }
  });
});

describe('TmuxRunner.stop on a handle the ferret owns', () => {
  test('a polite stop whose interrupt tmux refuses is thrown', async () => {
    const { subject } = runner({ 'send-keys': { code: 1, stderr: "can't find pane: %5" } });
    await expect(subject.stop(PANE, 'polite', LIVE_OWNER)).rejects.toThrow(/could not interrupt fy-.*can't find pane/u);
  });

  test('a stop now whose kill tmux refuses is thrown, with a plain reason when tmux gave none', async () => {
    await expect(
      runner({ 'kill-session': { code: 1, stderr: 'operation not permitted' } }).subject.stop(PANE, 'now', LIVE_OWNER),
    ).rejects.toThrow(/could not stop fy-.*operation not permitted/u);
    await expect(
      runner({ 'kill-session': { code: 1, stderr: '' } }).subject.stop(PANE, 'now', LIVE_OWNER),
    ).rejects.toThrow(/tmux exited 1/u);
  });

  test('a session that went away between the read and the kill is the stop already made', async () => {
    for (const stderr of ["can't find session: fy-x", 'no server running on /fixture/tmux.sock']) {
      const { subject } = runner({ 'kill-session': { code: 1, stderr } });
      await subject.stop(PANE, 'now', LIVE_OWNER);
    }
  });

  test('a stop that works still stops', async () => {
    const polite = runner({});
    await polite.subject.stop(PANE, 'polite', LIVE_OWNER);
    expect(polite.writes().map(args => args[0])).toEqual(['send-keys']);
    const now = runner({});
    await now.subject.stop(PANE, 'now', LIVE_OWNER);
    expect(now.writes().map(args => args[0])).toEqual(['kill-session']);
  });
});
