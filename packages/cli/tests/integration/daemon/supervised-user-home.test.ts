import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../daemon/src/adapters/index.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';

/**
 * Where a daemon `fy daemon start` launched looks for this host's harness logins — the way it hid.
 *
 * Bun's `homedir()` honours `HOME` only as a process was STARTED with it, and falls back to the user
 * database when it is absent. The supervisor handed the daemon `FY_HOME`, `PATH` and a locale and no
 * `HOME`, so a first run under `HOME=/tmp/x` prepared its default accounts and then looked for a
 * login to copy in the owner's real `~/.claude` and `~/.codex`. Every other journey boots `fyd`
 * inside the test process, which never drops the variable, so nothing noticed.
 *
 * So this launches a real `fyd` through the CLI's real `DirectSupervisor`, with default-account
 * preparation ON and an empty temporary home, and requires the login search to have named ONLY that
 * home.
 *
 * IT CANNOT COPY A LOGIN, EVEN WHERE THE BUG IS PRESENT. Both harnesses are declared as
 * `~/<unique directory>/<harness>`, and an explicitly named path that resolves to nothing searches no
 * further. Under the home the test gave, those are real executables and preparation runs. Under any
 * other home they name a directory that cannot exist, so no harness is found, nothing is prepared and
 * no login anywhere is read — the defect shows as that unreachable path in the log instead. `PATH` is
 * asserted to hold no `claude` or `codex` besides, and the test never reads the real home itself: it
 * only compares the log against its path.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const TMUX = Bun.which('tmux');

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();

afterEach(async () => {
  for (const pid of daemons) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  daemons.clear();
  for (const socket of sockets) {
    if (TMUX !== null)
      await Bun.spawn([TMUX, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
  }
  sockets.clear();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('the fixture server reported no port');
  return port;
}

async function executable(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`);
  await chmod(path, 0o755);
}

/** A private `PATH`, an empty user home holding the two declared harnesses, and an adopted state home. */
async function arrange(
  root: string,
  port: number,
): Promise<{ bin: string; userHome: string; stateHome: string; fyd: string }> {
  if (TMUX === null) throw new Error('tmux is required for this journey and was not found');
  const bin = join(root, 'bin');
  const userHome = join(root, 'home');
  const stateHome = join(root, 'state');
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'bun'));
  await symlink(TMUX, join(bin, 'tmux'));
  const fyd = join(bin, 'fyd');
  await executable(fyd, ['#!/bin/sh', `exec bun '${join(REPOSITORY, 'packages/daemon/bin/fyd.ts')}' "$@"`]);

  // Found only under the home this test hands the CLI. Nothing launches a harness to detect it, and
  // one that ran anyway would fail rather than pretend to be a provider.
  const probe = `.fy-home-probe-${crypto.randomUUID()}`;
  await mkdir(join(userHome, probe), { recursive: true });
  for (const harness of ['claude', 'codex']) await executable(join(userHome, probe, harness), ['#!/bin/sh', 'exit 97']);

  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: stateHome }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(),
    () => new KeyedSerialExecutor(),
  ).open();
  await opened.storage.close();
  await writeFile(
    join(stateHome, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port,
      relay: { url: 'https://off.example', enabled: false },
      harness: { paths: { claude: `~/${probe}/claude`, codex: `~/${probe}/codex` } },
      fleet: { prepareDefaults: true },
    }),
    { mode: 0o600 },
  );
  return { bin, userHome, stateHome, fyd };
}

/** The daemon log once the login search has been reported, or whatever it holds when time runs out. */
async function logAfterLoginSearch(logFile: string): Promise<string> {
  let log = '';
  for (let attempt = 0; attempt < 300; attempt += 1) {
    log = await readFile(logFile, 'utf8').catch(() => '');
    if (log.includes('Nothing was copied for Codex') && log.includes('Nothing was copied for Claude')) return log;
    await Bun.sleep(50);
  }
  return log;
}

describe('the user home of a daemon `fy daemon start` launched', () => {
  it('should look for harness logins only under the HOME the CLI ran with', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-home-'));
    roots.add(root);
    const port = await freeLoopbackPort();
    const { bin, userHome, stateHome, fyd } = await arrange(root, port);
    const searchPath = `${bin}:/usr/bin:/bin`;
    // Fail closed rather than let the daemon find a real harness through PATH.
    should(Bun.which('claude', { PATH: searchPath })).equal(null);
    should(Bun.which('codex', { PATH: searchPath })).equal(null);
    sockets.add(join(stateHome, 'tmux.sock'));
    const layout = resolveDaemonLayout({
      platform: process.platform,
      homeDirectory: userHome,
      stateHome,
      configHome: join(root, 'config-home'),
      stateDirectory: join(root, 'cli-state'),
      userId: 1000,
      daemonName: 'fyd',
      product: 'ferretry',
      searchPath,
    });
    const supervisor = new DirectSupervisor(
      layout,
      new BunDaemonProcess(),
      new FileServiceStore(),
      new StateHomeClaimService(new FileStateHomeClaim(), 'fy daemon adopt'),
    );

    // Act
    const handle = await supervisor.start(fyd);
    if (handle.pid !== undefined) daemons.add(handle.pid);
    const log = await logAfterLoginSearch(layout.logFile);

    // Assert — a failed containment prints the whole log, which is the evidence either way.
    should(log).containEql(`no usable Claude login was found in ${join(userHome, '.claude')}`);
    should(log).containEql(`no usable Codex login was found in ${join(userHome, '.codex')}`);
    should(log.includes(homedir())).equal(false, `the daemon named this account's own home:\n${log}`);
  }, 60_000);
});
