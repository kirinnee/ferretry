import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunSpec } from '@ferretry/core-ferrets/contract';
import type { HostFactsPort, SpawnOptions, SpawnResult } from '@ferretry/kernel/contract';
import { FERRET, ScriptedTmux, terminalsHalf } from '../../../support/daemon/half.ts';

/**
 * U1 AS MOUNTED: the guard `daemon/index.ts` composes from `kernel.hostFacts.launchGuard()`, the boot identity scrub
 * and the `tmux-release` doctor row, each through the whole half on the kernel's test host — not a runner or a
 * reader the test built itself.
 */

const SOCKET = '/state/terminals/tmux.sock';
const STORE_HASH = 'r331x6dfyzn5k8mj74p16gqm3ba1aw4n';

let root = '';
/** A bin folder holding a REAL-looking claude: a file inside a nix-store-shaped claude-code package. */
let realBin = '';
/** A bin folder holding a fake claude, as a test suite writes one. */
let fakeBin = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-u1-mount-'));
  realBin = join(root, 'nix', 'store', `${STORE_HASH}-claude-code-2.1.281`, 'bin');
  fakeBin = join(root, 'fake', 'bin');
  for (const bin of [realBin, fakeBin]) {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'claude'), 0o755);
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const guardFacts = (active: boolean, searchPath?: string): HostFactsPort =>
  ({
    launchGuard: () => (searchPath === undefined ? { active } : { active, searchPath }),
  }) as unknown as HostFactsPort;

interface Spawned {
  readonly program: string;
  readonly args: readonly string[];
  readonly options?: SpawnOptions;
}

/** The kernel's spawn port: tmux answers as a fresh server would; every other program (the limits probes) fails. */
function recordingSpawn(
  answer: (args: readonly string[], script: string) => Partial<SpawnResult> | undefined = () => undefined,
) {
  const calls: Spawned[] = [];
  const spawn = (program: string, args: readonly string[], options?: SpawnOptions): SpawnResult => {
    calls.push({ program, args, ...(options === undefined ? {} : { options }) });
    const base: SpawnResult = { exitCode: 1, signal: null, stdout: '', stderr: 'not in this test' };
    if (program !== 'tmux') return base;
    const script = scriptOf(options);
    if (script.includes('new-session')) return { ...base, exitCode: 0, stdout: '%7|4242', stderr: '' };
    return { ...base, exitCode: 0, stderr: '', ...answer(args, script) };
  };
  return { calls, spawn };
}

/** A tmux server with no `fy-` session yet, so a launch goes on to create one. */
const freshServer = () => new ScriptedTmux(args => (args[0] === 'has-session' ? { code: 1 } : {}));

const spec = (names: readonly string[] = []): RunSpec =>
  ({ ferret: FERRET, command: ['claude-default'], cwd: '/work/hadi', env: { names } }) as unknown as RunSpec;

/** What a tmux client was handed on stdin: a payload command goes as a `source-file -` script (`lib/tmux/script.ts`). */
const scriptOf = (options?: SpawnOptions): string => (typeof options?.stdin === 'string' ? options.stdin : '');
/** The launches: the one script that holds `new-session`. */
const launched = (calls: readonly Spawned[]) => calls.filter(call => scriptOf(call.options).includes('new-session'));

describe('terminals #23 launch guard armed by hostFacts.launchGuard() (U1 mount)', () => {
  test('terminals #23 launch guard armed by hostFacts.launchGuard() refuses a nix-store claude on the kernel PATH, with no tmux spawn', async () => {
    const tmux = freshServer();
    const { calls, spawn } = recordingSpawn();
    const half = await terminalsHalf({ tmux, socketPath: SOCKET }, undefined, {
      hostFacts: guardFacts(true, realBin),
      spawn,
    });

    const booted = calls.length;

    const started = await half.runner().start(spec());

    expect(started).toEqual({ ok: false, error: 'real_harness' });
    expect(launched(calls)).toEqual([]);
    // Nothing of tmux after the boot scrub: no has-session, no start-server, no new-session.
    expect(calls.slice(booted).filter(call => call.program === 'tmux')).toEqual([]);
    expect(tmux.calls).toEqual([]);
    // Loud: the sentence names the harness, where it resolved and the remedy; no environment value is in it.
    const refusal = half.host.logs.find(entry => entry.level === 'warn' && entry.message.includes('real harness'));
    expect(refusal?.message).toContain(`claude resolves to ${join(realBin, 'claude')}`);
    expect(refusal?.message).toContain('the Nix claude-code package');
    expect(refusal?.message).toContain('A test must put a fake claude/codex first on PATH');
    expect(refusal?.fields).toEqual({ ferret: FERRET, harness: 'claude' });
  });

  test('terminals #23 launch guard armed by hostFacts.launchGuard() lets a fake claude through and launches', async () => {
    const { calls, spawn } = recordingSpawn();
    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, {
      hostFacts: guardFacts(true, fakeBin),
      spawn,
    });

    const started = await half.runner().start(spec());

    expect(started.ok).toBe(true);
    expect(launched(calls)).toHaveLength(1);
  });

  test('terminals #23 launch guard not armed (active: false) does not stand in the way of a real claude on PATH', async () => {
    const { calls, spawn } = recordingSpawn();
    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, {
      hostFacts: guardFacts(false, realBin),
      spawn,
    });

    const started = await half.runner().start(spec());

    expect(started.ok).toBe(true);
    expect(launched(calls)).toHaveLength(1);
  });

  test('terminals #23 launch guard armed: a launch env that sets PATH is refused even with a fake claude on the kernel PATH', async () => {
    const tmux = freshServer();
    const { calls, spawn } = recordingSpawn();
    const half = await terminalsHalf({ tmux, socketPath: SOCKET }, undefined, {
      hostFacts: guardFacts(true, fakeBin),
      spawn,
    });

    // The ferret's environment handle names PATH: the pane would look claude up on a PATH the guard never sees.
    const started = await half.runner().start(spec(['FY_SESSION_TOKEN', 'PATH']));

    expect(started).toEqual({ ok: false, error: 'real_harness' });
    expect(launched(calls)).toEqual([]);
    expect(tmux.calls).toEqual([]);
    const refusal = half.host.logs.find(entry => entry.level === 'warn' && entry.message.includes('own PATH'));
    expect(refusal?.message).toContain('the launch sets its own PATH');
    expect(refusal?.fields).toEqual({ ferret: FERRET });
  });

  test('terminals #23 launch guard armed with no kernel search path fails closed and launches nothing', async () => {
    const { calls, spawn } = recordingSpawn();
    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, {
      hostFacts: guardFacts(true),
      spawn,
    });

    const started = await half.runner().start(spec());

    expect(started).toEqual({ ok: false, error: 'real_harness' });
    expect(launched(calls)).toEqual([]);
  });
});

