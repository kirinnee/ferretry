import { describe, it } from 'bun:test';
import should from 'should';
import { resolveDaemonLayout } from '../../src/lib/daemon/layout.ts';
import type { IDaemonProcessPort, IServiceFilePort, IStateHomeClaimPort } from '../../src/lib/daemon/ports.ts';
import {
  DirectSupervisor,
  LaunchdSupervisor,
  SystemdSupervisor,
  UnsupportedServiceManagerError,
} from '../../src/lib/daemon/supervisor.ts';

const layout = (platform: string) =>
  resolveDaemonLayout({
    platform,
    homeDirectory: '/fake/user',
    stateHome: '/fake/fy',
    configHome: '/fake/config',
    stateDirectory: '/fake/state',
    userId: 1234,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/fake/bin',
  });

type Outcome = { code: number; stdout: string; stderr: string };

function world(platform: string) {
  const ran: string[][] = [];
  const signals: { pid: number; signal: string }[] = [];
  const disk = new Map<string, string>();
  const replies: ((argv: readonly string[]) => Outcome | undefined)[] = [];
  const state = { holds: true as boolean | undefined, alive: true };
  const processes: IDaemonProcessPort = {
    run: async argv => {
      ran.push([...argv]);
      for (const reply of replies) {
        const answer = reply(argv);
        if (answer !== undefined) return answer;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnDetached: async () => ({ pid: 77 }),
    signal: (pid, signal) => {
      signals.push({ pid, signal: String(signal) });
      return true;
    },
    alive: () => state.alive,
    holdsOpen: async () => state.holds,
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
  const claims: IStateHomeClaimPort = { claim: async () => {}, inspect: async () => 'claimed' };
  const l = layout(platform);
  return { l, ran, signals, disk, replies, state, processes, files, claims };
}

const failing = (match: string, stderr: string) => (argv: readonly string[]) =>
  argv.includes(match) ? { code: 1, stdout: '', stderr } : undefined;

describe('the systemd supervisor', () => {
  it('rewrites the unit for the executable and starts it, handing back no process of its own', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);

    const handle = await systemd.start('/fake/bin/fyd');

    should(handle).deepEqual({});
    should(w.disk.get(w.l.systemdUnitFile)).containEql('/fake/bin/fyd');
    should(w.ran.map(argv => argv[2])).deepEqual(['daemon-reload', 'start']);
  });

  it('stops politely, and when escalated kills the daemon alone (never the whole control group)', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);

    await systemd.stop({ pidHint: undefined, escalate: false });
    await systemd.stop({ pidHint: undefined, escalate: true });

    should(w.ran).deepEqual([
      ['systemctl', '--user', 'stop', 'fyd.service'],
      ['systemctl', '--user', 'kill', '--kill-who=main', '--signal=SIGKILL', 'fyd.service'],
    ]);
  });

  it('uninstalls by disabling the unit, removing the file and reloading', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);
    await systemd.install('/fake/bin/fyd');
    w.ran.length = 0;

    await systemd.uninstall();

    should(w.ran.map(argv => argv.slice(2))).deepEqual([['disable', '--now', 'fyd.service'], ['daemon-reload']]);
    should(await systemd.installed()).equal(false);
  });

  it('says what the service manager said when a command it needs fails, or which command failed when it said nothing', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);
    w.replies.push(failing('start', ' Unit fyd.service not found. \n'));
    await should(systemd.start('/fake/bin/fyd')).be.rejectedWith('Unit fyd.service not found.');

    w.replies.length = 0;
    w.replies.push(failing('restart', ''));
    await should(systemd.restartInPlace('/fake/bin/fyd')).be.rejectedWith(
      'systemctl --user restart fyd.service failed',
    );
  });

  it('reports a unit systemctl cannot show as stopped when its file is there, and absent when it is not', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);
    w.replies.push(failing('show', 'Failed to connect to bus\n'));

    should(await systemd.inspect()).deepEqual({
      manager: 'systemd',
      state: 'absent',
      detail: 'Failed to connect to bus',
    });
    w.disk.set(w.l.systemdUnitFile, '[Service]');
    should((await systemd.inspect()).state).equal('stopped');
  });

  it('refuses a unit that names no state home before anything is changed', async () => {
    const w = world('linux');
    const systemd = new SystemdSupervisor(w.l, w.processes, w.files, w.claims);
    w.disk.set(w.l.systemdUnitFile, '[Service]\nExecStart="/x"');

    await should(systemd.assertServes(undefined)).be.rejectedWith(
      /names no FY_HOME, so it cannot be tied to \/fake\/fy/u,
    );
    should(w.ran).deepEqual([]);
  });
});

