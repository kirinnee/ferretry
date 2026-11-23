import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn, childEnvironments, MANAGER_ENVIRONMENT_NAMES } from '@ferretry/kernel/host';
import should from 'should';
import { KernelTmuxProcess } from '../../../../daemon/adapters/tmux/kernel-tmux-process.ts';
import { PANE_MANAGER_NAMES, TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * A ferret pane launched through the REAL launch path: the kernel's spawn port built exactly as `fyd` builds it (a base of
 * PATH and HOME, plus `childEnvironments(<the daemon's environment>)`), the real tmux adapter over it, and the real
 * runner, on a private tmux server in a temp directory (the owner's own tmux server is never touched).
 *
 * WHY: a limited pane's first program is `systemd-run --user --scope` (Terminals' ferret limits), and a pane sees only the
 * tmux server's environment plus what its launching client copies in. The server used to get PATH and HOME alone, so on
 * any Linux host with a user manager EVERY Claude ferret's pane printed "Failed to connect to bus: No medium found" and
 * exited 1 within two seconds, while the daemon's own scope probe (run as `systemd-run`, with the manager names) passed.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What the daemon's own environment holds: the two manager names, and secrets no pane may inherit from the host. */
const DAEMON_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: homedir(),
  XDG_RUNTIME_DIR: '/fixture/run/user/4242',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/run/user/4242/bus',
  GH_TOKEN: 'ghp_must_not_reach_a_pane',
  SSH_AUTH_SOCK: '/fixture/ssh-agent',
  HTTPS_PROXY: 'http://user:pass@proxy:3128',
};

/** The kernel spawn port as `fyd` wires it (`realAdapters` → `bunSpawn(childEnv, opener, toolEnv, sealedEnv, managerEnv)`). */
function daemonSpawn(source: Readonly<Record<string, string | undefined>>, handle: ChildEnvironment) {
  const { toolEnv, sealedEnv, managerEnv } = childEnvironments(source);
  return bunSpawn(
    { PATH: source['PATH'] ?? '/usr/bin:/bin', HOME: source['HOME'] ?? homedir() },
    () => ({ open: env => (env === handle ? {} : undefined), searchPathOf: () => undefined }),
    toolEnv,
    sealedEnv,
    managerEnv,
  );
}

async function world(source: Readonly<Record<string, string | undefined>> = DAEMON_ENVIRONMENT) {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-manager-env-'));
  const socket = join(root, 's');
  const handle = Object.freeze({ names: [] }) as unknown as ChildEnvironment;
  const spawn = daemonSpawn(source, handle);
  const tmux = new KernelTmuxProcess(spawn, socket, TMUX);
  cleanups.push(async () => {
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  const runner = new TmuxRunner({
    tmux,
    spawn,
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
  });
  /** Launch a ferret whose pane runs `script` under `sh -c`; its output goes to `<root>/<name>`. */
  const launch = async (name: string, script: string) => {
    const started = await runner.start({
      ferret: ferretId(name),
      command: ['sh', '-c', `${script} > "${root}/${name}" 2>&1`],
      cwd: fenced(root),
      env: handle,
    });
    if (!started.ok) throw new Error(`the pane did not start: ${JSON.stringify(started.error)}`);
  };
  const output = async (name: string) => {
    await waitFor(async () => (await readFile(join(root, name), 'utf8').catch(() => '')).endsWith('\n'), name);
    return await readFile(join(root, name), 'utf8');
  };
  return { root, socket, launch, output };
}

const PRINT_MANAGER =
  'printf "%s|%s|%s|%s|%s\\n" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$GH_TOKEN" "$SSH_AUTH_SOCK" "$HTTPS_PROXY"';

describe('a ferret pane reaches the user manager', () => {
  it('should hold the same two names the kernel gives a manager program', () => {
    should([...PANE_MANAGER_NAMES].sort()).deepEqual([...MANAGER_ENVIRONMENT_NAMES].sort());
  });

  it.skipIf(process.platform !== 'linux')(
    "should give a pane the daemon's XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, and none of its secrets",
    async () => {
      // Arrange
      const { launch, output } = await world();

      // Act
      await launch('f1', PRINT_MANAGER);

      // Assert
      should(await output('f1')).equal('/fixture/run/user/4242|unix:path=/fixture/run/user/4242/bus|||\n');
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'should give them to a pane on a server an older build started without them',
    async () => {
      // Arrange — the server is already running, started from a client that had only PATH and HOME (every 5.0 build
      // before this fix), and it holds another session so it outlives a daemon update.
      const { socket, launch, output } = await world();
      const older = new KernelTmuxProcess(
        bunSpawn({ PATH: DAEMON_ENVIRONMENT['PATH'] ?? '/usr/bin:/bin' }),
        socket,
        TMUX ?? 'tmux',
      );
      should((await older.execute(['new-session', '-d', '-s', 'keep', 'sleep', '600'])).code).equal(0);
      const global = await older.execute(['show-environment', '-g']);
      should(global.stdout).not.containEql('XDG_RUNTIME_DIR=');

      // Act
      await launch('f2', PRINT_MANAGER);

      // Assert
      should(await output('f2')).equal('/fixture/run/user/4242|unix:path=/fixture/run/user/4242/bus|||\n');
    },
  );

  const userManager =
    process.platform === 'linux' &&
    Bun.which('systemd-run') !== null &&
    Bun.spawnSync(['systemctl', '--user', 'show-environment'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;

  it.skipIf(!userManager)(
    "should run the limits wrapper's own `systemd-run --user --scope` in the pane (a host with a user manager)",
    async () => {
      // Arrange — the real daemon environment: the real bus, the real user manager.
      const { launch, output } = await world(process.env);

      // Act — the exact wrapper shape `agentScopeCommand` builds, with no slice so nothing is left configured.
      await launch(
        'f3',
        `systemd-run --user --scope --quiet --collect --unit=fy-test-manager-env-${String(process.pid)}.scope -- sh -c 'echo scoped'`,
      );

      // Assert
      should(await output('f3')).equal('scoped\n');
    },
  );
});
