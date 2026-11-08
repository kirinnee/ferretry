import { describe, expect, test } from 'bun:test';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { forgetFerretIdentity } from '../../../../daemon/adapters/tmux/forget-ferret-identity.ts';
import { tmuxReleaseDoctorCheck, tmuxReleaseSelftest } from '../../../../daemon/adapters/tmux/tmux-release-checks.ts';
import { TmuxReleaseReader } from '../../../../daemon/adapters/tmux/tmux-release-reader.ts';
import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';
import { judgeTmuxRelease } from '../../../../daemon/lib/tmux/version.ts';

/** A spawn port that records every program and argv and answers like tmux with no server on the socket. */
function tmuxSpawn(options: { readonly server?: string; readonly program?: string } = {}) {
  const calls: string[][] = [];
  const spawn = {
    run: async (program: string, args: readonly string[]) => {
      calls.push([program, ...args]);
      if (args.includes('display-message'))
        return options.server === undefined
          ? { exitCode: 1, signal: null, stdout: '', stderr: 'no server running on /x/tmux.sock' }
          : { exitCode: 0, signal: null, stdout: `${options.server}\n`, stderr: '' };
      return { exitCode: 1, signal: null, stdout: '', stderr: 'unexpected' };
    },
    start: (program: string, args: readonly string[]) => {
      calls.push([program, ...args]);
      const text = (value: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
          },
        });
      return {
        stdout: text(options.program === undefined ? '' : `${options.program}\n`),
        stderr: text(''),
        exited: Promise.resolve(options.program === undefined ? 127 : 0),
        kill: () => undefined,
      };
    },
  } as unknown as SpawnPort;
  return { spawn, calls };
}

const clock = { nowMs: () => 0, after: (_delay: unknown, _fn: () => void) => () => undefined };
const SERVER_STARTERS = ['new-session', 'start-server', 'attach-session', 'attach'];

describe('terminals #23 forget-ferret-identity (U1)', () => {
  test('#23 forget-ferret-identity clears FY_SESSION_TOKEN, the board capability and the id, and never fails boot', async () => {
    const asked: string[][] = [];
    const tmux: TmuxCommandPort = {
      execute: async arguments_ => {
        asked.push([...arguments_]);
        if (arguments_[3] === 'FY_SESSION_ID') throw new Error('tmux went away');
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const cleared = await forgetFerretIdentity(tmux);

    expect(cleared).toEqual(['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY']);
    expect(asked.map(command => command.slice(0, 3))).toEqual(Array(3).fill(['set-environment', '-g', '-u']));
  });

  test('#23 forget-ferret-identity with no server running clears nothing and asks only to unset names', async () => {
    const asked: string[][] = [];
    const tmux: TmuxCommandPort = {
      execute: async arguments_ => {
        asked.push([...arguments_]);
        return { code: 1, stdout: '', stderr: 'no server running' };
      },
    };

    expect(await forgetFerretIdentity(tmux)).toEqual([]);
    expect(asked.every(command => command[0] === 'set-environment')).toBe(true);
  });
});

describe('terminals #23 tmux release never starts a server (U1)', () => {
  test('#23 tmux release never starts a server: the doctor asks only -V and display-message', async () => {
    const { spawn, calls } = tmuxSpawn({ program: 'tmux 3.6a' });
    const reader = new TmuxReleaseReader(
      spawn,
      'tmux',
      {
        execute: async arguments_ => {
          const run = await spawn.run('tmux', ['-S', '/x', ...arguments_]);
          return { code: run.exitCode ?? 1, stdout: run.stdout, stderr: run.stderr };
        },
      },
      () => () => undefined,
    );

    const finding = await tmuxReleaseDoctorCheck(async () => await reader.read()).run();

    expect(finding.state).toBe('warn');
    expect(calls.flat().some(word => SERVER_STARTERS.includes(word))).toBe(false);
    expect(calls.map(call => call.includes('-V') || call.includes('display-message'))).toEqual([true, true]);
  });

  test('#23 tmux release never starts a server: the selftest with no server is a failed line and a read-only question', async () => {
    const { spawn, calls } = tmuxSpawn({ program: 'tmux 3.8' });

    const result = await tmuxReleaseSelftest
      .run({
        tempDir: '/t',
        signal: new AbortController().signal,
        clock: clock as never,
        spawn,
        stateDir: '/h/state/terminals',
      })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('no tmux server is running');
    expect(calls.flat().some(word => SERVER_STARTERS.includes(word))).toBe(false);
    const sockets = calls.filter(call => call.includes('-S')).map(call => call[call.indexOf('-S') + 1]);
    expect(sockets).toEqual(['/h/state/terminals/tmux.sock']);
  });

  test('#23 tmux release: the selftest reports both releases when the daemon server answers', async () => {
    const { spawn } = tmuxSpawn({ program: 'tmux 3.8', server: '3.8' });

    const text = await tmuxReleaseSelftest.run({
      tempDir: '/t',
      signal: new AbortController().signal,
      clock: clock as never,
      spawn,
      stateDir: '/h/state/terminals',
    });

    expect(text).toBe('tmux 3.8, server current');
  });

  test('J-0198 the release reader gives up on a wedged tmux at its timeout and answers nothing', async () => {
    let fire: (() => void) | undefined;
    const wedged: TmuxCommandPort = { execute: () => new Promise(() => undefined) };
    const spawn = {
      start: () => ({
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: new Promise<number>(() => undefined),
        kill: () => undefined,
      }),
    } as unknown as SpawnPort;
    const reader = new TmuxReleaseReader(
      spawn,
      'tmux',
      wedged,
      (_ms, fn) => {
        fire = fn;
        setTimeout(fn, 0);
        return () => undefined;
      },
      50,
    );

    expect(await reader.read()).toEqual({});
    expect(fire).toBeDefined();
  });

  test('#23 tmux release is judged from names only: crash release warns, absent program fails, absent server is fine', () => {
    expect(judgeTmuxRelease({ program: 'tmux 3.6a' }).state).toBe('warn');
    expect(judgeTmuxRelease({}).state).toBe('fail');
    expect(judgeTmuxRelease({ program: 'tmux 3.7', server: '3.7' }).state).toBe('ok');
    expect(judgeTmuxRelease({ program: 'tmux 3.7' }).detail).toContain('no server running');
  });
});
