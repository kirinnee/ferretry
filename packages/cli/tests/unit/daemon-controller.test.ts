import { describe, expect, test } from 'bun:test';
import { DaemonController, DaemonResetRefusedError } from '../../src/lib/daemon/controller.ts';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import type {
  IDaemonProcessPort,
  IServiceFilePort,
  IStateHomeClaimPort,
  LocalUpdateHealth,
  ResetCounts,
  ResetTreeMeasure,
} from '../../src/lib/daemon/ports.ts';
import { DirectSupervisor, SystemdSupervisor } from '../../src/lib/daemon/supervisor.ts';
import { CapturedOutput, FakePrompt, SteppingClock } from './update/support.ts';

interface Options {
  readonly installed?: boolean;
  readonly running?: boolean;
  readonly midTurn?: readonly number[];
  readonly interactive?: boolean;
  readonly answer?: string;
  readonly home?: 'claimed' | 'unclaimed' | 'absent';
  readonly counts?: ResetCounts | undefined;
  readonly binary?: 'found' | 'missing';
}

const MEASURED: ResetTreeMeasure = { kind: 'measured', files: 3, bytes: 3_000_000, escapingLinks: [] };

async function harness(options: Options = {}) {
  const layout = resolveDaemonLayout({
    platform: 'linux',
    homeDirectory: '/fake/user',
    stateHome: '/fake/user/fy',
    configHome: '/fake/config',
    stateDirectory: '/fake/state',
    runtimeDirectory: '/fake/run',
    userId: 1234,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/fake/bin',
  });
  const trail: string[] = [];
  const disk = new Map<string, string>();
  let current: LocalUpdateHealth | undefined =
    options.running === false ? undefined : { protocol: 1, version: '5.0.0', pid: 4321 };
  const processes: IDaemonProcessPort = {
    run: async argv => {
      trail.push(`run:${argv.join(' ')}`);
      if (argv.includes('stop')) current = undefined;
      if (argv.includes('start') || argv.includes('restart')) current = { protocol: 1, version: '5.0.1', pid: 4322 };
      return {
        code: 0,
        stdout: `LoadState=loaded\nActiveState=${current === undefined ? 'inactive' : 'active'}\nMainPID=${current?.pid ?? 0}`,
        stderr: '',
      };
    },
    spawnDetached: async () => {
      trail.push('spawn');
      current = { protocol: 1, version: '5.0.1', pid: 4322 };
      return { pid: 4322 };
    },
    signal: (pid, signal) => {
      trail.push(`signal:${String(pid)}:${signal}`);
      current = undefined;
      return true;
    },
    alive: () => current !== undefined,
    holdsOpen: async () => true,
  };
  const files: IServiceFilePort = {
    exists: async path => disk.has(path),
    read: async path => disk.get(path),
    writePrivate: async (path, value) => {
      disk.set(path, value);
    },
    remove: async path => {
      disk.delete(path);
    },
    ensureDirectory: async () => {},
  };
  const claims: IStateHomeClaimPort = { claim: async () => {}, inspect: async () => options.home ?? 'claimed' };
  const service = new SystemdSupervisor(layout, processes, files, claims);
  if (options.installed === true) await service.install('/fake/bin/old-fyd');
  trail.length = 0;
  const out = new CapturedOutput();
  const prompt = new FakePrompt(options.answer ?? 'reset');
  const turns = [...(options.midTurn ?? [])];
  const locks: string[] = [];
  const releases: string[] = [];
  const controller = new DaemonController({
    layout,
    service,
    direct: new DirectSupervisor(layout, processes, files, claims),
    health: { probe: async () => current },
    logs: {
      exists: async () => disk.has(layout.logFile),
      show: async (file, follow) => {
        trail.push(`logs:${file}:${String(follow)}`);
        return 0;
      },
    },
    nix: { realPath: async path => path, pin: async () => undefined, release: async () => {} },
    lifecycle: {
      acquire: async request => {
        locks.push(`${request.verb}:${request.lockPath}`);
        return {
          release: async () => {
            releases.push(request.lockPath);
            return undefined;
          },
        };
      },
    },
    installedDaemon: () => {
      if (options.binary === 'missing') throw new Error('cannot find fyd on PATH');
      return { path: '/fake/bin/fyd', source: 'PATH', version: '5.0.1' };
    },
    resetTrees: {
      measure: async root => {
        trail.push(`measure:${root}`);
        return MEASURED;
      },
      remove: async root => {
        trail.push(`remove:${root}`);
        return MEASURED;
      },
    },
    resetInventory: {
      count: async () => ('counts' in options ? options.counts : { secrets: 2, devices: 3, ferrets: 4 }),
    },
    sessionTerminals: {
      end: async socket => {
        trail.push(`end-terminals:${socket}`);
        return { kind: 'ended' };
      },
    },
    claims,
    prompt,
    interactive: () => options.interactive ?? false,
    clientName: 'fy',
    clock: new SteppingClock(100),
    out,
    turns: { midTurn: async () => turns.shift() ?? 0 },
  });
  return { controller, layout, trail, out, prompt, locks, releases, disk, health: () => current };
}

