/**
 * V-0436 `fy setup`: install the daemon as a user service, wait for `/healthz`, show the pairing QR, then the first run.
 * The order is pinned twice: over the pure steps (`runSetup`), and through the real router with the real verb table, a
 * fake controller and two fake halves standing in for Access's `pair` and Onboarding's `onboard`.
 */
import { describe, expect, it } from 'bun:test';
import { definePlugin, implementCli, verb, type VerbHandler } from '@ferretry/kernel/manifest';
import type { DaemonController, DaemonControlReads } from '../../src/lib/daemon/controller.ts';
import { runFy } from '../../src/lib/run.ts';
import { runSetup, type SetupHealth, type SetupSteps } from '../../src/lib/setup/setup.ts';
import type { Probe } from '../../src/lib/world.ts';
import { entry, fakeWorld, registryOf } from './fakes.ts';

interface Scene {
  readonly interactive?: boolean;
  readonly install?: number;
  readonly health?: SetupHealth;
  readonly pair?: number;
  readonly onboard?: number;
}

function steps(scene: Scene) {
  const calls: string[] = [];
  const said: string[] = [];
  const complained: string[] = [];
  const port: SetupSteps = {
    interactive: scene.interactive ?? true,
    install: async () => {
      calls.push('install');
      return scene.install ?? 0;
    },
    health: async () => {
      calls.push('health');
      return scene.health ?? { up: true, baseUrl: 'http://127.0.0.1:7431' };
    },
    pair: async () => {
      calls.push('pair');
      return scene.pair ?? 0;
    },
    onboard: async flags => {
      calls.push(`onboard ${flags.join(' ')}`.trim());
      return scene.onboard ?? 0;
    },
    say: line => void said.push(line),
    complain: line => void complained.push(line),
  };
  return { port, calls, said, complained };
}

const NONE = { yes: false, check: false, json: false };

