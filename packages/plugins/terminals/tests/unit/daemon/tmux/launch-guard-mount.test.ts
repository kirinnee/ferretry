import { describe, expect, test } from 'bun:test';
import type { RunSpec } from '@ferretry/core-ferrets/contract';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { RealHarnessLaunchGuard } from '../../../../daemon/adapters/tmux/harness-launch-guard.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandPort } from '../../../../daemon/lib/tmux/contracts.ts';
import { RealHarnessRefusedError, UnprovableHarnessError } from '../../../../daemon/lib/tmux/harness-guard.ts';

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

function runnerOver(
  tmux: TmuxCommandPort,
  runs: string[][],
  launchGuard?: RealHarnessLaunchGuard,
  warned: { message: string; fields?: object }[] = [],
): TmuxRunner {
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
    log: { warn: (message, fields) => warned.push({ message, ...(fields === undefined ? {} : { fields }) }) },
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
    const warned: { message: string; fields?: object }[] = [];

    const refused = await runnerOver(tmux, runs, guard, warned).start(spec);

    expect(refused).toEqual({ ok: false, error: 'real_harness' });
    expect(tmux.asked).toEqual([]);
    expect(runs).toEqual([]);
    expect(new Set(searched)).toEqual(new Set(['/kernel/search/path']));
    // Loud, never quiet: the refusal names the harness, the install and the remedy, in the daemon log.
    expect(warned).toEqual([
      {
        message: new RealHarnessRefusedError('claude', REAL_CLAUDE, 'the Nix claude-code package').message,
        fields: { ferret: 'f1', harness: 'claude' },
      },
    ]);
    expect(warned[0]?.message).toContain('A test must put a fake claude/codex first on PATH');
  });

  test('terminals #23 launch guard launch env sets PATH: refused when armed, before any tmux command', async () => {
    const tmux = recordingTmux();
    const runs: string[][] = [];
    const warned: { message: string; fields?: object }[] = [];
    // The kernel PATH holds only a fake; the launch handle names PATH, whose value the guard can never read.
    const guard = new RealHarnessLaunchGuard(
      () => '/fake/bin',
      () => '/tmp/fy-e2e-1/harness-bin/claude',
    );

    const refused = await runnerOver(tmux, runs, guard, warned).start({
      ...spec,
      env: { names: ['FY_SESSION_TOKEN', 'PATH'] },
    } as unknown as RunSpec);

    expect(refused).toEqual({ ok: false, error: 'real_harness' });
    expect(tmux.asked).toEqual([]);
    expect(runs).toEqual([]);
    expect(warned.map(entry => entry.message)).toEqual([new UnprovableHarnessError('own-path').message]);
  });

  test('terminals #23 launch guard searches a launch PATH it was handed by value, as today', async () => {
    const searched: string[] = [];
    const guard = new RealHarnessLaunchGuard(() => '/daemon/bin', realOnPath(searched));

    const refused = await guard
      .check({ session: 'fy-f1', cwd: '/w', command: ['claude-default'], env: { PATH: '/pane/bin' } })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(RealHarnessRefusedError);
    expect(new Set(searched)).toEqual(new Set(['/pane/bin']));
  });

  test('terminals #23 launch guard with no search path refuses every launch rather than pass a bare name', async () => {
    const located: string[] = [];
    const guard = new RealHarnessLaunchGuard(
      () => undefined,
      name => {
        located.push(name);
        return undefined;
      },
    );

    for (const command of [['claude'], ['/opt/fake/claude-default']] as const) {
      const refused = await guard
        .check({ session: 'fy-f1', cwd: '/w', command: [...command] as [string, ...string[]] })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(UnprovableHarnessError);
      expect((refused as UnprovableHarnessError).why).toBe('no-path');
    }
    expect(
      await new RealHarnessLaunchGuard(() => '').check({ session: 's', cwd: '/w', command: ['x'] }).catch(e => e),
    ).toBeInstanceOf(UnprovableHarnessError);
    expect(located).toEqual([]);
  });

  test('terminals #23 launch guard whose locator throws still fails the start closed', async () => {
    const tmux = recordingTmux();
    const runs: string[][] = [];
    const guard = new RealHarnessLaunchGuard(
      () => '/kernel/bin',
      () => {
        throw new Error('the disk went away');
      },
    );

    const failed = await runnerOver(tmux, runs, guard)
      .start(spec)
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(tmux.asked).toEqual([]);
    expect(runs).toEqual([]);
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