describe('fy daemon stop', () => {
  test('V-0244 stops a direct daemon by signalling the pid it proved to hold the state home, then reports it stopped', async () => {
    const h = await harness();
    await h.controller.stop();
    expect(h.trail).toContain('signal:4321:SIGTERM');
    expect(h.out.text).toContain('ok: fyd stopped');
    expect(h.health()).toBeUndefined();
  });

  test('V-0244 says the daemon is not running, and signals nothing, when none answers', async () => {
    const h = await harness({ running: false });
    await h.controller.stop();
    expect(h.out.text).toContain('warn: fyd is not running');
    expect(h.trail.some(line => line.startsWith('signal'))).toBe(false);
  });

  test('V-0244 stops a service-managed daemon through its manager', async () => {
    const h = await harness({ installed: true });
    await h.controller.stop();
    expect(h.trail.some(line => line.startsWith('run:systemctl') && line.includes('stop'))).toBe(true);
    expect(h.out.text).toContain('ok: fyd stopped');
  });

  test('V-0244 holds every lifecycle claim in the layout order and releases them in reverse', async () => {
    const h = await harness();
    await h.controller.stop();
    expect(h.locks).toEqual(h.layout.lifecycleLocks.map(path => `stop:${path}`));
    expect(h.releases).toEqual([...h.layout.lifecycleLocks].reverse());
  });
});

describe('fy daemon restart', () => {
  test('V-0237 stops the direct daemon, starts the installed executable and reports the new pid', async () => {
    const h = await harness();
    await h.controller.restart();
    expect(h.trail.indexOf('signal:4321:SIGTERM')).toBeGreaterThanOrEqual(0);
    expect(h.trail.indexOf('spawn')).toBeGreaterThan(h.trail.indexOf('signal:4321:SIGTERM'));
    expect(h.out.text).toContain('ok: fyd restarted (pid 4322)');
  });

  test('V-0237 restarts a service-managed daemon in one manager command', async () => {
    const h = await harness({ installed: true });
    await h.controller.restart();
    expect(h.trail.some(line => line.startsWith('run:systemctl') && line.includes('restart'))).toBe(true);
    expect(h.out.text).toContain('ok: fyd restarted (pid 4322)');
  });

  test('V-0237 resolves the executable BEFORE stopping, so a host with none keeps its running daemon', async () => {
    const h = await harness({ binary: 'missing' });
    await expect(h.controller.restart()).rejects.toThrow('cannot find fyd on PATH');
    expect(h.health()?.pid).toBe(4321);
    expect(h.trail.some(line => line.startsWith('signal'))).toBe(false);
  });

  test('V-0237 says ferrets keep running when some are mid-turn, and goes ahead', async () => {
    const h = await harness({ midTurn: [2] });
    await h.controller.restart();
    expect(h.out.text).toContain('2 ferrets are mid-turn; they keep running through the restart');
    expect(h.out.text).toContain('ok: fyd restarted');
  });

  test('V-0237 --when-idle waits until no ferret is mid-turn BEFORE it takes the claim or stops anything', async () => {
    const h = await harness({ midTurn: [2, 1, 0] });
    await h.controller.restart({ whenIdle: true });
    expect(h.out.text).toContain('waiting until every ferret is idle before restarting');
    expect(h.locks.length).toBeGreaterThan(0);
    expect(h.trail.indexOf('signal:4321:SIGTERM')).toBeGreaterThanOrEqual(0);
    expect(h.out.text.indexOf('waiting until every ferret is idle')).toBeLessThan(h.out.text.indexOf('restarted'));
  });

  test('V-0237 a caller that already said what the restart means for ferrets is not told twice', async () => {
    const h = await harness({ midTurn: [3] });
    await h.controller.restart({ midTurnSaid: true, ferretsKeepRunning: 3 });
    expect(h.out.text).not.toContain('mid-turn');
  });
});

describe('fy daemon install and uninstall', () => {
  test('V-0233 writes the service definition for the installed executable and waits for the daemon to serve', async () => {
    const h = await harness({ running: false });
    await h.controller.install();
    expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/fake/bin/fyd');
    expect(h.out.text).toContain('user service installed from');
    expect(h.locks[0]).toContain('install:');
  });

  test('V-0249 stops the daemon and removes the service definition, naming the root it keeps', async () => {
    const h = await harness({ installed: true });
    await h.controller.uninstall();
    expect(h.disk.has(h.layout.systemdUnitFile)).toBe(false);
    expect(h.out.text).toContain('user service removed');
    expect(h.out.text).toContain(h.layout.nixGcRoot);
  });
});

