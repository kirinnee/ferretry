import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
import { OS_CHOSEN_PORT } from '../../../../daemon/tests/integration/support/os-port.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files.ts';
import { FileStateHomeClaim } from '../../../src/adapters/state-home/claim-files.ts';
import { resolveDaemonLayout } from '../../../src/lib/daemon/layout.ts';
import { DirectSupervisor } from '../../../src/lib/daemon/supervisor.ts';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim.ts';
import { TEARDOWN_TIMEOUT_MS, tearDownSupervisedDaemons } from '../support/supervised-daemon-teardown.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * Where a daemon `fy daemon start` launched looks for this host's harness logins — the way it hid.
 *
 * Bun's `homedir()` honours `HOME` only as a process was STARTED with it, and falls back to the user
 * database when it is absent. The supervisor handed the daemon `FY_HOME`, `PATH` and a locale and no
 * `HOME`, so a daemon under `HOME=/tmp/x` looked for this host's Claude Code and Codex setup in the
 * owner's real `~/.claude` and `~/.codex`. Every other journey boots `fyd` inside the test process,
 * which never drops the variable, so nothing noticed.
 *
 * So this launches a real `fyd` through the CLI's real `DirectSupervisor`, with an empty temporary
 * home, and requires the boot to have found the harnesses ONLY under that home.
 *
 * IT CANNOT READ A REAL SETUP, EVEN WHERE THE BUG IS PRESENT. Both harnesses are declared as
 * `~/<unique directory>/<harness>`, and an explicitly named path that resolves to nothing searches no
 * further. Under the home the test gave, those are real executables and the boot names both. Under
 * any other home they name a directory that cannot exist, so no harness is found — the defect shows
 * as that unreachable path in the log instead. `PATH` is asserted to hold no `claude` or `codex`
 * besides, and the test never reads the real home itself: it only compares the log against its path.
 */

const REPOSITORY = resolve(import.meta.dir, '../../../../..');
const TMUX = Bun.which('tmux');

const roots = new Set<string>();
const daemons = new Set<number>();
const sockets = new Set<string>();

afterEach(async () => {
  await tearDownSupervisedDaemons({ daemons, sockets, roots }, { tmux: TMUX });
}, TEARDOWN_TIMEOUT_MS);

async function executable(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`);
  await chmod(path, 0o755);
}

/** A private `PATH`, an empty user home holding the two declared harnesses, and an adopted state home. */
async function arrange(
  root: string,
): Promise<{ bin: string; userHome: string; stateHome: string; fyd: string; probe: string }> {
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
      port: OS_CHOSEN_PORT,
      relay: { url: 'https://off.example', enabled: false },
      harness: { paths: { claude: `~/${probe}/claude`, codex: `~/${probe}/codex` } },
    }),
    { mode: 0o600 },
  );
  return { bin, userHome, stateHome, fyd, probe };
}

/** The daemon log once the boot says it is serving; a boot that never does fails with the log it wrote. */
async function logAfterReady(logFile: string): Promise<string> {
  const read = () => readFile(logFile, 'utf8').catch(() => '');
  return waitFor(
    async () => {
      const log = await read();
      return log.includes('serving http') ? log : undefined;
    },
    'the daemon to say it is serving http',
    { pollMs: 50, evidence: read },
  );
}

describe('the user home of a daemon `fy daemon start` launched', () => {
  it('should look for this host’s harness setup only under the HOME the CLI ran with', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-home-'));
    roots.add(root);
    const { bin, userHome, stateHome, fyd, probe } = await arrange(root);
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
    const log = await logAfterReady(layout.logFile);

    // Assert — a failed containment prints the whole log, which is the evidence either way.
    should(log).containEql(`claude: ${join(userHome, probe, 'claude')}`);
    should(log).containEql(`codex: ${join(userHome, probe, 'codex')}`);
    // Found, and still not imported: starting a daemon never sets the machine up by itself.
    should(log).not.containEql('first run:');
    should(await Bun.file(join(stateHome, 'fleet', 'config.yaml')).exists()).be.false();
    // Every path the defect produced, spelled against this account's own home. Not the home itself: a
    // temporary directory may live under it — a CI runner's does — and every path above would match.
    const owner = homedir();
    for (const leaked of [join(owner, '.claude'), join(owner, '.codex'), join(owner, probe)]) {
      should(log.includes(leaked)).equal(false, `the daemon named ${leaked}:\n${log}`);
    }
  }, 60_000);
});
