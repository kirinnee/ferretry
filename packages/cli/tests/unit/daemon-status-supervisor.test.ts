/**
 * V-0243 `fy daemon status` says what supervises the daemon: the real controller and the real systemd / launchd supervisor,
 * over a FAKE process runner (no test ever runs `systemctl` or `launchctl`), through the real verb. Both key sets of `--json` are pinned.
 */
import { describe, expect, it } from 'bun:test';
import { PROTOCOL } from '@ferretry/kernel/contract';
import { RunRecordDaemonHealth } from '../../src/adapters/daemon/health.ts';
import { DaemonController, type DaemonControllerDeps } from '../../src/lib/daemon/controller.ts';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import type { IDaemonProcessPort, IServiceFilePort, IStateHomeClaimPort } from '../../src/lib/daemon/ports.ts';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../../src/lib/daemon/supervisor.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld } from './fakes.ts';

/** What `systemctl --user show` is faked to say. */
type Unit = 'active' | 'inactive' | 'failed' | 'not-found';

interface Scene {
  readonly platform?: 'linux' | 'darwin';
  /** Is a unit file on disk? */
  readonly installed: boolean;
  readonly unit?: Unit;
  /** The pid the unit runs (MainPID). */
  readonly unitPid?: number;
  /** The pid the answering daemon reports for itself; absent = nothing answers. */
  readonly serving?: number;
  /** What the FAKE `launchctl print` answers (macOS scenes). */
  readonly launchctl?: { readonly code: number; readonly stdout?: string; readonly stderr?: string };
}

const SHOWN: Record<Unit, string> = {
  active: 'LoadState=loaded\nActiveState=active\nMainPID=7777',
  inactive: 'LoadState=loaded\nActiveState=inactive\nMainPID=0',
  failed: 'LoadState=loaded\nActiveState=failed\nMainPID=0',
  'not-found': 'LoadState=not-found\nActiveState=inactive\nMainPID=0',
};