describe('terminals #23 forget-ferret-identity at boot (U1 mount)', () => {
  test("#23 forget-ferret-identity runs before listen on the daemon's own socket and logs only a count", async () => {
    const { calls, spawn } = recordingSpawn();

    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, { spawn });

    const scrub = calls.filter(call => scriptOf(call.options).includes('set-environment'));
    expect(scrub.map(call => [call.program, ...call.args])).toEqual(
      Array(3).fill(['tmux', '-u', '-S', SOCKET, 'source-file', '-']),
    );
    expect(scrub.map(call => scriptOf(call.options))).toEqual(
      ['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY', 'FY_SESSION_ID'].map(
        name => `'set-environment' '-g' '-u' '${name}'\n`,
      ),
    );
    const cleared = half.host.logs.filter(entry => entry.message === 'cleared ferret identity from the tmux server');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.fields).toEqual({ count: 3 });
    // No variable NAME reaches the log, let alone a value.
    expect(JSON.stringify(half.host.logs)).not.toContain('FY_SESSION');
  });

  test('#23 forget-ferret-identity with no server running says nothing and never fails boot', async () => {
    const { spawn } = recordingSpawn((_args, script) =>
      script.includes('set-environment') ? { exitCode: 1, stderr: 'no server running' } : undefined,
    );

    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, { spawn });

    expect(half.host.logs.some(entry => entry.message.includes('ferret identity'))).toBe(false);
    expect(half.host.logs.some(entry => entry.message.includes('identity scrub'))).toBe(false);
  });
});

describe('terminals #23 tmux release doctor row (U1 mount)', () => {
  test('#23 tmux release doctor row is asked fresh on every report, read-only, on the daemon socket', async () => {
    let server = '3.6a';
    const { calls, spawn } = recordingSpawn(args =>
      args.includes('display-message') ? { stdout: `${server}\n` } : undefined,
    );
    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, { spawn });

    const first = await half.host.doctor('terminals', 'tmux-release');
    server = '3.8';
    const second = await half.host.doctor('terminals', 'tmux-release');

    // The test host cannot start `tmux -V`, so only the server answers: judged alone, exactly as today.
    expect(first).toEqual({
      state: 'warn',
      detail: 'running server 3.6a — the server still runs the old release',
      fix:
        'tmux before 3.7 can crash its whole server — ending every session at once — when a session ends while Ferretry is watching it. Ferretry works around it, but only a newer tmux removes it. ' +
        'Do not kill the tmux server to switch: the new release is used the next time the server starts — once the last session has ended, or the machine restarts.',
    });
    expect(second).toEqual({
      state: 'ok',
      detail: 'running server 3.8',
      fix: 'tmux 3.7 or newer: no known whole-server crash.',
    });
    const asked = calls.filter(call => call.args.includes('display-message'));
    expect(asked.map(call => call.args)).toEqual(
      Array(2).fill(['-u', '-S', SOCKET, 'display-message', '-p', '#{version}']),
    );
    // Bounded: the kernel kills the child at the reader's timeout.
    expect(asked.every(call => Number(call.options?.timeout) === 2_000)).toBe(true);
    const starters = ['new-session', 'start-server', 'attach-session', 'attach'];
    expect(calls.some(call => call.args.some(word => starters.includes(word)))).toBe(false);
  });

  test('#23 tmux release doctor row is left out when tmux answered nothing', async () => {
    const { spawn } = recordingSpawn(args =>
      args.includes('display-message') ? { exitCode: 1, stderr: 'no server running' } : undefined,
    );
    const half = await terminalsHalf({ tmux: freshServer(), socketPath: SOCKET }, undefined, { spawn });

    expect(await half.host.doctor('terminals', 'tmux-release')).toBeUndefined();
  });
});