describe('fy daemon which and logs', () => {
  test('V-0251 reports the installed and the running daemon, and tells a stale one to restart', async () => {
    const h = await harness();
    await h.controller.which({});
    expect(h.out.text).toContain('installed: /fake/bin/fyd (PATH, version 5.0.1)');
    expect(h.out.text).toContain('running: pid 4321 version 5.0.0');
    expect(h.out.text).toContain('run fy daemon restart to use the installed daemon');
  });

  test('V-0251 --json prints one machine shape, and a stopped daemon is not-running', async () => {
    const h = await harness({ running: false });
    await h.controller.which({ json: true });
    const payload = JSON.parse(h.out.lines[0]?.replace(/^ok: /u, '') ?? '{}') as {
      installed: { state: string };
      running: { state: string };
    };
    expect(payload.installed.state).toBe('found');
    expect(payload.running.state).toBe('not-running');
  });

  test('V-0251 names why the daemon cannot be located instead of a bare absence', async () => {
    const h = await harness({ binary: 'missing' });
    await h.controller.which({});
    expect(h.out.text).toContain('installed: cannot find fyd on PATH');
  });

  test('V-0234 says there is no log yet, rather than printing an empty one', async () => {
    const h = await harness();
    await h.controller.logs({});
    expect(h.out.text).toContain(`no fyd log at ${h.layout.logFile} yet`);
  });

  test('V-0234 shows the log once, or follows it with -f', async () => {
    const h = await harness();
    h.disk.set(h.layout.logFile, 'x');
    await h.controller.logs({});
    await h.controller.logs({ follow: true });
    expect(h.trail).toEqual([`logs:${h.layout.logFile}:false`, `logs:${h.layout.logFile}:true`]);
  });
});

describe('fy daemon reset', () => {
  test('V-0236 measures and counts first, stops the daemon, ends the ferret terminals, then removes both trees', async () => {
    const h = await harness();
    await h.controller.reset({ yes: true });
    const at = (prefix: string) => h.trail.findIndex(line => line.startsWith(prefix));
    expect(at('measure:')).toBeGreaterThanOrEqual(0);
    expect(at('signal:4321')).toBeGreaterThan(at('measure:'));
    expect(at('end-terminals:')).toBeGreaterThan(at('signal:4321'));
    expect(at('remove:')).toBeGreaterThan(at('end-terminals:'));
    expect(h.trail).toContain(`end-terminals:${h.layout.sessionTerminalSocket}`);
    expect(h.out.text).toContain('2 secret(s)');
    expect(h.out.text).toContain('3 paired device(s)');
    expect(h.out.text).toContain('4 ferret(s)');
    expect(h.out.text).toContain('fyd reset: removed 2 path(s)');
  });

  test('V-0236 off a terminal it refuses without --yes and has removed nothing', async () => {
    const h = await harness();
    await expect(h.controller.reset({})).rejects.toThrow(DaemonResetRefusedError);
    expect(h.trail.some(line => line.startsWith('remove:') || line.startsWith('signal'))).toBe(false);
  });

  test('V-0236 at a terminal it asks for the word, and anything else cancels before anything is stopped', async () => {
    const wrong = await harness({ interactive: true, answer: 'yes' });
    await expect(wrong.controller.reset({})).rejects.toThrow('reset cancelled');
    expect(wrong.trail.some(line => line.startsWith('signal'))).toBe(false);
    const right = await harness({ interactive: true, answer: 'reset' });
    await right.controller.reset({});
    expect(right.prompt.asked).toEqual(['Type "reset" to confirm:']);
    expect(right.trail.some(line => line.startsWith('remove:'))).toBe(true);
  });

  test('V-0236 refuses a state home that carries no Ferretry marker, before measuring anything', async () => {
    const h = await harness({ home: 'unclaimed' });
    await expect(h.controller.reset({ yes: true })).rejects.toThrow('carries no Ferretry marker');
    expect(h.trail).toEqual([]);
  });

  test('V-0236 a daemon that is down is not asked for counts, and the preflight says they are unavailable', async () => {
    const h = await harness({ running: false, counts: undefined });
    await h.controller.reset({ yes: true });
    expect(h.out.text).toContain('fyd is not running');
    expect(h.out.text).toContain('cannot be counted');
    expect(h.trail.some(line => line.startsWith('remove:'))).toBe(true);
  });

  test('V-0236 serialises under the reset claim like stop and restart', async () => {
    const h = await harness();
    await h.controller.reset({ yes: true });
    expect(h.locks.every(lock => lock.startsWith('reset:'))).toBe(true);
    expect(h.releases.length).toBe(h.locks.length);
  });
});
