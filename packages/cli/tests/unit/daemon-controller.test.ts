import { describe, expect, test } from 'bun:test';
import { RunRecordDaemonHealth } from '../../src/adapters/daemon/health.ts';
import { DaemonController, DaemonResetRefusedError } from '../../src/lib/daemon/controller.ts';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import type {
  IDaemonProcessPort,
  IServiceFilePort,
  IStateHomeClaimPort,
  LocalUpdateHealth,
  ResetCounts,
  ResetTreeMeasure,
  SessionTerminalEnding,
} from '../../src/lib/daemon/ports.ts';
import { DirectSupervisor, SystemdSupervisor } from '../../src/lib/daemon/supervisor.ts';
import { MidTurnUnreadableError } from '../../src/lib/update/mid-turn.ts';
import { CapturedOutput, FakePrompt, SteppingClock } from './update/support.ts';

interface Options {
  readonly installed?: boolean;
  readonly running?: boolean;
  readonly midTurn?: readonly (number | 'unreadable')[];
  readonly interactive?: boolean;
  readonly answer?: string;
  readonly home?: 'claimed' | 'unclaimed' | 'absent' | 'empty';
  /** What the process port answers to "does this pid hold the daemon lock": absent means yes. */
  readonly holdsOpen?: boolean | undefined;
  /** What the shell launcher comes to when a verb needs the home made. */
  readonly launch?: 'ok' | 'fails' | 'up-but-no-home' | 'absent';
  /** A nix-shell offer answering with this alternative executable. */
  readonly nixOffer?: string;
  /** The protocol the serving daemon reports. */
  readonly protocol?: number;
  readonly counts?: ResetCounts | undefined;
  readonly binary?: 'found' | 'missing';
  /** The version the serving daemon reports. */
  readonly runningVersion?: string;
  /** How the private terminal server ends. */
  readonly terminals?: SessionTerminalEnding;
  /** Contending lifecycle commands: the claims wait, reclaim a stale one, and leave residue on release. */
  readonly contended?: boolean;
  /** Nix: the executable is a store path and pinning it fails with this. */
  readonly pinFails?: string;
  /** How many stop attempts (a signal, a manager stop or kill) the daemon ignores before it goes down. */
  readonly ignoreStops?: number;
  /** What the service manager says, call by call, over what the daemon would imply; `always` once the queue is spent. */
  readonly manager?: {
    readonly queue?: readonly ManagerSays[];
    readonly always?: ManagerSays;
  };
  /** A start or restart that brings no daemon up. */
  readonly startsNothing?: boolean;
}