describe('runSetup', () => {
  it('installs, waits for health, pairs, then runs the first run, in that order', async () => {
    const run = steps({});
    expect(await runSetup(NONE, run.port, 'fy')).toBe(0);
    expect(run.calls).toEqual(['install', 'health', 'pair', 'onboard']);
    expect(run.said.join('\n')).toContain('the daemon is serving at http://127.0.0.1:7431');
  });

  it('hands --yes and --json on to onboard', async () => {
    const run = steps({ interactive: false });
    expect(await runSetup({ yes: true, check: false, json: true }, run.port, 'fy')).toBe(0);
    expect(run.calls).toEqual(['install', 'health', 'onboard --yes --json']);
  });

  it('REFUSES off a terminal without --yes, before anything is installed, and names the way through', async () => {
    const run = steps({ interactive: false });
    expect(await runSetup(NONE, run.port, 'fy')).toBe(2);
    expect(run.calls).toEqual([]);
    expect(run.complained.join('\n')).toContain('needs a terminal');
    expect(run.complained.join('\n')).toContain('--yes');
  });

  it('off a terminal with --yes it installs and onboards but draws no QR, and names `fy pair`', async () => {
    const run = steps({ interactive: false });
    expect(await runSetup({ ...NONE, yes: true }, run.port, 'fy')).toBe(0);
    expect(run.calls).toEqual(['install', 'health', 'onboard --yes']);
    expect(run.said.join('\n')).toContain('run `fy pair` at one');
  });

  it('--yes at a terminal draws no QR either (unattended), and names `fy pair`', async () => {
    const run = steps({});
    await runSetup({ ...NONE, yes: true }, run.port, 'fy');
    expect(run.calls).toEqual(['install', 'health', 'onboard --yes']);
    expect(run.said.join('\n')).toContain('run `fy pair` at one');
  });

  it('--json at a terminal draws no QR either: stdout is onboard’s JSON alone', async () => {
    const run = steps({});
    await runSetup({ ...NONE, json: true }, run.port, 'fy');
    expect(run.calls).toEqual(['install', 'health', 'onboard --json']);
  });

  it('a failed install stops there with the install’s own exit code', async () => {
    const run = steps({ install: 7 });
    expect(await runSetup(NONE, run.port, 'fy')).toBe(7);
    expect(run.calls).toEqual(['install']);
    expect(run.complained.join('\n')).toContain('did not install');
  });

  it('a daemon that never answers stops before pairing, with the reason and the logs verb', async () => {
    const run = steps({ health: { up: false, baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' } });
    expect(await runSetup(NONE, run.port, 'fy')).toBe(1);
    expect(run.calls).toEqual(['install', 'health']);
    expect(run.complained.join('\n')).toContain('connection refused');
    expect(run.complained.join('\n')).toContain('fy daemon logs');
  });

  it('a pairing code that cannot be shown does not stop the first run, but the exit code says so', async () => {
    const run = steps({ pair: 3 });
    expect(await runSetup(NONE, run.port, 'fy')).toBe(3);
    expect(run.calls).toEqual(['install', 'health', 'pair', 'onboard']);
    expect(run.complained.join('\n')).toContain('fy pair');
  });

  it('onboard’s failure is the exit code', async () => {
    expect(await runSetup(NONE, steps({ onboard: 4 }).port, 'fy')).toBe(4);
  });

  it('--check changes nothing: a serving daemon is asked `onboard --check`, and nothing is installed or paired', async () => {
    const run = steps({});
    expect(await runSetup({ ...NONE, check: true }, run.port, 'fy')).toBe(0);
    expect(run.calls).toEqual(['health', 'onboard --check']);
  });

  it('--check with the daemon down says what setup would do, exits non-zero, and does not ask onboard (that would start it)', async () => {
    const run = steps({ health: { up: false, baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' } });
    expect(await runSetup({ ...NONE, check: true }, run.port, 'fy')).toBe(1);
    expect(run.calls).toEqual(['health']);
    expect(run.said.join('\n')).toContain('would install it as a user service');
  });
});

const accessManifest = definePlugin({
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  actions: { cli: [verb('pair', { summary: 'pair a device' })] },
});
const onboardingManifest = definePlugin({
  id: 'onboarding',
  title: 'Onboarding',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: { cli: [verb('onboard', { summary: 'first run' })] },
});

/** The real router, over a fake controller and fake `pair` / `onboard` halves, all writing to one ordered log. */
function routed(options: { tty: boolean; probeUp?: boolean; installCode?: number; downLooks?: number }) {
  const log: string[] = [];
  const looks = { probes: 0, sleeps: 0 };
  const record =
    (name: string, code = 0): VerbHandler =>
    async invocation => {
      log.push(`${name} ${Object.keys(invocation.options).sort().join(',')}`.trim());
      return code;
    };
  const registry = registryOf(
    entry(
      accessManifest,
      'h-access',
      implementCli(accessManifest, { build: () => ({ verbs: { pair: record('pair') } }) }),
    ),
    entry(
      onboardingManifest,
      'h-onboarding',
      implementCli(onboardingManifest, { build: () => ({ verbs: { onboard: record('onboard') } }) }),
    ),
  );
  const made = fakeWorld({
    registry,
    probe:
      options.probeUp === false
        ? { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' }
        : { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } },
  });
  const controller = {
    install: async () => void log.push('install'),
  } as unknown as DaemonController;
  // The daemon the install just started takes `downLooks` looks to bind; the wait between looks is instant here.
  const downLooks = options.downLooks ?? 0;
  const probe = async (): Promise<Probe> => {
    looks.probes += 1;
    return looks.probes > downLooks && options.probeUp !== false
      ? { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: 1, version: '5.0.0' } }
      : { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' };
  };
  const world = {
    ...made.world,
    probe,
    host: {
      ...made.world.host,
      sleep: async () => {
        looks.sleeps += 1;
      },
    },
    io: { ...made.io, isTty: options.tty },
    daemon: (_reads: DaemonControlReads) => ({ controller, exitCode: () => options.installCode ?? 0 }),
  };
  return { world, io: made.io, log, looks };
}

describe('fy setup, through the router', () => {
  it('V-0436 at a terminal: install, then health, then `pair --no-wait` (the parser reads it as wait=false), then `onboard`', async () => {
    const run = routed({ tty: true });
    expect(await runFy(['setup'], run.world)).toBe(0);
    expect(run.log).toEqual(['install', 'pair wait', 'onboard']);
    expect(run.io.stdout()).toContain('the daemon is serving at http://127.0.0.1:7431');
  });

  it('V-0436 --yes --check runs no install and no pair: it reads `onboard --check`', async () => {
    const run = routed({ tty: true });
    expect(await runFy(['setup', '--yes', '--check'], run.world)).toBe(0);
    expect(run.log).toEqual(['onboard check,yes']);
  });

  it('V-0436 off a terminal without --yes it refuses (usage exit) and runs nothing', async () => {
    const run = routed({ tty: false });
    expect(await runFy(['setup'], run.world)).toBe(2);
    expect(run.log).toEqual([]);
    expect(run.io.stderr()).toContain('needs a terminal');
  });

  it('V-0436 off a terminal with --yes --json: install, then onboard --yes --json, progress on stderr only', async () => {
    const run = routed({ tty: false });
    expect(await runFy(['setup', '--yes', '--json'], run.world)).toBe(0);
    expect(run.log).toEqual(['install', 'onboard json,yes']);
    expect(run.io.stdout()).toBe('');
    expect(run.io.stderr()).toContain('run `fy pair` at one');
  });

  it('V-0436 a daemon still binding is waited for: it is looked at again, then setup goes on', async () => {
    const run = routed({ tty: true, downLooks: 3 });
    expect(await runFy(['setup'], run.world)).toBe(0);
    expect(run.looks.sleeps).toBe(3);
    expect(run.log).toEqual(['install', 'pair wait', 'onboard']);
  });

  it('V-0436 a daemon that never answers is given a bounded number of looks, then setup stops before pairing', async () => {
    const run = routed({ tty: true, probeUp: false });
    expect(await runFy(['setup'], run.world)).toBe(1);
    expect(run.looks.sleeps).toBe(19);
    expect(run.log).toEqual(['install']);
    expect(run.io.stderr()).toContain('connection refused');
  });

  it('V-0436 a failed install is the exit code and nothing after it runs', async () => {
    const run = routed({ tty: true, installCode: 7 });
    expect(await runFy(['setup'], run.world)).toBe(7);
    expect(run.log).toEqual(['install']);
  });
});
