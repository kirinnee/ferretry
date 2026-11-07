import { expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { UPDATES_REPORT } from '@ferretry/plugin-updates/contract';
import { decodeJson } from '../../../../core/kernel/host/state/format.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { createWorld } from '../../../src/adapters/world.ts';
import { registry as compiledRegistry } from '../../../src/generated/commands.ts';
import { runFy } from '../../../src/lib/run.ts';
import { capturedIo, entry, inventoryOf, registryOf } from '../fakes.ts';

test.each([1, 2])(
  'V-0250 production update composition runs with Updates off and checks home.json format %s before launch',
  async format => {
    const root = await mkdtemp(join(tmpdir(), 'fy-update-composition-'));
    const home = join(root, 'fy-home');
    const runtime = join(root, 'run');
    const binary = join(root, 'Caskroom', 'ferretry', '5.0.0', 'bin', 'fyd');
    const report = join(root, 'report.json');
    const io = capturedIo();
    const updates = compiledRegistry.plugins.find(plugin => plugin.id === 'updates');
    if (updates === undefined) throw new Error('Updates must be in the generated registry');
    const registry = registryOf(
      entry(updates.manifest, 'updates-hash', async () => {
        throw new Error('Updates is off');
      }),
    );
    const off = inventoryOf({ id: 'updates', on: false, contract: 'updates-hash' });
    let installed = '5.0.0';
    let health: { protocol: 1; version: string; pid: number } | undefined = {
      protocol: 1,
      version: installed,
      pid: 4321,
    };
    const signals: number[] = [];
    const checkedLocks: string[] = [];
    const requests: string[] = [];
    const commands: string[][] = [];
    let launches = 0;
    await mkdir(home, { recursive: true });
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, 'fixture; never executed\n');
    await chmod(binary, 0o700);
    await writeFile(
      join(home, 'home.json'),
      JSON.stringify({ format, createdBy: '5.0.0', createdAt: '2026-11-07T00:00:00.000Z' }),
    );
    // These process boundaries are the only fakes under createWorld -> buildUpdateMachine.
    const which = spyOn(Bun, 'which').mockReturnValue(null);
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('no real subprocess may run');
    });
    const version = spyOn(Bun, 'spawnSync').mockImplementation((...args) => {
      expect(args[0]).toEqual([binary, '--version']);
      return { exitCode: 0, stdout: Buffer.from(installed) } as ReturnType<typeof Bun.spawnSync>;
    });
    const run = spyOn(BunDaemonProcess.prototype, 'run').mockImplementation(async argv => {
      throw new Error(`unexpected process: ${argv.join(' ')}`);
    });
    const streaming = spyOn(BunDaemonProcess.prototype, 'runStreaming').mockImplementation(async argv => {
      commands.push([...argv]);
      if (argv.join(' ') === 'brew tap') return { code: 0, stdout: 'kirinnee/ferretry\n', stderr: '' };
      if (argv.join(' ') === 'brew upgrade --cask ferretry') installed = '5.0.1';
      else if (argv[0] !== 'brew') throw new Error(`unexpected package command: ${argv.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    });
    const holds = spyOn(BunDaemonProcess.prototype, 'holdsOpen').mockImplementation(async (pid, path) => {
      expect(pid).toBe(4321);
      checkedLocks.push(path);
      return path === join(home, 'run', 'daemon.lock');
    });
    const signal = spyOn(BunDaemonProcess.prototype, 'signal').mockImplementation((pid, how) => {
      expect(how).toBe('SIGTERM');
      signals.push(pid);
      health = undefined;
      return true;
    });
    const alive = spyOn(BunDaemonProcess.prototype, 'alive').mockImplementation(pid => pid === health?.pid);
    const detached = spyOn(BunDaemonProcess.prototype, 'spawnDetached').mockImplementation(async launch => {
      launches++;
      expect(launch.argv).toEqual([binary]);
      expect(launch.environment.FY_HOME).toBe(home);
      expect(launch.environment.HOME).toBe(root);
      expect(launch.logFile).toBe(join(home, 'logs', 'fyd.log'));
      health = { protocol: 1, version: installed, pid: 4322 };
      return { pid: health.pid };
    });
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input);
          requests.push(url);
          if (url === 'http://127.0.0.1:7431/healthz')
            return health === undefined ? new Response(null, { status: 503 }) : Response.json(health);
          if (url === 'http://127.0.0.1:17431/v1/plugins') return Response.json(off);
          throw new Error(`unexpected fetch: ${url}`);
        },
        {
          preconnect: () => {
            throw new Error('no real preconnect may run');
          },
        },
      ),
    );
    try {
      const world = createWorld({
        io,
        registry,
        userHome: root,
        product: 'ferretry',
        selfPath: join(dirname(binary), 'fy'),
        identity: { binary: 'fy', version: '5.0.0' },
        environment: {
          FY_HOME: home,
          FY_DAEMON_BIN: binary,
          // Explicit fixture credential avoids reading the real admin token or probing the host listener.
          FY_TOKEN: 'unit-test-only',
          FY_URL: 'http://127.0.0.1:17431',
          PATH: dirname(binary),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_RUNTIME_DIR: runtime,
        },
        process: {
          spawnDetached: () => {
            throw new Error('must not auto-start a real daemon');
          },
        },
      });
      expect(await runFy(['update', '--run', '--yes', '--to', '5.0.1', '--report', report], world)).toBe(
        format === 1 ? 0 : 1,
      );
      const decoded = decodeJson(UPDATES_REPORT, 'state/updates/update/report.json', await readFile(report, 'utf8'));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.from).toBe('5.0.0');
        expect(decoded.value.target).toBe('5.0.1');
        expect(decoded.value.outcome).toBe(format === 1 ? 'succeeded' : 'failed');
      }
      expect(launches).toBe(format === 1 ? 1 : 0);
      expect(signals).toEqual([4321]);
      expect(checkedLocks.length).toBeGreaterThan(0);
      expect(checkedLocks.every(path => path === join(home, 'run', 'daemon.lock'))).toBe(true);
      expect(commands).toContainEqual(['brew', 'upgrade', '--cask', 'ferretry']);
      expect(requests).toContain('http://127.0.0.1:7431/healthz');
      expect(requests).toContain('http://127.0.0.1:17431/v1/plugins');
      expect(requests.some(url => url.endsWith('/v1/daemon/update'))).toBe(false);
      expect(await readdir(runtime)).toEqual([]);
      if (format === 1) expect(health).toEqual({ protocol: 1, version: '5.0.1', pid: 4322 });
    } finally {
      fetcher.mockRestore();
      detached.mockRestore();
      alive.mockRestore();
      signal.mockRestore();
      holds.mockRestore();
      streaming.mockRestore();
      run.mockRestore();
      version.mockRestore();
      spawn.mockRestore();
      which.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
