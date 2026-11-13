import { expect, test } from 'bun:test';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import type {
  IDaemonProcessPort,
  IServiceFilePort,
  IStateHomeClaimPort,
  INixGcRootPort,
  LocalUpdateHealth,
} from '../../../src/lib/daemon/ports.ts';
import { DirectSupervisor, LaunchdSupervisor, SystemdSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { UpdateLifecycle } from '../../../src/lib/update/lifecycle.ts';
import { CapturedOutput, SteppingClock } from './support.ts';

interface HarnessOptions {
  /** A host with no service manager at all. */
  readonly withoutService?: boolean;
  /** What the Nix port answers; the real path of an executable defaults to itself. */
  readonly nix?: Partial<INixGcRootPort>;
  /** How many signals the daemon ignores before it goes down. */
  readonly ignoreSignals?: number;
}

function harness(platform: 'linux' | 'darwin', options: HarnessOptions = {}) {
  const layout = resolveDaemonLayout({
    platform,
    homeDirectory: '/fake/user',
    stateHome: '/fake/fy',
    configHome: '/fake/config',
    stateDirectory: '/fake/state',
    runtimeDirectory: '/fake/run',
    userId: 1234,
    daemonName: 'fyd',
    product: 'ferretry',
    searchPath: '/fake/bin',
  });
  const disk = new Map<string, string>();
  const ran: string[][] = [];
  const signals: number[] = [];
  let current: LocalUpdateHealth | undefined = { protocol: 1, version: '5.0.0', pid: 4321 };
  let serves = true;
  let ignored = options.ignoreSignals ?? 0;
  let launchdRunning = true;
  const processes: IDaemonProcessPort = {
    run: async argv => {
      ran.push([...argv]);
      if (argv[0] === 'launchctl') {
        if (argv.includes('print'))
          return launchdRunning
            ? { code: 0, stdout: `state = running\npid = ${current?.pid ?? 4322}`, stderr: '' }
            : { code: 113, stdout: '', stderr: 'Could not find service' };
        if (argv.includes('bootout')) {
          if (!launchdRunning) return { code: 113, stdout: '', stderr: 'Boot-out failed: No such process' };
          launchdRunning = false;
        }
        if (argv.includes('bootstrap')) launchdRunning = true;
      }
      if (argv.includes('stop') || argv.includes('bootout')) current = undefined;
      if (argv.includes('start') || argv.includes('restart') || argv.includes('bootstrap'))
        current = { protocol: 1, version: '5.0.1', pid: 4322 };
      return { code: 0, stdout: `LoadState=loaded\nActiveState=active\nMainPID=${current?.pid ?? 0}`, stderr: '' };
    },
    spawnDetached: async () => {
      current = { protocol: 1, version: '5.0.1', pid: 4322 };
      return { pid: 4322 };
    },
    signal: pid => {
      signals.push(pid);
      if (ignored > 0) ignored -= 1;
      else current = undefined;
      return true;
    },
    alive: () => current !== undefined,
    holdsOpen: async (_pid, path) => {
      expect(path).toBe('/fake/fy/run/daemon.lock');
      return serves;
    },
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
  const service =
    platform === 'linux'
      ? new SystemdSupervisor(layout, processes, files, claims)
      : new LaunchdSupervisor(layout, processes, files, claims);
  const direct = new DirectSupervisor(layout, processes, files, claims);
  const locks: string[] = [];
  let releases = 0;
  const out = new CapturedOutput();
  const lifecycle = new UpdateLifecycle({
    layout,
    service: options.withoutService === true ? undefined : service,
    direct,
    locks: {
      acquire: async request => {
        locks.push(request.lockPath);
        return {
          release: async () => {
            releases++;
            return undefined;
          },
        };
      },
    },
    nix: { realPath: async path => path, pin: async () => undefined, release: async () => {}, ...options.nix },
    clock: new SteppingClock(1000),
    out,
    installed: () => ({ path: '/fake/bin/fyd', source: 'PATH', version: '5.0.1' }),
    versionOf: () => '5.0.1',
    executable: () => true,
    health: async () => current,
  });
  return {
    layout,
    disk,
    ran,
    signals,
    service,
    out,
    lifecycle,
    locks,
    releases: () => releases,
    foreign: () => {
      serves = false;
    },
    unload: (orphan: boolean) => {
      launchdRunning = false;
      if (!orphan) current = undefined;
    },
    health: () => current,
  };
}

test('the copied systemd adapter rewrites the service for the installed binary and restarts it, under lifecycle claims', async () => {
  const h = harness('linux');
  await h.service.install('/fake/bin/old-fyd');
  h.ran.length = 0;
  await h.lifecycle.restart();
  expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/fake/bin/fyd');
  expect(h.ran).toEqual([
    [
      'systemctl',
      '--user',
      'show',
      'fyd.service',
      '--property=LoadState',
      '--property=ActiveState',
      '--property=MainPID',
    ],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', 'fyd.service'],
  ]);
  expect(h.locks).toEqual([...h.layout.lifecycleLocks]);
  expect(h.releases()).toBe(h.locks.length);
});

test.each([true, false])('launchd restart skips stop on an unloaded job and starts it (orphan=%s)', async orphan => {
  const h = harness('darwin');
  await h.service.install('/fake/bin/old-fyd');
  h.unload(orphan);
  h.ran.length = 0;
  await h.lifecycle.restart();
  expect(h.signals).toEqual(orphan ? [4322] : []);
  // start's reload tolerates one failed bootout; a stop before that would throw and prevent bootstrap.
  expect(h.ran.filter(argv => argv.includes('bootout'))).toHaveLength(1);
  expect(h.ran.at(-1)).toEqual(['launchctl', 'bootstrap', 'gui/1234', h.layout.launchAgentFile]);
  expect(h.health()).toEqual({ protocol: 1, version: '5.0.1', pid: 4322 });
  expect(h.releases()).toBe(h.locks.length);
});

test('the copied launchd adapter installs the new profile path by writing and reloading its definition', async () => {
  const h = harness('darwin');
  await h.lifecycle.installAt('/fake/profile/bin/fyd');
  expect(h.disk.get(h.layout.launchAgentFile)).toContain('/fake/profile/bin/fyd');
  expect(h.ran.at(-2)).toEqual(['launchctl', 'bootout', 'gui/1234/com.ferretry.fyd']);
  expect(h.ran.at(-1)).toEqual(['launchctl', 'bootstrap', 'gui/1234', h.layout.launchAgentFile]);
  expect(h.releases()).toBe(h.locks.length);
});

test('a forwarded daemon pid never becomes a local signal or service rewrite', async () => {
  const h = harness('linux');
  h.foreign();
  await expect(h.lifecycle.restart()).rejects.toThrow('does not hold');
  expect(h.signals).toEqual([]);
  expect(h.disk.size).toBe(0);
  expect(h.releases()).toBe(h.locks.length);
});

test('the copied service ownership check refuses a unit for another FY_HOME before changing it', async () => {
  const h = harness('linux');
  await h.service.install('/fake/bin/old-fyd');
  const original = h.disk.get(h.layout.systemdUnitFile)?.replace('/fake/fy', '/other/fy') as string;
  h.disk.set(h.layout.systemdUnitFile, original);
  h.ran.length = 0;
  await expect(h.lifecycle.restart()).rejects.toThrow('not /fake/fy');
  expect(h.ran).toEqual([]);
  expect(h.disk.get(h.layout.systemdUnitFile)).toBe(original);
});

test('a definition macOS would throttle is named, and one that is fine, absent or unreadable is not', async () => {
  const h = harness('darwin');
  expect(await h.lifecycle.staleDefinition()).toBeUndefined();
  await h.service.install('/fake/bin/fyd');
  expect(await h.lifecycle.staleDefinition()).toBeUndefined();
  h.disk.set(
    h.layout.launchAgentFile,
    h.disk.get(h.layout.launchAgentFile)?.replace('Interactive', 'Background') ?? '',
  );
  expect(await h.lifecycle.staleDefinition()).toBe('launchd ProcessType is not Interactive');
  expect(await harness('linux', { withoutService: true }).lifecycle.staleDefinition()).toBeUndefined();
});

test('an executable from the Nix store is pinned, and a pin that fails is warned about, not fatal', async () => {
  const store = `/nix/store/${'a'.repeat(32)}-ferretry`;
  const pinned: string[][] = [];
  const h = harness('linux', {
    nix: {
      realPath: async () => `${store}/bin/fyd`,
      pin: async (path, root) => {
        pinned.push([path, root]);
        return 'nix-store could not add the root';
      },
    },
  });
  await h.lifecycle.installAt('/fake/profile/bin/fyd');
  expect(pinned).toEqual([[store, h.layout.nixGcRoot]]);
  expect(h.out.text).toContain('warn: nix-store could not add the root');
  expect(h.disk.get(h.layout.systemdUnitFile)).toContain('/fake/profile/bin/fyd');
});

test('installing with no service manager on this host is refused as unsupported', async () => {
  const h = harness('linux', { withoutService: true });
  await expect(h.lifecycle.installAt('/fake/bin/fyd')).rejects.toThrow('service install supports launchd on macOS');
  expect(h.releases()).toBe(h.locks.length);
});

test('an install that finds an orphan daemon stops it, pressing harder when it ignores the first signal', async () => {
  const h = harness('darwin', { ignoreSignals: 1 });
  await h.service.install('/fake/bin/old-fyd');
  h.unload(true);
  await h.lifecycle.installAt('/fake/profile/bin/fyd');
  expect(h.signals).toEqual([4322, 4322]);
});

test('an install gives up, starting nothing, when the orphan daemon never goes down', async () => {
  const h = harness('darwin', { ignoreSignals: 1_000 });
  await h.service.install('/fake/bin/old-fyd');
  h.unload(true);
  h.ran.length = 0;
  await expect(h.lifecycle.installAt('/fake/profile/bin/fyd')).rejects.toThrow(
    'the daemon did not stop; nothing else was started',
  );
  expect(h.ran.filter(argv => argv.includes('bootstrap'))).toEqual([]);
  expect(h.releases()).toBe(h.locks.length);
});
