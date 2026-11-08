import { describe, expect, test } from 'bun:test';
import type { RunSpec } from '@ferretry/core-ferrets/contract';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { RealHarnessLaunchGuard } from '../../../../daemon/adapters/tmux/harness-launch-guard.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';
import { RealHarnessRefusedError } from '../../../../daemon/lib/tmux/harness-guard.ts';

const REAL_CLAUDE = '/nix/store/r331x6dfyzn5k8mj74p16gqm3ba1aw4n-claude-code-2.1.281/bin/claude';

/** A tmux that records what it is asked and answers "no such session" so a launch would go on to create one. */
function recordingTmux(): TmuxCommandPort & { readonly asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    execute: async arguments_ => {
      asked.push([...arguments_]);
      return { code: arguments_[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' };
    },
  };
}

function runnerOver(tmux: TmuxCommandPort, runs: string[][], launchGuard?: RealHarnessLaunchGuard): TmuxRunner {
  const spawn = {
    run: async (_program: string, args: readonly string[]) => {
      runs.push([...args]);
      return { exitCode: 0, signal: null, stdout: '%1|42', stderr: '' };
    },
  } as unknown as SpawnPort;
  return new TmuxRunner({
    tmux,
    spawn,
    socketPath: '/h/state/terminals/tmux.sock',
    instantOf: seconds => instantFromEpochMs(seconds * 1_000),
    now: () => instantFromEpochMs(0),
    ...(launchGuard === undefined ? {} : { launchGuard }),
  });
}

const spec = {
  ferret: 'f1',
  command: ['claude-default'],
  cwd: '/tmp/work',
  env: { names: [] },
} as unknown as RunSpec;

/** A locator that finds every harness name at the real install, as a real claude on the daemon's PATH would. */
const realOnPath = (searchPaths: string[]) => (name: string, searchPath: string) => {
  searchPaths.push(searchPath);
  return name === 'claude' ? REAL_CLAUDE : undefined;
};

describe('terminals #23 launch guard (U1)', () => {
  test('terminals #23 launch guard refuses a real claude on PATH when armed, before any tmux command', async () => {
    const tmux = recordingTmux();
    const runs: string[][] = [];
    const searched: string[] = [];
    // The search path is K3's `launchGuard().searchPath`, handed in; the locator is never given the daemon's env.
    const guard = new RealHarnessLaunchGuard(() => '/kernel/search/path', realOnPath(searched));

    const refused = await runnerOver(tmux, runs, guard)
      .start(spec)
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(RealHarnessRefusedError);
    expect(tmux.asked).toEqual([]);
    expect(runs).toEqual([]);
    expect(new Set(searched)).toEqual(new Set(['/kernel/search/path']));
  });

  test('terminals #23 launch guard does not stand in the way when not armed', async () => {
    const tmux = recordingTmux();
    const runs: string[][] = [];

    const started = await runnerOver(tmux, runs).start(spec);

    expect(started.ok).toBe(true);
    expect(runs).toHaveLength(1);
  });

  test('terminals #23 launch guard lets a fake first on PATH through when armed', async () => {
    const tmux = recordingTmux();
    const runs: string[][] = [];
    const guard = new RealHarnessLaunchGuard(
      () => '/fake/bin',
      () => '/tmp/fy-e2e-1/harness-bin/claude',
    );

    const started = await runnerOver(tmux, runs, guard).start(spec);

    expect(started.ok).toBe(true);
  });
});