type ManagerSays = 'other' | 'inactive' | 'running' | 'failed';

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
    options.running === false
      ? undefined
      : { protocol: options.protocol ?? 1, version: options.runningVersion ?? '5.0.0', pid: 4321 };
  let ignored = options.ignoreStops ?? 0;
  const managerQueue = [...(options.manager?.queue ?? [])];
  const stopOnce = (): void => {
    if (ignored > 0) ignored -= 1;
    else current = undefined;
  };
  const processes: IDaemonProcessPort = {
    run: async argv => {
      trail.push(`run:${argv.join(' ')}`);
      if (argv.includes('stop') || argv.includes('kill')) stopOnce();
      if ((argv.includes('start') || argv.includes('restart')) && options.startsNothing !== true)
        current = { protocol: 1, version: '5.0.1', pid: 4322 };
      const says = argv.includes('show') ? (managerQueue.shift() ?? options.manager?.always) : undefined;
      if (says !== undefined) {
        const shown = {
          other: 'ActiveState=active\nMainPID=9999',
          running: 'ActiveState=active\nMainPID=7777',
          failed: 'ActiveState=failed\nMainPID=0',
          inactive: 'ActiveState=inactive\nMainPID=0',
        }[says];
        return { code: 0, stdout: `LoadState=loaded\n${shown}`, stderr: '' };
      }
      return {
        code: 0,
        stdout: `LoadState=loaded\nActiveState=${current === undefined ? 'inactive' : 'active'}\nMainPID=${current?.pid ?? 0}`,
        stderr: '',
      };
    },
    spawnDetached: async () => {
      trail.push('spawn');
      if (options.startsNothing !== true) current = { protocol: 1, version: '5.0.1', pid: 4322 };
      return { pid: 4322 };
    },
    signal: (pid, signal) => {
      trail.push(`signal:${String(pid)}:${signal}`);
      stopOnce();
      return true;
    },
    alive: () => current !== undefined,
    holdsOpen: async () => ('holdsOpen' in options ? options.holdsOpen : true),
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
  // A service definition can only be written under a home that exists; the requested state is applied after it.
  let homeState = options.installed === true ? 'claimed' : (options.home ?? 'claimed');
  const claims: IStateHomeClaimPort = {
    // As in production: a supervisor cannot claim a home the daemon has not made.
    claim: async () => {
      if (homeState !== 'claimed')
        throw new Error(`${layout.stateHome} is not a Ferretry home; the daemon creates it on its first start`);
    },
    inspect: async () => homeState,
  };
  const service = new SystemdSupervisor(layout, processes, files, claims);
  if (options.installed === true) await service.install('/fake/bin/old-fyd');
  homeState = options.home ?? 'claimed';
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
    // The real health read, over a fake wire: what the daemon `current` says on /healthz is what the verbs see, so the
    // protocol a test sets goes through the same schema production uses.
    health: new RunRecordDaemonHealth(
      async () => 'http://127.0.0.1:7457',
      async () =>
        current === undefined
          ? Promise.reject(new Error('ECONNREFUSED'))
          : new Response(JSON.stringify({ status: 'ok', uptimeSeconds: 5, ...current }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
    ),
    logs: {
      exists: async () => disk.has(layout.logFile),
      show: async (file, follow) => {
        trail.push(`logs:${file}:${String(follow)}`);
        return 0;
      },
    },
    nix: {
      realPath: async path => (options.pinFails === undefined ? path : `/nix/store/${'a'.repeat(32)}-ferretry/bin/fyd`),
      pin: async () => options.pinFails,
      release: async () => {},
    },
    lifecycle: {
      acquire: async request => {
        locks.push(`${request.verb}:${request.lockPath}`);
        if (options.contended === true) {
          request.waiting?.('pid 11');
          request.reclaimed?.('pid 12');
        }
        return {
          release: async () => {
            releases.push(request.lockPath);
            return options.contended === true ? `${request.lockPath}.stale` : undefined;
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
        return options.terminals ?? { kind: 'ended' };
      },
    },
    claims,
    launcher:
      options.launch === 'absent'
        ? undefined
        : async () => {
            trail.push('launch');
            if (options.launch === 'fails') return { started: false, why: 'cannot find fyd beside this program' };
            // A launcher that comes to "up" without making this home: another home's daemon answered on the default address.
            if (options.launch !== 'up-but-no-home') homeState = 'claimed';
            current = { protocol: 1, version: '5.0.0', pid: 4399 };
            return { started: true };
          },
    nixShellOffer: {
      offer: async found => {
        trail.push(`offer:${found.path}:claims=${String(locks.length)}`);
        return options.nixOffer === undefined ? undefined : { ...found, path: options.nixOffer };
      },
    },
    prompt,
    interactive: () => options.interactive ?? false,
    clientName: 'fy',
    clock: new SteppingClock(100),
    out,
    turns: {
      midTurn: async () => {
        const next = turns.shift() ?? 0;
        if (next === 'unreadable') throw new MidTurnUnreadableError();
        return next;
      },
    },
  });
  return {
    controller,
    layout,
    trail,
    out,
    prompt,
    locks,
    releases,
    disk,
    health: () => current,
    home: () => homeState,
  };
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

  test('V-0237 --when-idle says so when no ferret is mid-turn at the first read, and goes ahead', async () => {
    const h = await harness({ midTurn: [0] });
    await h.controller.restart({ whenIdle: true });
    expect(h.out.text).toContain('no ferret is mid-turn');
    expect(h.out.text).toContain('ok: fyd restarted');
  });

  test('V-0237 without --when-idle a restart is silent about ferrets when none is mid-turn', async () => {
    const h = await harness({ midTurn: [0] });
    await h.controller.restart();
    expect(h.out.text).not.toContain('mid-turn');
  });

  test('V-0237 --when-idle with the daemon up but the count unreadable refuses, and stops nothing', async () => {
    const h = await harness({ midTurn: ['unreadable'] });
    await expect(h.controller.restart({ whenIdle: true })).rejects.toThrow(
      'could not read how many ferrets are mid-turn, so nothing was restarted; run it again, or leave out --when-idle',
    );
    expect(h.trail.some(line => line.startsWith('signal'))).toBe(false);
    expect(h.locks).toEqual([]);
  });

  test('V-0237 --when-idle refuses too when the count becomes unreadable WHILE waiting', async () => {
    const h = await harness({ midTurn: [2, 'unreadable'] });
    await expect(h.controller.restart({ whenIdle: true })).rejects.toThrow('nothing was restarted');
    expect(h.trail.some(line => line.startsWith('signal'))).toBe(false);
  });

  test('V-0237 without --when-idle an unreadable count is the same as none: the restart goes ahead, as before', async () => {
    const h = await harness({ midTurn: ['unreadable'] });
    await h.controller.restart();
    expect(h.out.text).toContain('ok: fyd restarted');
    expect(h.out.text).not.toContain('mid-turn');
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

describe('a home the daemon has not made yet (fresh machine, or after a reset)', () => {
  const at = (trail: readonly string[], prefix: string) => trail.findIndex(line => line.startsWith(prefix));

  test('V-0233 fy daemon install on a fresh machine brings the daemon up once so it makes the home, then installs', async () => {
    const h = await harness({ running: false, home: 'absent' });
    await h.controller.install();
    expect(h.trail.filter(line => line === 'launch')).toEqual(['launch']);
    expect(at(h.trail, 'launch')).toBeLessThan(at(h.trail, 'run:systemctl --user enable'));
    expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/fake/bin/fyd');
    expect(h.out.text).toContain('user service installed from');
    expect(h.home()).toBe('claimed');
  });

  test('V-0233 an empty home is the same: it is the daemon that makes it a home', async () => {
    const h = await harness({ running: false, home: 'empty' });
    await h.controller.install();
    expect(h.trail).toContain('launch');
    expect(h.out.text).toContain('starting fyd once so it creates it');
  });

  test('V-0233 a home that is already ours is never launched for', async () => {
    const h = await harness({ running: false });
    await h.controller.install();
    expect(h.trail).not.toContain('launch');
  });

  test('V-0233 a home that is there but is not ours is never launched into: the supervisors refuse it', async () => {
    const h = await harness({ running: false, home: 'unclaimed' });
    await expect(h.controller.install()).rejects.toThrow('is not a Ferretry home');
    expect(h.trail).not.toContain('launch');
    expect(h.disk.has(h.layout.systemdUnitFile)).toBe(false);
  });

  test('V-0233 a launcher that cannot start the daemon refuses the install with its words, writing no definition', async () => {
    const h = await harness({ running: false, home: 'absent', launch: 'fails' });
    await expect(h.controller.install()).rejects.toThrow('cannot find fyd beside this program');
    expect(h.disk.has(h.layout.systemdUnitFile)).toBe(false);
  });

  test('V-0237 fy daemon restart after a reset launches once so the home exists, then restarts it: one daemon, never two', async () => {
    const h = await harness({ running: false, home: 'absent' });
    await h.controller.restart();
    expect(h.trail.filter(line => line === 'launch')).toEqual(['launch']);
    expect(h.trail.filter(line => line === 'spawn')).toEqual(['spawn']);
    expect(at(h.trail, 'launch')).toBeLessThan(at(h.trail, 'spawn'));
    expect(h.trail).toContain('signal:4399:SIGTERM');
    expect(h.out.text).toContain('ok: fyd restarted (pid 4322)');
  });

  test('V-0237 a unit that supervises another FY_HOME refuses restart on an absent home with no launch in the trail', async () => {
    // The home is gone, as after a reset: the refusal must come before anything is launched to make it.
    const absent = await harness({ installed: true, running: false, home: 'absent' });
    absent.disk.set(
      absent.layout.systemdUnitFile,
      (absent.disk.get(absent.layout.systemdUnitFile) ?? '').replaceAll(absent.layout.stateHome, '/other/home'),
    );
    await expect(absent.controller.restart()).rejects.toThrow('/other/home');
    expect(absent.trail).not.toContain('launch');
    expect(
      absent.trail.filter(line => /^(spawn|signal|run:systemctl --user (start|stop|restart))/u.test(line)),
    ).toEqual([]);
    expect(absent.home()).toBe('absent');
  });

  test('V-0237 a launcher whose "up" did not make this home is refused: restart goes no further', async () => {
    const h = await harness({ running: false, home: 'absent', launch: 'up-but-no-home' });
    await expect(h.controller.restart()).rejects.toThrow('still not a fyd home');
    expect(h.trail.filter(line => line === 'launch')).toEqual(['launch']);
    expect(h.trail).not.toContain('spawn');
    expect(h.home()).toBe('absent');
  });

  test('V-0233 a launcher whose "up" did not make this home is refused by install, writing no definition', async () => {
    const h = await harness({ running: false, home: 'absent', launch: 'up-but-no-home' });
    await expect(h.controller.install()).rejects.toThrow('still not a fyd home');
    expect(h.disk.has(h.layout.systemdUnitFile)).toBe(false);
  });

  test('V-0237 restart on a home that is ours does not launch', async () => {
    const h = await harness();
    await h.controller.restart();
    expect(h.trail).not.toContain('launch');
  });

  test('V-0236 reset leaves an empty home alone as not-a-marked-home, exactly as before', async () => {
    const h = await harness({ home: 'empty' });
    await expect(h.controller.reset({ yes: true })).rejects.toThrow('carries no Ferretry marker');
    expect(h.trail).toEqual([]);
  });
});

describe('a daemon on another protocol is still the daemon (skew remedy)', () => {
  test('V-0244 fy daemon stop stops a daemon whose protocol differs, rather than calling it not running', async () => {
    const h = await harness({ protocol: 9 });
    await h.controller.stop();
    expect(h.trail).toContain('signal:4321:SIGTERM');
    expect(h.out.text).toContain('ok: fyd stopped');
  });

  test('V-0237 fy daemon restart replaces a daemon on another protocol with exactly one new one', async () => {
    const h = await harness({ protocol: 9 });
    await h.controller.restart();
    expect(h.trail.filter(line => line === 'spawn')).toEqual(['spawn']);
    expect(h.trail.indexOf('signal:4321:SIGTERM')).toBeLessThan(h.trail.indexOf('spawn'));
    expect(h.out.text).not.toContain('was not running');
    expect(h.out.text).toContain('ok: fyd restarted (pid 4322)');
  });

  test('V-0251 fy daemon which reports a daemon on another protocol as running', async () => {
    const h = await harness({ protocol: 9 });
    await h.controller.which({});
    expect(h.out.text).toContain('running: pid 4321 version 5.0.0');
  });
});

describe('only a daemon that provably holds the state home is signalled (V-0244, V-0237, V-0236)', () => {
  const nothingTouched = (trail: readonly string[]) =>
    trail.filter(line => /^(signal|measure|remove|spawn|end-terminals)/u.test(line));

  for (const [name, holds] of [
    ['a pid that does not hold the lock', false],
    ['a host with neither /proc nor lsof', undefined],
  ] as const) {
    test(`V-0244 fy daemon stop refuses ${name}, signalling nothing`, async () => {
      const h = await harness({ holdsOpen: holds });
      await expect(h.controller.stop()).rejects.toThrow(holds === false ? 'does not hold' : 'neither /proc nor lsof');
      expect(nothingTouched(h.trail)).toEqual([]);
      expect(h.health()?.pid).toBe(4321);
    });

    test(`V-0237 fy daemon restart refuses ${name}, signalling and starting nothing`, async () => {
      const h = await harness({ holdsOpen: holds });
      await expect(h.controller.restart()).rejects.toThrow(
        holds === false ? 'does not hold' : 'neither /proc nor lsof',
      );
      expect(nothingTouched(h.trail)).toEqual([]);
    });

    test(`V-0236 fy daemon reset refuses ${name}: no signal, no measure, no removal`, async () => {
      const h = await harness({ holdsOpen: holds });
      await expect(h.controller.reset({ yes: true })).rejects.toThrow(
        holds === false ? 'does not hold' : 'neither /proc nor lsof',
      );
      expect(nothingTouched(h.trail)).toEqual([]);
    });
  }

  test('V-0244 a unit that supervises another FY_HOME is refused by stop, and nothing is signalled or sent to systemd', async () => {
    const h = await harness({ installed: true });
    const unit = h.layout.systemdUnitFile;
    h.disk.set(unit, (h.disk.get(unit) ?? '').replaceAll(h.layout.stateHome, '/other/home'));
    await expect(h.controller.stop()).rejects.toThrow('/other/home');
    expect(h.trail.filter(line => /^(signal|run:systemctl --user (stop|restart))/u.test(line))).toEqual([]);
  });

  test('V-0236 a unit that supervises another FY_HOME is refused by reset before anything is measured or removed', async () => {
    const h = await harness({ installed: true });
    const unit = h.layout.systemdUnitFile;
    h.disk.set(unit, (h.disk.get(unit) ?? '').replaceAll(h.layout.stateHome, '/other/home'));
    await expect(h.controller.reset({ yes: true })).rejects.toThrow('/other/home');
    expect(nothingTouched(h.trail)).toEqual([]);
  });
});

describe('fy daemon install and the nix shell (V-0233)', () => {
  test('V-0233 offers the nix profile before it takes the claim, and installs the executable the offer chose', async () => {
    const h = await harness({ running: false, nixOffer: '/home/user/.nix-profile/bin/fyd' });
    await h.controller.install();
    expect(h.trail).toContain('offer:/fake/bin/fyd:claims=0');
    expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/home/user/.nix-profile/bin/fyd');
  });

  test('V-0233 a declined or unneeded offer installs the executable that was found', async () => {
    const h = await harness({ running: false });
    await h.controller.install();
    expect(h.trail).toContain('offer:/fake/bin/fyd:claims=0');
    expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/fake/bin/fyd');
  });
});

describe('what the controller says when the host will not cooperate', () => {
  test('V-0244 a daemon that ignores the first stop is pressed harder, saying so', async () => {
    const h = await harness({ ignoreStops: 1 });
    await h.controller.stop();
    expect(h.out.text).toContain('warn: fyd has not stopped; escalating to an unconditional kill');
    expect(h.trail.filter(line => line.startsWith('signal'))).toEqual(['signal:4321:SIGTERM', 'signal:4321:SIGKILL']);
    expect(h.out.text).toContain('ok: fyd stopped');
  });

  test('V-0244 a daemon that never stops is reported as not stopped, with where to look, and no success', async () => {
    const h = await harness({ ignoreStops: 1_000 });
    await expect(h.controller.stop()).rejects.toThrow(`fyd did not stop within 20s; inspect ${h.layout.logFile}`);
    expect(h.out.text).not.toContain('ok: fyd stopped');
  });

  test('V-0237 restarting a daemon that is not running says so and starts it', async () => {
    const h = await harness({ running: false });
    await h.controller.restart();
    expect(h.out.text).toContain('warn: fyd was not running; starting it');
    expect(h.out.text).toContain('ok: fyd restarted (pid 4322)');
  });

  test('V-0237 a start that brings up nothing times out naming the log, after saying it is still initializing', async () => {
    const h = await harness({ running: false, startsNothing: true });
    await expect(h.controller.restart()).rejects.toThrow(
      `fyd did not become ready within 90s; inspect ${h.layout.logFile}`,
    );
    expect(h.out.text).toMatch(/warn: fyd starting — still initializing \(\d+s\); waiting up to 90s…/u);
  });

  test('V-0237 a process seen running that then exits during startup is reported as exited, not as slow', async () => {
    const h = await harness({
      installed: true,
      running: false,
      startsNothing: true,
      manager: { queue: ['running', 'running', 'failed'], always: 'failed' },
    });
    await expect(h.controller.restart()).rejects.toThrow(
      `fyd started but its process exited during startup; inspect ${h.layout.logFile}`,
    );
  });

  test('V-0237 a daemon the manager did not start is handed over, and a manager that then cannot take the home says so', async () => {
    const h = await harness({ installed: true, manager: { always: 'inactive' } });
    await expect(h.controller.restart()).rejects.toThrow(
      "pid 4322 serves /fake/user/fy outside systemd, so systemd's own daemon could not take the state home; run fy daemon restart to hand it over",
    );
    expect(h.out.text).toContain(
      'warn: fyd pid 4322 serves /fake/user/fy outside systemd; stopping it so systemd owns the daemon',
    );
    expect(h.trail).toContain('signal:4322:SIGTERM');
  });

  test('V-0244 stopping hands over a daemon the manager did not start, then stops the manager’s own if it respawned one', async () => {
    const h = await harness({ installed: true, manager: { queue: ['other', 'other'] } });
    await h.controller.stop();
    expect(h.out.text).toContain('outside systemd; stopping it so systemd owns the daemon');
    expect(h.trail).toContain('signal:4322:SIGTERM');
    expect(h.trail.some(line => line.startsWith('run:systemctl') && line.includes(' stop '))).toBe(true);
    expect(h.out.text).toContain('ok: fyd stopped');
  });

  test('V-0233 a host that cannot launch the daemon at all says it cannot create the home', async () => {
    const h = await harness({ running: false, home: 'absent', launch: 'absent' });
    await expect(h.controller.install()).rejects.toThrow('fyd cannot be started here to create /fake/user/fy');
  });

  test('V-0236 says it could not end the ferret terminal server, and how to end it by hand, but still resets', async () => {
    const h = await harness({ yes: true, terminals: { kind: 'failed', reason: 'permission denied' } } as never);
    await h.controller.reset({ yes: true });
    expect(h.out.text).toContain(
      'could not end the fyd ferret terminal server at /fake/user/fy/state/terminals/tmux.sock (permission denied)',
    );
    expect(h.out.text).toContain('kill-server');
    expect(h.out.text).toContain('fyd reset: removed');
  });

  test('V-0236 says nothing about terminals when there was no server to end', async () => {
    const h = await harness({ terminals: { kind: 'none' } });
    await h.controller.reset({ yes: true });
    expect(h.out.text).not.toContain('terminal server');
    expect(h.out.text).toContain('fyd reset: removed');
  });

  test('V-0233 says a Nix closure could not be pinned and how to have Nix hold it instead, and installs anyway', async () => {
    const h = await harness({ running: false, pinFails: 'nix-store: no permission' });
    await h.controller.install();
    expect(h.out.text).toContain(
      'runtime closure could not be pinned against garbage collection (nix-store: no permission)',
    );
    expect(h.out.text).toContain('nix profile install');
    expect(h.out.text).toContain('user service installed');
  });

  test('V-0244 tells a person about a lifecycle claim it waited for, reclaimed, and could not release', async () => {
    const h = await harness({ contended: true });
    await h.controller.stop();
    expect(h.out.text).toContain('fyd stop is waiting up to 140s for another lifecycle command to finish (pid 11)');
    expect(h.out.text).toContain('fyd stop removed a lifecycle claim left behind by pid 12');
    expect(h.out.text).toContain('fyd lifecycle claim');
    expect(h.out.text).toContain('could not be released; remove it once no fyd lifecycle command is running');
  });

  test('V-0251 a stopped daemon is said to be stopped, and a running one that is the installed one is said so', async () => {
    const stopped = await harness({ running: false });
    await stopped.controller.which({});
    expect(stopped.out.text).toContain('running: daemon is not running');
    expect(stopped.out.text).not.toContain('the running daemon is the installed one');

    const current = await harness({ runningVersion: '5.0.1' });
    await current.controller.which({});
    expect(current.out.text).toContain('the running daemon is the installed one');
  });
});