async function status(scene: Scene, ...flags: string[]) {
  const platform = scene.platform ?? 'linux';
  const layout = resolveDaemonLayout({
    platform,
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
  const ran: string[] = [];
  const processes: IDaemonProcessPort = {
    run: async argv => {
      ran.push(argv.join(' '));
      if (argv[0] === 'launchctl') {
        const said = scene.launchctl ?? { code: 113, stderr: 'Could not find service' };
        return { code: said.code, stdout: said.stdout ?? '', stderr: said.stderr ?? '' };
      }
      return {
        code: 0,
        stdout: SHOWN[scene.unit ?? 'inactive'].replace('7777', String(scene.unitPid ?? 7777)),
        stderr: '',
      };
    },
    spawnDetached: async () => ({}),
    signal: () => true,
    alive: () => false,
    identify: async () => undefined,
    holdsOpen: async () => true,
  };
  const files: IServiceFilePort = {
    exists: async () => scene.installed,
    read: async () => undefined,
    writePrivate: async () => {},
    remove: async () => {},
    ensureDirectory: async () => {},
  };
  const claims: IStateHomeClaimPort = { claim: async () => ({}), inspect: async () => 'claimed' };
  const controller = new DaemonController({
    layout,
    service:
      platform === 'linux'
        ? new SystemdSupervisor(layout, processes, files, claims)
        : new LaunchdSupervisor(layout, processes, files, claims),
    direct: new DirectSupervisor(layout, processes, files, claims),
    health: new RunRecordDaemonHealth(
      async () => 'http://127.0.0.1:7431',
      async () =>
        scene.serving === undefined
          ? Promise.reject(new Error('ECONNREFUSED'))
          : new Response(JSON.stringify({ protocol: PROTOCOL, version: '5.0.0', pid: scene.serving }), { status: 200 }),
    ),
  } as unknown as DaemonControllerDeps);
  const made = fakeWorld({
    probe:
      scene.serving === undefined
        ? { state: 'down', baseUrl: 'http://127.0.0.1:7431', why: 'connection refused' }
        : { state: 'up', baseUrl: 'http://127.0.0.1:7431', health: { protocol: PROTOCOL, version: '5.0.0' } },
  });
  const world = { ...made.world, daemon: () => ({ controller, exitCode: () => 0 }) } as typeof made.world;
  const code = await runFy(['daemon', 'status', ...flags], world);
  const out = made.io.stdout();
  return {
    code,
    out,
    err: made.io.stderr(),
    ran,
    json: flags.includes('--json') ? (JSON.parse(out) as Record<string, unknown>) : undefined,
  };
}

describe('fy daemon status: what supervises the daemon (Linux, systemd)', () => {
  it('active: the manager, its state, its pid, and the daemon’s own pid', async () => {
    const result = await status({ installed: true, unit: 'active', unitPid: 4321, serving: 4321 });
    expect(result.code).toBe(0);
    expect(result.out).toContain('daemon   running at http://127.0.0.1:7431');
    expect(result.out).toContain('pid      4321');
    expect(result.out).toContain('  systemd: running (systemd reports active)');
    expect(result.out).not.toContain('OUTSIDE');
    expect(result.err).toBe('');
    // The manager's verdict on the process is read now (O6: liveness on Linux); only what 5.0 still has no read for is said.
    expect(result.out).toContain('Liveness: alive');
    expect(result.out).toContain('not reported in 5.0: tunnel, firewall');
    expect(result.ran).toEqual([
      'systemctl --user show fyd.service --property=LoadState --property=ActiveState --property=MainPID',
    ]);
  });

  it('an inactive unit under a daemon that serves is an ORPHAN, with the remedy, and still exits 0', async () => {
    const result = await status({ installed: true, unit: 'inactive', serving: 4321 });
    expect(result.code).toBe(0);
    expect(result.out).toContain('fyd is serving, but OUTSIDE systemd — nothing supervises it');
    expect(result.out).toContain('  systemd: stopped (systemd reports inactive)');
    expect(result.err).toContain(
      'pid 4321 was not started by systemd, so systemd cannot start its own; run fy daemon restart to stop it and have systemd own the daemon',
    );
  });

  it('a unit running a different pid than the one that answers is an orphan too', async () => {
    const result = await status({ installed: true, unit: 'active', unitPid: 7777, serving: 4321 });
    expect(result.out).toContain('OUTSIDE systemd');
  });

  it('failed and not answering: stopped, exit 1, the unit’s state on the error stream', async () => {
    const result = await status({ installed: true, unit: 'failed' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('not running at http://127.0.0.1:7431');
    expect(result.err).toContain('  systemd: failed (systemd reports failed)');
    expect(result.err).not.toContain('wedged');
  });

  it('a unit that runs while nothing answers is wedged: its process exists and says so', async () => {
    const result = await status({ installed: true, unit: 'active', unitPid: 7777 });
    expect(result.code).toBe(1);
    expect(result.err).toContain('a process exists (pid 7777) but answered nothing in time');
    expect(result.err).toContain('`fy daemon restart` replaces it');
  });

  it('a unit the manager does not know (file present, LoadState not-found) is absent', async () => {
    const result = await status({ installed: true, unit: 'not-found', serving: 4321 });
    expect(result.out).toContain('  systemd: absent (no systemd user unit is installed)');
  });

  it('no unit file: no service manager owns the daemon, and systemctl is never asked', async () => {
    const result = await status({ installed: false, serving: 4321 });
    expect(result.code).toBe(0);
    expect(result.out).toContain('  not managed by a service manager');
    expect(result.out).not.toContain('OUTSIDE');
    expect(result.ran).toEqual([]);
  });
});

const PLIST = '/fake/user/Library/LaunchAgents/com.ferretry.fyd.plist';
const printed = (state: string, extra: string) =>
  `gui/1234/com.ferretry.fyd = {\n\tactive count = 1\n\tpath = ${PLIST}\n\tstate = ${state}\n${extra}}\n`;

describe('fy daemon status: macOS reads launchd (a FAKE launchctl; this box never runs the real one)', () => {
  it('loaded and running: the pid, the last exit, and the plist path', async () => {
    const result = await status({
      platform: 'darwin',
      installed: true,
      serving: 4321,
      launchctl: { code: 0, stdout: printed('running', '\tpid = 4321\n\tlast exit code = 0\n') },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('pid      4321');
    expect(result.out).toContain('  launchd: running (launchd reports running)');
    expect(result.out).toContain(`loaded: yes; last exit: 0; plist: ${PLIST}`);
    expect(result.out).toContain('Liveness: alive');
    expect(result.out).not.toContain('not read');
    expect(result.ran).toEqual(['launchctl print gui/1234/com.ferretry.fyd']);
  });

  it('loaded but not running, with a bad last exit: failed, and the exit is said', async () => {
    const result = await status({
      platform: 'darwin',
      installed: true,
      launchctl: { code: 0, stdout: printed('waiting', '\tlast exit status = 78\n') },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('  launchd: failed (launchd reports waiting; last exit status 78)');
    expect(result.err).toContain(`loaded: yes; last exit: 78; plist: ${PLIST}`);
    expect(result.err).toContain('Liveness: dead');
  });

  it('a SIGABRT crash loop (macOS 26.5 print shape): failed, the signal is said, never a bare stopped', async () => {
    const launchctl = {
      code: 0,
      stdout: printed('spawn scheduled', '\truns = 14\n\tlast terminating signal = Aborted: 6\n'),
    };
    const result = await status({ platform: 'darwin', installed: true, launchctl });
    expect(result.code).toBe(1);
    expect(result.err).toContain('  launchd: failed (launchd reports spawn scheduled; crashed (SIGABRT), restarting)');
    expect(result.err).toContain(`loaded: yes; last signal: SIGABRT; plist: ${PLIST}`);
    expect(result.err).toContain('Liveness: dead');
    const { json } = await status({ platform: 'darwin', installed: true, launchctl }, '--json');
    expect(json).toMatchObject({ supervisor: { manager: 'launchd', state: 'failed', lastSignal: 'SIGABRT' } });
  });

  it('a plist on disk that launchd has not loaded: not loaded, stopped', async () => {
    const result = await status({
      platform: 'darwin',
      installed: true,
      launchctl: { code: 113, stderr: 'Could not find service "com.ferretry.fyd" in domain for user gui: 1234\n' },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('  launchd: stopped (Could not find service');
    expect(result.err).toContain(`loaded: no; plist: ${PLIST}`);
    expect(result.err).not.toContain('not read');
  });

  it('no plist: no service manager owns the daemon, and launchctl is never asked', async () => {
    const result = await status({ platform: 'darwin', installed: false, serving: 4321 });
    expect(result.out).toContain('  not managed by a service manager');
    expect(result.ran).toEqual([]);
  });

  it.each([
    [
      'launchctl cannot be run',
      { code: 127, stderr: 'launchctl: not found' },
      'launchctl print failed (exit 127): launchctl: not found',
    ],
    [
      'launchd refuses the read',
      { code: 1, stderr: 'Operation not permitted' },
      'launchctl print failed (exit 1): Operation not permitted',
    ],
    [
      'launchctl prints something that is not a job',
      { code: 0, stdout: '<html>nope</html>' },
      'launchctl print answered, but not in a form this fy understands',
    ],
  ])('%s: said plainly as not read, never guessed', async (_name, launchctl, why) => {
    const result = await status({ platform: 'darwin', installed: true, serving: 4321, launchctl });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`  launchd: not read — ${why}`);
    expect(result.out).toContain('not reported in 5.0: liveness, tunnel, firewall');
    expect(result.out).not.toContain('Liveness:');
    expect(result.out).not.toContain('OUTSIDE');
  });
});

describe('fy daemon status --json carries both key sets', () => {
  it('serving under systemd: 5.0’s keys and today’s keys, side by side', async () => {
    const { json, code } = await status({ installed: true, unit: 'active', unitPid: 4321, serving: 4321 }, '--json');
    expect(code).toBe(0);
    expect(json).toEqual({
      // 5.0
      running: true,
      baseUrl: 'http://127.0.0.1:7431',
      version: '5.0.0',
      protocol: PROTOCOL,
      // today's
      daemon: 'fyd',
      reachability: 'serving',
      orphan: false,
      supervisor: { manager: 'systemd', state: 'running', pid: 4321, detail: 'systemd reports active' },
      health: { protocol: PROTOCOL, version: '5.0.0', pid: 4321 },
      liveness: 'alive',
      notReported: ['tunnel', 'firewall'],
    });
  });

  it('liveness is the manager’s verdict on the process: running is alive, failed is dead, anything else absent', async () => {
    expect((await status({ installed: true, unit: 'active', serving: 4321 }, '--json')).json).toMatchObject({
      liveness: 'alive',
    });
    expect((await status({ installed: true, unit: 'failed' }, '--json')).json).toMatchObject({ liveness: 'dead' });
    expect((await status({ installed: true, unit: 'inactive', serving: 4321 }, '--json')).json).toMatchObject({
      liveness: 'absent',
    });
    const failed = await status({ installed: true, unit: 'failed' });
    expect(failed.err).toContain('Liveness: dead');
  });

  it('an orphan and a stopped daemon read from the same keys', async () => {
    const orphan = (await status({ installed: true, unit: 'inactive', serving: 4321 }, '--json')).json;
    expect(orphan).toMatchObject({
      reachability: 'serving',
      orphan: true,
      supervisor: { manager: 'systemd', state: 'stopped' },
    });
    const failed = await status({ installed: true, unit: 'failed' }, '--json');
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({
      running: false,
      why: 'connection refused',
      reachability: 'stopped',
      orphan: false,
      supervisor: { manager: 'systemd', state: 'failed' },
    });
    expect(failed.json).not.toHaveProperty('health');
    const wedged = (await status({ installed: true, unit: 'active', unitPid: 7777 }, '--json')).json;
    expect(wedged).toMatchObject({ running: false, reachability: 'wedged' });
  });

  it('macOS: launchd’s loaded, pid, last exit and plist ride in the supervisor key', async () => {
    const { json } = await status(
      {
        platform: 'darwin',
        installed: true,
        serving: 4321,
        launchctl: { code: 0, stdout: printed('running', '\tpid = 4321\n\tlast exit code = 0\n') },
      },
      '--json',
    );
    expect(json).toMatchObject({
      running: true,
      reachability: 'serving',
      orphan: false,
      supervisor: {
        manager: 'launchd',
        state: 'running',
        pid: 4321,
        loaded: true,
        lastExit: 0,
        definition: PLIST,
      },
      liveness: 'alive',
      notReported: ['tunnel', 'firewall'],
    });
  });

  it('macOS: a launchd that cannot be read is named and marked not reported', async () => {
    const { json } = await status(
      { platform: 'darwin', installed: true, serving: 4321, launchctl: { code: 127, stderr: 'launchctl: not found' } },
      '--json',
    );
    expect(json).toMatchObject({
      running: true,
      reachability: 'serving',
      orphan: false,
      supervisor: {
        manager: 'launchd',
        state: 'not-reported',
        detail: 'launchd could not be read: launchctl print failed (exit 127): launchctl: not found',
      },
      notReported: ['liveness', 'tunnel', 'firewall'],
    });
    expect(json).not.toHaveProperty('liveness');
  });
});