describe('the launchd supervisor', () => {
  it('uninstalls by booting the job out and removing its plist', async () => {
    const w = world('darwin');
    const launchd = new LaunchdSupervisor(w.l, w.processes, w.files, w.claims);
    await launchd.install('/fake/bin/fyd');
    w.ran.length = 0;

    await launchd.uninstall();

    should(w.ran).deepEqual([['launchctl', 'bootout', 'gui/1234/com.ferretry.fyd']]);
    should(await launchd.installed()).equal(false);
  });

  it('starts by rewriting and reloading the definition', async () => {
    const w = world('darwin');
    const launchd = new LaunchdSupervisor(w.l, w.processes, w.files, w.claims);

    should(await launchd.start('/fake/bin/fyd')).deepEqual({});
    should(w.ran.map(argv => argv[1])).deepEqual(['bootout', 'bootstrap']);
  });

  it('stops by booting the job out, and when escalated by killing it', async () => {
    const w = world('darwin');
    const launchd = new LaunchdSupervisor(w.l, w.processes, w.files, w.claims);

    await launchd.stop({ pidHint: undefined, escalate: false });
    await launchd.stop({ pidHint: undefined, escalate: true });
    w.replies.push(failing('bootout', 'Boot-out failed: 5'));
    await should(launchd.stop({ pidHint: undefined, escalate: false })).be.rejectedWith('Boot-out failed: 5');

    should(w.ran.slice(0, 2)).deepEqual([
      ['launchctl', 'bootout', 'gui/1234/com.ferretry.fyd'],
      ['launchctl', 'kill', 'SIGKILL', 'gui/1234/com.ferretry.fyd'],
    ]);
  });

  it('reads a binary plist through plutil, and refuses one plutil cannot convert, saying why', async () => {
    const w = world('darwin');
    const launchd = new LaunchdSupervisor(w.l, w.processes, w.files, w.claims);
    w.disk.set(w.l.launchAgentFile, 'bplist00\u0001');
    w.replies.push(argv =>
      argv[0] === 'plutil'
        ? {
            code: 0,
            stdout:
              '<plist><dict><key>EnvironmentVariables</key><dict><key>FY_HOME</key><string>/fake/fy</string></dict></dict></plist>',
            stderr: '',
          }
        : undefined,
    );
    await launchd.assertServes(undefined);
    should(w.ran[0]).deepEqual(['plutil', '-convert', 'xml1', '-o', '-', w.l.launchAgentFile]);

    w.replies.length = 0;
    w.replies.push(failing('plutil', 'not a plist\n'));
    await should(launchd.assertServes(undefined)).be.rejectedWith(
      /is a binary property list and `plutil -convert xml1` could not read it \(not a plist\); remove it, then install again/u,
    );

    w.replies.length = 0;
    w.replies.push(failing('plutil', ''));
    await should(launchd.assertServes(undefined)).be.rejectedWith(/could not read it; remove it/u);
  });
});

describe('the direct supervisor', () => {
  const direct = (w: ReturnType<typeof world>) => new DirectSupervisor(w.l, w.processes, w.files, w.claims);

  it('is never installed, and cannot be installed or uninstalled', async () => {
    const w = world('freebsd');
    const supervisor = direct(w);

    should(await supervisor.installed()).equal(false);
    await should(supervisor.install('/fake/bin/fyd')).be.rejectedWith(UnsupportedServiceManagerError);
    await should(supervisor.uninstall()).be.rejectedWith(
      'service install supports launchd on macOS and systemd user services on Linux',
    );
  });

  it('says the process it started is running, or has exited, and knows nothing without a handle', async () => {
    const w = world('freebsd');
    const supervisor = direct(w);

    should(await supervisor.inspect()).deepEqual({
      manager: 'direct',
      state: 'absent',
      detail: 'no service manager owns the daemon on this host',
    });
    should(await supervisor.inspect({ pid: 9 })).deepEqual({
      manager: 'direct',
      state: 'running',
      pid: 9,
      detail: 'started directly by this command',
    });
    w.state.alive = false;
    should((await supervisor.inspect({ pid: 9 })).state).equal('failed');
  });

  it('signals a pid only once it is proved to hold this state home’s lock', async () => {
    const w = world('freebsd');
    const supervisor = direct(w);

    await supervisor.stop({ pidHint: undefined, escalate: false });
    await supervisor.stop({ pidHint: 5, escalate: false });
    await supervisor.stop({ pidHint: 5, escalate: true });
    should(w.signals).deepEqual([
      { pid: 5, signal: 'SIGTERM' },
      { pid: 5, signal: 'SIGKILL' },
    ]);

    w.state.holds = false;
    await should(supervisor.stop({ pidHint: 6, escalate: false })).be.rejectedWith(
      /does not hold \/fake\/fy\/run\/daemon.lock/u,
    );
    w.state.holds = undefined;
    await should(supervisor.assertServes(6)).be.rejectedWith(/neither \/proc nor lsof/u);
    should(w.signals).have.length(2);
  });
});
