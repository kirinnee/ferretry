import { describe, expect, test } from 'bun:test';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { forgetFerretIdentity } from '../../../../daemon/adapters/tmux/forget-ferret-identity.ts';
import {
  releaseReader,
  tmuxReleaseDoctor,
  tmuxReleaseFinding,
  tmuxReleaseSelftest,
  tmuxSocketIn,
} from '../../../../daemon/adapters/tmux/tmux-release-checks.ts';
import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';
import { renderTmuxReleaseRow, type TmuxReleaseReading, tmuxReleaseRow } from '../../../../daemon/lib/tmux/version.ts';
import { stateSocketPath } from '../../../../daemon/index.ts';

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

/** Today's two sentences (`R/packages/daemon/src/lib/core/doctor.ts` `TMUX_CRASH`, `TMUX_MOVE`), typed out here byte for byte. */
const CRASH =
  'tmux before 3.7 can crash its whole server — ending every session at once — when a session ends while Ferretry is watching it. Ferretry works around it, but only a newer tmux removes it.';
const MOVE =
  'Do not kill the tmux server to switch: the new release is used the next time the server starts — once the last session has ended, or the machine restarts.';

describe('terminals #23 tmux release never starts a server (U1)', () => {
  test('#23 tmux release never starts a server: the doctor asks only -V and display-message', async () => {
    const { spawn, calls } = tmuxSpawn({ program: 'tmux 3.6a' });
    const reader = releaseReader(spawn, '/x/tmux.sock', () => () => undefined);

    const finding = await tmuxReleaseDoctor(async () => await reader.read())();

    expect(finding?.state).toBe('warn');
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

  test("#23 tmux release: the selftest prints today's row when the daemon server answers", async () => {
    const run = async (program: string, server: string) =>
      await tmuxReleaseSelftest.run({
        tempDir: '/t',
        signal: new AbortController().signal,
        clock: clock as never,
        spawn: tmuxSpawn({ program, server }).spawn,
        stateDir: '/h/state/terminals',
      });

    expect(await run('tmux 3.8', '3.8')).toBe('installed 3.8, running server 3.8');
    expect(await run('tmux 3.7b', '3.6a')).toBe(
      `installed 3.7b, running server 3.6a — the server still runs the old release — ${CRASH} 3.7b is installed already. ${MOVE}`,
    );
  });

  test('#23 tmux release: the selftest may run tmux and nothing else', () => {
    expect(tmuxReleaseSelftest.host).toBe(true);
    expect(tmuxReleaseSelftest.programs).toEqual(['tmux']);
  });

  test('J-0198 the release reader gives up on a wedged tmux at its timeout, kills the -V child and bounds the server child', async () => {
    const timers: number[] = [];
    const killed: (string | undefined)[] = [];
    const runs: { args: readonly string[]; timeout: unknown }[] = [];
    const starts: { args: readonly string[]; timeout: unknown }[] = [];
    const spawn = {
      // The server question never answers: only the kernel's timeout ends that child.
      run: (_program: string, args: readonly string[], options?: { timeout?: unknown }) => {
        runs.push({ args, timeout: options?.timeout });
        return new Promise(() => undefined);
      },
      start: (_program: string, args: readonly string[], options?: { timeout?: unknown }) => {
        starts.push({ args, timeout: options?.timeout });
        return {
          stdout: new ReadableStream<Uint8Array>(),
          stderr: new ReadableStream<Uint8Array>(),
          exited: new Promise<number>(() => undefined),
          kill: (signal?: string) => killed.push(signal),
        };
      },
    } as unknown as SpawnPort;
    const pending: (() => void)[] = [];
    const reader = releaseReader(
      spawn,
      '/h/state/terminals/tmux.sock',
      (ms, fn) => {
        timers.push(ms);
        pending.push(fn);
        return () => undefined;
      },
      50,
    );

    const reading = reader.read();
    await Bun.sleep(0);
    for (const fire of pending) fire();

    expect(await reading).toEqual({});
    // Each question waited exactly the bound it was given…
    expect(timers).toEqual([50, 50]);
    // …the `-V` child was killed outright, and the server child carries the kernel's kill-at timeout.
    expect(killed).toEqual(['SIGKILL']);
    expect(starts.map(start => [start.args, Number(start.timeout)])).toEqual([[['-V'], 50]]);
    expect(runs.map(run => Number(run.timeout))).toEqual([50]);
    expect(runs[0]?.args).toContain('display-message');
  });
});

describe("terminals #23 tmux release row: today's doctor words (U1)", () => {
  const row = (reading: TmuxReleaseReading | undefined) => tmuxReleaseRow(reading);

  test('#23 tmux release row is left out when tmux could not be asked', () => {
    expect(row(undefined)).toBeUndefined();
    expect(row({})).toBeUndefined();
    expect(row({ program: 'not a version' })).toBeUndefined();
  });

  test("#23 tmux release row passes 3.7 or newer on both, with today's words", () => {
    expect(row({ program: 'tmux 3.8', server: '3.7b' })).toEqual({
      status: 'present',
      summary: 'installed 3.8, running server 3.7b',
      impact: 'tmux 3.7 or newer: no known whole-server crash.',
    });
  });

  test('#23 tmux release row on 3.6a says 3.7 or newer is needed, byte for byte', () => {
    expect(row({ program: 'tmux 3.6a', server: '3.6a' })).toEqual({
      status: 'missing',
      summary: 'installed 3.6a, running server 3.6a — 3.7 or newer is needed',
      impact: `${CRASH} Install tmux 3.7 or newer. ${MOVE}`,
    });
  });

  test('#23 tmux release row after an upgrade says the server still runs the old release, byte for byte', () => {
    expect(row({ program: 'tmux 3.7b', server: '3.6a' })).toEqual({
      status: 'missing',
      summary: 'installed 3.7b, running server 3.6a — the server still runs the old release',
      impact: `${CRASH} 3.7b is installed already. ${MOVE}`,
    });
  });

  test('#23 tmux release row judges the installed program alone when no server runs, and the server alone with no program', () => {
    expect(row({ program: 'tmux 3.6a' })?.summary).toBe('installed 3.6a — 3.7 or newer is needed');
    expect(row({ program: 'tmux 3.8' })?.status).toBe('present');
    expect(row({ server: '3.6a' })).toEqual({
      status: 'missing',
      summary: 'running server 3.6a — the server still runs the old release',
      impact: `${CRASH} ${MOVE}`,
    });
    // A server on another release than the installed one is fine when neither crashes, as today.
    expect(row({ program: 'tmux 3.8', server: '3.7' })?.status).toBe('present');
  });

  test('#23 tmux release row maps to a capability finding: present is ok, missing a warn, never a fail', () => {
    const missing = row({ program: 'tmux 3.6a' });
    const present = row({ program: 'tmux 3.9' });
    if (missing === undefined || present === undefined) throw new Error('both rows are judged');

    expect(tmuxReleaseFinding(missing)).toEqual({
      state: 'warn',
      detail: 'installed 3.6a — 3.7 or newer is needed',
      fix: `${CRASH} Install tmux 3.7 or newer. ${MOVE}`,
    });
    expect(tmuxReleaseFinding(present)).toEqual({
      state: 'ok',
      detail: 'installed 3.9',
      fix: 'tmux 3.7 or newer: no known whole-server crash.',
    });
    expect(renderTmuxReleaseRow(present)).toBe('installed 3.9');
    expect(renderTmuxReleaseRow(missing)).toBe(
      `installed 3.6a — 3.7 or newer is needed — ${CRASH} Install tmux 3.7 or newer. ${MOVE}`,
    );
  });

  test('#23 tmux release doctor reports no row when neither answer came back', async () => {
    expect(await tmuxReleaseDoctor(async () => ({}))()).toBeUndefined();
  });
});

describe('terminals tmux socket has one owner (U1)', () => {
  test("the daemon's socket and the selftest's are the same tmuxSocketIn(<state folder>)", () => {
    const stateDir = '/home/owner/.ferretry/state/terminals';
    // The kernel keeps every internal root in the plugin's state folder (`pluginStateFolder`): `<state>/downloads`.
    const kernel = {
      roots: { root: () => ({ resolve: () => ({ ok: true, value: `${stateDir}/downloads` }) }) },
    } as unknown as Parameters<typeof stateSocketPath>[0];

    expect(stateSocketPath(kernel)).toBe(`${stateDir}/tmux.sock`);
    expect(tmuxSocketIn(stateDir)).toBe(stateSocketPath(kernel));
    expect(tmuxSocketIn(`${stateDir}/`)).toBe(`${stateDir}/tmux.sock`);
  });
});
